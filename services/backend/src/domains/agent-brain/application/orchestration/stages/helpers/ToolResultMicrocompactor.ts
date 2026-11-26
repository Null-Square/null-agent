/**
 * ToolResultMicrocompactor - Rewrite old large tool results into compact prompt stubs.
 *
 * This does not mutate persisted session history. It only shapes the prompt copy
 * that is sent to the model, preserving assistant/tool_call pairing while keeping
 * durable artifacts and full raw history available elsewhere.
 */

import type { Message } from '../../../../domain/types';
import { estimateTokens, getToolCallId, getToolCalls, safeStringify } from './messageUtils';
import { defaultToolResultPolicy } from '../../tool-results/ToolResultPolicy';
import {
  planToolResultReduction,
  type ToolResultReductionDecision,
  type ToolResultReductionEconomics,
  type ToolResultSlot,
} from '../../tool-results/ToolResultReductionPlan';

export interface ToolResultMicrocompactionStats {
  compactedResults: number;
  candidateResults: number;
  keptRecentResults: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  compactedTools: Record<string, number>;
  aggregateBudgetEnforcements: number;
  aggregateBudgetOverageTokensBefore: number;
  aggregateBudgetOverageTokensAfter: number;
  /** E12 Slice B: the single reduction decision this pass acted on. */
  decision: ToolResultReductionDecision;
}

export interface ToolResultMicrocompactionOptions {
  keepLastToolResults?: number;
  maxResultTokens?: number;
  maxResultChars?: number;
  aggregateToolResultBudgetTokens?: number;
  aggregateToolResultTargetTokens?: number;
  /** Set when an independent authority already requires reduction this turn. */
  forceReduction?: boolean;
  /**
   * Required for the ordinary path. Absent refuses reduction rather than rewriting a warm
   * prefix on a guess. The cross-turn caller cannot yet see how many further requests will
   * reuse this prefix, so it does not pass this and its ordinary path stays off; prompt
   * pressure is answered at dispatch by the same-turn owner.
   */
  economics?: ToolResultReductionEconomics;
}

const DEFAULT_POLICY_CONFIG = defaultToolResultPolicy.getConfig();
const DEFAULT_KEEP_LAST_TOOL_RESULTS = DEFAULT_POLICY_CONFIG.keepLastToolResults;
const DEFAULT_MAX_RESULT_TOKENS = DEFAULT_POLICY_CONFIG.maxResultTokens;
const DEFAULT_MAX_RESULT_CHARS = DEFAULT_POLICY_CONFIG.maxResultChars;
const DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET_TOKENS = DEFAULT_POLICY_CONFIG.aggregateToolResultPromptBudgetTokens;
const DEFAULT_AGGREGATE_TOOL_RESULT_TARGET_TOKENS = DEFAULT_POLICY_CONFIG.aggregateToolResultTargetTokens;
export const COMPACTABLE_TOOL_NAMES = DEFAULT_POLICY_CONFIG.compactableToolNames;

export const isCompactableToolName = (toolName: string | undefined): toolName is string =>
  defaultToolResultPolicy.isCompactableTool(toolName);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonObject = (content: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const compactText = (value: string, maxChars: number = 420): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}...`;

const firstArtifactPath = (record: Record<string, unknown> | undefined): string | undefined => {
  if (!record) return undefined;
  const direct =
    readString(record.artifactPath) ??
    readString(record.path) ??
    readString(record.filePath) ??
    readString(record.outputPath) ??
    readString(record.stdoutPath) ??
    readString(record.stderrPath) ??
    readString(record.statusPath);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const nested = firstArtifactPath(value);
      if (nested) return nested;
    }
  }
  return undefined;
};

const summarizeInventory = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const digest = readRecord(data.digest);
  const assets = readArray(data.assets);
  if (!digest && assets.length === 0) {
    return undefined;
  }
  const leads = Number(data.leadCount ?? digest?.leadAssets ?? assets.filter((asset) => readRecord(asset)?.isLead === true).length);
  const confirmed = Number(digest?.confirmedAssets ?? Math.max(0, assets.length - leads));
  const needsBroadScan = Number(digest?.needsBroadScan ?? assets.filter((asset) => readRecord(asset)?.needsBroadScan === true).length);
  const objectives = assets.flatMap((asset) => readArray(readRecord(asset)?.versionAcquisition));
  const needsVersion = Number(
    digest?.needsVersionAcquisition ??
      objectives.filter((objective) => readRecord(objective)?.status === 'needs_version').length,
  );
  const exhausted = Number(
    digest?.versionAcquisitionExhausted ??
      objectives.filter((objective) => readRecord(objective)?.status === 'exhausted').length,
  );
  return `${assets.length} assets: ${confirmed} confirmed, ${leads} ${leads === 1 ? 'lead' : 'leads'}; ${needsBroadScan} need broad scan; ${needsVersion} need version acquisition, ${exhausted} exhausted`;
};

const summarizeComplianceReadiness = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const frameworks = readArray(data.frameworks);
  if (frameworks.length === 0) {
    return undefined;
  }
  const summaries = frameworks.slice(0, 4).map((entry) => {
    const framework = readRecord(entry);
    const label = readString(framework?.label) ?? readString(framework?.key) ?? 'framework';
    const score = Number(framework?.score ?? 0);
    const returned = Number(framework?.returnedControls ?? 0);
    const total = Number(framework?.totalControls ?? 0);
    return `${label}: ${score}% readiness, ${returned}/${total} controls returned`;
  });
  return summaries.join('; ');
};

const summarizeComplianceEvidence = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const evidence = readArray(data.evidence);
  if (evidence.length === 0) {
    return '0 compliance evidence items';
  }
  const statuses = evidence.reduce<Record<string, number>>((acc, entry) => {
    const status = readString(readRecord(entry)?.status) ?? 'unknown';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  return `${evidence.length} compliance evidence items; statuses: ${Object.entries(statuses)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')}`;
};

