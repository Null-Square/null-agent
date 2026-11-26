import type {
  AnyWorkerType,
  LegacyWorkerType,
  SessionState,
  WorkerToolPreflightEntry,
  WorkerTaskStatus,
  WorkerType,
} from '../types';
import { getWorkerProfileRegistry, type WorkerProfile as WorkerTemplate } from './WorkerProfileRegistry';

export type { WorkerTemplate };

export interface ToolBudgetSnapshot {
  maxToolCalls?: number;
  usedToolCalls?: number;
  remainingToolCalls?: number;
  reservedToolCalls?: number;
}

export const LEGACY_WORKER_TYPE_ALIASES: Record<LegacyWorkerType, WorkerType> = {
  exploit_worker: 'validator_worker',
  report_writer_worker: 'evidence_worker',
};

const workerInheritedBlockReasons = new Set([
  'user_paused',
  'credits_exhausted',
  'provider_quota_exhausted',
  'runner_unavailable',
  'system_paused',
  'awaiting_user',
  'awaiting_approval',
  'aborted_by_user',
]);
const workerWriteScopeSafeTools = new Set(['submit_worker_result', 'load_skill']);
const workerWriteScopeUnscopedTools = new Set(['shell_run', 'python_session']);
// Canonical writes whose source artifact can be constrained to a delegated path. These tools
// remain limited to artifact-only scopes and must receive an explicit in-scope path at runtime;
// scoped workers may never rely on tool-side artifact auto-discovery.
const workerWriteScopePathBoundCanonicalTools = new Set(['ingest_scan_artifact']);
// Tools that perform a canonical (DB/store) write with no workspace path target. Under an
// active worker writeScope the runtime cannot constrain these writes to an allowed path and
// forbids them (ToolsRegistry.validateWorkerWriteScope, the descriptor.paths.length === 0
// branch) regardless of whether the scope is artifact-scoped. The preflight must withhold
// them too so advertised tools match what the worker can actually execute (H-2026-05-28-002).
const workerWriteScopeNoPathWriteTools = new Set([
  'oob_token_create',
  'persona_forget',
  'persona_save',
  'report_finding',
  'promote_finding',
  'report_note',
  'report_asset',
  'report_service',
  'submit_validation_outcome',
  'submit_validation_lead_outcome',
  'record_control_check',
  'record_control_request',
  'review_control_request',
  'map_compliance_evidence',
  'annotate_compliance_evidence',
]);
export const WORKER_INHERITED_BLOCK_REASONS = workerInheritedBlockReasons;
export const WORKER_WRITE_SCOPE_SAFE_TOOLS = workerWriteScopeSafeTools;
export const WORKER_WRITE_SCOPE_UNSCOPED_TOOLS = workerWriteScopeUnscopedTools;
export const WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS = workerWriteScopePathBoundCanonicalTools;
export const WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS = workerWriteScopeNoPathWriteTools;
export const ROOT_REPORTING_RESERVE_MIN_TOOL_CALLS = 6;
export const ROOT_REPORTING_RESERVE_RATIO = 0.2;
export const WORKER_ARTIFACT_WRITE_ROOT = '/workspace/.artifacts';

const normalizeWriteScope = (writeScope: string[] | undefined): string[] =>
  Array.isArray(writeScope)
    ? Array.from(
        new Set(
          writeScope
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      )
    : [];

const normalizeWorkspaceScopePath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/u, '');

export const isArtifactScopedWriteScope = (writeScope: string[] | undefined): boolean => {
  const normalizedWriteScope = normalizeWriteScope(writeScope);
  if (normalizedWriteScope.length === 0) {
    return false;
  }

  const artifactRoot = normalizeWorkspaceScopePath(WORKER_ARTIFACT_WRITE_ROOT);
  return normalizedWriteScope.every((scopePath) => {
    const normalized = normalizeWorkspaceScopePath(scopePath);
    return normalized === artifactRoot || normalized.startsWith(`${artifactRoot}/`);
  });
};

const WORKER_FILE_WRITE_SCOPE_REASON =
  'file_write is withheld because this worker was started without an explicit delegated writeScope.';
