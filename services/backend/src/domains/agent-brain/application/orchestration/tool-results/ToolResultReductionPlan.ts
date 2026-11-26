import { TOOL_RESULT_POLICY_VERSION } from './ToolResultPolicy';

/**
 * E12 Slice B — the single owner of the decision to reduce a tool result.
 *
 * Two call sites reduce tool results: `ToolResultMicrocompactor` across turns and
 * `SameTurnCompactor` within one. They held the same rule twice, on two message shapes, and
 * could not agree on when a reduction had already happened. This module owns the decision;
 * the call sites own only reading and writing their own shape.
 *
 * ## Why the rule changed
 *
 * The previous rule reduced every tool result older than the last `keepLastToolResults`,
 * and enabled itself on a **count** of tool results. The protected window slides forward as
 * new results arrive, so on every turn exactly one further message left the window and was
 * rewritten. A rewrite invalidates provider cache reuse from that message onward, so the
 * loop paid an uncached re-read on every turn, for ever.
 *
 * Measured on a 35-turn fixture before this change: a rewrite on every turn after the
 * eighth tool result, and 72.9% of all prompt tokens re-read uncached.
 *
 * ## Why a batch alone was not enough
 *
 * This projection does not mutate stored history. It is recomputed from raw messages on
 * every turn, so "reduce until the tail fits a target" still recomputes a slightly
 * different answer each turn and the boundary still creeps forward one result at a time.
 *
 * The boundary has to be **quantized**, not merely batched:
 *
 * > Let `frontier` be the cumulative raw tokens of all tool results. Let
 * > `generation = floor(frontier / windowTokens)`. Reduce exactly those results whose
 * > cumulative position is at or before `(generation - 1) * windowTokens`.
 *
 * The reduced set then changes only when the frontier crosses a multiple of
 * `windowTokens`, and the un-reduced tail always holds between one and two windows of raw
 * output. Between crossings the projection is byte-identical, so the prefix is stable and
 * the loop pays for a rewrite once per window of new tool output instead of once per turn.
 *
 * Carrying up to two windows of cached tool output is far cheaper than re-reading the
 * suffix uncached: on DeepSeek V4 Pro a cache miss costs 30x a cache hit.
 *
 * ## Properties this must hold
 *
 * - **Pure.** The decision is a function of the message history alone. No clock, no
 *   randomness, no external state — so a restart replays the identical projection without
 *   needing a durable transformation ledger.
 * - **Convergent.** Applying the plan and re-planning yields `changed: false`. A result is
 *   never reduced twice.
 * - **Monotone.** `generation` only increases as history grows, so the reduced set only
 *   grows. A reduction is never undone and the prefix never diverges backwards.
 * - **Stable.** Two consecutive turns inside one generation produce an identical reduced
 *   set, which is the property the provider cache actually depends on.
 * - **Attributable.** `firstChangedIndex` names the earliest message the plan will rewrite,
 *   which is exactly the boundary E12 cache lineage declares.
 *
 * ## Why quantization alone was still not enough
 *
 * The first production run fired this plan twice, both times on the ordinary path with no
 * prompt pressure. It removed 14,924 tokens for roughly $0.0929 of excess cache-miss spend
 * and about $0.0005 of downstream saving — near 185:1 negative. The second firing had
 * **one** model call left to amortize the rewrite over.
 *
 * Frequency was never the whole problem. A reduction that is rare and unprofitable is still
 * unprofitable. So the ordinary path now has to pay for itself before it runs — see
 * `ToolResultReductionEconomics` below. Hard pressure (`forceReduction`) still bypasses
 * everything, because the alternative there is a failed request.
 */

/** Conservative estimate of the reduced stub: status, tool, capped summary, and provenance. */
export const REDUCED_SLOT_ESTIMATED_TOKENS = 160;

/**
 * Cache-miss input price divided by cache-hit input price. DeepSeek V4 Pro publishes 30x
 * off-peak, which is the route this harness defaults to. A call site that knows its own
 * provider's ratio should pass it.
 */
