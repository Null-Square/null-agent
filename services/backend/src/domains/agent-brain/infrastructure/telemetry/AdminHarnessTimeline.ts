import type { TimelineEvent } from './TimelineService';

export type AdminHarnessCategory =
  | 'lifecycle'
  | 'model_context'
  | 'tool_action'
  | 'harness_gate'
  | 'workspace_projection'
  | 'skill_worker'
  | 'scanner_sandbox_storage'
  | 'securityops_outcome'
  | 'recovery_repair'
  | 'noise';

export type AdminHarnessOutcome =
  | 'success'
  | 'blocked'
  | 'warning'
  | 'retry'
  | 'repair'
  | 'failed'
  | 'info'
  | 'noise';

export interface AdminHarnessArtifactLink {
  label: string;
  kind: 'payload' | 'stdout' | 'stderr' | 'prompt' | 'tool_result' | 'scanner_artifact' | 'trace_bundle' | 'other';
  href: string;
  sizeBytes?: number;
  redacted: boolean;
}

export interface AdminHarnessSessionLink {
  label: string;
  sessionId: string;
  role?: 'parent' | 'phase' | 'worker' | 'child' | 'related';
  runId?: string;
  phaseId?: string;
  workerTaskId?: string;
}

export interface AdminHarnessTimelineEvent {
  id: string;
  ts: string;
  turn?: number;
  event: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  category: AdminHarnessCategory;
  subcategory?: string;
  color: string;
  icon: string;
  title: string;
  why?: string;
  subject?: string;
  outcome: AdminHarnessOutcome;
  nextAction?: string;
  payloadPreview?: Record<string, unknown>;
  sessionLinks: AdminHarnessSessionLink[];
  artifactLinks: AdminHarnessArtifactLink[];
  flags: {
    isGate: boolean;
    isRetry: boolean;
    isRepair: boolean;
    isCost: boolean;
    isSecurityOutcome: boolean;
    isNoise: boolean;
  };
  rawEvent?: TimelineEvent;
}

export interface AdminHarnessUsageBucket {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  chargedCostUsd?: number;
}

export interface AdminHarnessUsageTurnBucket extends AdminHarnessUsageBucket {
  turn: number;
}

export interface AdminHarnessUsageRoleBucket extends AdminHarnessUsageBucket {
  role: string;
}

export interface AdminHarnessUsageWorkerBucket extends AdminHarnessUsageBucket {
  sessionId: string;
  workerTaskId?: string;
  phaseId?: string;
}

export interface AdminHarnessUsageStats extends AdminHarnessUsageBucket {
  cachedTokenPercent: number;
  modelCallCount: number;
  byTurn: AdminHarnessUsageTurnBucket[];
  byRole: AdminHarnessUsageRoleBucket[];
  byWorker: AdminHarnessUsageWorkerBucket[];
}

export interface AdminHarnessTimelineStats {
  total: number;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
  errors: number;
  gates: number;
  retries: number;
  repairs: number;
  modelCalls: number;
  toolCalls: number;
  scannerBlocks: number;
  projectionFailures: number;
  artifactLinks: number;
  usage: AdminHarnessUsageStats;
}