const WORKER_SHELL_SCOPE_REASON =
  'shell_run/python_session are withheld because this worker writeScope is not limited to /workspace/.artifacts and unconstrained runtime writes cannot be safely constrained there.';
const WORKER_NO_PATH_WRITE_SCOPE_REASON =
  'this tool performs a canonical write with no workspace path, so it cannot be constrained to the active worker writeScope; the runtime forbids it, so it is withheld here to keep advertised tools aligned with executable tools.';
const WORKER_PATH_BOUND_CANONICAL_SCOPE_REASON =
  'this canonical write tool is available to scoped workers only when writeScope is limited to /workspace/.artifacts and the call supplies an explicit in-scope artifact path.';

export const resolveWorkerExecutableTools = (
  advertisedTools: string[],
  writeScope: string[] | undefined,
): { executableTools: string[]; withheldTools: WorkerToolPreflightEntry[] } => {
  const normalizedWriteScope = normalizeWriteScope(writeScope);
  const artifactScopedWriteScope = isArtifactScopedWriteScope(normalizedWriteScope);
  const executableTools: string[] = [];
  const withheldTools: WorkerToolPreflightEntry[] = [];

  for (const tool of Array.from(new Set(advertisedTools))) {
    if (tool === 'file_write' && normalizedWriteScope.length === 0) {
      withheldTools.push({ tool, reason: WORKER_FILE_WRITE_SCOPE_REASON });
      continue;
    }
    if (
      normalizedWriteScope.length > 0 &&
      WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS.has(tool) &&
      !artifactScopedWriteScope
    ) {
      withheldTools.push({ tool, reason: WORKER_PATH_BOUND_CANONICAL_SCOPE_REASON });
      continue;
    }
    // Canonical no-path writes are forbidden by the runtime under ANY active writeScope,
    // so withhold them whenever a writeScope is present, independent of artifact-scoping.
    if (
      normalizedWriteScope.length > 0 &&
      WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS.has(tool)
    ) {
      withheldTools.push({ tool, reason: WORKER_NO_PATH_WRITE_SCOPE_REASON });
      continue;
    }
    if (
      normalizedWriteScope.length > 0 &&
      WORKER_WRITE_SCOPE_UNSCOPED_TOOLS.has(tool) &&
      !artifactScopedWriteScope
    ) {
      withheldTools.push({ tool, reason: WORKER_SHELL_SCOPE_REASON });
      continue;
    }
    executableTools.push(tool);
  }

  return {
    executableTools,
    withheldTools,
  };
};

export const isWorkerSession = (session: Pick<SessionState, 'coordination'> | undefined): boolean =>
  session?.coordination?.role === 'worker';

export const normalizeWorkerType = (
  workerType: AnyWorkerType | string | undefined | null,
): WorkerType | undefined => {
  if (!workerType) {
    return undefined;
  }
  const workerProfileRegistry = getWorkerProfileRegistry();
  if (workerProfileRegistry.list().some((profile) => profile.workerType === workerType)) {
    return workerType as WorkerType;
  }
  if (workerType in LEGACY_WORKER_TYPE_ALIASES) {
    return LEGACY_WORKER_TYPE_ALIASES[workerType as LegacyWorkerType];
  }
  return undefined;
};

export const resolveWorkerMaxToolCalls = (
  session: Pick<SessionState, 'coordination'> | undefined,
  fallback: number,
): number => {
  const candidate = session?.coordination?.role === 'worker'
    ? session.coordination.maxToolCalls
    : undefined;

  if (!Number.isFinite(candidate) || !candidate || candidate <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(candidate));
};

export const resolveWorkerWriteScope = (
  session: Pick<SessionState, 'coordination'> | undefined,
): string[] | undefined => {
  if (session?.coordination?.role !== 'worker' || !Array.isArray(session.coordination.writeScope)) {
    return undefined;
  }

  const normalized = normalizeWriteScope(session.coordination.writeScope);

  return normalized.length > 0 ? normalized : undefined;
};

type ReportRequirementSession = Pick<SessionState, 'agentType' | 'coordination'> & Partial<Pick<SessionState, 'flags'>>;

