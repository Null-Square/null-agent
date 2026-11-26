import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { HttpDifferential } from '@/domains/agent-brain/adapters/tools/builtins';
import { HttpSessionManager } from '@/domains/agent-brain/adapters/tools/runtime/HttpSessionManager';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const makeContext = (workspaceDir: string, sandbox: any, overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir,
    sandbox,
    sessionStore: {
      get: vi.fn().mockReturnValue({
        id: 'session-1',
        turn: 1,
        workspaceDir,
        flags: {},
      }),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 65_536, timeoutMs: 30_000 },
    flags: {},
    planRuntime: { appendProvenanceSnippet: vi.fn() } as any,
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 65_536 } } as any,
    ...overrides,
  }) as ToolContext;

/**
 * Build a curl-shaped response for the mocked sandbox.exec. The httpRequestExecutor parses
 * stdout via parseCurlHttpResponse so we emit a realistic response (headers + blank line + body).
 */
const buildCurlStdout = (params: { status: number; body: string; headers?: Record<string, string> }) => {
  const headers = {
    'content-type': 'application/json',
    'content-length': String(params.body.length),
    ...(params.headers ?? {}),
  };
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return `HTTP/2 ${params.status}\r\n${headerLines}\r\n\r\n${params.body}`;
};

describe('HttpDifferential (PRD 2.0-B §2)', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-differential-'));
    HttpSessionManager.clearForTests();
  });

  afterEach(async () => {
    HttpSessionManager.clearForTests();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('dispatches one baseline plus N variants and tabulates the diff', async () => {
    let call = 0;
    const sandbox = {
      exec: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // baseline: id=1 returns small body
          return { exitCode: 0, stdout: buildCurlStdout({ status: 200, body: '{"id":1,"owner":"a"}' }), stderr: '', timedOut: false, aborted: false };
        }
        if (call === 2) {
          // id=2 returns a different body, same status — anomaly via combined signal (>256 byte delta? No — small delta), so use signal=body_length and accept it
          return { exitCode: 0, stdout: buildCurlStdout({ status: 200, body: '{"id":2,"owner":"b"}' }), stderr: '', timedOut: false, aborted: false };
        }
        if (call === 3) {
          // id=99999999 returns 404 — anomaly
          return { exitCode: 0, stdout: buildCurlStdout({ status: 404, body: 'not found' }), stderr: '', timedOut: false, aborted: false };
        }
        return { exitCode: 0, stdout: buildCurlStdout({ status: 200, body: '{}' }), stderr: '', timedOut: false, aborted: false };
      }),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await HttpDifferential.run(
      {
        url_template: 'https://target.example.com/api/orders/{orderId}',
        parameter: { name: 'orderId', in: 'path' },
        baseline: '1',
        values: [
          { kind: 'literal', value: '2' },
          { kind: 'literal', value: '99999999' },
        ],
        signal: 'status',
      } as any,
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(sandbox.exec).toHaveBeenCalledTimes(3); // baseline + 2 variants
    expect(result.data).toEqual(
      expect.objectContaining({
        baseline: expect.objectContaining({ value: '1', status: 200 }),
        observations: expect.arrayContaining([
          expect.objectContaining({ value: '2', status: 200, anomaly: false }),
          expect.objectContaining({
            parameter: 'orderId',
            baselineValue: '1',
            observedValue: '99999999',
            signal: 'status',
            value: '99999999',
            status: 404,
            anomaly: true,
            delta: expect.any(String),
          }),
        ]),
        anomalies: expect.arrayContaining([
          expect.objectContaining({ value: '99999999' }),
        ]),
      }),
    );
  });

  it('expands mutation classes into individual variants (capped)', async () => {
    let call = 0;
    const sandbox = {
      exec: vi.fn(async () => {
        call += 1;
        return { exitCode: 0, stdout: buildCurlStdout({ status: 200, body: '{}' }), stderr: '', timedOut: false, aborted: false };
      }),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    await HttpDifferential.run(
      {
        url_template: 'https://target.example.com/api/orders/{orderId}',
        parameter: { name: 'orderId', in: 'path' },
        baseline: '1',
        values: [{ kind: 'boundary' }, { kind: 'type_confusion' }],
        signal: 'status',
      } as any,
      ctx,
    );

    // boundary (5) + type_confusion (7) = 12 variants + 1 baseline = 13 exec calls
    expect(sandbox.exec.mock.calls.length).toBeGreaterThan(5);
    expect(sandbox.exec.mock.calls.length).toBeLessThanOrEqual(21); // baseline + MAX_VARIANTS
  });

  it('replaces existing query parameters instead of appending duplicate keys', async () => {
    const sandbox = {
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: buildCurlStdout({ status: 200, body: '{}' }),
        stderr: '',
        timedOut: false,
        aborted: false,
      })),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await HttpDifferential.run(
      {
        url_template: 'https://target.example.com/api/orders?orderId=1&sort=asc',
        parameter: { name: 'orderId', in: 'query' },
        baseline: '1',
        values: [{ kind: 'literal', value: '2' }],
      } as any,
      ctx,
    );

    expect(result.ok).toBe(true);
    const commands = sandbox.exec.mock.calls.map(([call]: any[]) => String(call.cmd));
    expect(commands[0]).toContain('https://target.example.com/api/orders?orderId=1&sort=asc');
    expect(commands[1]).toContain('https://target.example.com/api/orders?orderId=2&sort=asc');
    expect(commands[1]).not.toContain('orderId=1&sort=asc&orderId=2');
  });

  it('mutates JSON body fields for baseline and variants', async () => {
    const sandbox = {
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: buildCurlStdout({ status: 200, body: '{}' }),
        stderr: '',
        timedOut: false,
        aborted: false,
      })),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await HttpDifferential.run(
      {
        url_template: 'https://target.example.com/api/profile',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"alice"}',
        parameter: { name: 'role', in: 'body_json_field' },
        baseline: 'user',
        values: [{ kind: 'literal', value: 'admin' }],
        signal: 'status',
      } as any,
      ctx,
    );

    expect(result.ok).toBe(true);
    const commands = sandbox.exec.mock.calls.map(([call]: any[]) => String(call.cmd));
    expect(commands[0]).toContain('"role":"user"');
    expect(commands[1]).toContain('"role":"admin"');
  });

  it('mutates headers case-insensitively and flags configured header-signal anomalies', async () => {
    let call = 0;
    const sandbox = {
      exec: vi.fn(async () => {
        call += 1;
        return {
          exitCode: 0,
          stdout: buildCurlStdout({
            status: 302,
            body: '',
            headers: { location: call === 1 ? '/account' : '/login' },
          }),
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      }),
    } as any;
    const ctx = makeContext(workspaceDir, sandbox);

    const result = await HttpDifferential.run(
      {
        url_template: 'https://target.example.com/api/account',
        headers: { authorization: 'Bearer valid-token' },
        parameter: { name: 'Authorization', in: 'header' },
        baseline: 'Bearer valid-token',
        values: [{ kind: 'literal', value: 'REMOVE' }],
        signal: 'headers',
      } as any,
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      observations: [
        expect.objectContaining({
          value: 'REMOVE',
          anomaly: true,
          reason: expect.stringContaining('headers diverged'),
        }),
      ],
    }));
    const commands = sandbox.exec.mock.calls.map(([callArg]: any[]) => String(callArg.cmd));
    expect(commands[0]).toContain('authorization: Bearer valid-token');
    expect(commands[1]).not.toContain('authorization:');
  });

  it('returns an error when parameter or values are missing', async () => {
    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext(workspaceDir, sandbox);
    const result = await HttpDifferential.run({} as any, ctx);
    expect(result.ok).toBe(false);
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
