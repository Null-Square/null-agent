import { describe, expect, it } from 'vitest';

import {
  CodeReviewCreateBodySchema,
  CodeReviewRunBundleSchema,
  ComplianceAssessmentCreateBodySchema,
  RunCreateBodySchema,
  RunSummarySchema,
} from '@/interfaces/http/controllers/runs.schemas';

describe('run creation API schema', () => {
  it.each([
    [RunCreateBodySchema, { scopeId: 'scope-1', goal: 'Assess the target' }],
    [
      CodeReviewCreateBodySchema,
      { scopeId: '11111111-1111-4111-8111-111111111111' },
    ],
    [
      ComplianceAssessmentCreateBodySchema,
      { scopeId: 'scope-1', framework: 'soc2' },
    ],
  ])('does not expose a caller-controlled plan approval bypass', (schema, body) => {
    const parsed = schema.parse({ ...body, autoApproveOnPlanning: true });

    expect(parsed).not.toHaveProperty('autoApproveOnPlanning');
  });
});

describe('Code Review run API schema', () => {
  it('serializes Code Review as a first-class run discipline', () => {
    const result = RunSummarySchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      scopeId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      goal: 'Review the selected immutable revision.',
      workflowDiscipline: 'code_review',
      status: 'queued',
      trigger: 'manual',
      displayId: 'RUN-001',
      scopeName: 'Repository review',
    });

    expect(result.success).toBe(true);
  });

  it('requires durable fix-request state in the canonical Code Review bundle', () => {
    const result = CodeReviewRunBundleSchema.safeParse({
      context: {},
      findings: [],
      report: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['fixRequests'] }),
      ]));
    }
  });
});
