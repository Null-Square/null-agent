import { describe, expect, it } from 'vitest';

import {
  calculateAutomaticHostCapacity,
  parseDockerHostInfo,
  parseMeminfoMb,
} from '@/domains/security-ops/runs/scheduling/AutomaticHostCapacity';

const input = (overrides: Partial<Parameters<typeof calculateAutomaticHostCapacity>[0]> = {}) => ({
  docker: {
    id: 'docker-host-a', name: 'host-a', totalMemoryMb: 8_192, cpuCount: 4,
    memoryLimit: true, cpuLimit: true, pidsLimit: true,
  },
  availableMemoryMb: 5_000,
  load1m: 2,
  backendMemoryLimitMb: 2_048,
  workspaceTotalMb: 100_000,
  workspaceAvailableMb: 50_000,
  standardMemoryMb: 1_024,
  standardCpuMillis: 1_000,
  minimumProgressMemoryMb: 2_048,
  minimumProgressCpuMillis: 2_000,
  minimumProgressContainerSlots: 2,
  profileFingerprint: 'profile-v2',
  ...overrides,
});

describe('AutomaticHostCapacity', () => {
  it('parses the host procfs memory view used by containerized admission', () => {
    expect(parseMeminfoMb([
      'MemTotal:       16281964 kB',
      'MemFree:          573652 kB',
      'MemAvailable:   10483120 kB',
    ].join('\n'))).toEqual({ totalMemoryMb: 15_900, availableMemoryMb: 10_237 });
  });

  it('recognizes the current Docker Engine JSON spelling for hard resource controls', () => {
    expect(parseDockerHostInfo({
      ID: 'docker-host-a',
      Name: 'host-a',
      MemTotal: 8_589_934_592,
      NCPU: 4,
      MemoryLimit: true,
      CpuCfsPeriod: true,
      CpuCfsQuota: true,
      CPUShares: true,
      PidsLimit: true,
    })).toMatchObject({
      totalMemoryMb: 8_192,
      cpuCount: 4,
      memoryLimit: true,
      cpuLimit: true,
      pidsLimit: true,
    });
  });

  it('does not mistake soft CPU shares for the hard --cpus ceiling', () => {
    expect(parseDockerHostInfo({
      ID: 'docker-host-a',
      Name: 'host-a',
      MemTotal: 8_589_934_592,
      NCPU: 4,
      MemoryLimit: true,
      CPUShares: true,
      PidsLimit: true,
    }).cpuLimit).toBe(false);
  });

  it('derives capacity from host resources and enforced bundle limits without a Run-count setting', () => {
    const sample = calculateAutomaticHostCapacity(input());

    expect(sample).toMatchObject({
      reliable: true,
      source: 'docker_daemon',
      emergencyReserveMemoryMb: 820,
      platformReserveMemoryMb: 2_868,
      allocatableMemoryMb: 5_324,
      platformReserveCpuMillis: 1_000,
      allocatableCpuMillis: 3_000,
      detectedContainerSlots: 3,
      derivedActiveRunLimit: 1,
      memoryPressured: false,
      cpuPressured: false,
      diskPressured: false,
    });
  });

  it('automatically increases the derived Run envelope after a vertical upgrade', () => {
    const small = calculateAutomaticHostCapacity(input());
    const large = calculateAutomaticHostCapacity(input({
      docker: {
        id: 'docker-host-a', name: 'host-a', totalMemoryMb: 16_384, cpuCount: 8,
        memoryLimit: true, cpuLimit: true, pidsLimit: true,
      },
      availableMemoryMb: 12_000,
    }));

    expect(large.derivedActiveRunLimit).toBeGreaterThan(small.derivedActiveRunLimit);
    expect(large.allocatableMemoryMb).toBeGreaterThan(small.allocatableMemoryMb);
    expect(large.hostFingerprint).not.toBe(small.hostFingerprint);
  });

  it('does not invent extra Run capacity when RAM grows but CPU remains the bottleneck', () => {
    const current = calculateAutomaticHostCapacity(input());
    const ramOnlyUpgrade = calculateAutomaticHostCapacity(input({
      docker: {
        id: 'docker-host-a', name: 'host-a', totalMemoryMb: 32_768, cpuCount: 4,
        memoryLimit: true, cpuLimit: true, pidsLimit: true,
      },
      availableMemoryMb: 28_000,
    }));

    expect(ramOnlyUpgrade.allocatableMemoryMb).toBeGreaterThan(current.allocatableMemoryMb);
    expect(ramOnlyUpgrade.allocatableCpuMillis).toBe(current.allocatableCpuMillis);
    expect(ramOnlyUpgrade.derivedActiveRunLimit).toBe(current.derivedActiveRunLimit);
  });

  it('treats a backend cgroup-limit change as a drain-safe static fingerprint change', () => {
    const smallBackend = calculateAutomaticHostCapacity(input({ backendMemoryLimitMb: 1_024 }));
    const largeBackend = calculateAutomaticHostCapacity(input({ backendMemoryLimitMb: 3_072 }));

    expect(largeBackend.allocatableMemoryMb).toBeLessThan(smallBackend.allocatableMemoryMb);
    expect(largeBackend.hostFingerprint).not.toBe(smallBackend.hostFingerprint);
  });

  it('uses live CPU, memory, and disk observations only as downward admission brakes', () => {
    const healthy = calculateAutomaticHostCapacity(input());
    const pressured = calculateAutomaticHostCapacity(input({
      availableMemoryMb: 500,
      load1m: 8,
      workspaceAvailableMb: 1_000,
    }));

    expect(pressured.allocatableMemoryMb).toBe(healthy.allocatableMemoryMb);
    expect(pressured.derivedActiveRunLimit).toBe(healthy.derivedActiveRunLimit);
    expect(pressured).toMatchObject({ memoryPressured: true, cpuPressured: true, diskPressured: true });
  });
});
