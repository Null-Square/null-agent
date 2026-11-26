/**
 * TokenGuard - Per-session and per-user token limit enforcement.
 * 
 * Provides optional guardrails against runaway token consumption:
 * - Per-session limit: Optional hard cap on tokens per session (default: unlimited)
 * - Per-user daily limit: Optional soft cap on daily token usage
 * - Warning thresholds: Emit SSE warnings before hitting limits
 * 
 * Industry standard: Big providers (OpenAI, Anthropic) don't limit sessions.
 * They rely on credit/billing gating. This feature is kept for users who
 * want to set their own safety limits.
 * 
 * Integrates with UsageRecorder to track cumulative usage.
 */

import { logger } from '@/shared/logger';

const DEFAULT_PER_SESSION_LIMIT = 0;              // 0 = unlimited (industry standard)
const DEFAULT_PER_USER_DAILY_LIMIT = 0;           // 0 = unlimited (rely on credit gating)
const DEFAULT_WARNING_THRESHOLD_PCT = 80;          // Warn at 80% of limit (if limit is set)

/** Configuration for token guardrails */
export interface TokenGuardConfig {
    /** Maximum tokens allowed per session (0 = unlimited) */
    perSessionLimit?: number;
    /** Maximum tokens allowed per user per day (0 = unlimited) */
    perUserDailyLimit?: number;
    /** Percentage of limit at which to emit warning (0-100) */
    warningThresholdPct?: number;
}

/** Result of token limit check */
export interface TokenCheckResult {
    /** Whether the limit has been exceeded */
    exceeded: boolean;
    /** Which limit was exceeded, if any */
    limitType?: 'session' | 'daily';
    /** Current usage */
    currentUsage: number;
    /** Applicable limit */
    limit: number;
    /** Percentage of limit used */
    usagePct: number;
    /** Whether we're in warning territory */
    warning: boolean;
    /** Human-readable message */
    message?: string;
}

/** Session token usage tracker */
interface SessionUsage {
    sessionId: string;
    userId?: string;
    totalTokens: number;
    createdAt: number;
}

/** Per-user daily usage tracker */
interface DailyUsage {
    userId: string;
    date: string;
    totalTokens: number;
}

/**
 * TokenGuard enforces per-session and per-user token limits.
 */
export class TokenGuard {
    private readonly log = logger.child({ scope: 'TokenGuard' });
    private readonly perSessionLimit: number;
    private readonly perUserDailyLimit: number;
    private readonly warningThresholdPct: number;

    /** In-memory session usage cache */
    private readonly sessionUsage = new Map<string, SessionUsage>();
    /** In-memory daily user usage cache */
    private readonly dailyUsage = new Map<string, DailyUsage>();

    constructor(config: TokenGuardConfig = {}) {
        this.perSessionLimit = config.perSessionLimit ?? DEFAULT_PER_SESSION_LIMIT;
        this.perUserDailyLimit = config.perUserDailyLimit ?? DEFAULT_PER_USER_DAILY_LIMIT;
        this.warningThresholdPct = config.warningThresholdPct ?? DEFAULT_WARNING_THRESHOLD_PCT;
    }

    /**
     * Record token usage for a session/user.
     */
    recordUsage(params: { sessionId: string; userId?: string; tokens: number }): void {
        const { sessionId, userId, tokens } = params;

        // Update session usage
        const session = this.sessionUsage.get(sessionId) ?? {
            sessionId,
            userId,
            totalTokens: 0,
            createdAt: Date.now(),
        };
        session.totalTokens += tokens;
        this.sessionUsage.set(sessionId, session);

        // Update daily user usage if we have a userId
        if (userId) {
            const today = new Date().toISOString().slice(0, 10);
            const key = `${userId}:${today}`;
            const daily = this.dailyUsage.get(key) ?? {
                userId,
                date: today,
                totalTokens: 0,
            };
            daily.totalTokens += tokens;
            this.dailyUsage.set(key, daily);
        }

        this.log.debug(
            { sessionId, userId, tokens, sessionTotal: session.totalTokens },
            '[TokenGuard] Usage recorded',
        );
    }

