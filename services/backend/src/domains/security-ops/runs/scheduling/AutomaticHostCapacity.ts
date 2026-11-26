import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

import type { CloudRunSchedulingConfig } from './CloudRunSchedulingConfig';

const MIB = 1024 * 1024;
const DOCKER_INFO_CACHE_MS = 30_000;
const DOCKER_TIMEOUT_MS = 5_000;
const MAXIMUM_LOAD_PER_CPU = 1.5;
const MINIMUM_EMERGENCY_MEMORY_MB = 512;
const MINIMUM_WORKSPACE_RESERVE_MB = 2_048;
const MINIMUM_PLATFORM_CPU_RESERVE_MILLIS = 1_000;
const PLATFORM_CPU_RESERVE_RATIO = 0.25;

export type DockerHostInfo = {
  id: string;
  name: string;
  totalMemoryMb: number;
  cpuCount: number;
  memoryLimit: boolean;
  cpuLimit: boolean;
  pidsLimit: boolean;
};

export type AutomaticHostCapacitySample = {
  source: 'docker_daemon' | 'unavailable';
  reliable: boolean;
  failureReason: string | null;
  hostIdentity: string | null;
  hostFingerprint: string;
  totalMemoryMb: number;
  availableMemoryMb: number;
  cpuCount: number;
  load1m: number;
  loadPerCpu: number;
  backendMemoryLimitMb: number | null;
  platformReserveMemoryMb: number;
  emergencyReserveMemoryMb: number;
  allocatableMemoryMb: number;
  platformReserveCpuMillis: number;
  allocatableCpuMillis: number;
  detectedContainerSlots: number;
  derivedActiveRunLimit: number;
  workspaceTotalMb: number | null;
  workspaceAvailableMb: number | null;
  workspaceReserveMb: number | null;
  memoryPressured: boolean;
  cpuPressured: boolean;
  diskPressured: boolean;
};

type CapacityCalculationInput = {
  docker: DockerHostInfo;
  availableMemoryMb: number;
  load1m: number;
  backendMemoryLimitMb: number | null;
  workspaceTotalMb: number | null;
  workspaceAvailableMb: number | null;
  standardMemoryMb: number;
  standardCpuMillis: number;
  minimumProgressMemoryMb: number;
  minimumProgressCpuMillis: number;
  minimumProgressContainerSlots: number;
  profileFingerprint: string;
};

const positiveInteger = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const readText = (path: string): string | null => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  } catch {
    return null;
  }
};

export const parseMeminfoMb = (raw: string | null): { totalMemoryMb: number; availableMemoryMb: number } | null => {
  if (!raw) return null;
  const values = new Map<string, number>();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match?.[1] && match[2]) values.set(match[1], Math.floor(Number(match[2]) / 1024));
  }
  const totalMemoryMb = values.get('MemTotal');
  const availableMemoryMb = values.get('MemAvailable') ?? values.get('MemFree');
  return totalMemoryMb && availableMemoryMb !== undefined
    ? { totalMemoryMb, availableMemoryMb }
    : null;
};

const readHostMemory = (): { totalMemoryMb: number; availableMemoryMb: number; source: string } => {
  for (const path of ['/host/proc/meminfo', '/proc/meminfo']) {
    const parsed = parseMeminfoMb(readText(path));
    if (parsed) return { ...parsed, source: path };
  }
  return {
    totalMemoryMb: Math.floor(os.totalmem() / MIB),
    availableMemoryMb: Math.floor(os.freemem() / MIB),
    source: 'node:os',
  };
};

const readBackendMemoryLimitMb = (): number | null => {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const raw = readText(path);
    if (!raw || raw === 'max') continue;
    const bytes = positiveInteger(raw);
    // Very large cgroup-v1 sentinel values mean unlimited.
    if (bytes && bytes < os.totalmem() * 4) return Math.max(1, Math.floor(bytes / MIB));
  }
  return null;
};

const readWorkspaceDisk = (workspaceRoot: string): { totalMb: number; availableMb: number } | null => {
  try {
    const stats = statfsSync(workspaceRoot);
    const blockSize = Number(stats.bsize);
    return {
      totalMb: Math.floor((Number(stats.blocks) * blockSize) / MIB),
      availableMb: Math.floor((Number(stats.bavail) * blockSize) / MIB),
    };
  } catch {
    return null;
  }
};