export const DEFAULT_CACHE_MISS_PREMIUM = 30;

export type ToolResultReductionReason =
  | 'below_trigger'
  | 'no_eligible_candidates'
  | 'economics_unknown'
  | 'negative_economics'
  | 'reduced';

/** One tool result, read out of whichever message shape the call site owns. */
export interface ToolResultSlot {
  /** Position in the caller's message array. */
  index: number;
  toolName: string | undefined;
  contentChars: number;
  tokens: number;
  /** True when this result already carries a reduction marker. */
  alreadyReduced: boolean;
  /** False when the tool's output must never be replaced by a summary. */
  reducible: boolean;
}

/**
 * E12 Slice E, minimal — what the ordinary path needs to know before it rewrites a prefix
 * the provider is already serving from cache.
 *
 * Omitting this refuses ordinary reduction. That is deliberate: a warm cache is not rewritten
 * on a guess, and the live conformance leg proved the guess would be wrong. An early rewrite
 * that left ~3,500 structurally identical leading tokens received **zero** reuse from
 * DeepSeek, while a late rewrite kept 3,968. A structural prefix match is an upper bound on
 * what a provider will serve, never a prediction of it.
 */
export interface ToolResultReductionEconomics {
  /**
   * How many further model requests are expected to reuse this prefix. Callers should pass
   * an upper bound rather than a pessimistic one, so that a refusal can never be blamed on
   * an under-count.
   */
  expectedRemainingRequests: number;
  /**
   * Prefix tokens the provider is currently expected to serve from cache and which this
   * rewrite puts at risk. Pass **0 when the cache is known cold** — there is no warm value to
   * protect, so reduction is free and should happen aggressively.
   *
   * A function is the precise form: since D15 the boundary lands wherever this generation's
   * band starts, so only the tokens from that message onward are lost. The caller knows its
   * own message list and can answer exactly; the planner supplies `firstChangedIndex` once
   * it has chosen the band.
   *
   * A plain number means "this much is at risk wherever the boundary lands", which is the
   * conservative reading for a caller that cannot measure by position.
   */
  cachedPrefixTokensAtRisk: number | ((firstChangedIndex: number) => number);
  /** Defaults to `DEFAULT_CACHE_MISS_PREMIUM`. */
  cacheMissPremium?: number;
  /** Multiplier the benefit must clear. Defaults to 1 — break-even is already generous. */
  safetyFactor?: number;
}

/** What the gate computed, in cache-hit token equivalents, so a trace can be audited. */
export interface ToolResultReductionEconomicsAssessment {
  benefitTokens: number;
  lossTokens: number;
  expectedRemainingRequests: number;
  cachedPrefixTokensAtRisk: number;
  cacheMissPremium: number;
  safetyFactor: number;
  profitable: boolean;
}

export interface ToolResultReductionOptions {
  /**
   * The quantization step. The reduced set advances only when cumulative raw tool output
   * crosses a multiple of this, and the un-reduced tail always holds between one and two
   * windows of raw output.
   */
  windowTokens: number;
  /** Tail size the forced path reduces down to. Unused on the ordinary quantized path. */
  targetTokens: number;
  keepLastToolResults: number;
  maxResultTokens: number;
  maxResultChars: number;
  /**
   * Set when an independent authority already requires reduction this turn — a prompt that
   * crossed its soft threshold, or a confirmed provider overflow. The trigger is bypassed,
   * and so is the economic gate — a rewrite always beats a failed request. Every other
   * property still holds.
   */
  forceReduction?: boolean;
  /**
   * Required for the ordinary path. Absent means unknown, and unknown refuses. See
   * `ToolResultReductionEconomics`.
   */
  economics?: ToolResultReductionEconomics;
}

