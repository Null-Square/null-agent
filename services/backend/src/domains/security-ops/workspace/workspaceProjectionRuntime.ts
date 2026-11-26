import { db } from '@/db/client';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type { WorkspaceProjectionFlushResult } from '@/domains/agent-brain/ports';
import { createSandboxWorkspaceTarget, type WorkspaceSandboxWriter } from './WorkspaceFilePort';
import {
  WorkspaceProjectionService,
  type ProjectionScope,
} from './WorkspaceProjectionService';

const workspaceProjectionService = new WorkspaceProjectionService(db);
const DIRTY_FLAG_KEY = 'workspaceProjectionDirty';
const PROJECTION_SCOPES = new Set<ProjectionScope>([
  'all',
  'contract',
  'context',
  'recon',
  'surface',
  'coverage',
  'leads',
  'model',
  'findings',
  'evidence',
  'compliance',
  'skills',
  'scanDigest',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

const normalizeProjectionScopes = (scopes: readonly string[] | undefined): ProjectionScope[] => {
  const normalized = new Set<ProjectionScope>();
  for (const scope of scopes ?? []) {
    const candidate = scope.trim() as ProjectionScope;
    if (PROJECTION_SCOPES.has(candidate)) {
      normalized.add(candidate);
    }
  }
  return [...normalized];
};

type DirtyProjectionState = {
  runId: string;
  orgId: string;
  scopeId: string;
  scopes: ProjectionScope[];
  reasons: string[];
  dirtyCount: number;
  markedAt: string;
};

const readDirtyState = (value: unknown): DirtyProjectionState | null => {
  if (!isRecord(value)) {
    return null;
  }
  const runId = getString(value.runId);
  const orgId = getString(value.orgId);
  const scopeId = getString(value.scopeId);
  const scopes = normalizeProjectionScopes(getStringArray(value.scopes));
  if (!runId || !orgId || !scopeId || scopes.length === 0) {
    return null;
  }
  return {
    runId,
    orgId,
    scopeId,
    scopes,
    reasons: getStringArray(value.reasons).slice(0, 20),
    dirtyCount:
      typeof value.dirtyCount === 'number' && Number.isFinite(value.dirtyCount)
        ? Math.max(0, Math.floor(value.dirtyCount))
        : scopes.length,
    markedAt: getString(value.markedAt) ?? new Date().toISOString(),
  };
};

const getSecurityOpsFlags = (session: ReturnType<SessionStore['get']>): Record<string, unknown> | undefined =>
  isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;

const resolveProjectionIdentity = (session: ReturnType<SessionStore['get']>) => {
  const securityops = getSecurityOpsFlags(session);
  const orgId = getString(securityops?.organizationId);
  const scopeId = getString(session?.scopeId) ?? getString(securityops?.scopeId);
  const runId = getString(securityops?.runId);
  if (!session?.workspaceDir || !orgId || !scopeId || !runId) {
    return null;
  }
  return { session, securityops, orgId, scopeId, runId };
};

const makeWarning = (reason: string, message: string): string =>
  `Projection refresh failed after ${reason}: ${message}. Use canonical query tools if projected files look stale.`;

export async function markWorkspaceProjectionDirty(params: {
  ctx: ToolContext;
  reason: string;
  scopes: ProjectionScope[];
}): Promise<string | null> {
  const identity = resolveProjectionIdentity(getSessionFromContext(params.ctx));
  if (!identity) {
    return null;
  }

  const incomingScopes = normalizeProjectionScopes(params.scopes);
  if (incomingScopes.length === 0) {
    return null;
  }

  const currentDirty = readDirtyState(identity.securityops?.[DIRTY_FLAG_KEY]);
  const previousApplies = currentDirty?.runId === identity.runId;
  const scopes = new Set<ProjectionScope>(previousApplies ? currentDirty.scopes : []);
  for (const scope of incomingScopes) {
    scopes.add(scope);
  }
  const reasons = [
    ...(previousApplies ? currentDirty.reasons : []),
    params.reason,
  ]
    .filter((reason, index, all) => all.indexOf(reason) === index)
    .slice(-20);

  const dirtyState: DirtyProjectionState = {
    runId: identity.runId,
    orgId: identity.orgId,
    scopeId: identity.scopeId,
    scopes: [...scopes],
    reasons,
    dirtyCount: (previousApplies ? currentDirty.dirtyCount : 0) + 1,
    markedAt: new Date().toISOString(),
  };

  try {
    await params.ctx.sessionStore.mergeFlagNamespaceAsync(identity.session.id, 'securityops', {
      [DIRTY_FLAG_KEY]: dirtyState,
    });
    await params.ctx.trace?.write(params.ctx.sessionId, params.ctx.turnNumber ?? 0, {
      event: 'workspace_projection.dirty_marked',
      severity: 'debug',
      payload: {
        reason: params.reason,
        scopes: incomingScopes,
        coalescedScopes: dirtyState.scopes,
        dirtyCount: dirtyState.dirtyCount,
      },
      note: `workspace projection dirty: ${dirtyState.scopes.join(', ')}`,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeWarning(params.reason, message);
  }
}

async function clearFlushedDirtyScopes(params: {
  sessionStore: SessionStore;
  sessionId: string;
  runId: string;
  flushedScopes: ProjectionScope[];
}): Promise<void> {
  const latest = params.sessionStore.get(params.sessionId);
  const latestSecurityops = getSecurityOpsFlags(latest);
  const latestDirty = readDirtyState(latestSecurityops?.[DIRTY_FLAG_KEY]);
  if (!latestDirty || latestDirty.runId !== params.runId) {
    return;
  }

  const flushed = new Set(params.flushedScopes);
  const remainingScopes = latestDirty.scopes.filter((scope) => !flushed.has(scope));
  if (remainingScopes.length === 0) {
    await params.sessionStore.mergeFlagNamespaceAsync(params.sessionId, 'securityops', {
      [DIRTY_FLAG_KEY]: undefined,
    });
    return;
  }

  await params.sessionStore.mergeFlagNamespaceAsync(params.sessionId, 'securityops', {
    [DIRTY_FLAG_KEY]: {
      ...latestDirty,
      scopes: remainingScopes,
    },
  });
}

export async function flushWorkspaceProjectionForSession(params: {
  sessionStore: SessionStore;
  sandbox: WorkspaceSandboxWriter;
  trace?: SessionTraceRecorder;
  sessionId: string;
  reason: string;
  turnNumber?: number;
  scopes?: string[];
  forceModel?: boolean;
  service?: WorkspaceProjectionService;
}): Promise<WorkspaceProjectionFlushResult> {
  const identity = resolveProjectionIdentity(params.sessionStore.get(params.sessionId));
  if (!identity) {
    return { flushed: false, scopes: [], written: 0, dirtyCount: 0 };
  }

  const dirty = readDirtyState(identity.securityops?.[DIRTY_FLAG_KEY]);
  const explicitScopes = normalizeProjectionScopes(params.scopes);
  const scopes = new Set<ProjectionScope>([
    ...(dirty?.runId === identity.runId ? dirty.scopes : []),
    ...explicitScopes,
  ]);
  if (params.forceModel) {
    scopes.add('model');
  }

  const scopesToFlush = [...scopes];
  if (scopesToFlush.length === 0) {
    return { flushed: false, scopes: [], written: 0, dirtyCount: dirty?.dirtyCount ?? 0 };
  }

  try {
    const result = await (params.service ?? workspaceProjectionService).projectRunWorkspace({
      orgId: identity.orgId,
      scopeId: identity.scopeId,
      runId: identity.runId,
      sessionId: identity.session.id,
      phaseKey: getString(identity.securityops?.activePhaseKey),
      assignedSkillSlugs: getStringArray(identity.securityops?.phaseAssignedSkillSlugs),
      reason: params.reason,
      scopes: scopesToFlush,
      workspace: createSandboxWorkspaceTarget({
        runId: identity.runId,
        session: identity.session,
        sandbox: params.sandbox,
      }),
    });

    await clearFlushedDirtyScopes({
      sessionStore: params.sessionStore,
      sessionId: params.sessionId,
      runId: identity.runId,
      flushedScopes: scopesToFlush,
    });

    await params.trace?.write(params.sessionId, params.turnNumber ?? identity.session.turn ?? 0, {
      event: 'workspace_projection.flushed',
      severity: 'info',
      payload: {
        reason: params.reason,
        requestedScopes: explicitScopes,
        dirtyScopes: dirty?.runId === identity.runId ? dirty.scopes : [],
        flushedScopes: scopesToFlush,
        scopes: scopesToFlush,
        forceModel: params.forceModel === true,
        written: result.written.length,
        writtenPaths: result.written,
        skipped: result.skipped,
        dirtyCount: dirty?.dirtyCount ?? 0,
        dirtyReasons: dirty?.runId === identity.runId ? dirty.reasons : [],
        warnings: result.warnings,
      },
      note: `workspace projection flushed: ${scopesToFlush.join(', ')}`,
    });

    return {
      flushed: true,
      scopes: scopesToFlush,
      written: result.written.length,
      writtenPaths: result.written,
      requestedScopes: explicitScopes,
      forceModel: params.forceModel === true,
      dirtyCount: dirty?.dirtyCount ?? 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = makeWarning(params.reason, message);
    await params.trace?.write(params.sessionId, params.turnNumber ?? identity.session.turn ?? 0, {
      event: 'workspace_projection.refresh_failed',
      severity: 'warn',
      payload: {
        reason: params.reason,
        requestedScopes: explicitScopes,
        dirtyScopes: dirty?.runId === identity.runId ? dirty.scopes : [],
        flushedScopes: scopesToFlush,
        scopes: scopesToFlush,
        forceModel: params.forceModel === true,
        error: message,
        dirtyCount: dirty?.dirtyCount ?? 0,
        dirtyReasons: dirty?.runId === identity.runId ? dirty.reasons : [],
      },
      note: `workspace projection refresh failed: ${message}`,
    });
    return {
      flushed: false,
      scopes: scopesToFlush,
      written: 0,
      requestedScopes: explicitScopes,
      forceModel: params.forceModel === true,
      dirtyCount: dirty?.dirtyCount ?? 0,
      warning,
    };
  }
}

export async function flushWorkspaceProjectionForTool(params: {
  ctx: ToolContext;
  reason: string;
  scopes?: ProjectionScope[];
  forceModel?: boolean;
}): Promise<WorkspaceProjectionFlushResult> {
  return flushWorkspaceProjectionForSession({
    sessionStore: params.ctx.sessionStore,
    sandbox: params.ctx.sandbox,
    trace: params.ctx.trace,
    sessionId: params.ctx.sessionId,
    turnNumber: params.ctx.turnNumber,
    reason: params.reason,
    scopes: params.scopes,
    forceModel: params.forceModel,
  });
}

export async function refreshWorkspaceProjectionForTool(params: {
  ctx: ToolContext;
  reason: string;
  scopes: ProjectionScope[];
}): Promise<string | null> {
  const result = await flushWorkspaceProjectionForTool({
    ctx: params.ctx,
    reason: params.reason,
    scopes: params.scopes,
  });
  return result.warning ?? null;
}

export async function attachProjectionWarning<T extends object>(params: {
  ctx: ToolContext;
  data: T;
  reason: string;
  scopes: ProjectionScope[];
}): Promise<T> {
  const warning = await markWorkspaceProjectionDirty({
    ctx: params.ctx,
    reason: params.reason,
    scopes: params.scopes,
  });
  if (!warning) {
    return params.data;
  }
  return {
    ...params.data,
    projectionWarning: warning,
  };
}
