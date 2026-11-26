import { describe, expect, it } from 'vitest';

import {
  loadCloudRunSchedulingConfig,
  schedulingClassForPlan,
} from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';

describe('CloudRunSchedulingConfig', () => {
  it.each([
    [undefined, 'free'],
    ['inactive', 'free'],
    ['watch', 'free'],
    ['control', 'paid'],
    ['customize', 'pro'],
    ['internal', 'internal'],
    ['unknown', 'free'],
  ] as const)('maps plan %s to scheduling class %s', (plan, expected) => {
    expect(schedulingClassForPlan(plan)).toBe(expected);
  });

  it('loads separate backlog ceilings and honors the legacy starvation setting', () => {
    const config = loadCloudRunSchedulingConfig({
      CLOUD_RUN_FREE_BACKLOG: '2',
      CLOUD_RUN_PAID_BACKLOG: '4',
      CLOUD_RUN_PRO_BACKLOG: '6',
      CLOUD_RUN_INTERNAL_BACKLOG: '8',
      CLOUD_RUN_FREE_STARVATION_MS: '90000',
    } as NodeJS.ProcessEnv);

    expect(config.backlogByClass).toEqual({ free: 2, paid: 4, pro: 6, internal: 8 });
    expect(config.planStarvationMs).toBe(90_000);
  });

  it('prefers the plan-wide starvation setting when both names are present', () => {
    const config = loadCloudRunSchedulingConfig({
      CLOUD_RUN_PLAN_STARVATION_MS: '120000',
      CLOUD_RUN_FREE_STARVATION_MS: '90000',
    } as NodeJS.ProcessEnv);

    expect(config.planStarvationMs).toBe(120_000);
  });

  it('never queues runs: Null AI runs for one person, so every run starts directly', () => {
    expect(loadCloudRunSchedulingConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).queueCloudRuns).toBe(false);
    expect(loadCloudRunSchedulingConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).queueCloudRuns).toBe(false);
    expect(loadCloudRunSchedulingConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).queueCloudRuns).toBe(false);
    expect(loadCloudRunSchedulingConfig({} as NodeJS.ProcessEnv).queueCloudRuns).toBe(false);
  });

  it('derives scheduler profiles from the Docker-enforced sandbox limits', () => {
    const config = loadCloudRunSchedulingConfig(
      { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      { memoryMb: 768, cpuQuota: 1.5, pidsLimit: 192 },
    );
    expect(config.queueCloudRuns).toBe(false);
    expect(config.runnerName).toBeNull();
    expect(config.profiles.standard).toEqual({
      version: 2,
      memoryMb: 768,
      containerSlots: 1,
      cpuMillis: 1_500,
      pidLimit: 192,
    });
    expect(config.profiles.heavy).toEqual({
      version: 2,
      memoryMb: 1_536,
      containerSlots: 2,
      cpuMillis: 3_000,
      pidLimit: 384,
    });
  });

  it('keeps an explicit runner identity override without using it as capacity input', () => {
    const config = loadCloudRunSchedulingConfig({
      NODE_ENV: 'production',
      CLOUD_RUNNER_NAME: 'worker-host-amman-1',
    } as NodeJS.ProcessEnv);
    expect(config.runnerName).toBe('worker-host-amman-1');
  });
});
