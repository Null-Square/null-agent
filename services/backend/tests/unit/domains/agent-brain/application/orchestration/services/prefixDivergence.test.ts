import { describe, expect, it } from 'vitest';
import {
  describePrefixDivergence,
  diffPrefixSections,
  digestPrefixSections,
} from '@/domains/agent-brain/application/orchestration/services/prefixDivergence';

/**
 * D17 — every `cache.resume` event in production run r1, all four of them, reported
 * `prefixStable: false`. Nothing said what had changed, so "can this be fixed?" had no
 * evidence behind it and the turn boundary stayed cold.
 *
 * A prefix is a list of named sections and the system holds both sides of the comparison.
 * This names what moved. It diagnoses; deciding what to do about a section that keeps moving
 * needs this answer first.
 */
const sections = (entries: Array<[string, string]>) =>
  entries.map(([key, content]) => ({ key, content }));

const digestsOf = (entries: Array<[string, string]>) =>
  digestPrefixSections(sections(entries));

describe('prompt prefix divergence', () => {
  it('reports no divergence when every section is identical', () => {
    const before = digestsOf([['contract', 'a'], ['scope', 'b']]);
    const after = digestsOf([['contract', 'a'], ['scope', 'b']]);

    expect(diffPrefixSections(before, after)).toEqual({
      changed: [],
      added: [],
      removed: [],
      orderStable: true,
      diverged: false,
    });
  });

  it('names the section whose content moved', () => {
    const before = digestsOf([['contract', 'a'], ['inventory', 'assets: 4']]);
    const after = digestsOf([['contract', 'a'], ['inventory', 'assets: 9']]);

    const divergence = diffPrefixSections(before, after);

    expect(divergence.changed).toEqual(['inventory']);
    expect(divergence.diverged).toBe(true);
    expect(describePrefixDivergence(divergence)).toBe('changed: inventory');
  });

  it('separates a section that appeared from one that changed', () => {
    const before = digestsOf([['contract', 'a']]);
    const after = digestsOf([['contract', 'b'], ['nudge', 'repair this']]);

    const divergence = diffPrefixSections(before, after);

    expect(divergence.changed).toEqual(['contract']);
    expect(divergence.added).toEqual(['nudge']);
    expect(describePrefixDivergence(divergence)).toBe('changed: contract; added: nudge');
  });

  it('names a section that disappeared', () => {
    const before = digestsOf([['contract', 'a'], ['nudge', 'repair this']]);
    const after = digestsOf([['contract', 'a']]);

    const divergence = diffPrefixSections(before, after);

    expect(divergence.removed).toEqual(['nudge']);
    expect(divergence.changed).toEqual([]);
  });

  it('treats a reorder as divergence, because a provider does', () => {
    const before = digestsOf([['contract', 'a'], ['scope', 'b']]);
    const after = digestsOf([['scope', 'b'], ['contract', 'a']]);

    const divergence = diffPrefixSections(before, after);

    expect(divergence.changed).toEqual([]);
    expect(divergence.orderStable).toBe(false);
    expect(divergence.diverged).toBe(true);
    expect(describePrefixDivergence(divergence)).toBe('section order moved');
  });

  it('claims no divergence when there is nothing to compare against', () => {
    // The first turn of a session has no previous prefix. That is not instability.
    expect(diffPrefixSections(undefined, digestsOf([['contract', 'a']])).diverged).toBe(false);
  });

  it('produces a digest short enough to carry between turns', () => {
    const [entry] = digestsOf([['contract', 'a'.repeat(50_000)]]);

    expect(entry?.digest).toHaveLength(16);
    expect(entry?.key).toBe('contract');
  });

  it('gives the same digest for the same content', () => {
    expect(digestsOf([['a', 'same']])[0]?.digest).toBe(digestsOf([['a', 'same']])[0]?.digest);
    expect(digestsOf([['a', 'one']])[0]?.digest).not.toBe(digestsOf([['a', 'two']])[0]?.digest);
  });

  it('says plainly when nothing moved', () => {
    expect(describePrefixDivergence({
      changed: [], added: [], removed: [], orderStable: true, diverged: false,
    })).toBe('the prefix is unchanged');
  });
});
