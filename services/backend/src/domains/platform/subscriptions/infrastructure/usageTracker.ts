import { logger } from '@/shared/logger';

export interface RecordChatUsageInput {
  userId: string;
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  sessionCount: number;
  lastUpdated: number;
}

export interface UsageTrackerOptions {
  retentionMs?: number;
  log?: boolean;
}

interface UsageCounter {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  sessions: Set<string>;
  lastUpdated: number;
}

/**
 * Minimal in-memory tracker for per-user chat usage.
 * Keeps daily aggregates so plan gating / future billing hooks can query totals
 * before we plug into persistent storage.
 */
export class UsageTracker {
  private readonly retentionMs: number;

  private readonly logEvents: boolean;

  private readonly totals = new Map<string, UsageCounter>();

  constructor(options: UsageTrackerOptions = {}) {
    this.retentionMs = options.retentionMs ?? 1000 * 60 * 60 * 24; // 24 hours
    this.logEvents = options.log ?? false;
  }

  async recordChatUsage(input: RecordChatUsageInput): Promise<void> {
    const key = this.buildKey(input.userId);
    const counter = this.totals.get(key) ?? this.createCounter();
    counter.promptTokens += input.promptTokens;
    counter.completionTokens += input.completionTokens;
    counter.totalTokens += input.promptTokens + input.completionTokens;
    counter.sessions.add(input.sessionId);
    counter.lastUpdated = Date.now();
    this.totals.set(key, counter);
    this.purgeExpired();

    if (this.logEvents) {
      logger.debug(
        {
          userId: input.userId,
          sessionId: input.sessionId,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.promptTokens + input.completionTokens,
        },
        '[UsageTracker] chat usage',
      );
    }
  }

  getUsageSummary(userId: string, dateKey?: string): UsageSummary | undefined {
    const counter = this.totals.get(this.buildKey(userId, dateKey));
    if (!counter) {
      return undefined;
    }
    return {
      promptTokens: counter.promptTokens,
      completionTokens: counter.completionTokens,
      totalTokens: counter.totalTokens,
      sessionCount: counter.sessions.size,
      lastUpdated: counter.lastUpdated,
    };
  }

  resetUserUsage(userId: string, dateKey?: string): void {
    this.totals.delete(this.buildKey(userId, dateKey));
  }

  private buildKey(userId: string, dateKey?: string): string {
    const day = dateKey ?? new Date().toISOString().slice(0, 10);
    return `${userId}:${day}`;
  }

  private createCounter(): UsageCounter {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      sessions: new Set<string>(),
      lastUpdated: Date.now(),
    };
  }

  private purgeExpired(): void {
    if (this.retentionMs <= 0) {
      return;
    }
    const cutoff = Date.now() - this.retentionMs;
    for (const [key, counter] of this.totals.entries()) {
      if (counter.lastUpdated < cutoff) {
        this.totals.delete(key);
      }
    }
  }
}

declare global {
   
  var usageTracker: UsageTracker | undefined;
}
