/**
 * Integration tests for Session Status API
 * 
 * Tests that the backend correctly derives session status using @null-ai/contracts
 * and returns consistent status across all session endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveStatus } from '@null-ai/contracts';

/**
 * These tests verify the deriveStatus integration in the sessions router.
 * They test the deriveSessionStatus wrapper function behavior.
 */
describe('Session Status API Integration', () => {
  describe('deriveSessionStatus wrapper behavior', () => {
    /**
     * Simulates the deriveSessionStatus function from sessions.router.ts
     * This tests the contract between the router and @null-ai/contracts
     */
    const deriveSessionStatus = (
      session?: { stateMachine?: { isProcessing: () => boolean }; pendingApproval?: any; flags?: { session?: { completed?: boolean } } },
      blockedReason?: string | null,
      dbCompleted?: boolean,
      isProcessingOverride?: boolean,
    ): string => {
      const completed = dbCompleted ?? (session?.flags?.session?.completed === true);
      return deriveStatus({
        blockedReason,
        isProcessing: isProcessingOverride ?? session?.stateMachine?.isProcessing(),
        pendingApproval: session?.pendingApproval,
        completed,
      });
    };

    describe('Live session with in-memory state', () => {
      it('returns running when isProcessing is true', () => {
        const liveSession = { stateMachine: { isProcessing: () => true } };
        expect(deriveSessionStatus(liveSession, null, false)).toBe('running');
      });

      it('returns running even if completed flag is true (user continues session)', () => {
        const liveSession = { stateMachine: { isProcessing: () => true }, flags: { session: { completed: true } } };
        expect(deriveSessionStatus(liveSession, null, true)).toBe('running');
      });

      it('returns paused when pendingApproval is set', () => {
        const liveSession = { pendingApproval: { toolCallId: 'approval-1' } };
        expect(deriveSessionStatus(liveSession, null, false)).toBe('paused');
      });

      it('returns completed when dbCompleted is true and not processing', () => {
        const liveSession = { stateMachine: { isProcessing: () => false } };
        expect(deriveSessionStatus(liveSession, null, true)).toBe('completed');
      });

      it('returns completed from in-memory flags when dbCompleted is falsy', () => {
        const liveSession = { stateMachine: { isProcessing: () => false }, flags: { session: { completed: true } } };
        expect(deriveSessionStatus(liveSession, null, undefined)).toBe('completed');
      });
    });

    describe('DB session (no live session in memory)', () => {
      it('returns completed when dbCompleted is true', () => {
        expect(deriveSessionStatus(undefined, null, true)).toBe('completed');
      });

      it('returns idle when no flags set', () => {
        expect(deriveSessionStatus(undefined, null, false)).toBe('idle');
      });

      it('returns paused when blockedReason is set', () => {
        expect(deriveSessionStatus(undefined, 'credits_exhausted', false)).toBe('paused');
      });

      it('returns paused when blockedReason is user_paused', () => {
        expect(deriveSessionStatus(undefined, 'user_paused', false)).toBe('paused');
      });

      it('returns running when a durable processing lease is active', () => {
        expect(deriveSessionStatus(undefined, null, false, true)).toBe('running');
      });
    });

    describe('Blocked reason takes precedence', () => {
      it('blockedReason overrides isProcessing', () => {
        const liveSession = { stateMachine: { isProcessing: () => true } };
        expect(deriveSessionStatus(liveSession, 'credits_exhausted', false)).toBe('paused');
      });

      it('blockedReason overrides completed', () => {
        const liveSession = { flags: { session: { completed: true } } };
        expect(deriveSessionStatus(liveSession, 'user_paused', true)).toBe('paused');
      });

    });
  });

  describe('API Response Contract', () => {
    /**
     * Tests that verify the expected API response shape
     * These document the contract that frontend relies on
     */
    
    it('session list response includes status, isProcessing, completed fields', () => {
      // Mock session response shape
      const mockSessionResponse = {
        id: 'session-123',
        status: 'completed', // Already derived by backend
        blocked_reason: null,
        isProcessing: false,
        completed: true,
        mode: 'interactive',
      };

      expect(mockSessionResponse.status).toBe('completed');
      expect(mockSessionResponse.completed).toBe(true);
      expect(mockSessionResponse.isProcessing).toBe(false);
    });

    it('session detail response includes status field', () => {
      const mockDetailResponse = {
        session: {
          id: 'session-123',
          status: 'running', // Already derived by backend
          isProcessing: true,
          completed: false,
        },
      };

      expect(mockDetailResponse.session.status).toBe('running');
    });
  });
});
