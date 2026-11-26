import { describe, expect, it } from 'vitest';
import { DefaultStages } from '@/domains/agent-brain/application/orchestration/stages';

describe('orchestration stages export surface', () => {
  it('only exposes the concrete stages that still own logic', () => {
    expect(Object.keys(DefaultStages).sort()).toEqual(['Build', 'Prepare', 'Reconcile']);
  });
});
