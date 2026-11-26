import { opsMetrics } from '@/shared/metrics/opsMetrics';
import type { AppLogger } from '@/shared/logger';
import type { SessionState } from '../../domain/types';

export class SessionStateCache {
  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly sessionLocks: Map<string, Promise<unknown>> = new Map();
  private readonly messageCountCache: Map<string, number> = new Map();

  constructor(private readonly logger: AppLogger) {}

  getStore(): Map<string, SessionState> {
    return this.sessions;
  }

  entries(): IterableIterator<[string, SessionState]> {
    return this.sessions.entries();
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys();
  }

  values(): IterableIterator<SessionState> {
    return this.sessions.values();
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, session: SessionState): void {
    this.sessions.set(sessionId, session);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const acquireLocal = async () => {
      const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
      const next = previous.then(fn);
      const tracked = next.catch(() => undefined);
      this.sessionLocks.set(sessionId, tracked);
      try {
        return await next;
      } finally {
        // Compare against the exact promise stored above. Comparing with
        // `next` retained one settled promise per session forever.
        if (this.sessionLocks.get(sessionId) === tracked) {
          this.sessionLocks.delete(sessionId);
        }
      }
    };
    // SIMPLIFIED: No distributed lock - DB CAS is the only distributed authority
    return acquireLocal();
  }

  async updateSession<T>(
    sessionId: string,
    mutator: (session: SessionState) => Promise<T> | T,
    options?: { afterUpdate?: (session: SessionState) => void; context?: string },
  ): Promise<T | undefined> {
    return this.withLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return undefined;
      }
      const result = await mutator(session);
      session.flags = session.flags ?? {};
      session.lastActive = Date.now();
      session.version = (session.version ?? 0) + 1;
      this.sessions.set(sessionId, session);
      options?.afterUpdate?.(session);
      this.assertSessionState(session, options?.context ?? 'updateSession');
      return result;
    });
  }

  private assertSessionState(session: SessionState, context: string): void {
    const violations: string[] = [];

    // Invariant 1: Running sessions must have currentTurn
    if (session.status === 'running' && !session.currentTurn) {
      violations.push('Running session without currentTurn');
    }

    // Invariant 2: Message count should never decrease
    const lastKnownCount = this.messageCountCache.get(session.id);
    if (lastKnownCount !== undefined && session.messages.length < lastKnownCount) {
      violations.push(`Message count decreased from ${lastKnownCount} to ${session.messages.length}`);
      // Record as a persist conflict since this indicates state corruption
      opsMetrics.recordSessionConflict(session.id, 'persist', 1, false);
    }

    // Update the cache with current count
    this.messageCountCache.set(session.id, session.messages.length);

    // Invariant 3: Idle sessions with pending tool_calls are suspicious
    if (session.status === 'idle') {
      const lastMessage = session.messages[session.messages.length - 1];
      if (lastMessage?.role === 'assistant' && (lastMessage.tool_calls?.length ?? 0) > 0) {
        violations.push('Idle session ends with assistant containing tool_calls');
      }
    }

    if (violations.length > 0) {
      this.logger.error(
        {
          sessionId: session.id,
          context,
          violations,
          status: session.status,
          messageCount: session.messages.length,
          hasCurrentTurn: !!session.currentTurn,
          version: session.version,
        },
        '[SessionStore] INVARIANT VIOLATION detected',
      );
    }
  }
}