export interface AdminHarnessTimelineResponse {
  sessionId: string;
  source: 's3' | 'local' | 'db_fallback' | 'mixed';
  events: AdminHarnessTimelineEvent[];
  stats: AdminHarnessTimelineStats;
  pagination: {
    pageBy: 'turn' | 'event';
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

const CATEGORY_META: Record<AdminHarnessCategory, { color: string; icon: string }> = {
  lifecycle: { color: 'blue', icon: 'activity' },
  model_context: { color: 'purple', icon: 'cpu' },
  tool_action: { color: 'green', icon: 'wrench' },
  harness_gate: { color: 'amber', icon: 'shield-alert' },
  workspace_projection: { color: 'cyan', icon: 'folder-sync' },
  skill_worker: { color: 'indigo', icon: 'network' },
  scanner_sandbox_storage: { color: 'orange', icon: 'terminal' },
  securityops_outcome: { color: 'emerald', icon: 'shield-check' },
  recovery_repair: { color: 'amber', icon: 'refresh-cw' },
  noise: { color: 'gray', icon: 'file-text' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const sumNumber = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
};

const normalizeSeverity = (value: unknown): AdminHarnessTimelineEvent['severity'] => {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'debug' || raw === 'trace') return 'debug';
  if (raw === 'critical' || raw === 'fatal') return 'critical';
  if (raw === 'error') return 'error';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  return 'info';
};

const startCase = (value: string): string =>
  value
    .replace(/[._-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\b\w/gu, (char) => char.toUpperCase());

const readPayload = (event: TimelineEvent): Record<string, unknown> =>
  isRecord(event.payload) ? event.payload : {};

const pick = (payload: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== '') {
      output[key] = value;
    }
  }
  return output;
};

const firstString = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return undefined;
};

const includesAny = (value: string, needles: string[]): boolean =>
  needles.some((needle) => value.includes(needle));

const extractHref = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value;
};

const kindFromLabel = (label: string): AdminHarnessArtifactLink['kind'] => {
  const lower = label.toLowerCase();
  if (lower.includes('stdout')) return 'stdout';
  if (lower.includes('stderr')) return 'stderr';
  if (lower.includes('prompt') || lower.includes('message')) return 'prompt';
  if (lower.includes('tool')) return 'tool_result';
  if (lower.includes('scanner') || lower.includes('artifact')) return 'scanner_artifact';
  if (lower.includes('trace')) return 'trace_bundle';
  if (lower.includes('payload')) return 'payload';
  return 'other';
};

export const extractArtifactLinks = (event: TimelineEvent): AdminHarnessArtifactLink[] => {
  const links: AdminHarnessArtifactLink[] = [];
  const rawLinks = isRecord(event.links) ? event.links : {};
  for (const [label, hrefValue] of Object.entries(rawLinks)) {
    const href = extractHref(hrefValue);
    if (!href) continue;
    links.push({
      label,
      href,
      kind: kindFromLabel(label),
      redacted: true,
    });
  }

  const payload = readPayload(event);
  for (const key of ['artifact', 'artifactPath', 'stdoutPath', 'stderrPath', 'statusPath', 'outputPath', 'digestPath']) {
    const href = extractHref(payload[key]);
    if (!href || links.some((link) => link.href === href)) continue;
    links.push({
      label: key,
      href,
      kind: kindFromLabel(key),
      sizeBytes: asNumber(payload.sizeBytes),
      redacted: true,
    });
  }

  const scannerArtifacts = payload.scannerArtifacts;
  if (Array.isArray(scannerArtifacts)) {
    scannerArtifacts.forEach((item, index) => {
      if (!isRecord(item)) return;
      const href = extractHref(item.visiblePath) ?? extractHref(item.artifactPath);
      if (!href || links.some((link) => link.href === href)) return;
      links.push({
        label: asString(item.artifactPath) ?? `scanner artifact ${index + 1}`,
        href,
        kind: 'scanner_artifact',
        sizeBytes: asNumber(item.sizeBytes),
        redacted: true,
      });
    });
  }

  return links;
};