export interface ToolResultReductionDecision {
  /** Always true: the planner ran. Separate from whether it changed anything. */
  evaluated: true;
  changed: boolean;
  reason: ToolResultReductionReason;
  reduceIndices: ReadonlySet<number>;
  /**
   * The same indices, ordered, as a plain array. A `Set` serialises to `{}`, so the trace
   * recorded which generation fired without ever recording what it rewrote.
   */
  reducedIndices: readonly number[];
  /** Earliest message index this plan rewrites, or null when nothing is rewritten. */
  firstChangedIndex: number | null;
  toolResultTokensBefore: number;
  projectedToolResultTokens: number;
  eligibleCandidates: number;
  protectedRecentResults: number;
  windowTokens: number;
  targetTokens: number;
  /** Which quantized generation this plan belongs to. Stable between crossings. */
  generation: number;
  /** Cumulative raw token position at or before which results are reduced. */
  reductionHorizonTokens: number;
  forced: boolean;
  /**
   * What the economic gate computed, or null when it did not run — because the plan was
   * forced, or because nothing had been selected to price.
   */
  economics: ToolResultReductionEconomicsAssessment | null;
  policyVersion: string;
}

interface EmptyDecisionInput {
  reason: ToolResultReductionReason;
  options: ToolResultReductionOptions;
  toolResultTokens: number;
  protectedRecentResults: number;
  eligibleCandidates: number;
  generation: number;
  horizon: number;
  economics?: ToolResultReductionEconomicsAssessment;
}

const emptyDecision = (input: EmptyDecisionInput): ToolResultReductionDecision => ({
  evaluated: true,
  changed: false,
  reason: input.reason,
  reduceIndices: new Set<number>(),
  reducedIndices: [],
  firstChangedIndex: null,
  toolResultTokensBefore: input.toolResultTokens,
  projectedToolResultTokens: input.toolResultTokens,
  eligibleCandidates: input.eligibleCandidates,
  protectedRecentResults: input.protectedRecentResults,
  windowTokens: input.options.windowTokens,
  targetTokens: input.options.targetTokens,
  generation: input.generation,
  reductionHorizonTokens: input.horizon,
  forced: input.options.forceReduction === true,
  economics: input.economics ?? null,
  policyVersion: TOOL_RESULT_POLICY_VERSION,
});

/**
 * Prices the rewrite in cache-hit token equivalents.
 *
 * Reduction removes `saving` tokens from every later prompt. Those tokens were going to be
 * served from cache, so the benefit is `saving x remaining requests` hit-tokens.
 *
 * The rewrite invalidates `cachedPrefixTokensAtRisk`, which must then be re-read at miss
 * price instead of hit price. The cost is therefore `atRisk x (premium - 1)`.
 */
const assessEconomics = (
  economics: ToolResultReductionEconomics,
  savingTokens: number,
  firstChangedIndex: number,
): ToolResultReductionEconomicsAssessment => {
  const expectedRemainingRequests = Math.max(0, economics.expectedRemainingRequests);
  const declaredAtRisk = typeof economics.cachedPrefixTokensAtRisk === 'function'
    ? economics.cachedPrefixTokensAtRisk(firstChangedIndex)
    : economics.cachedPrefixTokensAtRisk;
  const cachedPrefixTokensAtRisk = Math.max(0, declaredAtRisk);
  const cacheMissPremium = Math.max(1, economics.cacheMissPremium ?? DEFAULT_CACHE_MISS_PREMIUM);
  const safetyFactor = Math.max(0, economics.safetyFactor ?? 1);

  const benefitTokens = Math.max(0, savingTokens) * expectedRemainingRequests;
  const lossTokens = cachedPrefixTokensAtRisk * (cacheMissPremium - 1);

  return {
    benefitTokens,
    lossTokens,
    expectedRemainingRequests,
    cachedPrefixTokensAtRisk,
    cacheMissPremium,
    safetyFactor,
    profitable: benefitTokens > lossTokens * safetyFactor,
  };
};

