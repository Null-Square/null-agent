import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

const securityOpsMocks = vi.hoisted(() => ({
  resolveHttpLoginCredential: vi.fn(),
  recordScopeAccessMaterialUse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry', () => ({
  getSecurityOpsService: () => securityOpsMocks,
}));

import { HttpPayload } from '@/domains/agent-brain/adapters/tools/builtins';
import { HttpSessionManager } from '@/domains/agent-brain/adapters/tools/runtime/HttpSessionManager';
import { readHttpHistoryEntries } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: { exec: vi.fn() } as any,
    sessionStore: { get: vi.fn() } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 2, timeoutMs: 5000 },
    flags: {},
    planRuntime: { appendProvenanceSnippet: vi.fn() } as any,
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 4 } } as any,
    ...overrides,
  }) as ToolContext;

const waitForHistoryEntries = async (workspaceDir: string, expected: number) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entries = await readHttpHistoryEntries(workspaceDir);
    if (entries.length >= expected) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readHttpHistoryEntries(workspaceDir);
};

describe('HttpPayload', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-payload-'));
    HttpSessionManager.clearForTests();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    HttpSessionManager.clearForTests();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('rejects empty url', async () => {
    const ctx = makeContext();

    const result = await HttpPayload.run({ url: '   ' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ success: false, error: 'url is required' });
  });

  it('returns error when session is missing', async () => {
    const ctx = makeContext({ sessionStore: { get: vi.fn().mockReturnValue(undefined) } as any });

    const result = await HttpPayload.run({ url: 'http://example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      success: false,
      error: 'Session session-1 not found',
    });
  });

  it('blocks private network URLs in SecurityOps cloud sessions', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    } as any;
    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await HttpPayload.run({ url: 'http://192.168.1.10' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('private runner'),
    });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('does not block public direct targets that carry private-address SSRF payload values', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    } as any;
    const stdout = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK';
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        abortReason: undefined,
        artifacts: [],
      })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await HttpPayload.run(
      { url: 'https://example.com/fetch?url=http%3A%2F%2F169.254.169.254%2Flatest' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it('blocks alternate localhost URL host encodings in SecurityOps cloud sessions', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    } as any;
    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await HttpPayload.run({ url: 'http://2130706433/' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('127.0.0.1'),
    });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('streams output, parses response, and writes history without raw stdout in the result', async () => {
    const session = { id: 'session-1', turn: 1, workspaceDir } as any;
    const streamBroker = { emit: vi.fn() } as any;
    const planRuntime = { appendProvenanceSnippet: vi.fn() } as any;
    const trace = { write: vi.fn().mockResolvedValue(undefined) } as any;

    const stdout =
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: session=top-secret\r\n\r\nBODY';
    const stderr = 'WARN';

    const sandbox = {
      exec: vi.fn(async ({ onStdout, onStderr }) => {
        onStdout?.(stdout);
        onStderr?.(stderr);
        return {
          stdout,
          stderr,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          abortReason: undefined,
          artifacts: [],
        };
      }),
    } as any;

    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
      streamBroker,
      planRuntime,
      trace,
      config: { trace: { stdoutChunkSize: 5 } } as any,
    });

    const result = await HttpPayload.run({ url: 'http://example.com' }, ctx);

    expect(sandbox.exec).toHaveBeenCalledTimes(1);

    const emittedChunks = streamBroker.emit.mock.calls
      .filter((call: any[]) => call[1]?.type === 'tool_output')
      .map((call: any[]) => call[1].data.chunk)
      .join('');

    expect(emittedChunks).toContain('HTTP/1.1 200 OK');
    expect(emittedChunks).toContain('BODY');
    expect(emittedChunks).toContain('WARN');

    expect(planRuntime.appendProvenanceSnippet).toHaveBeenCalled();
    expect(planRuntime.appendProvenanceSnippet).not.toHaveBeenCalledWith('session-1', 'WARN');

    expect(result.ok).toBe(true);
    const data = result.data as {
      success: boolean;
      method: string;
      status_code: number;
      body_preview: string;
      interesting_headers?: Record<string, string>;
      history_entry_id?: string;
      url: string;
      body_truncated: boolean;
      response_time_ms: number;
      stdout?: string;
    };
    expect(data.success).toBe(true);
    expect(data.method).toBe('GET');
    expect(data.status_code).toBe(200);
    expect(data.body_preview).toBe('BODY');
    expect(data.interesting_headers).toEqual(
      expect.objectContaining({
        'content-type': 'text/plain',
      }),
    );
    expect(data.history_entry_id).toEqual(expect.any(String));
    expect(data.url).toContain('http://example.com');
    expect(data.body_truncated).toBe(false);
    expect(data.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(data.stdout).toBeUndefined();

    const history = await waitForHistoryEntries(workspaceDir, 1);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('http://example.com'),
        }),
        status_code: 200,
        response_body: 'BODY',
      }),
    );
    expect(history[0]?.response_headers).toContain('Set-Cookie: [REDACTED]');
    expect(history[0]?.response_headers).not.toContain('session=top-secret');
  });

  it('retries direct when the sandbox HTTP proxy path fails', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      flags: {
        httpProxy: {
          enabled: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    } as any;
    const proxiedFailure = {
      stdout: '',
      stderr: 'curl: (56) CONNECT tunnel failed, response 502',
      exitCode: 56,
      timedOut: false,
      aborted: false,
      abortReason: undefined,
      artifacts: [],
    };
    const directSuccess = {
      stdout: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nDIRECT',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      abortReason: undefined,
      artifacts: [],
    };
    const sandbox = {
      exec: vi.fn()
        .mockResolvedValueOnce(proxiedFailure)
        .mockResolvedValueOnce(directSuccess),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await HttpPayload.run({ url: 'https://example.com' }, ctx);

    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(sandbox.exec.mock.calls[0]?.[0].cmd).toContain('--proxy http://127.0.0.1:8080');
    expect(sandbox.exec.mock.calls[1]?.[0].cmd).not.toContain('--proxy');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        body_preview: 'DIRECT',
        proxy_used: false,
        proxy_fallback: true,
      }),
    );
  });

  it('parses HTTP/2, caps response bodies, and emits passive security observations', async () => {
    const session = { id: 'session-1', turn: 1, workspaceDir } as any;
    const htmlBody = '<html><body>' + 'A'.repeat(14_000) + '</body></html>';
    const stdout = `HTTP/2 200\r\nContent-Type: text/html\r\n\r\n${htmlBody}`;

    const sandbox = {
      exec: vi.fn(async () => ({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        abortReason: undefined,
        artifacts: [],
      })),
    } as any;

    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    const result = await HttpPayload.run(
      { url: 'https://example.com', max_body_bytes: 12 },
      ctx,
    );

    expect(result.ok).toBe(true);
    const data = result.data as {
      status_code: number;
      body_preview: string;
      body_size: number;
      body_truncated: boolean;
      history_entry_id?: string;
      interesting_headers?: Record<string, string>;
      security_observations?: string[];
    };

    expect(data.status_code).toBe(200);
    expect(data.body_size).toBeGreaterThan(12);
    expect(data.body_preview).toHaveLength(12);
    expect(data.body_truncated).toBe(true);
    expect(data.history_entry_id).toEqual(expect.any(String));
    expect(data.interesting_headers).toEqual(
      expect.objectContaining({
        'content-type': 'text/html',
      }),
    );
    expect(data.security_observations).toEqual(
      expect.arrayContaining([
        'HSTS not set',
        'CSP not set',
        'X-Frame-Options not set',
        'X-Content-Type-Options not set',
      ]),
    );

    const history = await waitForHistoryEntries(workspaceDir, 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.response_body.length).toBeLessThanOrEqual(12_000);
    expect(history[0]?.response_body).toBe(htmlBody.slice(0, history[0]?.response_body.length));
    expect(history[0]?.body_truncated).toBe(true);
  });

  it('throws AbortError when sandbox reports aborted', async () => {
    const session = { id: 'session-1', turn: 0, workspaceDir } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: false,
        aborted: true,
        abortReason: 'cancelled',
        artifacts: [],
      })),
    } as any;
    const ctx = makeContext({
      sandbox,
      sessionStore: { get: vi.fn().mockReturnValue(session) } as any,
    });

    await expect(HttpPayload.run({ url: 'http://example.com' }, ctx)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancelled',
    });
  });

  it('ignores legacy credentialRef fields and executes the direct request payload', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          accessMaterials: {
            availableCount: 1,
            listChecked: true,
            usedByHost: {},
            materials: [
              {
                id: 'material-1',
                kind: 'login_credential',
                label: 'App Login',
                username: 'demo@example.com',
                headerName: null,
                notes: null,
                appliesToHosts: ['app.nullsquare.net'],
              },
            ],
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        abortReason: undefined,
        artifacts: [],
      })),
    } as any;
    const ctx = makeContext({
      workspaceDir,
      sandbox,
      sessionStore: {
        get: vi.fn().mockReturnValue(session),
      } as any,
      flags: session.flags,
    });

    const result = await HttpPayload.run(
      {
        url: 'https://app.nullsquare.net/api/auth/login',
        method: 'POST',
        body: JSON.stringify({ email: 'demo@example.com', password: 'guess' }),
        credentialRef: 'App Login',
        credentialPlacement: 'json',
        usernameField: 'email',
        passwordField: 'password',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(securityOpsMocks.resolveHttpLoginCredential).not.toHaveBeenCalled();
    expect(securityOpsMocks.recordScopeAccessMaterialUse).not.toHaveBeenCalled();
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining('demo@example.com'),
      }),
    );
  });

  it('uses caller-provided form data directly instead of server-side credential expansion', async () => {
    const session = {
      id: 'session-1',
      turn: 1,
      workspaceDir,
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          accessMaterials: {
            availableCount: 1,
            listChecked: true,
            usedByHost: {},
            materials: [],
          },
        },
      },
    } as any;
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        abortReason: undefined,
        artifacts: [],
      })),
    } as any;
    const ctx = makeContext({
      workspaceDir,
      sandbox,
      sessionStore: {
        get: vi.fn().mockReturnValue(session),
        mergeFlagNamespaceAsync: vi.fn().mockResolvedValue(true),
      } as any,
      flags: session.flags,
    });

    const result = await HttpPayload.run(
      {
        url: 'https://legacy.nullsquare.net/session',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'username=user%40example.com&password=legacy-secret',
        credentialRef: 'material-2',
        credentialPlacement: 'form',
        usernameField: 'username',
        passwordField: 'password',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(securityOpsMocks.resolveHttpLoginCredential).not.toHaveBeenCalled();
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: expect.stringContaining('username=user%40example.com&password=legacy-secret'),
      }),
    );
  });
});