    /**
     * Check if session or user has exceeded token limits.
     */
    checkLimits(sessionRef: string | { id: string; userId?: string }, userId?: string): TokenCheckResult {
        const sessionId = typeof sessionRef === 'string' ? sessionRef : sessionRef.id;
        const effectiveUserId = typeof sessionRef === 'string' ? userId : sessionRef.userId ?? userId;
        // Check session limit first
        const session = this.sessionUsage.get(sessionId);
        const sessionTokens = session?.totalTokens ?? 0;

        if (this.perSessionLimit > 0) {
            const usagePct = (sessionTokens / this.perSessionLimit) * 100;

            if (sessionTokens >= this.perSessionLimit) {
                return {
                    exceeded: true,
                    limitType: 'session',
                    currentUsage: sessionTokens,
                    limit: this.perSessionLimit,
                    usagePct,
                    warning: false,
                    message: `Session token limit exceeded (${sessionTokens.toLocaleString()}/${this.perSessionLimit.toLocaleString()})`,
                };
            }

            if (usagePct >= this.warningThresholdPct) {
                const roundedPct = Math.round(usagePct);
                return {
                    exceeded: false,
                    limitType: 'session',
                    currentUsage: sessionTokens,
                    limit: this.perSessionLimit,
                    usagePct,
                    warning: true,
                    message: `Session token use is at ${roundedPct}% of the safety limit. Finish the smallest valid unit now: submit_phase_handoff for phase sessions, submit_worker_result for workers, or finalize_run_artifacts for reporting. Do not start new broad exploration.`,
                };
            }
        }

        // Check daily user limit
        if (effectiveUserId && this.perUserDailyLimit > 0) {
            const today = new Date().toISOString().slice(0, 10);
            const key = `${effectiveUserId}:${today}`;
            const daily = this.dailyUsage.get(key);
            const dailyTokens = daily?.totalTokens ?? 0;
            const usagePct = (dailyTokens / this.perUserDailyLimit) * 100;

            if (dailyTokens >= this.perUserDailyLimit) {
                return {
                    exceeded: true,
                    limitType: 'daily',
                    currentUsage: dailyTokens,
                    limit: this.perUserDailyLimit,
                    usagePct,
                    warning: false,
                    message: `Daily token limit exceeded (${dailyTokens.toLocaleString()}/${this.perUserDailyLimit.toLocaleString()})`,
                };
            }

            if (usagePct >= this.warningThresholdPct) {
                const roundedPct = Math.round(usagePct);
                return {
                    exceeded: false,
                    limitType: 'daily',
                    currentUsage: dailyTokens,
                    limit: this.perUserDailyLimit,
                    usagePct,
                    warning: true,
                    message: `Daily token use is at ${roundedPct}% of the safety limit. Finish the smallest valid unit now: submit_phase_handoff for phase sessions, submit_worker_result for workers, or finalize_run_artifacts for reporting. Do not start new broad exploration.`,
                };
            }
        }

        // All good
        return {
            exceeded: false,
            currentUsage: sessionTokens,
            limit: this.perSessionLimit,
            usagePct: this.perSessionLimit > 0 ? (sessionTokens / this.perSessionLimit) * 100 : 0,
            warning: false,
        };
    }

    /**
     * Get current session usage.
     */
    getSessionUsage(sessionId: string): number {
        return this.sessionUsage.get(sessionId)?.totalTokens ?? 0;
    }

    /**
     * Get current daily user usage.
     */
    getDailyUserUsage(userId: string): number {
        const today = new Date().toISOString().slice(0, 10);
        const key = `${userId}:${today}`;
        return this.dailyUsage.get(key)?.totalTokens ?? 0;
    }

    /**
     * Clear session usage (e.g., when session ends).
     */
    clearSession(sessionId: string): void {
        this.sessionUsage.delete(sessionId);
    }

    /**
     * Purge expired daily usage entries.
     */
    purgeExpired(): void {
        const today = new Date().toISOString().slice(0, 10);
        for (const [key, usage] of this.dailyUsage.entries()) {
            if (usage.date !== today) {
                this.dailyUsage.delete(key);
            }
        }
    }

    /**
     * Get current configuration.
     */
    getConfig(): TokenGuardConfig {
        return {
            perSessionLimit: this.perSessionLimit,
            perUserDailyLimit: this.perUserDailyLimit,
            warningThresholdPct: this.warningThresholdPct,
        };
    }
}