export const extractSessionLinks = (event: TimelineEvent): AdminHarnessSessionLink[] => {
  const links = new Map<string, AdminHarnessSessionLink>();
  const payload = readPayload(event);

  const add = (label: string, sessionId: unknown, role?: AdminHarnessSessionLink['role']) => {
    const id = asString(sessionId);
    if (!id || id === event.sessionId) return;
    links.set(`${role ?? 'related'}:${id}`, {
      label,
      sessionId: id,
      role,
      runId: event.runId,
      phaseId: event.phaseId,
      workerTaskId: event.workerTaskId,
    });
  };

  add('Parent session', payload.parentSessionId, 'parent');
  add('Parent session', payload.parentId, 'parent');
  add('Worker session', payload.workerSessionId, 'worker');
  add('Worker session', payload.childSessionId, 'worker');
  add('Related session', payload.sessionId, 'related');

  const workers = payload.workers ?? payload.workerSessions ?? payload.childSessions;
  if (Array.isArray(workers)) {
    workers.forEach((worker, index) => {
      if (typeof worker === 'string') {
        add(`Worker ${index + 1}`, worker, 'worker');
      } else if (isRecord(worker)) {
        add(asString(worker.label) ?? asString(worker.workerType) ?? `Worker ${index + 1}`, worker.sessionId ?? worker.id, 'worker');
      }
    });
  }

  return Array.from(links.values());
};

type ClassificationSeed = {
  category: AdminHarnessCategory;
  subcategory?: string;
  title: string;
  why?: string;
  subject?: string;
  outcome?: AdminHarnessOutcome;
  nextAction?: string;
  payloadPreview?: Record<string, unknown>;
};

