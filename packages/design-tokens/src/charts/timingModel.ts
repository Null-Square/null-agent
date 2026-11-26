/**
 * The projection behind `TimingLanes`.
 *
 * A record stream has two independent orders and they disagree. One is what
 * caused what; the other is what the clock said. Concurrency, retries and
 * cross-session work make the second one a poor stand-in for the first, so a
 * timing strip that only draws wall clock quietly tells the reader that the
 * left-most bar happened first — which is a claim the data does not make.
 *
 * The answer is not to pick one. It is to make the axis a stated choice, and to
 * be explicit about what each projection can and cannot show. `sequence` is the
 * only one that can show every record, because it is the only one that does not
 * need a clock.
 *
 * Kept as plain functions with no React in them: the arithmetic is where the
 * mistakes are, and this way a test can check the arithmetic rather than a
 * rendered rectangle.
 */

export type TimingAxis = 'sequence' | 'duration' | 'time' | 'actual';

export const TIMING_AXES: readonly TimingAxis[] = ['sequence', 'duration', 'time', 'actual'];

export interface TimingLane {
  id: string;
  label: string;
}

export interface TimingSpanInput {
  id: string;
  /** Which lane this span is drawn in. A span with an unknown lane is dropped. */
  lane: string;
  /**
   * Position in the causal order. Required, because it is the one ordering
   * every record has.
   */
  ordinal: number;
  /** Wall-clock start, epoch ms. Absent means the record has no known timing. */
  startedAt?: number;
  /** Measured duration. Absent or non-positive means a point in time, not a span. */
  durationMs?: number;
  /** Draws the span in the finding colour. Reserved for a record that failed. */
  failed?: boolean;
  label?: string;
}

export interface ProjectedSpan {
  id: string;
  lane: string;
  ordinal: number;
  /** Start in domain units for the chosen axis. */
  start: number;
  /** End in domain units. Equal to `start` for a point. */
  end: number;
  failed: boolean;
  label?: string;
  /** True when the span has a real measured duration rather than a drawn minimum. */
  measured: boolean;
}

export interface TimingTick {
  at: number;
  label: string;
}

export interface TimingModel {
  axis: TimingAxis;
  domainStart: number;
  domainEnd: number;
  lanes: Array<{ lane: TimingLane; spans: ProjectedSpan[] }>;
  /**
   * Records the chosen axis cannot place. Non-zero only on a clock axis, and
   * always surfaced rather than silently dropped — a strip that shows 40 of 300
   * records without saying so is worse than one that shows none.
   */
  omitted: number;
  ticks: TimingTick[];
}

export interface TimingFocus {
  /** Inclusive, in the domain units of the axis the focus was committed on. */
  from: number;
  to: number;
}

/**
 * Gaps longer than this collapse on the `time` axis.
 *
 * An agent run is mostly waiting. Drawn at true scale a ten-minute run is four
 * bars and eight inches of nothing, so `time` keeps the clock order and removes
 * the dead air; `actual` keeps the dead air, which is the point of having both.
 */
export const IDLE_GAP_MS = 2_000;

/** What an idle gap is redrawn as, so a compression is still visible as one. */
const COMPRESSED_GAP_MS = 400;

/**
 * The minimum width a point gets, in domain units, so a zero-duration record is
 * still clickable. It is never counted as a measured duration.
 */
const POINT_WIDTH_RATIO = 0.004;

const hasTiming = (span: TimingSpanInput): span is TimingSpanInput & { startedAt: number } =>
  typeof span.startedAt === 'number' && Number.isFinite(span.startedAt);

const durationOf = (span: TimingSpanInput): number =>
  typeof span.durationMs === 'number' && Number.isFinite(span.durationMs) && span.durationMs > 0
    ? span.durationMs
    : 0;

const byOrdinal = (left: TimingSpanInput, right: TimingSpanInput): number =>
  left.ordinal - right.ordinal;

const byStart = (left: TimingSpanInput, right: TimingSpanInput): number =>
  (left.startedAt ?? 0) - (right.startedAt ?? 0);

/**
 * Wall clock with long idle removed.
 *
 * Walks the spans in clock order and rebuilds a timeline where every gap over
 * `IDLE_GAP_MS` becomes a fixed short one. Order and relative duration survive;
 * only the waiting is shortened.
 */
function compressIdle(spans: Array<TimingSpanInput & { startedAt: number }>): Map<string, number> {
  const ordered = [...spans].sort(byStart);
  const positions = new Map<string, number>();
  let cursor = 0;
  let previousEnd: number | null = null;

  for (const span of ordered) {
    if (previousEnd !== null) {
      const gap = span.startedAt - previousEnd;
      cursor += gap > IDLE_GAP_MS ? COMPRESSED_GAP_MS : Math.max(0, gap);
    }
    positions.set(span.id, cursor);
    previousEnd = span.startedAt + durationOf(span);
  }
  return positions;
}

const formatOffset = (ms: number): string => {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
};

function buildTicks(axis: TimingAxis, start: number, end: number, count = 4): TimingTick[] {
  if (!(end > start)) return [];
  const step = (end - start) / count;
  const ticks: TimingTick[] = [];
  for (let index = 1; index < count; index += 1) {
    const at = start + step * index;
    ticks.push({
      at,
      label: axis === 'sequence' ? `#${Math.round(at)}` : formatOffset(at - start),
    });
  }
  return ticks;
}

/**
 * Project a set of spans onto one axis.
 *
 * Every axis except `sequence` drops the records with no known timing, and says
 * how many it dropped. That is the honest reading: a record with no timestamp is
 * not early, it is unplaced.
 */
