import { execFile, spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { promisify } from 'util';
import path from 'path';
import type { ExecOptions, ExecResult, NamespaceAttachment, SandboxListEntry } from './types';
import { toSafeError } from '@/shared/errors';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const positiveInteger = (value: unknown): number | undefined => {
  const candidate = positiveNumber(value);
  return candidate === undefined ? undefined : Math.max(1, Math.floor(candidate));
};

const DOCKER_CONTROL_TIMEOUT_MS = 15_000;
const DOCKER_STATS_TIMEOUT_MS = 5_000;
const DOCKER_TRANSFER_TIMEOUT_MS = 60_000;
const DOCKER_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type DockerCreateOptions = {
  image: string;
  name: string;
  network: NamespaceAttachment;
  readonlyRootfs: boolean;
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  user?: string;
  cpuQuota?: number;
  memoryMb?: number;
  pidsLimit?: number;
  /** Size of the container's /dev/shm tmpfs. */
  shmSizeMb?: number;
  seccompProfilePath?: string;
  capDrop?: string[];
  capAdd?: string[];
  privileged?: boolean;
  securityOpts?: string[];
  command?: string[];
};

export type DockerCopyOptions = {
  containerPath: string;
  hostPath: string;
};

export class DockerDriver {
  private readonly execFileAsync = promisify(execFile);

  constructor(private readonly log: (message: string) => void) { }

  async create(options: DockerCreateOptions): Promise<string> {
    const args = this.buildRunArgs(options);
    this.log(`docker ${args.join(' ')}`);
    const { stdout } = await this.runDocker(args, DOCKER_TRANSFER_TIMEOUT_MS);
    const containerId = stdout.trim();
    if (!containerId) {
      throw new Error('Docker run did not return a container id');
    }
    return containerId;
  }

  async stop(containerId: string): Promise<void> {
    try {
      await this.runDocker(['stop', containerId]);
    } catch {
      // Ignore if already stopped or not found
    }
  }

  async destroy(containerId: string): Promise<void> {
    try {
      await this.runDocker(['rm', '-f', containerId]);
    } catch (error: unknown) {
      const err = toSafeError(error);
      const record = isRecord(error) ? error : undefined;
      const message =
        (typeof record?.['stderr'] === 'string' && record['stderr']) ||
        (typeof record?.['stdout'] === 'string' && record['stdout']) ||
        err.message;
      if (message && /No such container/i.test(message)) {
        return;
      }
      throw error;
    }
  }

  async list(filterName = 'ns-agent-'): Promise<SandboxListEntry[]> {
    // Format: json
    const args = ['ps', '-a', '--filter', `name=${filterName}`, '--format', '{{json .}}'];
    this.log(`docker ${args.join(' ')}`);
    const { stdout } = await this.runDocker(args);

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * List containers by label filter.
   * Used for orphan container discovery on startup.
   */
  async listByLabel(labelKey: string, labelValue?: string): Promise<SandboxListEntry[]> {
    const filter = labelValue ? `${labelKey}=${labelValue}` : labelKey;
    const args = ['ps', '-a', '--filter', `label=${filter}`, '--format', '{{json .}}'];
    this.log(`docker ${args.join(' ')}`);
    const { stdout } = await this.runDocker(args);

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async restart(containerId: string): Promise<void> {
    this.log(`docker restart ${containerId}`);
    await this.runDocker(['restart', containerId]);
  }

  async pause(containerId: string): Promise<void> {
    this.log(`docker pause ${containerId}`);
    await this.runDocker(['pause', containerId]);
  }

  async unpause(containerId: string): Promise<void> {
    this.log(`docker unpause ${containerId}`);
    await this.runDocker(['unpause', containerId]);
  }

  /**
   * Point-in-time resource usage from the Docker daemon's own accounting
   * (`docker stats`). Works where a cAdvisor sidecar cannot reliably see
   * short-lived container cgroups (e.g. Docker Desktop / WSL2). Returns null
   * when the container is gone or stats are unavailable; never throws.
   */
  async stats(containerId: string): Promise<DockerStatReading | null> {
    try {
      const { stdout } = await this.runDocker([
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        containerId,
      ], DOCKER_STATS_TIMEOUT_MS);
      const line = stdout.trim().split(/\r?\n/u).find((value) => value.trim().length > 0);
      if (!line) return null;
      return parseDockerStatLine(line);
    } catch {
      return null;
    }
  }

  async logs(containerId: string, options: { tail?: number; since?: string } = {}): Promise<string> {
    const args = ['logs'];
    if (options.tail) {
      args.push('--tail', String(options.tail));
    }
    if (options.since) {
      args.push('--since', options.since);
    }
    args.push(containerId);
    this.log(`docker ${args.join(' ')}`);
    try {
      const { stdout, stderr } = await this.runDocker(args);
      // Docker logs outputs to both stdout and stderr, combine them
      return stdout + stderr;
    } catch (error: unknown) {
      const record = isRecord(error) ? error : undefined;
      // Return stderr if available (docker logs error message)
      if (typeof record?.['stderr'] === 'string' && record['stderr']) {
        return `Error: ${record['stderr']}`;
      }
      throw error;
    }
  }

  async exec(containerId: string, options: ExecOptions): Promise<ExecResult> {
    const command = this.buildExecCommand(options);
    const args = ['exec', '-i'];

    if (options.user) {
      args.push('--user', options.user);
    }

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(containerId, 'bash', '-lc', command);

    this.log(`docker ${args.join(' ')}`);

    return new Promise<ExecResult>((resolve) => {
      const child = spawn('docker', args, {
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let abortReason: string | undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (abortHandler && options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
      };

      const finish = (code: number | null) => {
        cleanup();
        resolve({
          exitCode: code ?? (timedOut || aborted ? 1 : 0),
          stdout,
          stderr,
          bytesOut: Buffer.byteLength(stdout, 'utf8'),
          bytesErr: Buffer.byteLength(stderr, 'utf8'),
          timedOut,
          aborted,
          abortReason,
        });
      };

      const stopProcess = (reason?: string) => {
        if (reason === 'timeout') {
          timedOut = true;
        } else {
          aborted = true;
          abortReason = reason ?? 'Aborted';
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      };

      const timeoutMs = options.timeoutMs ?? 0;
      const timeoutHandle =
        timeoutMs > 0
          ? setTimeout(() => {
            stopProcess('timeout');
          }, timeoutMs)
          : undefined;

      const abortHandler =
        options.signal &&
        ((() => {
          if (options.signal?.aborted) {
            stopProcess('Aborted by operator');
            return undefined;
          }
          const handler = () => stopProcess('Aborted by operator');
          options.signal?.addEventListener('abort', handler, { once: true });
          return handler;
        })() as (() => void) | undefined);

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        stdout += chunk;
        options.onStdout?.(chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        stderr += chunk;
        options.onStderr?.(chunk);
      });

      if (options.stdin !== undefined) {
        child.stdin?.on('error', () => {
          // The exec target may exit before consuming stdin; the close event still records the outcome.
        });
        child.stdin?.end(options.stdin);
      }

      child.on('error', (error) => {
        stderr += (stderr ? '\n' : '') + error.message;
        finish(null);
      });

      child.on('close', (code) => {
        finish(code);
      });
    });
  }

  async execDetached(containerId: string, options: ExecOptions): Promise<void> {
    const command = this.buildExecCommand(options);
    const args = ['exec', '-d'];

    if (options.user) {
      args.push('--user', options.user);
    }

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(containerId, 'bash', '-lc', command);

    this.log(`docker ${args.join(' ')}`);
    await this.runDocker(args);
  }

  /**
   * A raw byte stream to a process in the container: `docker exec -i`, stdin and stdout piped, no TTY.
   * The caller owns the process and kills it when its stream ends.
   */
  execStream(containerId: string, argv: string[]): ChildProcessByStdio<Writable, Readable, null> {
    const args = ['exec', '-i', containerId, ...argv];
    this.log(`docker ${args.join(' ')}`);
    return spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  }

  async copyToContainer(containerId: string, options: DockerCopyOptions): Promise<void> {
    const source = this.normalizeHostPath(options.hostPath);
    const target = `${containerId}:${options.containerPath}`;
    this.log(`docker cp ${source} ${target}`);
    await this.runDocker(['cp', source, target], DOCKER_TRANSFER_TIMEOUT_MS);
  }

  async copyFromContainer(containerId: string, options: DockerCopyOptions): Promise<void> {
    const source = `${containerId}:${options.containerPath}`;
    const target = this.normalizeHostPath(options.hostPath);
    this.log(`docker cp ${source} ${target}`);
    await this.runDocker(['cp', source, target], DOCKER_TRANSFER_TIMEOUT_MS);
  }

  async inspect(containerId: string): Promise<Record<string, unknown>> {
    const { stdout } = await this.runDocker(['inspect', containerId]);
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0] as Record<string, unknown>;
    }
    throw new Error(`Unexpected docker inspect payload for ${containerId}`);
  }

  async inspectImage(image: string): Promise<Record<string, unknown> | null> {
    try {
      const { stdout } = await this.runDocker(['image', 'inspect', image]);
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0] as Record<string, unknown>;
      }
    } catch (error: unknown) {
      const err = toSafeError(error);
      const record = isRecord(error) ? error : undefined;
      const message =
        (typeof record?.['stderr'] === 'string' && record['stderr']) ||
        (typeof record?.['stdout'] === 'string' && record['stdout']) ||
        err.message;
      if (message && /No such image/i.test(message)) {
        return null;
      }
      throw error;
    }
    return null;
  }

  private buildRunArgs(options: DockerCreateOptions): string[] {
    const args: string[] = ['run', '-d', '--rm', '--name', options.name];

    if (typeof options.network === 'string') {
      args.push('--network', options.network);
    } else {
      args.push('--network', `container:${options.network.shareWith}`);
    }

    if (options.readonlyRootfs) {
      args.push('--read-only');
    }

    if (options.user) {
      args.push('--user', options.user);
    }

    if (options.privileged) {
      args.push('--privileged');
    }

    const cpuQuota = positiveNumber(options.cpuQuota);
    if (cpuQuota !== undefined) {
      args.push('--cpus', String(cpuQuota));
    }

    const memoryMb = positiveInteger(options.memoryMb);
    if (memoryMb !== undefined) {
      args.push('--memory', `${memoryMb}m`);
    }

    const pidsLimit = positiveInteger(options.pidsLimit);
    if (pidsLimit !== undefined) {
      args.push('--pids-limit', String(pidsLimit));
    }

    const shmSizeMb = positiveInteger(options.shmSizeMb);
    if (shmSizeMb !== undefined) {
      args.push('--shm-size', `${shmSizeMb}m`);
    }

    if (options.seccompProfilePath) {
      args.push('--security-opt', `seccomp=${options.seccompProfilePath}`);
    }

    if (options.securityOpts) {
      for (const opt of options.securityOpts) {
        args.push('--security-opt', opt);
      }
    }

    if (options.capDrop) {
      for (const capability of options.capDrop) {
        args.push('--cap-drop', capability);
      }
    }

    if (options.capAdd) {
      for (const capability of options.capAdd) {
        args.push('--cap-add', capability);
      }
    }

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    if (options.mounts) {
      for (const mount of options.mounts) {
        const suffix = mount.readOnly ? ':ro' : '';
        args.push('-v', `${this.normalizeVolumePath(mount.source)}:${mount.target}${suffix}`);
      }
    }

    // Add labels for container discovery (used by orphan cleanup)
    if (options.labels) {
      for (const [key, value] of Object.entries(options.labels)) {
        args.push('--label', `${key}=${value}`);
      }
    }

    // CRITICAL: If no command provided, we use 'sleep infinity' to keep container alive.
    // This requires /bin/bash as entrypoint. Many images (like reconftw) have custom entrypoints,
    // so we always override to /bin/bash when using the default sleep command.
    const hasCustomCommand = options.command && options.command.length > 0;
    const command: string[] = hasCustomCommand ? options.command! : ['-c', 'sleep infinity'];
    
    if (!hasCustomCommand) {
      // Force bash entrypoint for default sleep command
      args.push('--entrypoint', '/bin/bash');
    }
    
    args.push(options.image, ...command);
    return args;
  }

  private buildExecCommand(options: ExecOptions): string {
    if (options.cwd) {
      const escapedCwd = this.escapeShellArg(options.cwd);
      return `cd ${escapedCwd} && ${options.cmd}`;
    }
    return options.cmd;
  }

  private normalizeVolumePath(volumePath: string): string {
    if (process.platform === 'win32') {
      return volumePath.replace(/\\/g, '/');
    }
    return volumePath;
  }

  private normalizeHostPath(filePath: string): string {
    return path.resolve(filePath);
  }

  private async runDocker(
    args: string[],
    timeoutMs = DOCKER_CONTROL_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.execFileAsync('docker', args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: DOCKER_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });
  }

  async build(options: {
    tag: string;
    contextPath: string;
    dockerfile?: string; // Path to Dockerfile relative to context, or absolute
    buildArgs?: Record<string, string>;
    platform?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const args = ['build', '-t', options.tag];

    if (options.dockerfile) {
      args.push('-f', options.dockerfile);
    }

    if (options.buildArgs) {
      for (const [key, value] of Object.entries(options.buildArgs)) {
        args.push('--build-arg', `${key}=${value}`);
      }
    }

    if (options.platform) {
      args.push('--platform', options.platform);
    }

    args.push(options.contextPath);

    this.log(`docker ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          child.kill();
          reject(new Error('Build aborted'));
        }, { once: true });  // Prevent memory leak - listener auto-removed after firing
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        options.onStdout?.(chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        options.onStderr?.(chunk);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Docker build failed with code ${code}`));
        }
      });
    });
  }

  async push(image: string, options: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {}): Promise<void> {
    const args = ['push', image];
    this.log(`docker ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        options.onStdout?.(chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        options.onStderr?.(chunk);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Docker push failed with code ${code}`));
        }
      });
    });
  }

  private escapeShellArg(value: string): string {
    if (!value) {
      return "''";
    }
    if (/^[a-zA-Z0-9/_-]+$/.test(value)) {
      return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}

export type DockerStatReading = {
  cpuCores: number | null;
  memoryBytes: number | null;
  pids: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** Parse a docker stats size token such as "90.62MiB" or "1.44MB" into bytes. */
export const parseDockerSize = (token: string | undefined): number | null => {
  if (!token) return null;
  const match = /^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)?$/u.exec(token.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = SIZE_UNITS[unit] ?? 1;
  return value * factor;
};

const parsePercentToCores = (token: string | undefined): number | null => {
  if (!token) return null;
  const value = Number(token.replace('%', '').trim());
  return Number.isFinite(value) ? value / 100 : null;
};

/** Parse one `docker stats --format '{{json .}}'` line into a normalized reading. */
export const parseDockerStatLine = (line: string): DockerStatReading | null => {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string | undefined =>
    typeof row[key] === 'string' ? (row[key] as string) : undefined;

  const [memUsage] = (str('MemUsage') ?? '').split('/');
  const [netRx, netTx] = (str('NetIO') ?? '').split('/');
  const pidsRaw = Number((str('PIDs') ?? '').trim());

  return {
    cpuCores: parsePercentToCores(str('CPUPerc')),
    memoryBytes: parseDockerSize(memUsage?.trim()),
    pids: Number.isFinite(pidsRaw) ? pidsRaw : null,
    networkRxBytes: parseDockerSize(netRx?.trim()),
    networkTxBytes: parseDockerSize(netTx?.trim()),
  };
};