const classifySeed = (event: TimelineEvent): ClassificationSeed => {
  const name = event.event || 'event';
  const lower = name.toLowerCase();
  const payload = readPayload(event);
  const severity = normalizeSeverity(event.severity);
  const status = firstString(payload, ['status', 'outcome', 'result', 'state'])?.toLowerCase();
  const errorText = firstString(payload, ['errorMessage', 'message', 'error', 'reason', 'outcomeReason']);
  const lowerErrorText = errorText?.toLowerCase() ?? '';

  if (lower === 'usage.recorded') {
    return {
      category: 'model_context',
      subcategory: 'usage',
      title: 'Usage recorded',
      why: event.note,
      subject: firstString(payload, ['model']),
      outcome: 'info',
      payloadPreview: pick(payload, [
        'model',
        'promptTokens',
        'cachedPromptTokens',
        'completionTokens',
        'totalTokens',
        'platformPrice',
        'credits',
        'currency',
      ]),
    };
  }

  if (lower.startsWith('model.call')) {
    const failed = lower.endsWith('.error') || severity === 'error' || severity === 'critical';
    return {
      category: 'model_context',
      subcategory: 'model_call',
      title: failed ? 'Model call failed' : lower.endsWith('.finish') ? 'Model call finished' : 'Model call started',
      why: failed ? errorText : firstString(payload, ['finishReason', 'reason']),
      subject: firstString(payload, ['model', 'provider']),
      outcome: failed ? 'failed' : lower.endsWith('.finish') ? 'success' : 'info',
      payloadPreview: pick(payload, [
        'provider',
        'model',
        'latencyMs',
        'finishReason',
        'toolCalls',
        'toolNames',
        'messageCount',
        'toolCount',
        'estimatedTokens',
        'tokens',
      ]),
    };
  }

  if (lower.startsWith('context.') || lower === 'history.trim' || lower === 'tool_result_compacted' || lower === 'llm.messages' || lower === 'system.prompt.full') {
    const isNoise = lower === 'llm.messages' || lower === 'system.prompt.full';
    return {
      category: isNoise ? 'noise' : 'model_context',
      subcategory: 'context',
      title: startCase(name),
      why: firstString(payload, ['reason', 'summary', 'message']) ?? event.note,
      outcome: isNoise ? 'noise' : includesAny(lower, ['repair', 'compacted', 'trim']) ? 'repair' : 'info',
      payloadPreview: pick(payload, [
        'reason',
        'summary',
        'beforeTokens',
        'afterTokens',
        'estimatedTokens',
        'tokens',
        'microcompactionSavedTokens',
      ]),
    };
  }

  if (lower === 'submit_plan.gate_blocked') {
    return {
      category: 'harness_gate',
      subcategory: 'submit_plan',
      title: 'Plan rejected by harness gate',
      why: firstString(payload, ['reason', 'gateCode', 'message']),
      subject: firstString(payload, ['taskId', 'skillSlug', 'phaseKey']),
      outcome: 'blocked',
      nextAction: firstString(payload, ['correctionHint', 'nextAction']),
      payloadPreview: pick(payload, ['gateCode', 'taskId', 'phaseKey', 'skillSlug', 'reason', 'correctionHint']),
    };
  }

  if (lower.includes('gate_blocked') || lower === 'session.work_blocked' || lower === 'tool.permission_decision' || lower === 'tool.hook_blocked' || lower === 'tool.forbidden') {
    return {
      category: 'harness_gate',
      subcategory: lower.startsWith('tool.') ? 'tool_policy' : 'runtime_gate',
      title: lower === 'session.work_blocked' ? 'Session work blocked' : startCase(name),
      why: firstString(payload, ['reason', 'outcomeReason', 'message', 'blockedReason']) ?? event.note,
      subject: firstString(payload, ['toolName', 'tool', 'phaseKey', 'boundary', 'action', 'host', 'path']),
      outcome: 'blocked',
      nextAction: firstString(payload, ['nextAction', 'correctionHint']),
      payloadPreview: pick(payload, [
        'gateCode',
        'boundary',
        'reason',
        'status',
        'resumeAllowed',
        'toolName',
        'source',
        'action',
        'paths',
        'hosts',
        'phaseKey',
      ]),
    };
  }

  if (lower.startsWith('workspace_projection.') || lower === 'workspace.run_scoped_assigned' || lower === 'file_read.raw_artifact_digest_hint') {
    const failed = lower.endsWith('.failed') || lower.includes('refresh_failed') || severity === 'error';
    return {
      category: 'workspace_projection',
      subcategory: 'projection',
      title: failed ? 'Workspace projection failed' : startCase(name),
      why: firstString(payload, ['reason', 'errorMessage', 'message']) ?? event.note,
      subject: firstString(payload, ['path', 'targetPath', 'phaseKey', 'artifactPath', 'digestPath']),
      outcome: failed ? 'failed' : severity === 'warn' ? 'warning' : 'success',
      nextAction: failed ? firstString(payload, ['nextAction']) ?? 'Inspect workspace storage and projection warnings.' : undefined,
      payloadPreview: pick(payload, [
        'reason',
        'scopes',
        'phaseKey',
        'written',
        'warnings',
        'errorCode',
        'errorMessage',
        'dirty',
        'dirtyKeys',
        'artifactPath',
        'digestPath',
      ]),
    };
  }

  if (
    lowerErrorText.includes('no space left on device') ||
    lowerErrorText.includes('enospc') ||
    lowerErrorText.includes('workspace storage') ||
    lowerErrorText.includes('quota_exceeded')
  ) {
    return {
      category: 'scanner_sandbox_storage',
      subcategory: 'storage',
      title: 'Workspace storage pressure',
      why: errorText,
      subject: firstString(payload, ['toolName', 'name', 'tool', 'path', 'artifactPath', 'outputPath']),
      outcome: 'failed',
      nextAction: 'Inspect workspace storage, cleanup, and scanner output volume.',
      payloadPreview: pick(payload, [
        'toolName',
        'name',
        'tool',
        'outcome',
        'outcomeReason',
        'errorMessage',
        'message',
        'path',
        'artifactPath',
        'outputPath',
      ]),
    };
  }

  if (lower.startsWith('assigned_skills.') || lower.startsWith('skill.') || lower.startsWith('worker.') || lower.startsWith('delegation.')) {
    return {
      category: 'skill_worker',
      subcategory: lower.startsWith('worker.') ? 'worker' : lower.startsWith('delegation.') ? 'delegation' : 'skill',
      title: startCase(name),
      why: firstString(payload, ['reason', 'source', 'summary']) ?? event.note,
      subject: firstString(payload, ['skillSlug', 'slug', 'workerTaskId', 'workerType', 'taskId', 'phaseKey']),
      outcome: severity === 'warn' ? 'warning' : severity === 'error' ? 'failed' : 'info',
      payloadPreview: pick(payload, [
        'skillSlug',
        'slug',
        'source',
        'rank',
        'reason',
        'phaseKey',
        'workerTaskId',
        'workerType',
        'taskId',
        'assignedSkills',
      ]),
    };
  }

  if (lower.startsWith('scanner.') || lower.startsWith('shell_job.') || lower.startsWith('sandbox.') || lower === 'docker.log') {
    const blocked = lower.includes('blocked') || lower.includes('budget_exceeded') || status === 'blocked';
    const failed = lower.includes('failed') || status === 'failed' || severity === 'error';
    const noise = lower === 'docker.log';
    return {
      category: noise ? 'noise' : 'scanner_sandbox_storage',
      subcategory: lower.startsWith('sandbox.') ? 'sandbox' : lower.startsWith('scanner.') ? 'scanner' : 'shell_job',
      title: startCase(name),
      why: firstString(payload, ['reason', 'outcomeReason', 'message', 'errorMessage']) ?? event.note,
      subject: firstString(payload, ['scannerFamily', 'tool', 'command', 'artifactPath', 'requestedProfile', 'profileKey', 'containerId', 'image']),
      outcome: noise ? 'noise' : failed ? 'failed' : blocked ? 'blocked' : severity === 'warn' ? 'warning' : 'success',
      nextAction: firstString(payload, ['recommendedNextAction', 'nextAction', 'missingHint']),
      payloadPreview: pick(payload, [
        'scannerFamily',
        'command',
        'budgetExceeded',
        'elapsedMs',
        'artifactPath',
        'outputPath',
        'exitCode',
        'success',
        'status',
        'requestedProfile',
        'resolvedProfile',
        'reason',
        'profileKey',
        'containerId',
        'image',
        'storagePreflight',
      ]),
    };
  }

  if (lower === 'tool.stdout' || lower === 'tool.stderr' || lower.includes('stdout') || lower.includes('stderr')) {
    return {
      category: 'noise',
      subcategory: 'stream',
      title: startCase(name),
      why: event.note,
      subject: firstString(payload, ['toolName', 'jobId', 'path']),
      outcome: 'noise',
      payloadPreview: pick(payload, ['bytes', 'truncated', 'path', 'jobId']),
    };
  }

  if (lower.startsWith('tool.') || lower === 'action.summary') {
    const blocked = status === 'blocked' || lower.includes('forbidden') || lower.includes('abort');
    const failed = status === 'error' || status === 'failed' || status === 'failure' || severity === 'error';
    return {
      category: 'tool_action',
      subcategory: 'tool',
      title: lower === 'action.summary' ? firstString(payload, ['action', 'title']) ?? 'Action summary' : startCase(name),
      why: firstString(payload, ['outcomeReason', 'reason', 'summary', 'message']) ?? event.note,
      subject: firstString(payload, ['toolName', 'name', 'tool', 'action', 'artifactPath']),
      outcome: failed ? 'failed' : blocked ? 'blocked' : lower.endsWith('.start') ? 'info' : 'success',
      payloadPreview: pick(payload, [
        'toolName',
        'name',
        'action',
        'outcome',
        'status',
        'durationMs',
        'success',
        'summary',
        'artifactPath',
        'args',
      ]),
    };
  }

  if (lower === 'discovery' || lower === 'memory.update' || lower.startsWith('validation.') || lower.startsWith('report.') || lower.startsWith('report_finding.')) {
    return {
      category: 'securityops_outcome',
      subcategory: lower.startsWith('validation.') ? 'validation' : lower.startsWith('report') ? 'report' : 'inventory',
      title: startCase(name),
      why: firstString(payload, ['summary', 'reason', 'blockerCode', 'outcome']) ?? event.note,
      subject: firstString(payload, ['findingId', 'leadId', 'ntype', 'host', 'endpoint', 'path']),
      outcome: severity === 'error' ? 'failed' : severity === 'warn' ? 'warning' : 'success',
      payloadPreview: pick(payload, [
        'category',
        'ntype',
        'host',
        'endpoint',
        'findingId',
        'leadId',
        'blockerCode',
        'outcome',
        'confidence',
        'reportPath',
      ]),
    };
  }

  if (
    lower.startsWith('assistant.') ||
    lower.startsWith('input.') ||
    lower.startsWith('automated.guard.') ||
    lower === 'turn.error.retry_scheduled' ||
    lower.includes('retry') ||
    lower.includes('repair')
  ) {
    const isRetry = lower.includes('retry') || lower.includes('guard');
    return {
      category: 'recovery_repair',
      subcategory: isRetry ? 'retry' : 'repair',
      title: startCase(name),
      why: firstString(payload, ['reason', 'message', 'guard', 'summary']) ?? event.note,
      subject: firstString(payload, ['guard', 'toolName', 'boundary']),
      outcome: isRetry ? 'retry' : 'repair',
      nextAction: firstString(payload, ['nextAction']),
      payloadPreview: pick(payload, ['reason', 'guard', 'attempt', 'nextAttemptAt', 'message', 'boundary']),
    };
  }

  if (lower.startsWith('session.') || lower.startsWith('turn.') || lower.startsWith('approval.') || lower.startsWith('abort') || lower === 'run.event' || lower === 'mode.switch' || lower === 'cache.resume') {
    const failed = severity === 'error' || includesAny(lower, ['failed', 'credits_exhausted']);
    const blocked = includesAny(lower, ['blocked', 'paused']);
    return {
      category: 'lifecycle',
      subcategory: 'state',
      title: startCase(name),
      why: firstString(payload, ['reason', 'message', 'status', 'stopReason']) ?? event.note,
      subject: firstString(payload, ['status', 'from', 'to', 'phaseKey', 'workerTaskId']),
      outcome: failed ? 'failed' : blocked ? 'blocked' : severity === 'warn' ? 'warning' : 'info',
      nextAction: firstString(payload, ['nextAction']),
      payloadPreview: pick(payload, ['from', 'to', 'status', 'reason', 'source', 'stopReason', 'nextAction', 'phaseKey', 'workerTaskId']),
    };
  }

  return {
    category: severity === 'error' || severity === 'critical' ? 'lifecycle' : 'noise',
    subcategory: 'unknown',
    title: startCase(name || 'event'),
    why: errorText ?? event.note,
    subject: firstString(payload, ['name', 'toolName', 'phaseKey', 'path']),
    outcome: severity === 'error' || severity === 'critical' ? 'failed' : 'noise',
    payloadPreview: pick(payload, ['name', 'toolName', 'status', 'reason', 'message', 'summary']),
  };
};

