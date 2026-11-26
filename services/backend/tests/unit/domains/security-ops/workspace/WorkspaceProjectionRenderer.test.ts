import { describe, expect, it } from 'vitest';

import { WorkspaceProjectionRenderer } from '@/domains/security-ops/workspace/WorkspaceProjectionRenderer';

describe('WorkspaceProjectionRenderer rules of engagement', () => {
  it('does not present the plan-approval preference as testing authority', () => {
    const markdown = new WorkspaceProjectionRenderer().renderRoeMarkdown({
      scope: {
        safeMode: true,
        stealthPosture: 'coordinated',
        impactTolerance: 'non_destructive',
        rateLimitRps: 2,
        blastWindow: null,
        roeDocument: 'Do not alter production data.',
      },
    } as never);

    expect(markdown).not.toContain('Safe mode');
    expect(markdown).toContain('Impact tolerance: non_destructive');
    expect(markdown).toContain('Do not alter production data.');
  });
});
