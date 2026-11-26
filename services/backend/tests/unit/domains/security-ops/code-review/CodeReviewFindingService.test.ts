import { describe, expect, it } from 'vitest';

import {
  FinalizeCodeReviewReportSchema,
  ReportCodeReviewCandidateSchema,
  ValidateCodeReviewFindingSchema,
  buildCodeReviewFindingFingerprint,
  renderCodeReviewFindingMarkdown,
  resolveCodeReviewSourceAnchor,
} from '@/domains/security-ops/code-review/CodeReviewFindingService';
import type { CodeReviewFindingRow } from '@/db/schema';

describe('CodeReviewFindingService contracts', () => {
  it('keeps confidence internal when rendering a customer code-review finding', () => {
    const markdown = renderCodeReviewFindingMarkdown({
      title: 'Missing ownership check',
      severity: 'high',
      confidence: 0.93,
      category: 'authorization',
      changeAttribution: 'repository_scope',
      attributionRationale: null,
      fixability: 'fixable',
      fixabilityRationale: 'A bounded authorization guard can be added.',
      summary: 'A reachable handler returns records without checking ownership.',
      impact: 'A caller may read another account record.',
      locations: [{
        repositoryId: 'repository-1',
        repositoryFullName: 'nullsquare/backend',
        commitSha: 'c'.repeat(40),
        filePath: 'src/handler.ts',
        startLine: 20,
        endLine: 28,
        sourceExcerpt: 'return record;',
        sourceExcerptSha256: 'a'.repeat(64),
        sourceOriginalSha256: 'b'.repeat(64),
      }],
      remediation: 'Require ownership before returning the record.',
    } as CodeReviewFindingRow, 1);

    expect(markdown).toContain('- Severity: high');
    expect(markdown).toContain('- Category: authorization');
    expect(markdown).not.toContain('Confidence:');
    expect(markdown).not.toContain('93%');
  });

  describe('finding id shapes', () => {
    // A hosted run has no database and addresses findings by the sha256
    // fingerprint the report tool derives from their content. Requiring uuid
    // accepted only organization runs, so a hosted validation phase could
    // finish its analysis and still be unable to record the disposition —
    // which is how a run reached "completed" with every finding a candidate.
    const base = {
      findingVersion: 1,
      outcome: 'validated' as const,
      rationale: 'Reproduced at the pinned commit with a minimal case.',
      confidence: 0.9,
    };

    it('accepts the uuid an organization run uses', () => {
      expect(() => ValidateCodeReviewFindingSchema.parse({
        ...base,
        findingId: '3f8c2b1e-9d4a-4c7f-8e21-5a6b7c8d9e01',
      })).not.toThrow();
    });

    it('accepts the sha256 fingerprint a hosted run uses', () => {
      expect(() => ValidateCodeReviewFindingSchema.parse({
        ...base,
        findingId: 'a'.repeat(64),
      })).not.toThrow();
      expect(() => ValidateCodeReviewFindingSchema.parse({
        ...base,
        findingId: 'b1'.repeat(32),
      })).not.toThrow();
    });

    it('still rejects an identifier that is neither', () => {
      for (const findingId of ['', 'F-001', 'not-a-uuid', 'a'.repeat(63), 'z'.repeat(64)]) {
        expect(() => ValidateCodeReviewFindingSchema.parse({ ...base, findingId }))
          .toThrow();
      }
    });
  });

  it('defaults whole-repository candidates to repository-scope attribution', () => {
    const candidate = ReportCodeReviewCandidateSchema.parse({
      severity: 'high',
      confidence: 0.8,
      category: 'authorization',
      title: 'Missing ownership check',
      summary: 'A reachable handler returns records without checking ownership.',
      impact: 'A caller may read another account record.',
      remediation: 'Require ownership before returning the record.',
      locations: [{ filePath: 'src/handler.ts', sourceAnchor: 'return record;' }],
    });

    expect(candidate.changeAttribution).toBe('repository_scope');
  });

  it('requires an exact candidate version before recording a disposition', () => {
    const withoutVersion = ValidateCodeReviewFindingSchema.safeParse({
      findingId: '11111111-1111-4111-8111-111111111111',
      outcome: 'validated',
      rationale: 'The source path is reachable and the guard is missing.',
      confidence: 0.9,
      fixability: 'uncertain',
    });
    expect(withoutVersion.success).toBe(false);

    const withVersion = ValidateCodeReviewFindingSchema.safeParse({
      findingId: '11111111-1111-4111-8111-111111111111',
      findingVersion: 3,
      outcome: 'validated',
      rationale: 'The source path is reachable and the guard is missing.',
      confidence: 0.9,
      fixability: 'fixable',
      fixabilityRationale: 'A bounded authorization guard can be added.',
      expectedFiles: ['src/authorization.ts'],
      validationPlan: ['Run the authorization unit tests and a negative-control case.'],
    });
    expect(withVersion.success).toBe(true);
  });

  it('requires the reporting agent to declare honest review completeness', () => {
    expect(FinalizeCodeReviewReportSchema.safeParse({
      executiveSummary: 'No validated findings were recorded.',
      scopeSummary: 'Reviewed the bounded immutable path manifest.',
      limitations: ['Dynamic execution was not available.'],
    }).success).toBe(false);

    expect(FinalizeCodeReviewReportSchema.safeParse({
      executiveSummary: 'No validated findings were recorded.',
      scopeSummary: 'Reviewed the bounded immutable path manifest.',
      limitations: ['Dynamic execution was not available.'],
      completeness: 'partial',
    }).success).toBe(true);
  });

  it('keeps finding lineage stable when only commit and line positions change', () => {
    const input = ReportCodeReviewCandidateSchema.parse({
      severity: 'high',
      confidence: 0.9,
      category: 'authorization',
      title: 'Missing ownership check',
      summary: 'A reachable handler returns records without checking ownership.',
      impact: 'A caller may read another account record.',
      remediation: 'Require ownership before returning the record.',
      locations: [{ filePath: 'src/handler.ts', sourceAnchor: 'return record;' }],
    });
    const location = {
      repositoryId: 'repository-1',
      repositoryFullName: 'nullsquare/backend',
      filePath: 'src/handler.ts',
      startLine: 20,
      endLine: 28,
      sourceExcerpt: 'return record;',
      sourceExcerptSha256: 'a'.repeat(64),
      sourceOriginalSha256: 'b'.repeat(64),
    };

    const first = buildCodeReviewFindingFingerprint(input, [{
      ...location,
      commitSha: 'c'.repeat(40),
    }]);
    const moved = buildCodeReviewFindingFingerprint(input, [{
      ...location,
      commitSha: 'd'.repeat(40),
      startLine: 120,
      endLine: 128,
    }]);

    expect(moved).toBe(first);
  });

  it('resolves exact source anchors to backend-owned line ranges', () => {
    const location = ReportCodeReviewCandidateSchema.parse({
      severity: 'critical',
      confidence: 1,
      category: 'command-injection',
      title: 'Untrusted revision reaches a shell command',
      summary: 'A request value is interpolated into an executed command.',
      impact: 'An attacker can execute arbitrary commands.',
      remediation: 'Use an argument-vector API and validate the revision.',
      locations: [{
        filePath: 'src/revision.ts',
        sourceAnchor: 'const output = exec(`git show ${revision}`);',
        contextBeforeLines: 1,
        contextAfterLines: 0,
      }],
    }).locations[0];

    expect(resolveCodeReviewSourceAnchor(
      [
        'import { exec } from "node:child_process";',
        '',
        'export function showRevision(revision: string) {',
        '  const output = exec(`git show ${revision}`);',
        '  return output;',
        '}',
      ].join('\r\n'),
      location,
    )).toEqual({
      startLine: 3,
      endLine: 4,
      sourceExcerpt: [
        'export function showRevision(revision: string) {',
        '  const output = exec(`git show ${revision}`);',
      ].join('\n'),
    });
  });

  it('rejects ambiguous anchors until the caller selects an occurrence', () => {
    const ambiguous = ReportCodeReviewCandidateSchema.parse({
      severity: 'medium',
      confidence: 0.8,
      category: 'validation',
      title: 'Repeated unsafe conversion',
      summary: 'A repeated conversion requires a precise source citation.',
      impact: 'Malformed values may reach a sensitive operation.',
      remediation: 'Validate before conversion.',
      locations: [{
        filePath: 'src/repeated.ts',
        sourceAnchor: 'parse(input);',
        contextBeforeLines: 0,
        contextAfterLines: 0,
      }],
    }).locations[0];
    const content = ['parse(input);', 'guard();', 'parse(input);'].join('\n');

    expect(() => resolveCodeReviewSourceAnchor(content, ambiguous)).toThrow(
      'matched 2 locations',
    );
    expect(resolveCodeReviewSourceAnchor(content, {
      ...ambiguous,
      occurrence: 2,
    })).toMatchObject({
      startLine: 3,
      endLine: 3,
      sourceExcerpt: 'parse(input);',
    });
  });
});