export const classifyTraceEvent = (
  event: TimelineEvent,
  options: { includeRawEvent?: boolean } = {},
): AdminHarnessTimelineEvent => {
  const seed = classifySeed(event);
  const categoryMeta = CATEGORY_META[seed.category];
  const severity = normalizeSeverity(event.severity);
  const outcome = seed.outcome ?? (severity === 'error' || severity === 'critical' ? 'failed' : severity === 'warn' ? 'warning' : 'info');
  const classified: AdminHarnessTimelineEvent = {
    id: event.id || `${event.sessionId}-${event.turn}-${event.event}-${event.ts}`,
    ts: event.ts,
    turn: event.turn,
    event: event.event || 'event',
    severity,
    category: seed.category,
    subcategory: seed.subcategory,
    color: categoryMeta.color,
    icon: categoryMeta.icon,
    title: seed.title,
    why: seed.why,
    subject: seed.subject,
    outcome,
    nextAction: seed.nextAction,
    payloadPreview: seed.payloadPreview,
    sessionLinks: extractSessionLinks(event),
    artifactLinks: extractArtifactLinks(event),
    flags: {
      isGate: seed.category === 'harness_gate',
      isRetry: outcome === 'retry',
      isRepair: outcome === 'repair',
      isCost: event.event === 'usage.recorded',
      isSecurityOutcome: seed.category === 'securityops_outcome',
      isNoise: seed.category === 'noise' || outcome === 'noise',
    },
  };

  if (options.includeRawEvent) {
    classified.rawEvent = event;
  }

  return classified;
};