const summarizeComplianceMissingEvidence = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const missing = readArray(data.missing);
  if (missing.length === 0) {
    return '0 missing compliance evidence controls';
  }
  const frameworks = Array.from(
    new Set(missing.map((entry) => readString(readRecord(entry)?.frameworkLabel) ?? readString(readRecord(entry)?.frameworkKey)).filter(Boolean)),
  );
  return `${missing.length} missing compliance evidence controls${frameworks.length ? ` across ${frameworks.slice(0, 4).join(', ')}` : ''}`;
};

const summarizeComplianceProofPackage = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const control = readRecord(data.control);
  const framework = readRecord(data.framework);
  const checks = readArray(data.checks);
  const controlId = readString(control?.id) ?? 'control';
  const frameworkLabel = readString(framework?.label) ?? readString(framework?.key) ?? 'framework';
  const verdict = readString(control?.verdict) ?? 'unknown';
  const outcome = readString(control?.outcome) ?? 'unknown';
  const artifactCount = checks.reduce<number>((total, entry) => total + readArray(readRecord(entry)?.artifacts).length, 0);
  const evidenceCount = checks.reduce<number>((total, entry) => total + readArray(readRecord(entry)?.userEvidence).length, 0);
  return `${frameworkLabel} ${controlId}: verdict=${verdict}, outcome=${outcome}, checks=${checks.length}, artifacts=${artifactCount}, userEvidence=${evidenceCount}`;
};

const summarizeFileRead = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const path = readString(data.path);
  const totalLines = Number(data.totalLines ?? 0);
  const startLine = Number(data.startLine ?? 0);
  const endLine = Number(data.endLine ?? 0);
  if (!path && !totalLines) {
    return undefined;
  }
  const range = startLine > 0 && endLine > 0 ? ` lines ${startLine}-${endLine}` : '';
  const total = totalLines > 0 ? ` of ${totalLines}` : '';
  return `${path ?? 'file'}${range}${total}`;
};

const summarizeShellJob = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const jobId = readString(data.jobId);
  const status = readString(data.status);
  const outcome = readString(data.outcome);
  const nextAction = readString(data.nextAction);
  const stdoutPath = readString(data.stdoutPath);
  const stderrPath = readString(data.stderrPath);
  const command = readString(data.command);
  if (!jobId && !status && !stdoutPath && !stderrPath) {
    return undefined;
  }

  const parts = [
    jobId ? `jobId=${jobId}` : undefined,
    status ? `status=${status}` : undefined,
    outcome ? `outcome=${outcome}` : undefined,
    nextAction ? `nextAction=${nextAction}` : undefined,
    stdoutPath ? `stdoutPath=${stdoutPath}` : undefined,
    stderrPath ? `stderrPath=${stderrPath}` : undefined,
    command ? `command=${compactText(command.replace(/\s+/g, ' '), 360)}` : undefined,
  ].filter(Boolean);
  return parts.join('; ');
};

