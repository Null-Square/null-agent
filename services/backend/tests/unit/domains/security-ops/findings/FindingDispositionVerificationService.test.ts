import { describe, expect, it } from 'vitest';

import {
  assertFindingDispositionProof,
  dispositionEvidenceReferenceResolves,
  isAllowedFindingDispositionOutcome,
  type DispositionVerificationProof,
} from '@/domains/security-ops/findings/FindingDispositionVerificationService';

const proof = (
  values: Partial<DispositionVerificationProof> = {},
): DispositionVerificationProof => ({
  claim: 'The host parameter reaches a shell.',
  replayAttempted: true,
  replayReproduced: false,
  prerequisitesSatisfied: true,
  evidenceIds: ['replay-exchange'],
  controlEvidenceIds: ['normal-control-exchange'],
  ...values,
});

describe('FindingDispositionVerificationService contracts', () => {
  it('resolves a current-session source alias only when it was materialized as durable evidence', () => {
    const rows = [{
      id: 'evidence-row',
      path: 'http_exchange:abc',
      displayPath: 'GET https://target.test/replay',
      label: 'replay',
    }];
    expect(dispositionEvidenceReferenceResolves(
      'history-entry-id',
      rows,
      new Set(['history-entry-id']),
    )).toBe(true);
    expect(dispositionEvidenceReferenceResolves(
      'old-history-entry-id',
      rows,
      new Set(),
    )).toBe(false);
  });

  it.each([
    ['resolved', 'fixed', true],
    ['resolved', 'still_present', true],
    ['resolved', 'inconclusive', true],
    ['resolved', 'false_positive', false],
    ['resolved', 'validated', false],
    ['dismissed', 'false_positive', true],
    ['dismissed', 'validated', true],
    ['dismissed', 'inconclusive', true],
    ['dismissed', 'fixed', false],
    ['dismissed', 'still_present', false],
  ] as const)(
    'maps request %s and outcome %s to allowed=%s',
    (request, outcome, allowed) => {
      expect(isAllowedFindingDispositionOutcome(request, outcome)).toBe(allowed);
    },
  );

  it('accepts fixed only with non-reproduction and working controls', () => {
    expect(() => assertFindingDispositionProof({
      outcome: 'fixed',
      proof: proof(),
    })).not.toThrow();

    for (const invalid of [
      proof({ replayAttempted: false }),
      proof({ replayReproduced: true }),
      proof({ prerequisitesSatisfied: false }),
      proof({ evidenceIds: [] }),
      proof({ controlEvidenceIds: [] }),
    ]) {
      expect(() => assertFindingDispositionProof({
        outcome: 'fixed',
        proof: invalid,
      })).toThrow();
    }
  });

  it.each(['still_present', 'validated'] as const)(
    '%s requires fresh reproducing evidence',
    (outcome) => {
      expect(() => assertFindingDispositionProof({
        outcome,
        proof: proof({
          replayReproduced: true,
          controlEvidenceIds: [],
        }),
      })).not.toThrow();
      expect(() => assertFindingDispositionProof({
        outcome,
        proof: proof({ replayReproduced: false }),
      })).toThrow();
      expect(() => assertFindingDispositionProof({
        outcome,
        proof: proof({ replayReproduced: true, evidenceIds: [] }),
      })).toThrow();
    },
  );

  it('requires false-positive disproof plus functioning controls', () => {
    expect(() => assertFindingDispositionProof({
      outcome: 'false_positive',
      proof: proof(),
    })).not.toThrow();
    expect(() => assertFindingDispositionProof({
      outcome: 'false_positive',
      proof: proof({ prerequisitesSatisfied: false }),
    })).toThrow();
    expect(() => assertFindingDispositionProof({
      outcome: 'false_positive',
      proof: proof({ controlEvidenceIds: [] }),
    })).toThrow();
  });

  it('requires a blocker code for inconclusive and no reproduction evidence', () => {
    expect(() => assertFindingDispositionProof({
      outcome: 'inconclusive',
      blockerCode: 'target_unavailable',
      proof: proof({
        replayAttempted: false,
        replayReproduced: undefined,
        prerequisitesSatisfied: false,
        evidenceIds: [],
        controlEvidenceIds: [],
      }),
    })).not.toThrow();
    expect(() => assertFindingDispositionProof({
      outcome: 'inconclusive',
      proof: proof(),
    })).toThrow();
  });
});
