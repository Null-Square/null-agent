import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';

describe('TokenGuard', () => {
    let guard: TokenGuard;

    beforeEach(() => {
        guard = new TokenGuard({
            perSessionLimit: 1000,
            perUserDailyLimit: 5000,
            warningThresholdPct: 80,
        });
    });

    describe('recordUsage', () => {
        it('should track session token usage', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 100 });
            expect(guard.getSessionUsage('s1')).toBe(100);
        });

        it('should accumulate multiple usage records', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 100 });
            guard.recordUsage({ sessionId: 's1', tokens: 200 });
            expect(guard.getSessionUsage('s1')).toBe(300);
        });

        it('should track per-user daily usage when userId provided', () => {
            guard.recordUsage({ sessionId: 's1', userId: 'u1', tokens: 100 });
            expect(guard.getDailyUserUsage('u1')).toBe(100);
        });

        it('should not track daily usage without userId', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 100 });
            expect(guard.getDailyUserUsage('u1')).toBe(0);
        });
    });

    describe('checkLimits', () => {
        it('should return not exceeded when under limits', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 500 });
            const result = guard.checkLimits('s1');

            expect(result.exceeded).toBe(false);
            expect(result.warning).toBe(false);
        });

        it('should return warning when at 80% of session limit', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 800 });
            const result = guard.checkLimits('s1');

            expect(result.exceeded).toBe(false);
            expect(result.warning).toBe(true);
            expect(result.limitType).toBe('session');
            expect(result.message).toContain('Finish the smallest valid unit now');
            expect(result.message).toContain('submit_phase_handoff');
        });

        it('should return exceeded when session limit reached', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 1000 });
            const result = guard.checkLimits('s1');

            expect(result.exceeded).toBe(true);
            expect(result.limitType).toBe('session');
            expect(result.message).toContain('exceeded');
        });

        it('should return exceeded when over session limit', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 1500 });
            const result = guard.checkLimits('s1');

            expect(result.exceeded).toBe(true);
            expect(result.currentUsage).toBe(1500);
            expect(result.limit).toBe(1000);
        });

        it('should check daily limit when userId provided', () => {
            guard.recordUsage({ sessionId: 's1', userId: 'u1', tokens: 5000 });
            const result = guard.checkLimits('s1', 'u1');

            // Session limit hit first (1000 < 5000)
            expect(result.exceeded).toBe(true);
            expect(result.limitType).toBe('session');
        });

        it('should return no warning for new session', () => {
            const result = guard.checkLimits('new-session');

            expect(result.exceeded).toBe(false);
            expect(result.warning).toBe(false);
            expect(result.currentUsage).toBe(0);
        });
    });

    describe('clearSession', () => {
        it('should clear session usage', () => {
            guard.recordUsage({ sessionId: 's1', tokens: 500 });
            expect(guard.getSessionUsage('s1')).toBe(500);

            guard.clearSession('s1');
            expect(guard.getSessionUsage('s1')).toBe(0);
        });
    });

    describe('getConfig', () => {
        it('should return current configuration', () => {
            const config = guard.getConfig();

            expect(config.perSessionLimit).toBe(1000);
            expect(config.perUserDailyLimit).toBe(5000);
            expect(config.warningThresholdPct).toBe(80);
        });
    });

    describe('unlimited limits', () => {
        it('should allow unlimited usage when limit is 0', () => {
            const unlimitedGuard = new TokenGuard({
                perSessionLimit: 0,
                perUserDailyLimit: 0,
            });

            unlimitedGuard.recordUsage({ sessionId: 's1', tokens: 1_000_000 });
            const result = unlimitedGuard.checkLimits('s1');

            expect(result.exceeded).toBe(false);
            expect(result.warning).toBe(false);
        });
    });

});







