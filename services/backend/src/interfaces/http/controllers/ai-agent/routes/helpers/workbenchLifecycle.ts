import type { SessionState } from '@/domains/agent-brain/domain/types';

export const STALE_PHASE_SESSION_STATUSES = new Set(['failed', 'aborted', 'timed_out']);

export type WorkbenchPhaseSessionRef = {
  id: string;
  runId: string;
  phaseKey: string;
  status: string;
  sessionId: string | null;
  ordinal?: number | null;
};

export type WorkbenchPhaseSessionRouting = {
  current: WorkbenchPhaseSessionRef | null;
  active: WorkbenchPhaseSessionRef | null;
};

type WorkbenchTraceEventPayload =
  | Record<string, unknown>
  | object
  | string
  | number
  | boolean
  | null
  | Array<unknown>;

type WorkbenchTraceEvent = {
  event: string;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  payload?: WorkbenchTraceEventPayload;
  links?: Record<string, string>;
  note?: string;
  parentEventId?: string;
  depth?: number;
};

type WorkbenchTraceRecorder = {
  write(sessionId: string, turn: number, event: WorkbenchTraceEvent): Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const getWorkbenchSecurityOpsFlags = (session: SessionState | undefined): Record<string, unknown> | null => {
  const flags = session?.flags;
  const securityops = isRecord(flags?.securityops) ? flags.securityops : undefined;
  return securityops ?? null;
};

export const readWorkbenchRunId = (session: SessionState | undefined): string | undefined => {
  const securityops = getWorkbenchSecurityOpsFlags(session);
  const runId = securityops?.runId;
  return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : undefined;
};

export const buildStalePhaseSessionResponse = (
  routing: WorkbenchPhaseSessionRouting,
): Record<string, unknown> => {
  const current = routing.current;
  const active = routing.active;
  return {
    accepted: false,
    interrupted: false,
    status: 'stale_phase_session',
    message: active?.sessionId
      ? 'This phase session is stale. Open the active phase session for this run phase.'
      : 'This phase session is stale and no active replacement session is attached yet.',
    runId: current?.runId ?? active?.runId ?? null,
    phaseId: current?.id ?? null,
    phaseKey: current?.phaseKey ?? active?.phaseKey ?? null,
    phaseStatus: current?.status ?? null,
    currentSessionId: active?.sessionId ?? current?.sessionId ?? null,
    activePhaseSession: active
      ? {
        phaseId: active.id,
        phaseKey: active.phaseKey,
        phaseStatus: active.status,
        sessionId: active.sessionId,
        ordinal: active.ordinal ?? null,
      }
      : null,
    redirect: active?.sessionId
      ? {
        runId: active.runId,
        phaseKey: active.phaseKey,
        sessionId: active.sessionId,
      }
      : null,
  };
};

export const writeWorkbenchActionTrace = async (params: {
  traceRecorder?: WorkbenchTraceRecorder;
  session: SessionState | undefined;
  sessionId: string;
  action: 'stop' | 'start' | 'redirect' | 'force_close' | 'message' | 'interrupt_and_message';
  operatorId?: string | null;
  targetSessionId?: string | null;
  runId?: string | null;
  phaseId?: string | null;
  phaseKey?: string | null;
  reason?: string | null;
  result?: 'accepted' | 'rejected' | 'offered';
  extra?: Record<string, unknown>;
}): Promise<void> => {
  const recorder = params.traceRecorder;
  if (!recorder) {
    return;
  }
  const securityops = getWorkbenchSecurityOpsFlags(params.session);
  const runId = params.runId ?? (typeof securityops?.runId === 'string' ? securityops.runId : null);
  const phaseId = params.phaseId ?? (typeof securityops?.activePhaseId === 'string' ? securityops.activePhaseId : null);
  const phaseKey = params.phaseKey ?? (typeof securityops?.activePhaseKey === 'string' ? securityops.activePhaseKey : null);
  await recorder.write(params.sessionId, (params.session?.turn ?? 0) + 1, {
    event: 'workbench.action',
    severity: params.result === 'rejected' ? 'warn' : 'info',
    payload: {
      action: params.action,
      operatorId: params.operatorId ?? null,
      targetSessionId: params.targetSessionId ?? params.sessionId,
      selectedSessionId: params.sessionId,
      runId,
      phaseId,
      phaseKey,
      reason: params.reason ?? null,
      result: params.result ?? 'accepted',
      ...(params.extra ?? {}),
    },
    note: `workbench ${params.action}`,
  });
};