const emptyUsage = (): AdminHarnessUsageBucket => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  chargedCostUsd: 0,
});

const addUsage = (target: AdminHarnessUsageBucket, source: AdminHarnessUsageBucket): void => {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.cachedTokens += source.cachedTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCostUsd = sumNumber(target.estimatedCostUsd, source.estimatedCostUsd);
  target.chargedCostUsd = sumNumber(target.chargedCostUsd, source.chargedCostUsd);
};

const usageFromEvent = (
  event: TimelineEvent,
  options: { useModelCallFallback?: boolean } = {},
): AdminHarnessUsageBucket | null => {
  if (event.event === 'usage.recorded') {
    const payload = readPayload(event);
    // D7 - `promptTokens` meant total input in this event and uncached input in the summary
    // of the same name, which is how this timeline came to print a 1,117% cache rate for run
    // r1. Prefer the explicit fields; fall back to the ambiguous one only for older events,
    // and reconstruct the total there rather than assuming which meaning was written.
    const cachedTokens = asNumber(payload.cacheReadTokens)
      ?? asNumber(payload.cachedPromptTokens)
      ?? asNumber(payload.cachedTokens)
      ?? 0;
    const uncachedTokens = asNumber(payload.uncachedInputTokens);
    const legacyPromptTokens = asNumber(payload.promptTokens) ?? 0;
    const inputTokensTotal = asNumber(payload.inputTokensTotal)
      ?? (uncachedTokens !== undefined
        ? uncachedTokens + cachedTokens
        : Math.max(legacyPromptTokens, cachedTokens));
    return {
      promptTokens: inputTokensTotal,
      completionTokens: asNumber(payload.outputTokens) ?? asNumber(payload.completionTokens) ?? 0,
      cachedTokens,
      totalTokens: asNumber(payload.totalTokens) ?? 0,
      estimatedCostUsd: asNumber(payload.nativeCost) ?? asNumber(payload.cost),
      chargedCostUsd: asNumber(payload.platformPrice) ?? asNumber(payload.platformCost),
    };
  }

  if (!options.useModelCallFallback || event.event !== 'model.call.finish') return null;
  const payload = readPayload(event);
  const tokens = isRecord(payload.tokens) ? payload.tokens : {};
  const promptTokens = asNumber(tokens.input) ?? asNumber(tokens.prompt) ?? 0;
  const completionTokens = asNumber(tokens.output) ?? asNumber(tokens.completion) ?? 0;
  const cachedTokens = asNumber(tokens.cached) ?? asNumber(tokens.cachedPrompt) ?? 0;
  const totalTokens = asNumber(tokens.total) ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && cachedTokens === 0 && totalTokens === 0) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    estimatedCostUsd: undefined,
    chargedCostUsd: undefined,
  };
};

