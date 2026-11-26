import { sha256Hex } from '@/shared/utils/hash';

export const TOOL_RESULT_POLICY_VERSION = 'tool-result-policy/v1';

export interface ToolResultPolicyConfig {
  persistThresholdChars: number;
  defaultPreviewChars: number;
  /**
   * E12 Slice B: reduction trigger. Nothing is reduced until tool results reach this size,
   * so the model-visible projection stays byte-stable between crossings.
   */
  aggregateToolResultPromptBudgetTokens: number;
  /**
   * E12 Slice B: reduction target. On a crossing the oldest eligible results are reduced in
   * one batch until they fit this size. The gap between trigger and target is how many
   * turns pass before the next prefix rewrite.
   */
  aggregateToolResultTargetTokens: number;
  keepLastToolResults: number;
  maxResultTokens: number;
  maxResultChars: number;
  httpPayloadBodyPreviewChars: number;
  httpHeaderMaxCount: number;
  httpHeaderValueMaxChars: number;
  browserActionPreviewChars: number;
  shellInlineOutputChars: number;
  waitForShellJobInlineOutputChars: number;
  compactableToolNames: ReadonlySet<string>;
}

export interface ToolResultNormalization {
  result: unknown;
  persistRecommended: boolean;
  rawCharsSavedByNormalization: number;
}

const DEFAULT_COMPACTABLE_TOOL_NAMES = new Set([
  'file_read',
  'shell_run',
  'wait_for_shell_job',
  'query_inventory',
  'query_notes',
  'query_compliance_readiness',
  'query_compliance_evidence',
  'query_compliance_proof_package',
  'query_compliance_missing_evidence',
  'web_search',
  'web_fetch',
  'http_list',
  'http_payload',
  'http_raw_send',
  'http_view',
  'browser_action',
  'python_session',
]);

