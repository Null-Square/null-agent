import { describe, expect, it } from 'vitest';
import {
  REDUCED_SLOT_ESTIMATED_TOKENS,
  planToolResultReduction,
  type ToolResultReductionOptions,
  type ToolResultSlot,
} from '@/domains/agent-brain/application/orchestration/tool-results/ToolResultReductionPlan';

/**
 * A cold cache: nothing is being served from the provider's cache, so a rewrite destroys
 * nothing and the economic gate is satisfied by construction. These cases are about the
 * quantized boundary; the gate has its own cases below.
 */
const options: ToolResultReductionOptions = {
  windowTokens: 1_000,
  targetTokens: 500,
  keepLastToolResults: 2,
  maxResultTokens: 300,
  maxResultChars: 1_200,
  economics: { expectedRemainingRequests: 10, cachedPrefixTokensAtRisk: 0 },
};

/** `count` tool results of `tokens` each, at message indices 1, 3, 5, ... */
const slots = (count: number, tokens = 400): ToolResultSlot[] =>
  Array.from({ length: count }, (_entry, index) => ({
    index: index * 2 + 1,
    toolName: 'http_payload',
    contentChars: tokens * 4,
    tokens,
    alreadyReduced: false,
    reducible: true,
  }));

/** Applies a decision the way a call site does, so a re-plan sees reduced slots. */
const apply = (
  input: ToolResultSlot[],
  reduceIndices: ReadonlySet<number>,
): ToolResultSlot[] => input.map((slot) => (reduceIndices.has(slot.index)
  ? {
    ...slot,
    tokens: REDUCED_SLOT_ESTIMATED_TOKENS,
    contentChars: REDUCED_SLOT_ESTIMATED_TOKENS * 4,
    alreadyReduced: true,
  }
  : slot));

