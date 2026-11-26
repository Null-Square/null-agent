import type { ApprovalRequest, SandboxPolicy } from '@/types/chat';

export type SessionStatusType =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'error';

export interface SessionState {
  status: SessionStatusType;
  statusVersion: number;
  pauseReason?: 'manual' | 'approval' | 'credits' | 'runner' | 'system' | null;
  interactionType?: 'none';
  blockedReason?: string | null;
  isLoading: boolean;
  isAborting: boolean;
  sandboxPolicy?: SandboxPolicy;
  pendingApproval?: ApprovalRequest | null;
  streamConnected: boolean;
  lastStreamActivityAt?: number;
  lastStreamPingAt?: number;
}

export type SessionAction =
  | { type: 'session/setStatus'; payload: SessionState['status'] }
  | {
      type: 'session/setStatusWithVersion';
      payload: {
        status: SessionState['status'];
        version: number;
        pauseReason?: SessionState['pauseReason'];
        interactionType?: SessionState['interactionType'];
      };
    }
  | {
      type: 'session/setPauseMeta';
      payload: {
        pauseReason?: SessionState['pauseReason'];
        interactionType?: SessionState['interactionType'];
        blockedReason?: string | null;
      };
    }
  | { type: 'session/setBlockedReason'; payload: string | null }
  | { type: 'session/setLoading'; payload: boolean }
  | { type: 'session/setAborting'; payload: boolean }
  | { type: 'session/setSandboxPolicy'; payload?: SandboxPolicy }
  | { type: 'session/setPendingApproval'; payload: ApprovalRequest | null }
  | { type: 'session/clearPendingApproval'; payload?: { actionId?: string } }
  | { type: 'session/setStreamConnected'; payload: boolean }
  | { type: 'session/markStreamActivity'; payload?: { timestamp?: number; kind?: 'event' | 'ping' } }
  | { type: 'session/reset' };

export const initialSessionState: SessionState = {
  status: 'idle',
  statusVersion: 0,
  pauseReason: null,
  interactionType: 'none',
  blockedReason: null,
  isLoading: false,
  isAborting: false,
  sandboxPolicy: undefined,
  pendingApproval: null,
  streamConnected: false,
  lastStreamActivityAt: undefined,
  lastStreamPingAt: undefined,
};

export const sessionReducer = (
  state: SessionState = initialSessionState,
  action: SessionAction
): SessionState => {
  switch (action.type) {
    case 'session/setStatus':
      return { ...state, status: action.payload };
    case 'session/setStatusWithVersion':
      // Version-based dedup: only update if new version is higher
      if (action.payload.version > state.statusVersion) {
        return {
          ...state,
          status: action.payload.status,
          pauseReason: action.payload.pauseReason ?? null,
          interactionType: action.payload.interactionType ?? 'none',
          statusVersion: action.payload.version,
        };
      }
      return state;  // Drop stale event
    case 'session/setPauseMeta':
      return {
        ...state,
        pauseReason: action.payload.pauseReason ?? null,
        interactionType: action.payload.interactionType ?? 'none',
        blockedReason: action.payload.blockedReason ?? null,
      };
    case 'session/setBlockedReason':
      return { ...state, blockedReason: action.payload };
    case 'session/setLoading':
      return { ...state, isLoading: action.payload };
    case 'session/setAborting':
      return { ...state, isAborting: action.payload };
    case 'session/setSandboxPolicy':
      return { ...state, sandboxPolicy: action.payload };
    case 'session/setPendingApproval':
      return { ...state, pendingApproval: action.payload };
    case 'session/clearPendingApproval':
      if (
        action.payload?.actionId &&
        state.pendingApproval &&
        state.pendingApproval.actionId !== action.payload.actionId &&
        state.pendingApproval.toolCallId !== action.payload.actionId
      ) {
        return state;
      }
      return { ...state, pendingApproval: null };
    case 'session/setStreamConnected':
      return { ...state, streamConnected: action.payload };
    case 'session/markStreamActivity': {
      const timestamp = action.payload?.timestamp ?? Date.now();
      if (action.payload?.kind === 'ping') {
        return { ...state, lastStreamPingAt: timestamp };
      }
      return {
        ...state,
        lastStreamActivityAt: timestamp,
      };
    }
    case 'session/reset':
      return initialSessionState;
    default:
      return state;
  }
};

export const sessionSelectors = {
  status: (state: SessionState) => state.status,
  statusVersion: (state: SessionState) => state.statusVersion,
  pauseReason: (state: SessionState) => state.pauseReason,
  interactionType: (state: SessionState) => state.interactionType,
  blockedReason: (state: SessionState) => state.blockedReason,
  isLoading: (state: SessionState) => state.isLoading,
  isAborting: (state: SessionState) => state.isAborting,
  sandboxPolicy: (state: SessionState) => state.sandboxPolicy,
  pendingApproval: (state: SessionState) => state.pendingApproval,
  streamConnected: (state: SessionState) => state.streamConnected,
  lastStreamActivityAt: (state: SessionState) => state.lastStreamActivityAt,
  lastStreamPingAt: (state: SessionState) => state.lastStreamPingAt,
};
