import { logger as appLogger, type AppLogger } from '@/shared/logger';
import { LLM_REQUEST_MS } from '@/config/timeouts';
import type { SessionState } from '../../domain/types';
import { cloneFlags } from '../../domain/helpers';

const createNoopLogger = (): AppLogger => {
  const silentLogger = appLogger.child({ scope: 'TurnManagementService' });
  silentLogger.level = 'silent';
  return silentLogger;
};

const hasWarn = (candidate: unknown): candidate is AppLogger =>
  Boolean(candidate && typeof (candidate as { warn?: unknown }).warn === 'function');

const hasChild = (candidate: unknown): candidate is { child: (bindings: Record<string, unknown>) => AppLogger } =>
  Boolean(candidate && typeof (candidate as { child?: unknown }).child === 'function');

const resolveLogger = (parentLogger?: AppLogger): AppLogger => {
  const baseLogger = parentLogger ?? appLogger;
  const childLogger = hasChild(baseLogger)
    ? baseLogger.child({ scope: 'TurnManagementService' })
    : baseLogger;
  if (hasWarn(childLogger)) {
    return childLogger;
  }
  if (hasWarn(baseLogger)) {
    return baseLogger;
  }
  return createNoopLogger();
};

export interface TurnManagementPort {
  getSession(sessionId: string): SessionState | undefined;
  updateSession<T>(
    sessionId: string,
    mutator: (session: SessionState) => Promise<T> | T,
  ): Promise<T | undefined>;
}

export class TurnManagementService {
  private readonly logger: AppLogger;
  private readonly currentTurns: Map<string, SessionState['currentTurn']> = new Map();
  private readonly turnSettlements = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
  }>();

  constructor(private readonly port: TurnManagementPort, parentLogger?: AppLogger) {
    this.logger = resolveLogger(parentLogger);
  }

  attachCurrentTurn(sessionId: string, session: SessionState): void {
    const currentTurn = this.currentTurns.get(sessionId);
    if (currentTurn) {
      session.currentTurn = currentTurn;
    }
  }

  getCurrentTurn(sessionId: string): SessionState['currentTurn'] | undefined {
    return this.currentTurns.get(sessionId);
  }

  clearCurrentTurnState(sessionId: string): void {
    this.currentTurns.delete(sessionId);
    const settlement = this.turnSettlements.get(sessionId);
    settlement?.resolve();
    this.turnSettlements.delete(sessionId);
  }

  async startTurn(
    sessionId: string,
    controller: AbortController,
    metadata?: { reason?: string },
  ): Promise<boolean> {
    let resolveSettlement!: () => void;
    const settlementPromise = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const updated = await this.port.updateSession(sessionId, async (session) => {
      if (this.currentTurns.has(sessionId)) {
        return false;
      }
      const currentTurn = {
        controller,
        startedAt: Date.now(),
        reason: metadata?.reason,
        abortedEventEmitted: false,
        flagsSnapshot: cloneFlags(session.flags),
      };
      this.currentTurns.set(sessionId, currentTurn);
      this.turnSettlements.set(sessionId, {
        promise: settlementPromise,
        resolve: resolveSettlement,
      });
      session.currentTurn = currentTurn;
      return true;
    });
    if (!updated) {
      resolveSettlement();
    }
    return Boolean(updated);
  }

  async clearCurrentTurn(sessionId: string): Promise<void> {
    try {
      await this.port.updateSession(sessionId, async (session) => {
        session.currentTurn = undefined;
        return undefined;
      });
    } finally {
      this.currentTurns.delete(sessionId);
      const settlement = this.turnSettlements.get(sessionId);
      settlement?.resolve();
      this.turnSettlements.delete(sessionId);
    }
  }

  async abortCurrentTurn(sessionId: string, reason?: string): Promise<void> {
    const current = this.currentTurns.get(sessionId);
    if (current?.controller) {
      try {
        current.reason = reason ?? current.reason;
        current.controller.abort(reason ?? 'aborted');
      } catch (error) {
        this.logger.warn({ err: error, sessionId }, '[TurnManagement] abortCurrentTurn failed');
      }
    }

  }

  async abortCurrentTurnAndWait(
    sessionId: string,
    reason?: string,
    timeoutMs = LLM_REQUEST_MS + 10_000,
  ): Promise<boolean> {
    await this.abortCurrentTurn(sessionId, reason);
    return this.waitForCurrentTurnToSettle(sessionId, timeoutMs);
  }

  async waitForCurrentTurnToSettle(
    sessionId: string,
    timeoutMs = LLM_REQUEST_MS + 10_000,
  ): Promise<boolean> {
    const settlement = this.turnSettlements.get(sessionId);
    if (!settlement) {
      return true;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        settlement.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async markAbortEventEmitted(sessionId: string, reason?: string): Promise<void> {
    await this.port.updateSession(sessionId, async (session) => {
      const currentTurn = this.currentTurns.get(sessionId);
      if (!currentTurn) {
        return;
      }
      currentTurn.abortEventEmitted = true;
      if (reason) {
        currentTurn.reason = reason;
      }
      this.currentTurns.set(sessionId, currentTurn);
      session.currentTurn = currentTurn;
    });
  }

}