describe('tool result reduction plan', () => {
  it('reduces nothing until output is a full window behind the frontier', () => {
    // Four results of 400 tokens is 1,600: past one window, not yet two.
    const decision = planToolResultReduction(slots(4), options);

    expect(decision.evaluated).toBe(true);
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe('below_trigger');
    expect(decision.generation).toBe(1);
    expect(decision.firstChangedIndex).toBeNull();
  });

  it('is stable across every turn inside one generation', () => {
    // 5..7 results all sit in generation 2, so the reduced set must not move.
    const sets = [5, 6, 7].map((count) => {
      const decision = planToolResultReduction(slots(count), options);
      return {
        generation: decision.generation,
        indices: [...decision.reduceIndices].sort((a, b) => a - b).join(','),
        firstChangedIndex: decision.firstChangedIndex,
      };
    });

    expect(sets.map((entry) => entry.generation)).toEqual([2, 2, 2]);
    expect(new Set(sets.map((entry) => entry.indices)).size).toBe(1);
    expect(new Set(sets.map((entry) => entry.firstChangedIndex)).size).toBe(1);
  });

  it('advances the boundary forward when the generation changes', () => {
    // D15: each generation owns one window-wide band and reduces only that. The band moves
    // toward the tail; it does not return to the head and re-rewrite what is already reduced.
    let history = slots(7);
    const first = planToolResultReduction(history, options);
    expect(first.generation).toBe(2);
    expect(first.changed).toBe(true);

    history = apply(history, first.reduceIndices);
    // Grow until the generation advances, applying nothing in between.
    let second = planToolResultReduction(history, options);
    for (let count = 8; count <= 16 && second.generation < 3; count += 1) {
      history = [...apply(slots(count), first.reduceIndices)];
      second = planToolResultReduction(history, options);
    }

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.changed).toBe(true);
    // The new band is strictly later, and it does not touch what generation 2 reduced.
    expect(second.firstChangedIndex).toBeGreaterThan(first.firstChangedIndex!);
    for (const index of first.reduceIndices) {
      expect(second.reduceIndices.has(index)).toBe(false);
    }
  });

  it('never moves the boundary back toward the head as history grows', () => {
    // The property the provider cache actually depends on. Before D15 the plan reduced
    // everything up to the horizon oldest-first, so every firing rewrote message 3 or 4.
    let history = slots(6);
    let lowestBoundarySeen: number | null = null;

    for (let count = 6; count <= 40; count += 1) {
      const decision = planToolResultReduction(history, options);
      if (decision.changed) {
        if (lowestBoundarySeen !== null) {
          expect(decision.firstChangedIndex).toBeGreaterThanOrEqual(lowestBoundarySeen);
        }
        lowestBoundarySeen = decision.firstChangedIndex!;
        history = apply(history, decision.reduceIndices);
      }
      // One more raw tool result arrives.
      history = [...history, ...slots(count + 1).slice(count)];
    }

    expect(lowestBoundarySeen).not.toBeNull();
  });

  it('converges: applying the plan and re-planning changes nothing', () => {
    const first = planToolResultReduction(slots(6), options);
    expect(first.changed).toBe(true);

    const applied = apply(slots(6), first.reduceIndices);
    const second = planToolResultReduction(applied, options);

    expect(second.changed).toBe(false);
    expect(second.firstChangedIndex).toBeNull();
  });

  it('is a pure function of the slots it is given', () => {
    const input = slots(6);
    const a = planToolResultReduction(input, options);
    const b = planToolResultReduction(input, options);

    expect([...a.reduceIndices]).toEqual([...b.reduceIndices]);
    expect(a.generation).toBe(b.generation);
    expect(a.projectedToolResultTokens).toBe(b.projectedToolResultTokens);
  });

  it('reports the reduced set as an ordered array, not only as a Set', () => {
    // A Set serialises to `{}`, so the production trace recorded which generation fired
    // without ever recording what it rewrote.
    const decision = planToolResultReduction(slots(6), options);

    expect(decision.reducedIndices).toEqual([...decision.reduceIndices].sort((a, b) => a - b));
    expect(JSON.parse(JSON.stringify({ reducedIndices: decision.reducedIndices }))).toEqual({
      reducedIndices: decision.reducedIndices,
    });
  });

  it('names the earliest message it will rewrite', () => {
    const decision = planToolResultReduction(slots(6), options);

    const earliest = Math.min(...decision.reduceIndices);
    expect(decision.firstChangedIndex).toBe(earliest);
  });

  it('never reduces the protected recent results', () => {
    const input = slots(8);
    const decision = planToolResultReduction(input, options);
    const protectedIndices = input.slice(-options.keepLastToolResults).map((slot) => slot.index);

    for (const index of protectedIndices) {
      expect(decision.reduceIndices.has(index)).toBe(false);
    }
    expect(decision.protectedRecentResults).toBe(options.keepLastToolResults);
  });

  it('never reduces a result that is already reduced', () => {
    const input = apply(slots(8), new Set([1, 3]));
    const decision = planToolResultReduction(input, options);

    expect(decision.reduceIndices.has(1)).toBe(false);
    expect(decision.reduceIndices.has(3)).toBe(false);
  });

  it('never reduces a result whose tool output must be kept verbatim', () => {
    const input = slots(8).map((slot, position) => (position === 0
      ? { ...slot, reducible: false }
      : slot));
    const decision = planToolResultReduction(input, options);

    expect(decision.reduceIndices.has(1)).toBe(false);
  });

  it('does not summarise a result too small to save anything', () => {
    // Enough of them to be well past the boundary, so the floor is what stops the plan.
    const input = slots(16, REDUCED_SLOT_ESTIMATED_TOKENS);
    const decision = planToolResultReduction(input, options);

    expect(decision.generation).toBeGreaterThanOrEqual(2);
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe('no_eligible_candidates');
  });

  it('overrides the per-result size threshold under aggregate pressure', () => {
    // Individually modest results that still add up past the window.
    const modest = slots(8, 250);
    const decision = planToolResultReduction(modest, {
      ...options,
      maxResultTokens: 99_999,
      maxResultChars: 99_999,
    });

    expect(decision.changed).toBe(true);
  });

  it('bypasses the quantized boundary when an independent authority forces reduction', () => {
    const belowTrigger = slots(4);

    expect(planToolResultReduction(belowTrigger, options).changed).toBe(false);
    const forced = planToolResultReduction(belowTrigger, { ...options, forceReduction: true });

    expect(forced.changed).toBe(true);
    expect(forced.forced).toBe(true);
    expect(forced.projectedToolResultTokens).toBeLessThan(forced.toolResultTokensBefore);
    // It reduces everything it is allowed to. The protected recent results can still hold
    // the tail above the target, and that floor is deliberate: the newest evidence stays.
    expect(forced.reduceIndices.size).toBe(forced.eligibleCandidates);
  });

  it('still finds a band when a single result is larger than the whole window', () => {
    // A 2,200-token http_payload result against a 1,000-token window: no cumulative position
    // lands inside a 1,000-wide band, so the band came back empty and the plan reported
    // `no_candidates` while there was plenty to reduce.
    const oversized = slots(6, 2_200);
    const decision = planToolResultReduction(oversized, options);

    expect(decision.changed).toBe(true);
    expect(decision.reason).toBe('reduced');
    expect(decision.reduceIndices.size).toBeGreaterThan(0);
  });

  it('picks the same fallback result on every turn inside one generation', () => {
    const sets = [6, 7].map((count) => {
      const decision = planToolResultReduction(slots(count, 2_200), options);
      return { generation: decision.generation, indices: decision.reducedIndices.join(',') };
    });

    if (sets[0]!.generation === sets[1]!.generation) {
      expect(sets[0]!.indices).toBe(sets[1]!.indices);
    }
  });

  it('reduces at most one window of raw output per firing', () => {
    // D15: a firing rewrites one band, not the whole history behind the horizon. That bound
    // is what keeps the cost of a single rewrite proportional to what it saves.
    for (let count = 5; count <= 40; count += 1) {
      const decision = planToolResultReduction(slots(count), options);
      if (!decision.changed) continue;

      const reducedTokens = slots(count)
        .filter((slot) => decision.reduceIndices.has(slot.index))
        .reduce((total, slot) => total + slot.tokens, 0);

      // One window, plus at most the one result that straddles its edge.
      expect(reducedTokens).toBeLessThanOrEqual(options.windowTokens + options.maxResultTokens);
    }
  });

  it('keeps reducing as history grows, so nothing is abandoned', () => {
    // Deferred, not abandoned: applying each plan in turn keeps the raw carry bounded.
    let history = slots(6);
    let firings = 0;

    for (let count = 6; count <= 40; count += 1) {
      const decision = planToolResultReduction(history, options);
      if (decision.changed) {
        firings += 1;
        history = apply(history, decision.reduceIndices);
      }
      history = [...history, ...slots(count + 1).slice(count)];
    }

    expect(firings).toBeGreaterThan(1);
    const rawRemaining = history
      .filter((slot) => !slot.alreadyReduced)
      .reduce((total, slot) => total + slot.tokens, 0);
    // The raw carry stays bounded rather than growing with the whole history.
    expect(rawRemaining).toBeLessThan(options.windowTokens * 4);
  });

  describe('the economic gate on the ordinary path', () => {
    const warm = (
      overrides: Partial<ToolResultReductionOptions['economics'] & object> = {},
    ): ToolResultReductionOptions => ({
      ...options,
      economics: {
        expectedRemainingRequests: 4,
        cachedPrefixTokensAtRisk: 40_000,
        ...overrides,
      },
    });

    it('refuses to rewrite a warm prefix when nobody priced the rewrite', () => {
      const { economics: _dropped, ...withoutEconomics } = options;
      const decision = planToolResultReduction(slots(6), withoutEconomics);

      expect(decision.changed).toBe(false);
      expect(decision.reason).toBe('economics_unknown');
      expect(decision.economics).toBeNull();
    });

    it('refuses a reduction that costs more cache than it saves prompt', () => {
      const decision = planToolResultReduction(slots(6), warm());

      expect(decision.changed).toBe(false);
      expect(decision.reason).toBe('negative_economics');
      expect(decision.economics?.profitable).toBe(false);
      expect(decision.economics?.lossTokens).toBeGreaterThan(decision.economics!.benefitTokens);
    });

    it('reproduces the production firing that should never have run', () => {
      // Run r1, second same-turn compaction: it saved 7,311 prompt tokens and had exactly
      // one model call left to earn that back, against a ~47,000-token warm prefix.
      const decision = planToolResultReduction(slots(6), {
        ...options,
        economics: { expectedRemainingRequests: 1, cachedPrefixTokensAtRisk: 47_247 },
      });

      expect(decision.changed).toBe(false);
      expect(decision.reason).toBe('negative_economics');
    });

    it('allows an aggressive reduction when the cache is known cold', () => {
      const decision = planToolResultReduction(slots(6), warm({ cachedPrefixTokensAtRisk: 0 }));

      expect(decision.changed).toBe(true);
      expect(decision.economics?.lossTokens).toBe(0);
      expect(decision.economics?.profitable).toBe(true);
    });

    it('allows a reduction with enough remaining requests to earn the rewrite back', () => {
      // The plan reduces two 400-token results to 160 each: 480 saved per later request.
      // A 100-token warm prefix re-read at 30x costs 2,900, so it takes seven requests to
      // break even and eight to clear it.
      const marginal = planToolResultReduction(slots(6), warm({
        cachedPrefixTokensAtRisk: 100,
        expectedRemainingRequests: 8,
      }));

      expect(marginal.changed).toBe(true);
      expect(marginal.economics?.benefitTokens).toBeGreaterThan(marginal.economics!.lossTokens);
    });

    it('never blocks a forced reduction, which answers overflow rather than economics', () => {
      const { economics: _dropped, ...withoutEconomics } = options;
      const forced = planToolResultReduction(slots(6), {
        ...withoutEconomics,
        forceReduction: true,
      });

      expect(forced.changed).toBe(true);
      expect(forced.forced).toBe(true);
      expect(forced.economics).toBeNull();
    });

    it('prices the loss at the full cache-miss premium, never at face value', () => {
      const decision = planToolResultReduction(slots(6), warm({
        cachedPrefixTokensAtRisk: 1_000,
        cacheMissPremium: 30,
      }));

      // 1,000 cached tokens re-read at 30x cost 29,000 hit-token equivalents, not 1,000.
      expect(decision.economics?.lossTokens).toBe(29_000);
    });
  });
});