/**
 * A result is worth reducing only when replacing it actually saves something. Reducing a
 * small result costs evidence and returns almost nothing.
 *
 * The per-result size thresholds protect evidence, not cache. Under real aggregate
 * pressure they are overridden: many individually-modest results can still add up past the
 * budget, and refusing to touch any of them would leave the prompt over its ceiling.
 */
const isEligible = (
  slot: ToolResultSlot,
  options: ToolResultReductionOptions,
  underAggregatePressure: boolean,
): boolean => {
  if (!slot.reducible || slot.alreadyReduced || slot.toolName === undefined) return false;
  if (slot.tokens <= REDUCED_SLOT_ESTIMATED_TOKENS) return false;
  if (underAggregatePressure) return true;
  return slot.tokens > options.maxResultTokens || slot.contentChars > options.maxResultChars;
};

export const planToolResultReduction = (
  slots: readonly ToolResultSlot[],
  options: ToolResultReductionOptions,
): ToolResultReductionDecision => {
  const toolResultTokens = slots.reduce((total, slot) => total + slot.tokens, 0);
  const windowTokens = Math.max(1, options.windowTokens);

  // The protected window keeps the newest evidence verbatim. It bounds the selection; it
  // never drives it, so a window that slid on a quiet turn changes nothing on its own.
  const protectedCount = Math.max(0, Math.min(options.keepLastToolResults, slots.length));
  const protectedFrom = slots.length - protectedCount;

  // Quantize the trigger. `generation` advances only when cumulative raw output crosses a
  // multiple of the window, so every turn inside one generation yields the same decision.
  // `horizon` is reported for continuity with earlier traces; since D15 the *selection* is
  // made from the protected window backwards, not from the head forwards.
  const generation = Math.floor(toolResultTokens / windowTokens);
  const horizon = Math.max(0, (generation - 1) * windowTokens);
  const underAggregatePressure = options.forceReduction === true
    || toolResultTokens > windowTokens;

  // D15 - the band this generation owns, anchored to the generation rather than to the
  // sliding protected window. Cumulative positions of existing results do not change when
  // new results are appended, so the band is identical on every turn inside one generation —
  // which is the property the provider cache depends on.
  const bandEnd = horizon;
  const bandStart = Math.max(0, horizon - windowTokens);

  const eligible: ToolResultSlot[] = [];
  const generationBand: ToolResultSlot[] = [];
  /** The latest eligible result at or before the horizon, so a band is never empty for lack of fit. */
  let latestBeforeHorizon: ToolResultSlot | undefined;
  let cumulative = 0;
  for (let position = 0; position < slots.length; position += 1) {
    const slot = slots[position]!;
    cumulative += slot.tokens;
    if (position >= protectedFrom) continue;
    if (!isEligible(slot, options, underAggregatePressure)) continue;
    eligible.push(slot);
    if (cumulative <= bandEnd) {
      latestBeforeHorizon = slot;
    }
    if (cumulative > bandStart && cumulative <= bandEnd) {
      generationBand.push(slot);
    }
  }

  // A single result can be larger than the whole window, in which case no cumulative position
  // lands inside the band and it comes back empty even though there is plenty to reduce. Fall
  // back to the latest eligible result at or before the horizon: still deterministic, still
  // stable within a generation, and still as late as the horizon allows.
  if (generationBand.length === 0 && latestBeforeHorizon !== undefined) {
    generationBand.push(latestBeforeHorizon);
  }

  const common = {
    options,
    toolResultTokens,
    protectedRecentResults: protectedCount,
    eligibleCandidates: eligible.length,
    generation,
    horizon,
  };

  if (options.forceReduction !== true && generation < 2) {
    // Fewer than two windows of output: nothing is far enough behind the frontier to be
    // worth the prefix rewrite.
    return emptyDecision({ ...common, reason: 'below_trigger' });
  }

  // The forced path answers a separate authority — prompt pressure or a confirmed overflow.
  // It reduces oldest-first until the tail fits the target, accepting the rewrite because
  // the alternative is a failed request.
  const selected = options.forceReduction === true
    ? selectUntilTarget(eligible, toolResultTokens, options.targetTokens)
    : generationBand;

  if (selected.length === 0) {
    return emptyDecision({ ...common, reason: 'no_eligible_candidates' });
  }

  const reduceIndices = new Set<number>();
  let projected = toolResultTokens;
  let firstChangedIndex: number | null = null;
  for (const slot of selected) {
    reduceIndices.add(slot.index);
    if (firstChangedIndex === null || slot.index < firstChangedIndex) {
      firstChangedIndex = slot.index;
    }
    projected -= Math.max(0, slot.tokens - REDUCED_SLOT_ESTIMATED_TOKENS);
  }
  const reducedIndices = [...reduceIndices].sort((left, right) => left - right);

  // The ordinary path must pay for itself. Priced only now, because the saving is not known
  // until the selection is made.
  let economics: ToolResultReductionEconomicsAssessment | null = null;
  if (options.forceReduction !== true) {
    if (options.economics === undefined) {
      return emptyDecision({ ...common, reason: 'economics_unknown' });
    }
    economics = assessEconomics(
      options.economics,
      toolResultTokens - Math.max(0, projected),
      firstChangedIndex ?? 0,
    );
    if (!economics.profitable) {
      return emptyDecision({ ...common, reason: 'negative_economics', economics });
    }
  }

  return {
    evaluated: true,
    changed: true,
    reason: 'reduced',
    reduceIndices,
    reducedIndices,
    firstChangedIndex,
    toolResultTokensBefore: toolResultTokens,
    projectedToolResultTokens: Math.max(0, projected),
    eligibleCandidates: eligible.length,
    protectedRecentResults: protectedCount,
    windowTokens,
    targetTokens: options.targetTokens,
    generation,
    reductionHorizonTokens: horizon,
    forced: options.forceReduction === true,
    economics,
    policyVersion: TOOL_RESULT_POLICY_VERSION,
  };
};