export function deriveTimingModel(input: {
  spans: TimingSpanInput[];
  lanes: TimingLane[];
  axis: TimingAxis;
}): TimingModel {
  const { axis, lanes } = input;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const spans = input.spans.filter((span) => laneIds.has(span.lane));

  const placeable = axis === 'sequence' ? spans : spans.filter(hasTiming);
  const omitted = spans.length - placeable.length;

  let positions: Map<string, number>;
  let widths: Map<string, number>;

  if (axis === 'sequence') {
    positions = new Map(placeable.map((span) => [span.id, span.ordinal]));
    // One slot per record. Sequence is a rank, not a measurement, so a long call
    // and a short one are the same width here — deliberately.
    widths = new Map(placeable.map((span) => [span.id, 1]));
  } else if (axis === 'duration') {
    // Idle removed entirely: the strip becomes "where the work went", packed in
    // causal order. Nothing here is a clock reading.
    const ordered = [...placeable].sort(byOrdinal);
    positions = new Map();
    widths = new Map();
    let cursor = 0;
    for (const span of ordered) {
      const width = durationOf(span);
      positions.set(span.id, cursor);
      widths.set(span.id, width);
      cursor += width;
    }
  } else {
    const timed = placeable as Array<TimingSpanInput & { startedAt: number }>;
    const origin = timed.reduce(
      (min, span) => Math.min(min, span.startedAt),
      Number.POSITIVE_INFINITY,
    );
    const offsets = axis === 'time'
      ? compressIdle(timed)
      : new Map(timed.map((span) => [span.id, span.startedAt - origin]));
    positions = offsets;
    widths = new Map(timed.map((span) => [span.id, durationOf(span)]));
  }

  const rawEnd = placeable.reduce((max, span) => {
    const start = positions.get(span.id) ?? 0;
    return Math.max(max, start + (widths.get(span.id) ?? 0));
  }, 0);
  const domainStart = 0;
  const domainEnd = rawEnd > 0 ? rawEnd : 1;
  const minimumWidth = axis === 'sequence' ? 0 : domainEnd * POINT_WIDTH_RATIO;

  // Annotated because the tuple is inferred as `[string, never[]]` otherwise,
  // which trips `noImplicitAny` in the consumers that compile this package from
  // source under a stricter config than the kit's own.
  const projected = new Map<string, ProjectedSpan[]>(
    lanes.map((lane): [string, ProjectedSpan[]] => [lane.id, []]),
  );
  for (const span of placeable) {
    const start = positions.get(span.id) ?? 0;
    const width = widths.get(span.id) ?? 0;
    projected.get(span.lane)?.push({
      id: span.id,
      lane: span.lane,
      ordinal: span.ordinal,
      start,
      // A point still needs to be clickable, so it is drawn at a floor width.
      // `measured` records that the width is a drawing decision, not data.
      end: start + Math.max(width, minimumWidth),
      failed: Boolean(span.failed),
      label: span.label,
      measured: width > 0,
    });
  }

  return {
    axis,
    domainStart,
    domainEnd,
    lanes: lanes.map((lane) => ({
      lane,
      spans: (projected.get(lane.id) ?? []).sort((left, right) => left.start - right.start),
    })),
    omitted,
    ticks: buildTicks(axis, domainStart, domainEnd),
  };
}

/**
 * Which spans a committed interval selects.
 *
 * Overlap, not containment. A call that began before the interval opened and was
 * still running inside it is part of what happened there, and every network
 * waterfall an operator has ever used already answers it that way.
 */
export function spansInFocus(model: TimingModel, focus: TimingFocus): Set<string> {
  const from = Math.min(focus.from, focus.to);
  const to = Math.max(focus.from, focus.to);
  const selected = new Set<string>();
  for (const lane of model.lanes) {
    for (const span of lane.spans) {
      if (span.end >= from && span.start <= to) selected.add(span.id);
    }
  }
  return selected;
}

/** Domain units → 0..1 across the drawn strip. */
export function toFraction(model: TimingModel, value: number): number {
  const width = model.domainEnd - model.domainStart;
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (value - model.domainStart) / width));
}

/** 0..1 across the drawn strip → domain units. */
export function fromFraction(model: TimingModel, fraction: number): number {
  const width = model.domainEnd - model.domainStart;
  return model.domainStart + Math.min(1, Math.max(0, fraction)) * width;
}

/**
 * Narrow a focus interval toward a point, for wheel zoom.
 *
 * Never returns an interval that escapes the domain and never collapses to a
 * width of zero, because an empty focus is indistinguishable from a broken one.
 */
export function zoomTimingFocus(
  model: TimingModel,
  focus: TimingFocus | null,
  anchor: number,
  scale: number,
): TimingFocus {
  const current = focus ?? { from: model.domainStart, to: model.domainEnd };
  const width = Math.max(current.to - current.from, Number.EPSILON);
  const nextWidth = Math.min(
    model.domainEnd - model.domainStart,
    Math.max(width * scale, (model.domainEnd - model.domainStart) / 500),
  );
  const ratio = (anchor - current.from) / width;
  let from = anchor - nextWidth * ratio;
  let to = from + nextWidth;
  if (from < model.domainStart) {
    from = model.domainStart;
    to = from + nextWidth;
  }
  if (to > model.domainEnd) {
    to = model.domainEnd;
    from = to - nextWidth;
  }
  return { from: Math.max(model.domainStart, from), to: Math.min(model.domainEnd, to) };
}
