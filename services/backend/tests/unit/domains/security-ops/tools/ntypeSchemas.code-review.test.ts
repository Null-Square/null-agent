import { describe, expect, it } from 'vitest';

import { ntypeSchemas } from '@/domains/security-ops/tools/ntypeSchemas';

const commitSha = 'a'.repeat(40);

describe('Code Review run.digest schema', () => {
  it('requires immutable repository identity for Code Review memory', () => {
    const result = ntypeSchemas['run.digest']?.safeParse({
      workflowDiscipline: 'code_review',
      goal: 'Review the authentication data flow.',
      outcome: 'completed',
    });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['repositoryId', 'immutableCommitSha']),
      );
    }
  });

  it('accepts Code Review memory bound to an immutable revision', () => {
    expect(
      ntypeSchemas['run.digest']?.safeParse({
        workflowDiscipline: 'code_review',
        repositoryId: 'repo-123',
        immutableCommitSha: commitSha,
        goal: 'Review the authentication data flow.',
        outcome: 'completed',
      }).success,
    ).toBe(true);
  });
});