/**
 * D15 — where the divergence boundary lands.
 *
 * The plan used to reduce **everything** up to the horizon, oldest first, so
 * `firstChangedIndex` landed at the head: message 4 of 128 and message 3 of 59 in production
 * run r1, destroying the whole cached prefix both times for a saving worth about 1/185th of
 * what it cost.
 *
 * Each generation now owns exactly one window-wide band, `(horizon - window, horizon]`, and
 * reduces only that. Bands reduced by earlier generations stay reduced, so over time the
 * history takes the shape the cache wants:
 *
 * ```text
 *   already-reduced bands | this generation's band | raw recent output | protected evidence
 * ```
 *
 * Three properties come out of anchoring to the generation rather than to the protected
 * window, which slides on every turn:
 *
 * - **Stable.** A slot's cumulative position does not change when later slots are appended,
 *   so the band is byte-identical on every turn inside one generation.
 * - **Forward-moving.** The band advances by one window per generation, so the boundary
 *   marches toward the tail instead of returning to the head.
 * - **Bounded.** One window of raw output is rewritten per generation, not all of it.
 *
 * At generation 2 the band is still near the head, because two windows of output is all
 * there is and the newest is protected. That firing genuinely does not pay for itself, and
 * the economic gate is what refuses it — see `ToolResultReductionEconomics`.
 */

const selectUntilTarget = (
  eligible: readonly ToolResultSlot[],
  toolResultTokens: number,
  targetTokens: number,
): ToolResultSlot[] => {
  const selected: ToolResultSlot[] = [];
  let projected = toolResultTokens;
  for (const slot of eligible) {
    if (projected <= targetTokens) break;
    selected.push(slot);
    projected -= Math.max(0, slot.tokens - REDUCED_SLOT_ESTIMATED_TOKENS);
  }
  return selected;
};