const getActiveSecurityOpsPhaseKey = (session: Partial<Pick<SessionState, 'flags'>> | undefined): string | null => {
  const securityops = session?.flags?.securityops;
  if (!securityops || typeof securityops !== 'object' || Array.isArray(securityops)) {
    return null;
  }
  const phaseKey = (securityops as Record<string, unknown>).activePhaseKey;
  return typeof phaseKey === 'string' && phaseKey.trim().length > 0
    ? phaseKey.trim().toLowerCase()
    : null;
};

export const shouldRequireReportForSession = (
  session: ReportRequirementSession | undefined,
): boolean => {
  if (!session) {
    return true;
  }
  if (session.agentType === 'planner') {
    return false;
  }
  if (session.coordination?.role === 'worker') {
    return false;
  }
  const activePhaseKey = getActiveSecurityOpsPhaseKey(session);
  if (activePhaseKey) {
    return activePhaseKey === 'reporting';
  }
  return true;
};

export const resolveRootReportingReserveToolCalls = (
  session: Pick<SessionState, 'agentType' | 'coordination'> | undefined,
  maxToolCalls: number,
): number => {
  if (!shouldRequireReportForSession(session) || !Number.isFinite(maxToolCalls) || maxToolCalls <= 1) {
    return 0;
  }

  const normalizedMax = Math.max(1, Math.floor(maxToolCalls));
  const rawReserve = Math.max(
    ROOT_REPORTING_RESERVE_MIN_TOOL_CALLS,
    Math.ceil(normalizedMax * ROOT_REPORTING_RESERVE_RATIO),
  );

  return Math.max(0, Math.min(normalizedMax - 1, rawReserve));
};

export const resolveRemainingToolCalls = (budget: ToolBudgetSnapshot | undefined): number | undefined => {
  if (!budget) {
    return undefined;
  }
  if (Number.isFinite(budget.remainingToolCalls)) {
    return Math.max(0, Math.floor(budget.remainingToolCalls as number));
  }
  if (Number.isFinite(budget.maxToolCalls) && Number.isFinite(budget.usedToolCalls)) {
    return Math.max(0, Math.floor((budget.maxToolCalls as number) - (budget.usedToolCalls as number)));
  }
  return undefined;
};

export const getWorkerSpawnReserveBlockReason = (
  session: Pick<SessionState, 'agentType' | 'coordination'> | undefined,
  budget: ToolBudgetSnapshot | undefined,
  workerType?: AnyWorkerType | string,
): string | undefined => {
  if (
    (!shouldRequireReportForSession(session) && workerType !== 'enumeration_worker') ||
    !budget
  ) {
    return undefined;
  }

  const remaining = resolveRemainingToolCalls(budget);
  const configuredReserved = Number.isFinite(budget.reservedToolCalls)
    ? Math.max(0, Math.floor(budget.reservedToolCalls as number))
    : 0;
  const reserved =
    configuredReserved > 0
      ? configuredReserved
      : workerType === 'enumeration_worker' &&
          typeof budget.maxToolCalls === 'number'
        ? resolveRootReportingReserveToolCalls(undefined, budget.maxToolCalls)
        : 0;
  if (remaining === undefined || reserved <= 0) {
    return undefined;
  }

  const remainingAfterSpawn = Math.max(0, remaining - 1);
  if (remainingAfterSpawn >= reserved) {
    return undefined;
  }

  return (
    `Cannot spawn a new worker because only ${remainingAfterSpawn} tool call` +
    `${remainingAfterSpawn === 1 ? '' : 's'} would remain after this call, and ${reserved} are reserved ` +
    'for required completion work.'
  );
};

/**
 * Default cap on how many workers the parent executor should spawn in the opening
 * wave when multiple independent plan tasks are pending. Chosen small enough to
 * keep attention on each worker result; the effective cap is further bounded by
 * remaining budget.
 */
export const OPENING_WAVE_PREFERRED_CAP = 3;

/**
 * Computes the safe number of workers the parent executor can spawn in the opening
 * wave given the remaining budget. Returns at least `1` whenever a spawn is
 * possible. Returns `0` if the reporting reserve would be violated. Returns
 * `OPENING_WAVE_PREFERRED_CAP` when no budget snapshot is available (treat as
 * unbounded and let per-spawn guards catch it).
 */