export const DEFAULT_TOOL_RESULT_POLICY_CONFIG: ToolResultPolicyConfig = {
  persistThresholdChars: 20_000,
  defaultPreviewChars: 2_000,
  aggregateToolResultPromptBudgetTokens: 16_000,
  // Half the trigger. Claude batches to a far deeper target (40k from a 180k trigger); a
  // shallower target discards less context per event and is the conservative default until
  // Slice A has production lineage data to tune it with.
  aggregateToolResultTargetTokens: 8_000,
  keepLastToolResults: 6,
  maxResultTokens: 600,
  maxResultChars: 2_500,
  httpPayloadBodyPreviewChars: 1_500,
  httpHeaderMaxCount: 8,
  httpHeaderValueMaxChars: 300,
  browserActionPreviewChars: 2_000,
  shellInlineOutputChars: 3_000,
  waitForShellJobInlineOutputChars: 1_000,
  compactableToolNames: DEFAULT_COMPACTABLE_TOOL_NAMES,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncateText = (
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: boolean; originalChars: number } => {
  if (typeof value !== 'string') {
    return { value, truncated: false, originalChars: 0 };
  }
  if (value.length <= maxChars) {
    return { value, truncated: false, originalChars: value.length };
  }
  return {
    value: `${value.slice(0, Math.max(0, maxChars)).trimEnd()}...[truncated by tool result policy]`,
    truncated: true,
    originalChars: value.length,
  };
};

const tailText = (
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: boolean; originalChars: number; sha256?: string } => {
  if (typeof value !== 'string') {
    return { value, truncated: false, originalChars: 0 };
  }
  const sha256 = value.length > 0 ? sha256Hex(value) : undefined;
  if (value.length <= maxChars) {
    return { value, truncated: false, originalChars: value.length, sha256 };
  }
  const tail = value.slice(Math.max(0, value.length - maxChars));
  return {
    value: `[output truncated by tool result policy; showing last ${maxChars} of ${value.length} chars]\n${tail}`,
    truncated: true,
    originalChars: value.length,
    sha256,
  };
};

const readPayload = (result: unknown): { wrapper?: Record<string, unknown>; data: Record<string, unknown> | undefined } => {
  if (!isRecord(result)) {
    return { data: undefined };
  }
  if (isRecord(result.data)) {
    return { wrapper: result, data: result.data };
  }
  return { wrapper: undefined, data: result };
};

const writePayload = (
  original: unknown,
  data: Record<string, unknown>,
): unknown => {
  if (isRecord(original) && isRecord(original.data)) {
    return {
      ...original,
      data,
    };
  }
  return data;
};

const capHeaders = (
  headers: unknown,
  config: ToolResultPolicyConfig,
): { headers: unknown; truncated: boolean; omitted: string[]; summarized: string[] } => {
  if (!isRecord(headers)) {
    return { headers, truncated: false, omitted: [], summarized: [] };
  }
  const entries = Object.entries(headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  const capped: Record<string, string> = {};
  const omitted: string[] = [];
  const summarized: string[] = [];

  for (const [name, value] of entries) {
    if (Object.keys(capped).length >= config.httpHeaderMaxCount) {
      omitted.push(name);
      continue;
    }
    if (value.length > config.httpHeaderValueMaxChars) {
      capped[name] = `${value.slice(0, config.httpHeaderValueMaxChars).trimEnd()}...[header truncated]`;
      summarized.push(name);
      continue;
    }
    capped[name] = value;
  }

  return {
    headers: capped,
    truncated: omitted.length > 0 || summarized.length > 0,
    omitted,
    summarized,
  };
};

export class ToolResultPolicy {
  constructor(private readonly config: ToolResultPolicyConfig = DEFAULT_TOOL_RESULT_POLICY_CONFIG) {}

  get version(): string {
    return TOOL_RESULT_POLICY_VERSION;
  }

  getConfig(): ToolResultPolicyConfig {
    return this.config;
  }

  isCompactableTool(toolName: string | undefined): toolName is string {
    return typeof toolName === 'string' && this.config.compactableToolNames.has(toolName);
  }

  estimateSavedTokens(rawChars: number, promptChars: number): number {
    return Math.max(0, Math.ceil(rawChars / 4) - Math.ceil(promptChars / 4));
  }

  normalizeResult(toolName: string, result: unknown): ToolResultNormalization {
    const rawChars = safeStringify(result).length;
    let next = result;
    let persistRecommended = false;

    if (toolName === 'http_payload' || toolName === 'http_view' || toolName === 'http_raw_send') {
      const normalized = this.normalizeHttpResult(result);
      next = normalized.result;
      persistRecommended = normalized.persistRecommended;
    } else if (toolName === 'browser_action') {
      const normalized = this.normalizeBrowserActionResult(result);
      next = normalized.result;
      persistRecommended = normalized.persistRecommended;
    } else if (toolName === 'python_session') {
      const normalized = this.normalizePythonSessionResult(result);
      next = normalized.result;
      persistRecommended = normalized.persistRecommended;
    } else if (toolName === 'shell_run') {
      const normalized = this.normalizeShellResult(result, this.config.shellInlineOutputChars, false);
      next = normalized.result;
      persistRecommended = normalized.persistRecommended;
    } else if (toolName === 'wait_for_shell_job') {
      const normalized = this.normalizeShellResult(result, this.config.waitForShellJobInlineOutputChars, true);
      next = normalized.result;
      persistRecommended = normalized.persistRecommended;
    }

    const nextChars = safeStringify(next).length;
    return {
      result: next,
      persistRecommended,
      rawCharsSavedByNormalization: Math.max(0, rawChars - nextChars),
    };
  }

  private normalizeHttpResult(result: unknown): ToolResultNormalization {
    const { data } = readPayload(result);
    if (!data) {
      return { result, persistRecommended: false, rawCharsSavedByNormalization: 0 };
    }

    const before = safeStringify(result).length;
    const nextData = { ...data };
    const body = truncateText(nextData.body_preview, this.config.httpPayloadBodyPreviewChars);
    if (body.truncated) {
      nextData.body_preview = body.value;
      nextData.body_preview_policy_truncated = true;
      nextData.body_preview_original_chars = body.originalChars;
    }
    const rawResponse = truncateText(nextData.response_preview, this.config.httpPayloadBodyPreviewChars);
    if (rawResponse.truncated) {
      nextData.response_preview = rawResponse.value;
      nextData.response_preview_policy_truncated = true;
      nextData.response_preview_original_chars = rawResponse.originalChars;
    }
    const rawRequest = truncateText(nextData.request_preview, this.config.httpPayloadBodyPreviewChars);
    if (rawRequest.truncated) {
      nextData.request_preview = rawRequest.value;
      nextData.request_preview_policy_truncated = true;
      nextData.request_preview_original_chars = rawRequest.originalChars;
    }

    const headers = capHeaders(nextData.interesting_headers, this.config);
    if (headers.truncated) {
      nextData.interesting_headers = headers.headers;
      nextData.interesting_headers_policy = {
        maxCount: this.config.httpHeaderMaxCount,
        maxValueChars: this.config.httpHeaderValueMaxChars,
        omitted: headers.omitted,
        summarized: headers.summarized,
      };
    }

    const next = writePayload(result, nextData);
    const after = safeStringify(next).length;
    // Only body/request/response previews being withheld warrant a disk round-trip:
    // the model may need the full bytes or body as evidence. Header summarization
    // stays inline and must not force persistence of an otherwise-small result.
    return {
      result: next,
      persistRecommended: body.truncated || rawResponse.truncated || rawRequest.truncated,
      rawCharsSavedByNormalization: Math.max(0, before - after),
    };
  }

  private normalizeBrowserActionResult(result: unknown): ToolResultNormalization {
    const { data } = readPayload(result);
    if (!data) {
      return { result, persistRecommended: false, rawCharsSavedByNormalization: 0 };
    }

    const before = safeStringify(result).length;
    const nextData = { ...data };
    let persistRecommended = false;

    for (const field of ['text_preview', 'js_result'] as const) {
      const capped = truncateText(nextData[field], this.config.browserActionPreviewChars);
      if (capped.truncated) {
        nextData[field] = capped.value;
        nextData[`${field}_policy_truncated`] = true;
        nextData[`${field}_original_chars`] = capped.originalChars;
        persistRecommended = true;
      }
    }

    if (typeof nextData.source === 'string' && nextData.source.length > this.config.browserActionPreviewChars) {
      nextData.source_preview = `${nextData.source.slice(0, this.config.browserActionPreviewChars).trimEnd()}...[source truncated by tool result policy]`;
      nextData.source_original_chars = nextData.source.length;
      nextData.source_policy_truncated = true;
      delete nextData.source;
      persistRecommended = true;
    }

    const next = writePayload(result, nextData);
    const after = safeStringify(next).length;
    return {
      result: next,
      persistRecommended,
      rawCharsSavedByNormalization: Math.max(0, before - after),
    };
  }

  private normalizePythonSessionResult(result: unknown): ToolResultNormalization {
    const { data } = readPayload(result);
    if (!data) {
      return { result, persistRecommended: false, rawCharsSavedByNormalization: 0 };
    }

    const before = safeStringify(result).length;
    const nextData = { ...data };
    let persistRecommended = false;

    for (const field of ['stdout', 'stderr', 'result_repr'] as const) {
      if (typeof nextData[field] !== 'string' || nextData[field].length === 0) {
        continue;
      }
      const original = nextData[field];
      const capped = tailText(original, this.config.shellInlineOutputChars);
      nextData[`${field}_sha256`] = capped.sha256 ?? sha256Hex(original);
      nextData[`${field}_original_chars`] = original.length;
      if (capped.truncated) {
        nextData[field] = capped.value;
        nextData[`${field}_policy_truncated`] = true;
        persistRecommended = true;
      }
    }

    const next = writePayload(result, nextData);
    const after = safeStringify(next).length;
    return {
      result: next,
      persistRecommended,
      rawCharsSavedByNormalization: Math.max(0, before - after),
    };
  }

  private normalizeShellResult(
    result: unknown,
    maxChars: number,
    omitCompletedOutput: boolean,
  ): ToolResultNormalization {
    const { data } = readPayload(result);
    if (!data) {
      return { result, persistRecommended: false, rawCharsSavedByNormalization: 0 };
    }

    const before = safeStringify(result).length;
    const nextData = { ...data };
    let persistRecommended = false;
    const status = typeof nextData.status === 'string' ? nextData.status : '';

    for (const field of ['stdout', 'stderr'] as const) {
      if (typeof nextData[field] !== 'string' || nextData[field].length === 0) {
        continue;
      }
      const pathField = field === 'stdout' ? 'stdoutPath' : 'stderrPath';
      const pathValue = typeof nextData[pathField] === 'string' ? nextData[pathField] : undefined;
      const original = nextData[field];
      const hash = sha256Hex(original);
      nextData[`${field}Sha256`] = hash;
      nextData[`${field}OriginalChars`] = original.length;

      if (omitCompletedOutput && status === 'completed' && pathValue) {
        nextData[field] = `[${field} omitted by tool result policy; full output at ${pathValue}; chars=${original.length}; sha256=${hash}]`;
        nextData[`${field}OmittedByPolicy`] = true;
        persistRecommended = true;
        continue;
      }

      const capped = tailText(original, maxChars);
      if (capped.truncated) {
        nextData[field] = capped.value;
        nextData[`${field}PolicyTruncated`] = true;
        persistRecommended = true;
      }
    }

    const next = writePayload(result, nextData);
    const after = safeStringify(next).length;
    return {
      result: next,
      persistRecommended,
      rawCharsSavedByNormalization: Math.max(0, before - after),
    };
  }
}

export const defaultToolResultPolicy = new ToolResultPolicy();