const summarizeHttpResult = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const method = readString(data.method);
  const url = readString(data.url);
  const statusCode = data.status_code;
  const bodySize = Number(data.body_size ?? 0);
  const historyEntryId = readString(data.history_entry_id);
  const rawExchangeId = readString(data.raw_exchange_id);
  const artifacts = readRecord(data.artifacts);
  const rawManifestPath = readString(artifacts?.manifest_path);
  const artifactPath = firstArtifactPath(payload);
  if (!url && !statusCode && !historyEntryId && !rawExchangeId) {
    return undefined;
  }
  return [
    method ? `method=${method}` : undefined,
    url ? `url=${compactText(url, 260)}` : undefined,
    statusCode !== undefined ? `status=${String(statusCode)}` : undefined,
    bodySize > 0 ? `bodySize=${bodySize}` : undefined,
    historyEntryId ? `historyEntryId=${historyEntryId}` : undefined,
    rawExchangeId ? `rawExchangeId=${rawExchangeId}` : undefined,
    rawManifestPath ? `manifest=${rawManifestPath}` : undefined,
    artifactPath ? `artifact=${artifactPath}` : undefined,
  ].filter(Boolean).join('; ');
};

const summarizeBrowserAction = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const action = readString(data.action);
  const url = readString(data.url);
  const title = readString(data.title);
  const sourceOriginalChars = Number(data.source_original_chars ?? 0);
  const artifactPath = firstArtifactPath(payload);
  if (!action && !url && !title && !artifactPath) {
    return undefined;
  }
  return [
    action ? `action=${action}` : undefined,
    url ? `url=${compactText(url, 260)}` : undefined,
    title ? `title=${compactText(title, 160)}` : undefined,
    sourceOriginalChars > 0 ? `sourceChars=${sourceOriginalChars}` : undefined,
    artifactPath ? `artifact=${artifactPath}` : undefined,
  ].filter(Boolean).join('; ');
};

const summarizePythonSession = (payload: Record<string, unknown>): string | undefined => {
  const data = readRecord(payload.data) ?? payload;
  const action = readString(data.action);
  const error = readString(data.error);
  const result = readString(data.result_repr);
  const exchangeId = readString(data.new_exchange_id) ?? readString(data.raw_exchange_id) ?? readString(data.exchange_id);
  const artifactPath = firstArtifactPath(payload);
  const definedNames = readArray(data.defined_names).filter((entry): entry is string => typeof entry === 'string');
  if (!action && !error && !result && !exchangeId && !artifactPath && definedNames.length === 0) {
    return undefined;
  }
  return [
    action ? `action=${action}` : undefined,
    error ? `error=${compactText(error, 220)}` : undefined,
    result ? `result=${compactText(result, 220)}` : undefined,
    exchangeId ? `exchangeId=${exchangeId}` : undefined,
    definedNames.length > 0 ? `defined=${definedNames.slice(0, 8).join(',')}` : undefined,
    artifactPath ? `artifact=${artifactPath}` : undefined,
  ].filter(Boolean).join('; ');
};

const summarizeGenericJson = (payload: Record<string, unknown>): string | undefined => {
  const status = readString(payload.status);
  const summary = readString(payload.summary);
  if (summary) {
    return summary;
  }
  if (status) {
    return `status=${status}`;
  }
  const data = readRecord(payload.data);
  if (data) {
    const keys = Object.keys(data).slice(0, 8);
    return keys.length > 0 ? `json result keys: ${keys.join(', ')}` : undefined;
  }
  return undefined;
};

export const summarizeToolResult = (toolName: string, content: string): { summary: string; artifactPath?: string } => {
  const payload = parseJsonObject(content);
  const artifactPath = firstArtifactPath(payload);
  const summary =
    (toolName === 'query_inventory' && payload ? summarizeInventory(payload) : undefined) ??
    (toolName === 'query_compliance_readiness' && payload ? summarizeComplianceReadiness(payload) : undefined) ??
    (toolName === 'query_compliance_evidence' && payload ? summarizeComplianceEvidence(payload) : undefined) ??
    (toolName === 'query_compliance_proof_package' && payload ? summarizeComplianceProofPackage(payload) : undefined) ??
    (toolName === 'query_compliance_missing_evidence' && payload ? summarizeComplianceMissingEvidence(payload) : undefined) ??
    (toolName === 'file_read' && payload ? summarizeFileRead(payload) : undefined) ??
    ((toolName === 'shell_run' || toolName === 'wait_for_shell_job') && payload ? summarizeShellJob(payload) : undefined) ??
    ((toolName === 'http_payload' || toolName === 'http_view' || toolName === 'http_raw_send') && payload ? summarizeHttpResult(payload) : undefined) ??
    (toolName === 'browser_action' && payload ? summarizeBrowserAction(payload) : undefined) ??
    (toolName === 'python_session' && payload ? summarizePythonSession(payload) : undefined) ??
    (payload ? summarizeGenericJson(payload) : undefined) ??
    compactText(content.replace(/\s+/g, ' ').trim());

  return {
    summary: summary || `${toolName} result compacted`,
    ...(artifactPath ? { artifactPath } : {}),
  };
};

