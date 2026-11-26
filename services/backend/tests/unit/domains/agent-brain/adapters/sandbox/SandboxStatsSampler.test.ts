import { describe, expect, it, vi } from 'vitest';

import { parseDockerSize, parseDockerStatLine, type DockerStatReading } from '@/domains/agent-brain/adapters/sandbox/DockerDriver';
import {
  aggregateDockerReadings,
  computeNumericStats,
  SandboxStatsSampler,
  type SandboxStatsAggregate,
  type TimestampedReading,
} from '@/domains/agent-brain/adapters/sandbox/SandboxStatsSampler';

describe('parseDockerSize', () => {
  it('parses MiB/GiB (binary) and MB (decimal) tokens', () => {
    expect(parseDockerSize('90.62MiB')).toBeCloseTo(90.62 * 1024 ** 2, 0);
    expect(parseDockerSize('1.44MB')).toBeCloseTo(1.44e6, 0);
    expect(parseDockerSize('512B')).toBe(512);
    expect(parseDockerSize('')).toBeNull();
    expect(parseDockerSize('n/a')).toBeNull();
  });
});

describe('parseDockerStatLine', () => {
  it('normalizes a docker stats json row into cores/bytes/pids', () => {
    const line = JSON.stringify({
      CPUPerc: '250.00%',
      MemUsage: '90.62MiB / 15.53GiB',
      PIDs: '4',
      NetIO: '5.32MB / 1.44MB',
    });
    const reading = parseDockerStatLine(line);
    expect(reading?.cpuCores).toBeCloseTo(2.5, 5);
    expect(reading?.memoryBytes).toBeCloseTo(90.62 * 1024 ** 2, 0);
    expect(reading?.pids).toBe(4);
    expect(reading?.networkRxBytes).toBeCloseTo(5.32e6, 0);
    expect(reading?.networkTxBytes).toBeCloseTo(1.44e6, 0);
  });

  it('returns null on malformed json', () => {
    expect(parseDockerStatLine('not json')).toBeNull();
  });
});

describe('computeNumericStats', () => {
  it('computes avg/max/p95/last and ignores negatives', () => {
    const stats = computeNumericStats([1, 2, 3, 4, -5]);
    expect(stats.samples).toBe(4);
    expect(stats.avg).toBeCloseTo(2.5, 5);
    expect(stats.max).toBe(4);
    expect(stats.last).toBe(4);
  });

  it('returns empty stats for no samples', () => {
    expect(computeNumericStats([])).toEqual({ samples: 0, avg: null, max: null, p95: null, last: null });
  });
});

describe('aggregateDockerReadings', () => {
  it('derives per-second network rates from cumulative totals and peaks for cpu/mem/pids', () => {
    const r = (cpu: number, mem: number, pids: number, rx: number, tx: number): DockerStatReading => ({
      cpuCores: cpu, memoryBytes: mem, pids, networkRxBytes: rx, networkTxBytes: tx,
    });
    const samples: TimestampedReading[] = [
      { at: 0, reading: r(0.2, 100, 5, 0, 0) },
      { at: 1000, reading: r(0.8, 250, 12, 1000, 500) },
      { at: 2000, reading: r(0.5, 180, 9, 3000, 1500) },
    ];
    const agg = aggregateDockerReadings(samples);
    expect(agg.samples).toBe(3);
    expect(agg.memoryBytes.max).toBe(250);
    expect(agg.cpuCores.max).toBe(0.8);
    expect(agg.pids.max).toBe(12);
    // cumulative totals -> last reading is the estimated total
    expect(agg.networkRxBytesEstimatedTotal).toBe(3000);
    expect(agg.networkTxBytesEstimatedTotal).toBe(1500);
    // rates: (1000-0)/1s = 1000, (3000-1000)/1s = 2000 -> max 2000
    expect(agg.networkRxBytesPerSecond.max).toBe(2000);
  });
});

describe('SandboxStatsSampler', () => {
  it('samples during life and emits a single aggregate on stop', async () => {
    let clock = 0;
    const readings: Array<DockerStatReading | null> = [
      { cpuCores: 0.3, memoryBytes: 100, pids: 4, networkRxBytes: 0, networkTxBytes: 0 },
      { cpuCores: 0.9, memoryBytes: 300, pids: 11, networkRxBytes: 2000, networkTxBytes: 1000 },
      { cpuCores: 0.5, memoryBytes: 200, pids: 8, networkRxBytes: 5000, networkTxBytes: 2000 },
    ];
    let idx = 0;
    const statsFn = vi.fn(async () => readings[Math.min(idx++, readings.length - 1)] ?? null);
    const emitted: SandboxStatsAggregate[] = [];
    const sampler = new SandboxStatsSampler({
      statsFn,
      emit: (aggregate) => { emitted.push(aggregate); },
      intervalMs: 1_000,
      now: () => clock,
    });

    sampler.start({ containerId: 'c1', sessionId: 's1', runId: 'r1' });
    // immediate first reading happened in start(); advance and stop
    clock = 2_000;
    await sampler.stop('c1');

    expect(emitted).toHaveLength(1);
    const agg = emitted[0]!;
    expect(agg.containerId).toBe('c1');
    expect(agg.sessionId).toBe('s1');
    expect(agg.runId).toBe('r1');
    expect(agg.source).toBe('docker_stats');
    expect(agg.samples).toBeGreaterThanOrEqual(2);
    expect(agg.memoryBytes.max).toBeGreaterThanOrEqual(200);
    expect(agg.cpuCores.max).toBeGreaterThanOrEqual(0.5);
  });

  it('emits periodic cumulative aggregates during the run (realtime + abort survival)', async () => {
    let clock = 0;
    const reading: DockerStatReading = { cpuCores: 0.5, memoryBytes: 200, pids: 7, networkRxBytes: 100, networkTxBytes: 50 };
    const statsFn = vi.fn(async () => reading);
    const emitted: SandboxStatsAggregate[] = [];
    const sampler = new SandboxStatsSampler({
      statsFn,
      emit: (aggregate) => { emitted.push(aggregate); },
      intervalMs: 1_000,
      flushEverySamples: 3,
      now: () => (clock += 1_000),
    });

    // start() takes the immediate first reading; drive two more samples to reach 3.
    sampler.start({ containerId: 'c1', sessionId: 's1', runId: 'r1' });
    await (sampler as unknown as { sample: (id: string) => Promise<void> }).sample('c1');
    await (sampler as unknown as { sample: (id: string) => Promise<void> }).sample('c1');

    // A periodic flush should have fired at the 3rd sample, before any stop().
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0]?.source).toBe('docker_stats');
    expect(emitted[0]?.samples).toBeGreaterThanOrEqual(3);
  });

  it('emits nothing when no readings were collected', async () => {
    const emitted: SandboxStatsAggregate[] = [];
    const sampler = new SandboxStatsSampler({
      statsFn: async () => null,
      emit: (aggregate) => { emitted.push(aggregate); },
      now: () => 0,
    });
    sampler.start({ containerId: 'c2', sessionId: 's2' });
    await sampler.stop('c2');
    expect(emitted).toHaveLength(0);
  });

  it('never throws when statsFn rejects', async () => {
    const sampler = new SandboxStatsSampler({
      statsFn: async () => { throw new Error('docker gone'); },
      emit: () => undefined,
      now: () => 0,
      onError: () => undefined,
    });
    sampler.start({ containerId: 'c3', sessionId: 's3' });
    await expect(sampler.stop('c3')).resolves.toBeUndefined();
  });
});