export const computeAdminHarnessStats = (
  allEvents: TimelineEvent[],
  classifiedEvents: AdminHarnessTimelineEvent[],
): AdminHarnessTimelineStats => {
  const stats: AdminHarnessTimelineStats = {
    total: allEvents.length,
    byCategory: {},
    byOutcome: {},
    errors: 0,
    gates: 0,
    retries: 0,
    repairs: 0,
    modelCalls: 0,
    toolCalls: 0,
    scannerBlocks: 0,
    projectionFailures: 0,
    artifactLinks: 0,
    usage: {
      ...emptyUsage(),
      cachedTokenPercent: 0,
      modelCallCount: 0,
      byTurn: [],
      byRole: [],
      byWorker: [],
    },
  };

  for (const event of classifiedEvents) {
    stats.byCategory[event.category] = (stats.byCategory[event.category] ?? 0) + 1;
    stats.byOutcome[event.outcome] = (stats.byOutcome[event.outcome] ?? 0) + 1;
    if (event.severity === 'error' || event.severity === 'critical' || event.outcome === 'failed') stats.errors++;
    if (event.flags.isGate) stats.gates++;
    if (event.flags.isRetry) stats.retries++;
    if (event.flags.isRepair) stats.repairs++;
    if (event.event === 'model.call.finish') stats.modelCalls++;
    if (event.event === 'tool.finish') stats.toolCalls++;
    if (event.category === 'scanner_sandbox_storage' && event.outcome === 'blocked') stats.scannerBlocks++;
    if (event.event.startsWith('workspace_projection.') && event.outcome === 'failed') stats.projectionFailures++;
    stats.artifactLinks += event.artifactLinks.length;
  }

  const byTurn = new Map<number, AdminHarnessUsageTurnBucket>();
  const byRole = new Map<string, AdminHarnessUsageRoleBucket>();
  const byWorker = new Map<string, AdminHarnessUsageWorkerBucket>();

  const hasUsageRecordedEvents = allEvents.some((event) => event.event === 'usage.recorded');

  for (const event of allEvents) {
    const usage = usageFromEvent(event, { useModelCallFallback: !hasUsageRecordedEvents });
    if (!usage) continue;
    stats.usage.modelCallCount++;
    addUsage(stats.usage, usage);

    const turn = Number.isFinite(event.turn) ? event.turn : 0;
    const turnBucket = byTurn.get(turn) ?? { turn, ...emptyUsage() };
    addUsage(turnBucket, usage);
    byTurn.set(turn, turnBucket);

    const role = event.agentRole ?? event.agentType ?? 'unknown';
    const roleBucket = byRole.get(role) ?? { role, ...emptyUsage() };
    addUsage(roleBucket, usage);
    byRole.set(role, roleBucket);

    const isWorkerUsage =
      Boolean(event.workerTaskId) ||
      event.agentRole === 'worker' ||
      event.agentType === 'worker';
    const workerKey = event.workerTaskId ?? event.sessionId;
    if (isWorkerUsage && workerKey) {
      const workerBucket = byWorker.get(workerKey) ?? {
        sessionId: event.sessionId,
        workerTaskId: event.workerTaskId,
        phaseId: event.phaseId,
        ...emptyUsage(),
      };
      addUsage(workerBucket, usage);
      byWorker.set(workerKey, workerBucket);
    }
  }

  // A share of input, so it is bounded by definition. It printed 1,117% for run r1 because
  // the denominator held cache-miss input while the numerator held cache hits.
  stats.usage.cachedTokenPercent = stats.usage.promptTokens > 0
    ? Math.min(100, (stats.usage.cachedTokens / stats.usage.promptTokens) * 100)
    : 0;
  stats.usage.byTurn = Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn);
  stats.usage.byRole = Array.from(byRole.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  stats.usage.byWorker = Array.from(byWorker.values()).sort((a, b) => b.totalTokens - a.totalTokens);

  return stats;
};

export const searchAdminHarnessEvent = (event: AdminHarnessTimelineEvent, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    event.event,
    event.title,
    event.why,
    event.subject,
    event.outcome,
    event.category,
    event.subcategory,
    event.nextAction,
    ...event.sessionLinks.map((link) => `${link.label} ${link.sessionId} ${link.role ?? ''}`),
    ...event.artifactLinks.map((link) => `${link.label} ${link.href} ${link.kind}`),
    event.payloadPreview ? JSON.stringify(event.payloadPreview) : '',
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
};
