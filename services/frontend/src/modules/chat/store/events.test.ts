import { describe, expect, it } from 'vitest';
import {
  approvalDeniedFromServer,
  approvalGrantedFromServer,
  approvalNeededFromServer,
  planTurnComplete,
} from './events';

describe('chat store server events', () => {
  it('does not clear the plan on turn completion', () => {
    expect(planTurnComplete()).toEqual([]);
  });

  it('stores pending approvals from the stream', () => {
    expect(
      approvalNeededFromServer(
        {
          actionId: 'approval-1',
          tool: 'update_scope_brief',
          args: { safeMode: true },
          requestedAt: 123,
        },
        () => 'id-1',
      ),
    ).toEqual([
      {
        type: 'session/setPendingApproval',
        payload: {
          actionId: 'approval-1',
          tool: 'update_scope_brief',
          args: { safeMode: true },
          requestedAt: 123,
        },
      },
      { type: 'session/setStatus', payload: 'paused' },
      {
        type: 'session/setPauseMeta',
        payload: { pauseReason: 'approval', interactionType: 'none', blockedReason: null },
      },
      { type: 'session/setLoading', payload: false },
    ]);
  });

  it('clears approvals after a decision', () => {
    expect(approvalGrantedFromServer({ actionId: 'approval-1' }, () => 'id-1')).toEqual([
      { type: 'session/clearPendingApproval', payload: { actionId: 'approval-1' } },
      { type: 'session/setLoading', payload: false },
    ]);
    expect(approvalDeniedFromServer({ actionId: 'approval-1' }, () => 'id-1')).toEqual([
      { type: 'session/clearPendingApproval', payload: { actionId: 'approval-1' } },
      { type: 'session/setLoading', payload: false },
    ]);
  });
});
