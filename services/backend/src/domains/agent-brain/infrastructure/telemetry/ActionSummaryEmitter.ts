/**
 * ActionSummaryEmitter - Generates human-readable summaries of tool executions.
 *
 * This service creates high-signal `action.summary` events that make session
 * traces easy to understand at a glance.
 *
 * @module agent-brain/infrastructure/telemetry/ActionSummaryEmitter
 */

import type { ToolResult } from '../../application/tools/runtime/Tool';
import type { ToolArgs } from '../../application/tools/types';
import type {
  ActionSummaryPayload,
  ActionExecution,
  ActionObservation,
  ActionOutcome,
  DiscoveryPayload,
  DiscoveryCategory,
  DiscoverySource,
} from './types';

/**
 * HTTP status text mapping for common codes
 */
const HTTP_STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Patterns for detecting interesting content in tool output
 */
interface FindingPattern {
  pattern: RegExp;
  description: string;
  category?: DiscoveryCategory;
}

const FINDING_PATTERNS: FindingPattern[] = [
  { pattern: /flag\{[^}]+\}/i, description: 'Potential flag found in response', category: 'flag' },
  { pattern: /FLAG\{[^}]+\}/, description: 'Flag found in response', category: 'flag' },
  { pattern: /<!--.*?(password|credential|secret|token|api[_-]?key)/i, description: 'HTML comment contains sensitive keywords' },
  { pattern: /<!--.*?([a-zA-Z0-9]+:[a-zA-Z0-9]+).*?-->/i, description: 'Found credentials hint in HTML comment', category: 'credential' },
  { pattern: /(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+["']?/i, description: 'Password pattern found in response', category: 'credential' },
  { pattern: /\b(admin|root|administrator)\s*[:@]/i, description: 'Admin credentials pattern detected', category: 'credential' },
  { pattern: /sql(i|injection)|syntax error.*sql|mysql_/i, description: 'Potential SQL injection indicator', category: 'vulnerability' },
  { pattern: /<script[^>]*>.*?(alert|document\.cookie|eval)/i, description: 'Potential XSS vector', category: 'vulnerability' },
  { pattern: /\.\.\//g, description: 'Path traversal pattern detected', category: 'vulnerability' },
  { pattern: /\.git\/(config|HEAD)/i, description: 'Git repository exposed', category: 'vulnerability' },
  { pattern: /\.env|\.htaccess|wp-config\.php/i, description: 'Sensitive file detected', category: 'configuration' },
  { pattern: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/i, description: 'JWT token found', category: 'credential' },
  { pattern: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]+["']?/i, description: 'API key found', category: 'credential' },
];

/**
 * Discovery patterns for auto-detecting findings
 */
interface DiscoveryPattern {
  category: DiscoveryCategory;
  pattern: RegExp;
  confidence: number;
  extractKey: (match: RegExpMatchArray) => string;
  extractValue: (match: RegExpMatchArray, body: string) => unknown;
  summary: (match: RegExpMatchArray) => string;
}

const DISCOVERY_PATTERNS: DiscoveryPattern[] = [
  {
    category: 'flag',
    pattern: /(FLAG|flag|Flag)\{([^}]+)\}/,
    confidence: 1.0,
    extractKey: (m) => m[0],
    extractValue: (m) => m[0],
    summary: (m) => `Captured flag: ${m[0]}`,
  },
  {
    category: 'credential',
    pattern: /<!--\s*([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_]+)\s*-->/,
    confidence: 0.9,
    extractKey: (m) => `${m[1]}:${m[2]}`,
    extractValue: (m) => ({ username: m[1], password: m[2] }),
    summary: (m) => `Found credentials in HTML comment: ${m[1]}:${m[2]}`,
  },
  {
    category: 'credential',
    pattern: /(?:username|user|login)\s*[:=]\s*["']?([^"'\s<>]+)["']?.*?(?:password|passwd|pwd)\s*[:=]\s*["']?([^"'\s<>]+)["']?/is,
    confidence: 0.85,
    extractKey: (m) => `${m[1]}:${m[2]}`,
    extractValue: (m) => ({ username: m[1], password: m[2] }),
    summary: (m) => `Found credentials: ${m[1]}:${m[2]}`,
  },
  {
    category: 'endpoint',
    pattern: /href=["'](\/(?:api|admin|dashboard|user|account|settings)[^"']*)/gi,
    confidence: 0.7,
    extractKey: (m) => m[1],
    extractValue: (m) => ({ path: m[1], type: 'discovered_link' }),
    summary: (m) => `Discovered endpoint: ${m[1]}`,
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      output[key] = entry;
    }
  }
  return output;
};

const extractSuccessSignal = (result: ToolResult): boolean => {
  if (isRecord(result.data)) {
    if (typeof result.data.success === 'boolean') {
      return result.data.success;
    }

    if (typeof result.data.ok === 'boolean') {
      return result.data.ok;
    }

    if (typeof result.data.status_code === 'number') {
      return result.data.status_code >= 200 && result.data.status_code < 400;
    }

    if (result.data.timedOut === true || result.data.aborted === true) {
      return false;
    }

    if (typeof result.data.error === 'string' && result.data.error.trim().length > 0) {
      return false;
    }

    if (typeof result.data.code === 'number') {
      return result.data.code === 0;
    }
  }

  if (typeof result.ok === 'boolean') {
    return result.ok;
  }

  return true;
};

const getResultData = (result: ToolResult): Record<string, unknown> =>
  isRecord(result.data) ? result.data : {};

const isPolicyBlockedResult = (result: ToolResult): boolean => {
  const data = getResultData(result);
  return (
    data.forbidden === true ||
    data.denied === true ||
    (typeof result.message === 'string' && result.message.includes('outside the policy allowlist'))
  );
};

const getFailureMessage = (result: ToolResult, fallback: string): string => {
  const data = getResultData(result);
  return (
    result.message ||
    (typeof data.error === 'string' ? data.error : undefined) ||
    (typeof data.reason === 'string' ? data.reason : undefined) ||
    fallback
  );
};

const isTrustedInternalReadPath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return (
    normalizedPath.includes('/.skills/') ||
    normalizedPath.startsWith('.skills/') ||
    normalizedPath.includes('/.artifacts/report/') ||
    normalizedPath.startsWith('.artifacts/report/') ||
    normalizedPath.endsWith('/.plan') ||
    normalizedPath === '.plan' ||
    normalizedPath.endsWith('/.todo') ||
    normalizedPath === '.todo'
  );
};

/**
 * Result of summarizing a tool execution
 */
export interface ActionSummaryResult {
  summary: ActionSummaryPayload;
  discoveries: DiscoveryPayload[];
}

/**
 * Options for generating action summary
 */
export interface SummarizeOptions {
  toolName: string;
  toolCallId: string;
  args: ToolArgs;
  result: ToolResult;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

/** Maps a status line onto the observation axis. See `ActionObservation`. */
const classifyHttpObservation = (
  execution: ActionExecution,
  statusCode: number | undefined,
): ActionObservation => {
  if (typeof statusCode !== 'number') {
    return execution === 'succeeded' ? 'not_applicable' : 'no_response';
  }
  if (statusCode >= 200 && statusCode < 300) return '2xx_positive';
  if (statusCode >= 300 && statusCode < 400) return '3xx_redirect';
  if (statusCode === 401) return '401_auth_enforced';
  if (statusCode === 403) return '403_forbidden';
  if (statusCode === 404) return '404_absent';
  if (statusCode === 429) return '429_rate_limited';
  if (statusCode >= 400 && statusCode < 500) return '4xx_client_error';
  if (statusCode >= 500 && statusCode < 600) return '5xx_server_error';
  return 'not_applicable';
};

/** Non-HTTP tools have no target response to classify. */
const executionToObservation = (execution: ActionExecution): ActionObservation =>
  execution === 'succeeded' ? 'not_applicable' : 'no_response';

/**
 * For tools that do not talk to a target there is only one axis, so the execution value
 * follows the outcome directly. `error` and `failure` both mean the tool did not run to
 * completion.
 */
const outcomeToExecution = (outcome: ActionOutcome): ActionExecution => {
  switch (outcome) {
    case 'success': return 'succeeded';
    case 'timeout': return 'timeout';
    case 'blocked': return 'policy_blocked';
    case 'skipped': return 'skipped';
    default: return 'transport_failed';
  }
};

/**
 * ActionSummaryEmitter generates human-readable summaries and detects discoveries
 * from tool execution results.
 */
export class ActionSummaryEmitter {
  /**
   * Generate an action summary and detect discoveries from a tool execution
   */
  static summarize(options: SummarizeOptions): ActionSummaryResult {
    const { toolName, toolCallId, args, result, durationMs, skipped, skipReason } = options;

    // Handle skipped tools
    if (skipped) {
      return {
        summary: {
          tool: toolName,
          toolCallId,
          action: this.formatAction(toolName, args),
          outcome: 'skipped',
          outcomeReason: skipReason || 'Skipped by guard',
          execution: 'skipped',
          observation: 'not_applicable',
          durationMs: 0,
        },
        discoveries: [],
      };
    }

    // Route to tool-specific summarizer
    switch (toolName) {
      case 'http_payload':
        return this.summarizeHttpPayload('http_payload', toolCallId, args, result, durationMs);
      case 'http_raw_send':
        return this.summarizeHttpPayload('http_raw_send', toolCallId, args, result, durationMs);
      case 'shell_run':
        return this.summarizeShellRun(toolCallId, args, result, durationMs);
      case 'python_session':
        return this.summarizePythonSession(toolCallId, args, result, durationMs);
      case 'file_read':
        return this.summarizeFileRead(toolCallId, args, result, durationMs);
      case 'file_write':
        return this.summarizeFileWrite(toolCallId, args, result, durationMs);
      case 'web_search':
        return this.summarizeWebSearch(toolCallId, args, result, durationMs);
      default:
        return this.summarizeGeneric(toolName, toolCallId, args, result, durationMs);
    }
  }

  /**
   * Summarize HTTP payload tool execution
   */
  private static summarizeHttpPayload(
    toolName: string,
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const method = toolName === 'http_raw_send'
      ? 'RAW'
      : (args.method as string)?.toUpperCase() || 'GET';
    const url = args.url as string || 'unknown';
    const data = isRecord(result.data)
      ? result.data
      : isRecord(result)
        ? (result as unknown as Record<string, unknown>)
        : {};
    const statusCode = data.status_code as number | undefined;
    const responseBody =
      (data.body_preview as string) ||
      (data.response_preview as string) ||
      (data.response_body as string) ||
      '';
    const rawHeaders = (data.response_headers as string) || '';
    const interestingHeaders = toStringMap(data.interesting_headers);
    const contentType = this.extractContentType(rawHeaders, interestingHeaders);
    const resultOk =
      typeof result.ok === 'boolean'
        ? result.ok
        : data.success !== false && data.timedOut !== true && data.aborted !== true;

    // D2 — two axes. Did the request execute, and what did the target say? A target that
    // answers 401 has answered; the tool did its job. Collapsing the two turned ordinary
    // security evidence into recorded failures.
    let execution: ActionExecution = 'succeeded';
    let outcome: ActionOutcome = 'success';
    let outcomeReason: string | undefined;

    if (!resultOk) {
      if (data.timedOut) {
        execution = 'timeout';
        outcome = 'timeout';
        outcomeReason = 'Request timed out';
      } else if (data.aborted) {
        execution = 'policy_blocked';
        outcome = 'blocked';
        outcomeReason = (data.abortReason as string) || 'Request aborted';
      } else if (isPolicyBlockedResult(result)) {
        execution = 'policy_blocked';
        outcome = 'blocked';
        outcomeReason = getFailureMessage(result, 'Request blocked by policy');
      } else if (statusCode) {
        // The transport worked well enough to read a status line. The tool ran.
        outcomeReason = `${statusCode} ${HTTP_STATUS_TEXT[statusCode] || 'Error'}`;
      } else {
        execution = 'transport_failed';
        outcome = 'failure';
        outcomeReason = getFailureMessage(result, 'Request failed');
      }
    } else if (statusCode) {
      outcomeReason = `${statusCode} ${
        HTTP_STATUS_TEXT[statusCode] || (statusCode >= 400 ? 'Error' : 'OK')
      }`;
    }

    const observation = classifyHttpObservation(execution, statusCode);

    // Detect findings and discoveries
    const { finding, discoveries } = this.analyzeContent(responseBody, toolCallId, 'tool_output');

    return {
      summary: {
        tool: toolName,
        toolCallId,
        action: `${method} ${url}`,
        outcome,
        outcomeReason,
        execution,
        observation,
        statusCode,
        contentType: contentType || undefined,
        finding,
        durationMs,
      },
      discoveries,
    };
  }

  /**
   * Summarize shell command execution
   */
  private static summarizeShellRun(
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const command = (args.command as string) || 'unknown';
    const data = result.data as Record<string, unknown> || {};
    const exitCode = data.code as number | undefined;
    const stdout = (data.stdout as string) || '';

    // Truncate command for display
    const displayCommand = command.length > 80 ? command.substring(0, 77) + '...' : command;

    // Determine outcome
    let outcome: ActionOutcome = result.ok ? 'success' : 'failure';
    let outcomeReason: string | undefined;

    if (data.timedOut) {
      outcome = 'timeout';
      outcomeReason = 'Command timed out';
    } else if (isPolicyBlockedResult(result)) {
      outcome = 'blocked';
      outcomeReason = getFailureMessage(result, 'Command blocked');
    } else if (data.aborted) {
      outcome = 'blocked';
      outcomeReason = (data.abortReason as string) || 'Command aborted';
    } else if (!result.ok) {
      if (exitCode !== undefined) {
        outcomeReason = `Exit code ${exitCode}`;
      } else {
        outcomeReason = (data.error as string) || 'Command failed';
      }
    }

    // Detect findings and discoveries
    const { finding, discoveries } = this.analyzeContent(stdout, toolCallId, 'tool_output');

    return {
      summary: {
        tool: 'shell_run',
        toolCallId,
        action: displayCommand,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        finding,
        durationMs,
      },
      discoveries,
    };
  }

  /**
   * Summarize persistent Python execution.
   */
  private static summarizePythonSession(
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const action = (args.action as string) || 'exec';
    const label = (args.label as string) || '';
    const data = result.data as Record<string, unknown> || {};
    const stdout = (data.stdout as string) || '';
    const stderr = (data.stderr as string) || '';
    const error = (data.error as string) || '';
    const display = label || (action === 'exec' ? 'exec' : action);
    const blocked = isPolicyBlockedResult(result);
    let outcome: ActionOutcome = blocked ? 'blocked' : result.ok ? 'success' : 'failure';
    if (error.toLowerCase().includes('timed out')) {
      outcome = 'timeout';
    }

    const outcomeReason = result.ok
      ? undefined
      : getFailureMessage(result, 'Python session action failed');
    const { finding, discoveries } = this.analyzeContent(`${stdout}\n${stderr}`, toolCallId, 'tool_output');

    return {
      summary: {
        tool: 'python_session',
        toolCallId,
        action: `python_session ${display}`,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        finding,
        durationMs,
      },
      discoveries,
    };
  }

  /**
   * Summarize file read operation
   */
  private static summarizeFileRead(
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const path = (args.path as string) || 'unknown';
    const data = result.data as Record<string, unknown> || {};
    const content = (typeof data === 'string' ? data : (data.content as string)) || '';

    const blocked = isPolicyBlockedResult(result);
    const outcome: ActionOutcome = blocked ? 'blocked' : result.ok ? 'success' : 'failure';
    const outcomeReason: string | undefined = !result.ok ? getFailureMessage(result, 'File not found or unreadable') : `${content.length} bytes`;

    const { finding, discoveries } = isTrustedInternalReadPath(path)
      ? { finding: undefined, discoveries: [] }
      : this.analyzeContent(content, toolCallId, 'tool_output');

    return {
      summary: {
        tool: 'file_read',
        toolCallId,
        action: `Read ${path}`,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        finding,
        durationMs,
      },
      discoveries,
    };
  }

  /**
   * Summarize file write operation
   */
  private static summarizeFileWrite(
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const path = (args.path as string) || 'unknown';
    const content = (args.content as string) || '';

    const blocked = isPolicyBlockedResult(result);
    const outcome: ActionOutcome = blocked ? 'blocked' : result.ok ? 'success' : 'failure';
    const outcomeReason: string | undefined = !result.ok ? getFailureMessage(result, 'Write failed') : `${content.length} bytes written`;

    return {
      summary: {
        tool: 'file_write',
        toolCallId,
        action: `Write ${path}`,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        durationMs,
      },
      discoveries: [],
    };
  }

  /**
   * Summarize web search operation
   */
  private static summarizeWebSearch(
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const query = (args.q as string) || 'unknown';
    const data = result.data as Record<string, unknown> || {};
    const results = (data.results as unknown[]) || [];

    const outcome: ActionOutcome = result.ok ? 'success' : 'failure';
    const outcomeReason: string | undefined = !result.ok
      ? ((data.error as string) || 'Search failed')
      : `${results.length} results`;

    return {
      summary: {
        tool: 'web_search',
        toolCallId,
        action: `Search: "${query.length > 40 ? query.substring(0, 37) + '...' : query}"`,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        durationMs,
      },
      discoveries: [],
    };
  }

  /**
   * Generic summarizer for unknown tools
   */
  private static summarizeGeneric(
    toolName: string,
    toolCallId: string,
    args: ToolArgs,
    result: ToolResult,
    durationMs: number
  ): ActionSummaryResult {
    const action = this.formatAction(toolName, args);

    const logicalSuccess = extractSuccessSignal(result);
    const data = getResultData(result);
    const outcome: ActionOutcome = isPolicyBlockedResult(result)
      ? 'blocked'
      : logicalSuccess
        ? 'success'
        : 'failure';
    const outcomeReason: string | undefined = logicalSuccess
      ? undefined
      : result.message ||
        (typeof data.error === 'string' ? data.error : undefined) ||
        (typeof data.status_code === 'number'
          ? `${data.status_code} ${HTTP_STATUS_TEXT[data.status_code] || 'Error'}`
          : undefined) ||
        'Operation failed';

    // Try to extract content for discovery analysis
    const content =
      (data.stdout as string) ||
      (data.content as string) ||
      (data.body_preview as string) ||
      (data.response_body as string) ||
      '';
    const { finding, discoveries } = this.analyzeContent(content, toolCallId, 'tool_output');

    return {
      summary: {
        tool: toolName,
        toolCallId,
        action,
        outcome,
        outcomeReason,
        execution: outcomeToExecution(outcome),
        observation: executionToObservation(outcomeToExecution(outcome)),
        finding,
        durationMs,
      },
      discoveries,
    };
  }

  /**
   * Format a human-readable action description from tool name and args
   */
  private static formatAction(toolName: string, args: ToolArgs): string {
    const argsStr = Object.entries(args)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        const strVal = String(v);
        return `${k}=${strVal.length > 20 ? strVal.substring(0, 17) + '...' : strVal}`;
      })
      .join(', ');

    return argsStr ? `${toolName}(${argsStr})` : toolName;
  }

  /**
   * Analyze content for findings and discoveries
   */
  private static analyzeContent(
    content: string,
    toolCallId: string,
    source: DiscoverySource
  ): { finding?: string; discoveries: DiscoveryPayload[] } {
    if (!content || content.length === 0) {
      return { discoveries: [] };
    }

    let finding: string | undefined;
    const discoveries: DiscoveryPayload[] = [];

    // Check for finding patterns (short descriptions)
    for (const pattern of FINDING_PATTERNS) {
      if (pattern.pattern.test(content)) {
        finding = pattern.description;
        break;
      }
    }

    // Check for discovery patterns (structured findings)
    for (const pattern of DISCOVERY_PATTERNS) {
      const match = content.match(pattern.pattern);
      if (match) {
        const key = pattern.extractKey(match);
        // Avoid duplicate discoveries
        if (!discoveries.some((d) => d.key === key)) {
          discoveries.push({
            category: pattern.category,
            key,
            value: pattern.extractValue(match, content),
            confidence: pattern.confidence,
            source,
            sourceToolCallId: toolCallId,
            summary: pattern.summary(match),
          });
        }
      }
    }

    return { finding, discoveries };
  }

  /**
   * Detect discoveries from content without generating a full action summary.
   * Useful for post-processing tool outputs.
   */
  static detectDiscoveries(
    content: string,
    toolCallId: string,
    source: DiscoverySource
  ): DiscoveryPayload[] {
    const { discoveries } = this.analyzeContent(content, toolCallId, source);
    return discoveries;
  }

  /**
   * Extract Content-Type value from raw response headers string.
   * Returns the media type without parameters (e.g. 'text/html' not 'text/html; charset=utf-8').
   */
  private static extractContentType(
    rawHeaders: string,
    interestingHeaders: Record<string, string> = {},
  ): string | null {
    const hintedContentType = interestingHeaders['content-type'];
    if (hintedContentType) {
      return hintedContentType.split(';', 1)[0]?.trim().toLowerCase() || null;
    }
    if (!rawHeaders) return null;
    const match = rawHeaders.match(/^content-type:\s*([^\r\n;]+)/im);
    if (!match || !match[1]) return null;
    return match[1].trim().toLowerCase();
  }
}
