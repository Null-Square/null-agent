import { describe, expect, it, vi } from 'vitest';

import {
  RunContextService,
  workflowDisciplineForStrategicNote,
} from '@/domains/security-ops/runs/RunContextService';

const note = (workflowDiscipline?: string) => ({
  ntype: 'run.digest' as const,
  data: workflowDiscipline ? { workflowDiscipline } : {},
});

describe('Code Review strategic memory discipline', () => {
  it('keeps explicit Code Review memory out of Pentest identity', () => {
    expect(workflowDisciplineForStrategicNote(note('code_review'))).toBe('code_review');
  });

  it('marks unknown explicit disciplines unknown rather than Pentest', () => {
    expect(workflowDisciplineForStrategicNote(note('future_product'))).toBe('unknown');
  });

  it('preserves the historical missing-discipline default without reclassifying explicit values', () => {
    expect(workflowDisciplineForStrategicNote(note())).toBe('pentest');
    expect(
      workflowDisciplineForStrategicNote({
        ntype: 'scan.coverage',
        data: {},
      }),
    ).toBe('shared');
  });

  it('never queries the shared strategic-memory feed for standalone Code Review', async () => {
    const select = vi.fn();
    const service = new RunContextService({ select } as never, {} as never);

    await expect(
      service.getStrategicNotesForMemorySeed('org-1', 'scope-1', 'code_review'),
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
