import { describe, expect, it } from 'vitest';
import { deriveSessionState, deriveStatus } from './deriveStatus.js';

describe('deriveStatus', () => {
  describe('blocked reasons', () => {
    it('maps credits exhaustion to paused/credits', () => {
      expect(deriveStatus({ blockedReason: 'credits_exhausted' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'credits_exhausted' })).toMatchObject({
        status: 'paused',
        pauseReason: 'credits',
        interactionType: 'none',
      });
    });

    it('maps legacy awaiting-user and guard exhaustion blocks to paused/manual', () => {
      expect(deriveStatus({ blockedReason: 'awaiting_user' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'awaiting_user' })).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
      });

      expect(deriveStatus({ blockedReason: 'guard_exhausted' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'guard_exhausted' })).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
      });
    });

    it('maps awaiting approval to paused/approval', () => {
      expect(deriveStatus({ blockedReason: 'awaiting_approval' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'awaiting_approval' })).toMatchObject({
        status: 'paused',
        pauseReason: 'approval',
        interactionType: 'none',
      });
    });

    it('maps manual pauses and cancelled-run session blocks to paused/manual', () => {
      expect(deriveStatus({ blockedReason: 'user_paused' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'user_paused' })).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
      });

      expect(deriveStatus({ blockedReason: 'aborted_by_user' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'aborted_by_user' })).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
      });
    });

    it('keeps retry states as running and hard errors as error', () => {
      expect(deriveStatus({ blockedReason: 'error_retry:llm_timeout' })).toBe('running');
      expect(deriveStatus({ blockedReason: 'guard_retry:pending_no_tools' })).toBe('running');
      expect(deriveStatus({ blockedReason: 'error' })).toBe('error');
    });

    it('maps recoverable runtime failures to paused/system', () => {
      expect(deriveStatus({ blockedReason: 'system_paused' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'system_paused' })).toMatchObject({
        status: 'paused',
        pauseReason: 'system',
        interactionType: 'none',
        blockedReason: 'system_paused',
      });
    });

    it('falls back unknown blocked reasons to paused/manual', () => {
      expect(deriveStatus({ blockedReason: 'unknown_reason' })).toBe('paused');
      expect(deriveSessionState({ blockedReason: 'unknown_reason' })).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
      });
    });
  });

  describe('priority order', () => {
    it('uses pending approval when no blocked reason is set', () => {
      expect(deriveStatus({ pendingApproval: { toolCallId: 'approval-1' } })).toBe('paused');
      expect(deriveSessionState({ pendingApproval: { toolCallId: 'approval-1' } })).toMatchObject({
        status: 'paused',
        pauseReason: 'approval',
        interactionType: 'none',
      });
    });

    it('returns running when processing and completed when finished', () => {
      expect(deriveStatus({ isProcessing: true })).toBe('running');
      expect(deriveStatus({ completed: true })).toBe('completed');
      expect(deriveStatus({ isProcessing: true, completed: true })).toBe('running');
    });

    it('lets blocked reasons override all other flags', () => {
      expect(
        deriveStatus({
          blockedReason: 'credits_exhausted',
          isProcessing: true,
          completed: true,
        }),
      ).toBe('paused');
    });
  });

  describe('defaults', () => {
    it('returns idle for empty inputs', () => {
      expect(deriveStatus(undefined)).toBe('idle');
      expect(deriveStatus({})).toBe('idle');
      expect(deriveStatus({ blockedReason: null, isProcessing: false })).toBe('idle');
    });
  });
});