export const isAlreadyCompacted = (content: string): boolean => {
  if (content.includes('<persisted-output')) {
    return true;
  }
  const payload = parseJsonObject(content);
  return (
    payload?.status === 'tool_result_compacted' ||
    payload?.status === 'tool_result_persisted' ||
    payload?.status === 'output_too_large' ||
    payload?.status === 'file_unchanged'
  );
};

const buildToolNameByCallId = (messages: Message[]): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of getToolCalls(message)) {
      const callId = readString(call.id);
      const toolName = readString(call.function?.name);
      if (callId && toolName) {
        toolNameByCallId.set(callId, toolName);
      }
    }
  }
  return toolNameByCallId;
};

const resolveToolName = (message: Message, toolNameByCallId: Map<string, string>): string | undefined => {
  const direct = readString(message.toolName);
  if (direct) {
    return direct;
  }
  const toolCallId = getToolCallId(message);
  if (!toolCallId) {
    return undefined;
  }
  return toolNameByCallId.get(toolCallId);
};

export function microcompactToolResults(
  messages: Message[],
  options: ToolResultMicrocompactionOptions = {},
): { messages: Message[]; stats: ToolResultMicrocompactionStats } {
  const keepLastToolResults = options.keepLastToolResults ?? DEFAULT_KEEP_LAST_TOOL_RESULTS;
  const maxResultTokens = options.maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const windowTokens =
    options.aggregateToolResultBudgetTokens ?? DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET_TOKENS;
  const targetTokens =
    options.aggregateToolResultTargetTokens ?? DEFAULT_AGGREGATE_TOOL_RESULT_TARGET_TOKENS;

  const toolNameByCallId = buildToolNameByCallId(messages);
  const slots: ToolResultSlot[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const toolName = resolveToolName(message, toolNameByCallId);
    slots.push({
      index,
      toolName,
      contentChars: content.length,
      tokens: estimateTokens(message),
      alreadyReduced: content.length === 0 || isAlreadyCompacted(content),
      reducible: typeof message.content === 'string' && isCompactableToolName(toolName),
    });
  }

  // One owner decides; this function only reads and writes the Message shape.
  const decision = planToolResultReduction(slots, {
    windowTokens,
    targetTokens,
    keepLastToolResults,
    maxResultTokens,
    maxResultChars,
    ...(options.forceReduction === true ? { forceReduction: true } : {}),
    ...(options.economics ? { economics: options.economics } : {}),
  });

  const stats: ToolResultMicrocompactionStats = {
    compactedResults: 0,
    candidateResults: decision.eligibleCandidates,
    keptRecentResults: decision.protectedRecentResults,
    beforeTokens: 0,
    afterTokens: 0,
    savedTokens: 0,
    compactedTools: {},
    aggregateBudgetEnforcements: decision.changed ? 1 : 0,
    aggregateBudgetOverageTokensBefore: Math.max(
      0,
      decision.toolResultTokensBefore - windowTokens,
    ),
    aggregateBudgetOverageTokensAfter: Math.max(
      0,
      decision.projectedToolResultTokens - windowTokens,
    ),
    decision,
  };

  const nextMessages = messages.map((message, index): Message => {
    const beforeTokens = estimateTokens(message);
    stats.beforeTokens += beforeTokens;

    if (!decision.reduceIndices.has(index) || typeof message.content !== 'string') {
      stats.afterTokens += beforeTokens;
      return message;
    }

    const toolName = resolveToolName(message, toolNameByCallId);
    if (!isCompactableToolName(toolName)) {
      stats.afterTokens += beforeTokens;
      return message;
    }

    const { summary, artifactPath } = summarizeToolResult(toolName, message.content);
    const compactedContent = safeStringify({
      status: 'tool_result_compacted',
      tool: toolName,
      summary,
      ...(artifactPath ? { artifactPath } : {}),
      reason: 'older large tool result compacted before prompt build',
      originalApproxTokens: beforeTokens,
    });
    const compactedMessage: Message = {
      ...message,
      content: compactedContent,
      metadata: {
        ...(message.metadata ?? {}),
        microcompacted: true,
        originalApproxTokens: beforeTokens,
      },
    };
    const afterTokens = estimateTokens(compactedMessage);
    stats.afterTokens += afterTokens;
    stats.compactedResults += 1;
    stats.savedTokens += Math.max(0, beforeTokens - afterTokens);
    stats.compactedTools[toolName] = (stats.compactedTools[toolName] ?? 0) + 1;
    return compactedMessage;
  });

  return { messages: nextMessages, stats };
}
