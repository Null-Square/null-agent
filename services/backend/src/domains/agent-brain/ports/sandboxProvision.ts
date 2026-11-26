import type { SessionState, SandboxPolicySummary } from '../domain/types';

export interface SandboxProvisioningPort {
  create(session: SessionState): Promise<void>;
  stop(session: SessionState, reason?: string): Promise<void>;
  destroy(session: SessionState): Promise<void>;
  getPolicy(sessionId: string): Promise<SandboxPolicySummary | undefined>;
}