export const resolveOpeningWaveConcurrency = (
  session: Pick<SessionState, 'agentType' | 'coordination' | 'flags'> | undefined,
  budget: ToolBudgetSnapshot | undefined,
  preferredCap: number = OPENING_WAVE_PREFERRED_CAP,
  recommendedWorkerTypes: readonly AnyWorkerType[] = [],
): number => {
  const securityops =
    session?.flags?.securityops &&
    typeof session.flags.securityops === 'object' &&
    !Array.isArray(session.flags.securityops)
      ? session.flags.securityops as Record<string, unknown>
      : undefined;
  const configuredActiveCap =
    typeof securityops?.maxActiveWorkers === 'number' && Number.isFinite(securityops.maxActiveWorkers)
      ? Math.max(1, Math.floor(securityops.maxActiveWorkers))
      : OPENING_WAVE_PREFERRED_CAP;
  const cap = Math.max(1, Math.min(Math.floor(preferredCap), configuredActiveCap));

  const includesEnumerationWorker = recommendedWorkerTypes.includes('enumeration_worker');
  if (!shouldRequireReportForSession(session) && !includesEnumerationWorker) {
    return cap;
  }

  if (!budget) {
    return cap;
  }

  // Reporting-reserve headroom: how many spawn_worker calls still leave
  // reportingToolCalls reserved for wrap-up.
  const remainingToolCalls = resolveRemainingToolCalls(budget);
  const configuredReserved = Number.isFinite(budget.reservedToolCalls)
    ? Math.max(0, Math.floor(budget.reservedToolCalls as number))
    : 0;
  const reserved =
    configuredReserved > 0
      ? configuredReserved
      : includesEnumerationWorker && typeof budget.maxToolCalls === 'number'
        ? resolveRootReportingReserveToolCalls(undefined, budget.maxToolCalls)
        : 0;
  let toolCallCap = cap;
  if (remainingToolCalls !== undefined && reserved > 0) {
    toolCallCap = Math.max(0, remainingToolCalls - reserved);
  }

  return Math.max(0, Math.min(cap, toolCallCap));
};

export const deriveWorkerTaskStatus = (session: SessionState | undefined): WorkerTaskStatus => {
  if (!session) {
    return 'failed';
  }
  if (session.workerResult) {
    return 'completed';
  }
  if (session.pendingApproval) {
    return 'awaiting_approval';
  }
  if (session.stateMachine?.isProcessing()) {
    return 'running';
  }
  if (session.completed || session.flags?.session?.completed === true) {
    return 'completed';
  }
  if (typeof session.blockedReason === 'string' && session.blockedReason.length > 0) {
    if (WORKER_INHERITED_BLOCK_REASONS.has(session.blockedReason)) {
      return 'blocked';
    }
    return session.blockedReason === 'worker_cancelled' ? 'cancelled' : 'failed';
  }
  return 'running';
};

export const getWorkerTemplate = (workerType: AnyWorkerType | string): WorkerTemplate => {
  const workerProfileRegistry = getWorkerProfileRegistry();
  const normalized = normalizeWorkerType(workerType);
  if (!normalized) {
    throw new Error(`Unknown worker type: ${workerType}`);
  }
  const template = workerProfileRegistry.get(normalized);
  if (!template) {
    throw new Error(`Worker profile is not registered: ${normalized}`);
  }
  return template;
};

export const renderWorkerSelectionGuide = (
  options: { includeEnumerationWorker?: boolean } = {},
): string => {
  const workerProfileRegistry = getWorkerProfileRegistry();
  const profiles = workerProfileRegistry.list().filter(
    (profile) =>
      options.includeEnumerationWorker === true ||
      profile.workerType !== 'enumeration_worker',
  );
  return [
    '- Worker roles are bounded execution templates. Choose the role for its tool and context shape, then specialize the mission in the task prompt.',
    ...profiles.map((template) =>
      [
        `- ${template.workerType}: use for ${template.useCases.join('; ')}.`,
        `  Continue when ${template.continueWhen}.`,
        `  Spawn fresh when ${template.spawnFreshWhen}.`,
      ].join('\n'),
    ),
  ].join('\n');
};
