import { describe, expect, it } from 'vitest';

import { projectRunPhaseRows } from '@/domains/security-ops/runs/runPhaseProjection';

describe('run phase projection', () => {
  it('projects typed exploitation denials as skipped with a user-visible reason', () => {
    expect(projectRunPhaseRows([{
      id: 'phase-exploitation',
      ordinal: 4,
      phaseKey: 'exploitation',
      status: 'completed',
      sessionId: null,
      startedAt: '2026-07-25T10:00:00.000Z',
      completedAt: '2026-07-25T10:00:01.000Z',
      lastError: 'controlled_exploitation_skipped:no_same_run_validated_finding',
    }], 'running')).toEqual([
      expect.objectContaining({
        phase: 'exploitation',
        status: 'skipped',
        rawStatus: 'completed',
        reason: 'no_same_run_validated_finding',
      }),
    ]);
  });
});