const safeFingerprint = (parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export const parseDockerHostInfo = (parsed: Record<string, unknown>): DockerHostInfo => {
  const id = typeof parsed.ID === 'string' ? parsed.ID.trim() : '';
  const name = typeof parsed.Name === 'string' ? parsed.Name.trim() : '';
  const totalMemoryBytes = positiveInteger(parsed.MemTotal);
  const cpuCount = positiveInteger(parsed.NCPU);
  if (!id || !totalMemoryBytes || !cpuCount) throw new Error('docker_info_incomplete');

  // Docker's Go template exposes CPUCfs*, while its JSON output has used both
  // CpuCfs* and CPUCfs* spellings across Engine releases. --cpus requires both
  // the CFS period and quota controls; CPU shares alone are not a hard ceiling.
  const cpuCfsPeriod = parsed.CpuCfsPeriod === true || parsed.CPUCfsPeriod === true;
  const cpuCfsQuota = parsed.CpuCfsQuota === true || parsed.CPUCfsQuota === true;
  return {
    id,
    name,
    totalMemoryMb: Math.floor(totalMemoryBytes / MIB),
    cpuCount,
    memoryLimit: parsed.MemoryLimit === true,
    cpuLimit: cpuCfsPeriod && cpuCfsQuota,
    pidsLimit: parsed.PidsLimit === true,
  };
};

export const calculateAutomaticHostCapacity = (
  input: CapacityCalculationInput,
): AutomaticHostCapacitySample => {
  const emergencyReserveMemoryMb = Math.max(
    MINIMUM_EMERGENCY_MEMORY_MB,
    Math.ceil(input.docker.totalMemoryMb * 0.1),
  );
  const platformReserveMemoryMb = Math.max(
    Math.ceil(input.docker.totalMemoryMb * 0.25),
    (input.backendMemoryLimitMb ?? MINIMUM_EMERGENCY_MEMORY_MB) + emergencyReserveMemoryMb,
  );
  const allocatableMemoryMb = Math.max(0, input.docker.totalMemoryMb - platformReserveMemoryMb);
  const totalCpuMillis = input.docker.cpuCount * 1_000;
  const platformReserveCpuMillis = Math.min(
    totalCpuMillis,
    Math.max(
      MINIMUM_PLATFORM_CPU_RESERVE_MILLIS,
      Math.ceil(totalCpuMillis * PLATFORM_CPU_RESERVE_RATIO),
    ),
  );
  const allocatableCpuMillis = Math.max(0, totalCpuMillis - platformReserveCpuMillis);
  const workspaceReserveMb = input.workspaceTotalMb === null
    ? null
    : Math.max(MINIMUM_WORKSPACE_RESERVE_MB, Math.ceil(input.workspaceTotalMb * 0.1));
  const loadPerCpu = input.load1m / Math.max(1, input.docker.cpuCount);
  const memoryContainerSlots = Math.floor(allocatableMemoryMb / Math.max(1, input.standardMemoryMb));
  const cpuContainerSlots = Math.floor(allocatableCpuMillis / Math.max(1, input.standardCpuMillis));
  const detectedContainerSlots = Math.min(memoryContainerSlots, cpuContainerSlots);
  const derivedActiveRunLimit = Math.min(
    Math.floor(allocatableMemoryMb / Math.max(1, input.minimumProgressMemoryMb)),
    Math.floor(allocatableCpuMillis / Math.max(1, input.minimumProgressCpuMillis)),
    Math.floor(detectedContainerSlots / Math.max(1, input.minimumProgressContainerSlots)),
  );
  const diskPressured = input.workspaceAvailableMb !== null
    && workspaceReserveMb !== null
    && input.workspaceAvailableMb < workspaceReserveMb;
  return {
    source: 'docker_daemon',
    reliable: true,
    failureReason: null,
    hostIdentity: safeFingerprint(['docker-host-v1', input.docker.id, input.docker.name]).slice(0, 16),
    hostFingerprint: safeFingerprint([
      'automatic-host-capacity-v2',
      input.docker.id,
      input.docker.totalMemoryMb,
      input.docker.cpuCount,
      input.docker.memoryLimit,
      input.docker.cpuLimit,
      input.docker.pidsLimit,
      input.backendMemoryLimitMb,
      input.profileFingerprint,
    ]),
    totalMemoryMb: input.docker.totalMemoryMb,
    availableMemoryMb: Math.max(0, input.availableMemoryMb),
    cpuCount: input.docker.cpuCount,
    load1m: Math.max(0, input.load1m),
    loadPerCpu,
    backendMemoryLimitMb: input.backendMemoryLimitMb,
    platformReserveMemoryMb,
    emergencyReserveMemoryMb,
    allocatableMemoryMb,
    platformReserveCpuMillis,
    allocatableCpuMillis,
    detectedContainerSlots,
    derivedActiveRunLimit,
    workspaceTotalMb: input.workspaceTotalMb,
    workspaceAvailableMb: input.workspaceAvailableMb,
    workspaceReserveMb,
    memoryPressured: input.availableMemoryMb < emergencyReserveMemoryMb,
    cpuPressured: loadPerCpu > MAXIMUM_LOAD_PER_CPU,
    diskPressured,
  };
};

const unavailableSample = (reason: string): AutomaticHostCapacitySample => ({
  source: 'unavailable',
  reliable: false,
  failureReason: reason,
  hostIdentity: null,
  hostFingerprint: 'unavailable',
  totalMemoryMb: 0,
  availableMemoryMb: 0,
  cpuCount: 0,
  load1m: 0,
  loadPerCpu: 0,
  backendMemoryLimitMb: null,
  platformReserveMemoryMb: 0,
  emergencyReserveMemoryMb: 0,
  allocatableMemoryMb: 0,
  platformReserveCpuMillis: 0,
  allocatableCpuMillis: 0,
  detectedContainerSlots: 0,
  derivedActiveRunLimit: 0,
  workspaceTotalMb: null,
  workspaceAvailableMb: null,
  workspaceReserveMb: null,
  memoryPressured: true,
  cpuPressured: false,
  diskPressured: false,
});

export class AutomaticHostCapacityProbe {
  private readonly execFileAsync = promisify(execFile);
  private cachedDocker: { value: DockerHostInfo; expiresAt: number } | null = null;

  constructor(
    private readonly config: CloudRunSchedulingConfig,
    private readonly workspaceRoot: string = process.env.WORKSPACE_ROOT?.trim() || process.cwd(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async dockerInfo(): Promise<DockerHostInfo> {
    if (this.cachedDocker && this.cachedDocker.expiresAt > this.now()) return this.cachedDocker.value;
    const { stdout } = await this.execFileAsync(
      'docker',
      ['info', '--format', '{{json .}}'],
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const value = parseDockerHostInfo(parsed);
    this.cachedDocker = { value, expiresAt: this.now() + DOCKER_INFO_CACHE_MS };
    return value;
  }

  async sample(): Promise<AutomaticHostCapacitySample> {
    try {
      const docker = await this.dockerInfo();
      if (!docker.memoryLimit || !docker.cpuLimit || !docker.pidsLimit) {
        return unavailableSample('docker_resource_limits_unavailable');
      }
      const memory = readHostMemory();
      const memoryViewToleranceMb = Math.max(128, Math.ceil(docker.totalMemoryMb * 0.05));
      if (Math.abs(memory.totalMemoryMb - docker.totalMemoryMb) > memoryViewToleranceMb) {
        return unavailableSample(`host_memory_view_mismatch:${memory.source}`);
      }
      const disk = readWorkspaceDisk(this.workspaceRoot);
      const profileFingerprint = safeFingerprint([
        this.config.profiles.standard,
        this.config.profiles.heavy,
      ]);
      return calculateAutomaticHostCapacity({
        docker,
        availableMemoryMb: memory.availableMemoryMb,
        load1m: os.loadavg()[0] ?? 0,
        backendMemoryLimitMb: readBackendMemoryLimitMb(),
        workspaceTotalMb: disk?.totalMb ?? null,
        workspaceAvailableMb: disk?.availableMb ?? null,
        standardMemoryMb: this.config.profiles.standard.memoryMb,
        standardCpuMillis: this.config.profiles.standard.cpuMillis ?? 0,
        minimumProgressMemoryMb: this.config.profiles.heavy.memoryMb,
        minimumProgressCpuMillis: this.config.profiles.heavy.cpuMillis ?? 0,
        minimumProgressContainerSlots: this.config.profiles.heavy.containerSlots,
        profileFingerprint,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailableSample(`docker_host_probe_failed:${message.slice(0, 120)}`);
    }
  }
}
