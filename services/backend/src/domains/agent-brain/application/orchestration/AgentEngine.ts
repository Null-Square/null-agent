import type { SessionState, SandboxPolicySummary } from '../../domain/types';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { AgentBrainPorts } from '../core/AgentBrainPorts';
import type { TaskPreparation } from '../../domain/types';
import { type SessionStore } from '../core/SessionStore';
import { SessionLifecycleManager } from './services/SessionLifecycleManager';
import { SandboxProvisioner } from './services/SandboxProvisioner';
import { logger } from '@/shared/logger';
import { releaseCacheLineageSession } from './cacheLineageRegistry';

interface ProvisionSandboxOptions {
  session: SessionState;
  sandboxImage?: string;
  traceRecorder?: SessionTraceRecorder;
}

export class AgentEngine {
  private readonly lifecycleManager: SessionLifecycleManager;
  private readonly sandboxProvisioner: SandboxProvisioner;
  private readonly log = logger.child({ scope: 'AgentEngine' });

  constructor(
    private readonly ports: AgentBrainPorts,
    private readonly sessions: SessionStore,
  ) {
    this.lifecycleManager = new SessionLifecycleManager({
      sessions: this.sessions,
      events: this.ports.events,
    });
    this.sandboxProvisioner = new SandboxProvisioner({
      provision: this.ports.sandbox.provision,
      events: this.ports.events,
    });
  }

  async initializeSession(options: {
    session: SessionState;
    preparation?: TaskPreparation;
    sandboxImage?: string;
    traceRecorder?: SessionTraceRecorder;
    provisionSandbox?: boolean;
  }): Promise<void> {
    const { session, preparation, sandboxImage, traceRecorder } = options;

    await this.lifecycleManager.initialize(session, preparation, traceRecorder);

    if (options.provisionSandbox !== false) {
      await this.provisionSandbox({
        session,
        sandboxImage,
        traceRecorder,
      });
    }
  }

  async provisionSandbox(options: ProvisionSandboxOptions): Promise<SandboxPolicySummary | undefined> {
    const { session, sandboxImage, traceRecorder } = options;
    return this.sandboxProvisioner.provision(session, sandboxImage, traceRecorder);
  }

  async stopSandbox(session: SessionState, reason?: string): Promise<void> {
    await this.sandboxProvisioner.stop(session, reason);
  }

  async destroySandbox(session: SessionState): Promise<void> {
    await this.sandboxProvisioner.destroy(session);
  }

  async cleanupSession(sessionId: string, session?: SessionState): Promise<void> {
    if (session) {
      try {
        await this.destroySandbox(session);
      } catch (error) {
        this.log.warn({ err: error, sessionId }, 'Failed to destroy sandbox for session');
      }
    }
    this.lifecycleManager.cleanup(sessionId);
    // E12 Slice A holds one cache ancestor per live session; release it with the session.
    releaseCacheLineageSession(sessionId);
  }

  getSandboxPolicy(sessionId: string): Promise<SandboxPolicySummary | undefined> {
    return this.sandboxProvisioner.getPolicy(sessionId);
  }
}
