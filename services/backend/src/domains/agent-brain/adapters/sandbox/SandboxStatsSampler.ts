import type { DockerStatReading } from './DockerDriver';

/** Matches the performance domain's NumericStats shape (avg/max/p95/last). */
export type SamplerNumericStats = {
  samples: number;
  avg: number | null;
  max: number | null;
  p95: number | null;
  last: number | null;
};

export type SandboxStatsAggregate = {
  containerId: string;
  sessionId: string;
  runId: string | null;
  source: 'docker_stats';
  samples: number;
  startedAt: string;
  endedAt: string;
  cpuCores: SamplerNumericStats;
  memoryBytes: SamplerNumericStats;
  pids: SamplerNumericStats;
  networkRxBytesPerSecond: SamplerNumericStats;
  networkTxBytesPerSecond: SamplerNumericStats;
  networkRxBytesEstimatedTotal: number | null;
  networkTxBytesEstimatedTotal: number | null;
};

export type TimestampedReading = { at: number; reading: DockerStatReading };

const EMPTY_STATS: SamplerNumericStats = { samples: 0, avg: null, max: null, p95: null, last: null };

export const computeNumericStats = (values: number[]): SamplerNumericStats => {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (clean.length === 0) return { ...EMPTY_STATS };
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = clean.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
  return {
    samples: clean.length,
    avg: sum / clean.length,
    max: sorted[sorted.length - 1] ?? null,
    p95: sorted[p95Index] ?? null,
    last: clean[clean.length - 1] ?? null,
  };
};

const collect = (samples: TimestampedReading[], pick: (r: DockerStatReading) => number | null): number[] =>
  samples.map((s) => pick(s.reading)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

/**
 * docker NetIO is cumulative since container start; derive per-second rates from
 * consecutive deltas, and report the final cumulative value as the estimated total.
 */
const ratesFromCumulative = (samples: TimestampedReading[], pick: (r: DockerStatReading) => number | null): number[] => {
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = pick(samples[i - 1]!.reading);
    const curr = pick(samples[i]!.reading);
    const dtSec = (samples[i]!.at - samples[i - 1]!.at) / 1000;
    if (prev == null || curr == null || dtSec <= 0) continue;
    const delta = curr - prev;
    if (delta >= 0) rates.push(delta / dtSec);
  }
  return rates;
};

const lastCumulative = (samples: TimestampedReading[], pick: (r: DockerStatReading) => number | null): number | null => {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const value = pick(samples[i]!.reading);
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
};

/** Pure aggregation of a container's readings into the sandbox.stats payload body. */
export const aggregateDockerReadings = (
  samples: TimestampedReading[],
): Omit<SandboxStatsAggregate, 'containerId' | 'sessionId' | 'runId' | 'source' | 'startedAt' | 'endedAt'> => ({
  samples: samples.length,
  cpuCores: computeNumericStats(collect(samples, (r) => r.cpuCores)),
  memoryBytes: computeNumericStats(collect(samples, (r) => r.memoryBytes)),
  pids: computeNumericStats(collect(samples, (r) => r.pids)),
  networkRxBytesPerSecond: computeNumericStats(ratesFromCumulative(samples, (r) => r.networkRxBytes)),
  networkTxBytesPerSecond: computeNumericStats(ratesFromCumulative(samples, (r) => r.networkTxBytes)),
  networkRxBytesEstimatedTotal: lastCumulative(samples, (r) => r.networkRxBytes),
  networkTxBytesEstimatedTotal: lastCumulative(samples, (r) => r.networkTxBytes),
});

type SamplerEntry = {
  sessionId: string;
  runId: string | null;
  startedAt: number;
  samples: TimestampedReading[];
  timer: NodeJS.Timeout;
};

export type SandboxStatsSamplerOptions = {
  statsFn: (containerId: string) => Promise<DockerStatReading | null>;
  emit: (aggregate: SandboxStatsAggregate) => void | Promise<void>;
  intervalMs?: number;
  /**
   * Emit a cumulative aggregate every N samples during the run (not only on stop),
   * so the performance summary renders near-realtime for active runs and survives
   * aborted/hung runs that never reach container stop. Default 6 (~30s at 5s interval).
   */
  flushEverySamples?: number;
  now?: () => number;
  onError?: (error: unknown, containerId: string) => void;
};

/**
 * Samples `docker stats` for live sandbox containers and, on stop, emits a single
 * aggregated `sandbox.stats` record. Fully failure-isolated: a stats error never
 * propagates to the container lifecycle.
 */
export class SandboxStatsSampler {
  private readonly entries = new Map<string, SamplerEntry>();
  private readonly intervalMs: number;
  private readonly flushEverySamples: number;
  private readonly now: () => number;

  constructor(private readonly options: SandboxStatsSamplerOptions) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
    this.flushEverySamples = Math.max(1, options.flushEverySamples ?? 6);
    this.now = options.now ?? (() => Date.now());
  }

  private buildAggregate(containerId: string, entry: SamplerEntry): SandboxStatsAggregate | null {
    if (entry.samples.length === 0) return null;
    return {
      containerId,
      sessionId: entry.sessionId,
      runId: entry.runId,
      source: 'docker_stats',
      startedAt: new Date(entry.startedAt).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      ...aggregateDockerReadings(entry.samples),
    };
  }

  start(params: { containerId: string; sessionId: string; runId?: string | null }): void {
    const { containerId } = params;
    if (this.entries.has(containerId)) return;
    const entry: SamplerEntry = {
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      startedAt: this.now(),
      samples: [],
      timer: setInterval(() => {
        void this.sample(containerId);
      }, this.intervalMs),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.entries.set(containerId, entry);
    // Take an immediate first reading so very short runs still get a sample.
    void this.sample(containerId);
  }

  private async sample(containerId: string): Promise<void> {
    const entry = this.entries.get(containerId);
    if (!entry) return;
    try {
      const reading = await this.options.statsFn(containerId);
      if (!reading) return;
      entry.samples.push({ at: this.now(), reading });
      // Periodic cumulative flush so active/aborted runs still expose metrics.
      if (entry.samples.length % this.flushEverySamples === 0) {
        const aggregate = this.buildAggregate(containerId, entry);
        if (aggregate) {
          try {
            await this.options.emit(aggregate);
          } catch (emitError) {
            this.options.onError?.(emitError, containerId);
          }
        }
      }
    } catch (error) {
      this.options.onError?.(error, containerId);
    }
  }

  async stop(containerId: string): Promise<void> {
    const entry = this.entries.get(containerId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.entries.delete(containerId);
    try {
      await this.sample(containerId); // final live reading before teardown
      // sample() returned early because the entry was deleted; capture directly.
      const finalReading = await this.options.statsFn(containerId);
      if (finalReading) entry.samples.push({ at: this.now(), reading: finalReading });
    } catch (error) {
      this.options.onError?.(error, containerId);
    }
    const aggregate = this.buildAggregate(containerId, entry);
    if (!aggregate) return;
    try {
      await this.options.emit(aggregate);
    } catch (error) {
      this.options.onError?.(error, containerId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
