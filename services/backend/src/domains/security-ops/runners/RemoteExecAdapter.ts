import { randomUUID } from 'crypto';
import type { ExecResult } from '@/domains/agent-brain/adapters/sandbox';
import { logger } from '@/shared/logger';
import { runnerConnectionRegistry, type RunnerConnectionRegistry } from './RunnerConnectionRegistry';

const DEFAULT_TIMEOUT_MS = 300_000;

type RunnerMessage = Record<string, unknown> & {
  type: string;
  requestId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export class RunnerDisconnectedError extends Error {
  constructor(runnerId: string) {
    super(`Runner disconnected: ${runnerId}`);
    this.name = 'RunnerDisconnectedError';
  }
}

export class RunnerTimeoutError extends Error {
  constructor(requestId: string, timeoutMs: number) {
    super(`Runner request timed out (${requestId}) after ${timeoutMs}ms`);
    this.name = 'RunnerTimeoutError';
  }
}

export class RemoteExecAdapter {
  private readonly log = logger.child({ scope: 'RemoteExecAdapter' });

  constructor(private readonly registry: RunnerConnectionRegistry = runnerConnectionRegistry) {}

  private async request(
    runnerId: string,
    payload: Record<string, unknown>,
    responseTypes: string[],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<RunnerMessage> {
    const requestId =
      typeof payload.requestId === 'string' && payload.requestId.trim().length > 0
        ? payload.requestId.trim()
        : randomUUID();

    const message = await this.registry.request<RunnerMessage>(
      runnerId,
      {
        ...payload,
        requestId,
      },
      {
        responseTypes: [...responseTypes, 'error'],
        timeoutMs: Math.max(1_000, timeoutMs),
      },
    );

    if (message.type === 'error') {
      throw new Error(getString(message.message) ?? 'Runner request failed');
    }

    return message;
  }

  async exec(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    cmd: string;
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<ExecResult> {
    const requestId = randomUUID();
    const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeMessage();
        unsubscribeDisconnect();
        params.signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        finish(() => reject(new Error(params.signal?.reason?.toString() || 'aborted')));
      };

      const unsubscribeDisconnect = this.registry.onRunnerDisconnect(params.runnerId, () => {
        finish(() => reject(new RunnerDisconnectedError(params.runnerId)));
      });

      const unsubscribeMessage = this.registry.subscribeRequest(requestId, (message) => {
        switch (message.type) {
          case 'stdout': {
            const chunk = getString(message.data);
            if (!chunk) return;
            stdout += chunk;
            params.onStdout?.(chunk);
            return;
          }
          case 'stderr': {
            const chunk = getString(message.data);
            if (!chunk) return;
            stderr += chunk;
            params.onStderr?.(chunk);
            return;
          }
          case 'error': {
            const msg = getString(message.message) ?? 'Runner execution failed';
            finish(() => reject(new Error(msg)));
            return;
          }
          case 'exit': {
            const codeRaw = message.code;
            const code = typeof codeRaw === 'number' ? codeRaw : Number(codeRaw ?? 1);
            finish(() =>
              resolve({
                exitCode: Number.isFinite(code) ? code : 1,
                stdout,
                stderr,
                bytesOut: Buffer.byteLength(stdout, 'utf-8'),
                bytesErr: Buffer.byteLength(stderr, 'utf-8'),
              }),
            );
            return;
          }
          default:
            return;
        }
      });

      const timer = setTimeout(() => {
        finish(() => reject(new RunnerTimeoutError(requestId, timeoutMs)));
      }, timeoutMs);

      if (params.signal) {
        params.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        this.registry.send(params.runnerId, {
          type: 'exec',
          requestId,
          sessionId: params.sessionId,
          ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
          command: params.cmd,
          env: params.env ?? {},
          cwd: params.cwd ?? '/workspace',
          timeoutMs,
        });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async readFile(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    path: string;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<Buffer> {
    const message = await this.request(
      params.runnerId,
      {
        type: 'file_read',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
        path: params.path,
        ...(typeof params.maxBytes === 'number' && params.maxBytes >= 0
          ? { maxBytes: Math.floor(params.maxBytes) }
          : {}),
      },
      ['file_read_result'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    if (typeof message.content === 'string') {
      return Buffer.from(message.content, 'utf-8');
    }
    if (typeof message.contentBase64 === 'string') {
      return Buffer.from(message.contentBase64, 'base64');
    }
    throw new Error('Invalid file_read_result payload');
  }

  async writeFile(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    path: string;
    content: string | Buffer;
    timeoutMs?: number;
  }): Promise<void> {
    const payload =
      typeof params.content === 'string'
        ? {
            content: params.content,
            contentEncoding: 'utf8',
          }
        : {
            content: params.content.toString('base64'),
            contentEncoding: 'base64',
          };

    await this.request(
      params.runnerId,
      {
        type: 'file_write',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
        path: params.path,
        ...payload,
      },
      ['file_write_ack'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  async statFile(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    path: string;
    timeoutMs?: number;
  }): Promise<{
    exists: boolean;
    isFile: boolean;
    sizeBytes: number;
    mtimeMs: number | null;
    isSymbolicLink: boolean | null;
  }> {
    const message = await this.request(
      params.runnerId,
      {
        type: 'file_stat',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
        path: params.path,
      },
      ['file_stat_result'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    return {
      exists: message.exists === true,
      isFile: message.isFile === true,
      sizeBytes: typeof message.sizeBytes === 'number' ? message.sizeBytes : 0,
      mtimeMs: typeof message.mtimeMs === 'number' ? message.mtimeMs : null,
      isSymbolicLink:
        typeof message.isSymbolicLink === 'boolean' ? message.isSymbolicLink : null,
    };
  }

  async sessionInit(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    timeoutMs?: number;
  }): Promise<void> {
    await this.request(
      params.runnerId,
      {
        type: 'session_init',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
      },
      ['session_init_ack'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  async sessionDestroy(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    timeoutMs?: number;
  }): Promise<void> {
    await this.request(
      params.runnerId,
      {
        type: 'session_destroy',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
      },
      ['session_destroy_ack'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  async browserAction(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    action: string;
    payload: Record<string, unknown>;
    scopeBoundary?: {
      rulesDigest: string;
      roots: Array<{ type: 'domain' | 'cidr'; value: string }>;
      exclusions: Array<{ type: 'domain' | 'cidr'; value: string }>;
    };
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const message = await this.request(
      params.runnerId,
      {
        type: 'browser_action',
        sessionId: params.sessionId,
        ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
        action: params.action,
        payload: params.payload,
        ...(params.scopeBoundary ? { scopeBoundary: params.scopeBoundary } : {}),
      },
      ['browser_action_result'],
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    return isRecord(message.data) ? message.data : {};
  }

  async fetchArtifacts(params: {
    runnerId: string;
    sessionId: string;
    workspaceKey?: string;
    paths: string[];
    timeoutMs?: number;
  }): Promise<Map<string, Buffer>> {
    const requestId = randomUUID();
    const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const files = new Map<string, Buffer>();

    return new Promise<Map<string, Buffer>>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeMessage();
        unsubscribeDisconnect();
      };

      const unsubscribeDisconnect = this.registry.onRunnerDisconnect(params.runnerId, () => {
        finish(() => reject(new RunnerDisconnectedError(params.runnerId)));
      });

      const unsubscribeMessage = this.registry.subscribeRequest(requestId, (message) => {
        if (message.type === 'error') {
          finish(() => reject(new Error(getString(message.message) ?? 'Artifact fetch failed')));
          return;
        }

        if (message.type === 'artifact') {
          const path = getString(message.path);
          const content = getString(message.content);
          if (!path || content === null) {
            return;
          }
          const encoding =
            getString(message.contentEncoding)?.toLowerCase() === 'utf8' ? 'utf8' : 'base64';
          const buffer =
            encoding === 'utf8' ? Buffer.from(content, 'utf-8') : Buffer.from(content, 'base64');
          files.set(path, buffer);
          return;
        }

        if (message.type === 'artifact_done') {
          finish(() => resolve(files));
        }
      });

      const timer = setTimeout(() => {
        finish(() => reject(new RunnerTimeoutError(requestId, timeoutMs)));
      }, timeoutMs);

      try {
        this.registry.send(params.runnerId, {
          type: 'artifact_request',
          requestId,
          sessionId: params.sessionId,
          ...(params.workspaceKey ? { workspaceKey: params.workspaceKey } : {}),
          paths: params.paths,
        });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
}

export const remoteExecAdapter = new RemoteExecAdapter();

export const parseRunnerMessage = (value: unknown): RunnerMessage | null => {
  if (!isRecord(value)) return null;
  if (typeof value.type !== 'string') return null;
  return value as RunnerMessage;
};
