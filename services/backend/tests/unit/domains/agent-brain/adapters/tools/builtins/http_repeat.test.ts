import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { HttpRepeat, HttpView } from '@/domains/agent-brain/adapters/tools/builtins';
import { HttpSessionManager } from '@/domains/agent-brain/adapters/tools/runtime/HttpSessionManager';
import { appendHttpHistoryEntry, readHttpHistoryEntries } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import { appendRawHttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/rawHttpHistory';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

const makeContext = (workspaceDir: string, overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir,
    sandbox: { exec: vi.fn() } as any,
    sessionStore: {
      get: vi.fn().mockReturnValue({
        id: 'session-1',
        turn: 1,
        workspaceDir,
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

describe('HttpRepeat', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-repeat-'));
    HttpSessionManager.clearForTests();
  });

  afterEach(async () => {
    HttpSessionManager.clearForTests();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('returns the stored response in view mode without resending traffic', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-1',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/view',
        headers: {},
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 18,
      body_truncated: false,
      body_preview: 'stored-preview',
      response_body: 'stored-body-content',
      response_headers: 'HTTP/2 200',
    });

    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext(workspaceDir, { sandbox });

    const result = await HttpView.run({ request_id: 'req-1', part: 'response' }, ctx);

    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        id: 'req-1',
        part: 'response',
        response: expect.objectContaining({
          status_code: 200,
          body: 'stored-body-content',
        }),
      }),
    );
  });

  it('replays a stored request with mutations and reuses session auth instead of sending [REDACTED]', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'req-2',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://example.com/api/users',
        headers: {
          Authorization: '[REDACTED]',
          'Content-Type': 'application/json',
        },
        body: '{"name":"old"}',
        options: {
          timeout: 15,
          follow_redirects: true,
          insecure: false,
        },
      },
      success: true,
      status_code: 200,
      response_time_ms: 111,
      body_size: 2,
      body_truncated: false,
      body_preview: '{}',
      response_body: '{}',
      response_headers: 'HTTP/2 200',
    });

    const httpSession = await HttpSessionManager.getSession({
      url: 'https://example.com/api/users',
      workspaceDir,
    });
    expect(httpSession).not.toBeNull();
    HttpSessionManager.updateFromRequest(httpSession!, { Authorization: 'Bearer live-token' });

    const stdout = 'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{"ok":true}';
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

    const ctx = makeContext(workspaceDir, { sandbox });
    const result = await HttpRepeat.run(
      {
        request_id: 'req-2',
        modifications: {
          headers: { 'X-Test': '1' },
          params: { page: '2' },
          body: '{"name":"new"}',
        },
      },
      ctx,
    );

    expect(sandbox.exec).toHaveBeenCalledTimes(1);
    const command = sandbox.exec.mock.calls[0][0].cmd as string;
    expect(command).toContain('Authorization: Bearer live-token');
    expect(command).not.toContain('[REDACTED]');
    expect(command).toContain('X-Test: 1');
    expect(command).toContain('https://example.com/api/users?page=2');
    expect(command).toContain('{"name":"new"}');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        status_code: 201,
        replayed: true,
        replayed_from: 'req-2',
      }),
    );

    const history = await waitForHistoryEntries(workspaceDir, 2);
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual(
      expect.objectContaining({
        replayed_from: 'req-2',
        request: expect.objectContaining({
          url: 'https://example.com/api/users?page=2',
        }),
      }),
    );
  });

  it('exposes raw captures through http_view but refuses normalized replay', async () => {
    await appendRawHttpHistoryEntry(workspaceDir, {
      id: 'raw-repeat-block',
      ts: '2026-03-08T10:00:00.000Z',
      source: 'http_raw_send',
      target: {
        url: 'https://example.com/smuggle',
        host: 'example.com',
        port: 443,
        tls: true,
      },
      request_count: 1,
      read_strategy: 'after_each',
      status_code: 200,
      success: true,
      response_time_ms: 99,
      request_artifacts: [
        {
          path: '.artifacts/raw-http/raw-repeat-block/request-1.bin',
          sha256: 'request-hash',
          size: 84,
        },
      ],
      response_artifacts: [
        {
          path: '.artifacts/raw-http/raw-repeat-block/response-1.bin',
          sha256: 'response-hash',
          size: 55,
        },
      ],
      manifest_path: '.artifacts/raw-http/raw-repeat-block/manifest.json',
      request_preview: 'POST /smuggle HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n',
      response_preview: 'HTTP/1.1 200 OK\r\n\r\nOK',
      body_size: 55,
      response_truncated: false,
    });

    const sandbox = { exec: vi.fn() } as any;
    const ctx = makeContext(workspaceDir, { sandbox });

    const viewResult = await HttpView.run({ request_id: 'raw-repeat-block', part: 'request' }, ctx);
    expect(viewResult.ok).toBe(true);
    expect(viewResult.data).toEqual(
      expect.objectContaining({
        id: 'raw-repeat-block',
        request: expect.objectContaining({
          method: 'RAW',
          body: expect.stringContaining('Transfer-Encoding: chunked'),
        }),
        raw: expect.objectContaining({
          manifest_path: '.artifacts/raw-http/raw-repeat-block/manifest.json',
          request_paths: ['.artifacts/raw-http/raw-repeat-block/request-1.bin'],
        }),
      }),
    );

    const repeatResult = await HttpRepeat.run({ request_id: 'raw-repeat-block' }, ctx);
    expect(repeatResult.ok).toBe(false);
    expect(repeatResult.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('cannot be replayed with http_repeat'),
        raw: expect.objectContaining({
          request_paths: ['.artifacts/raw-http/raw-repeat-block/request-1.bin'],
        }),
      }),
    );
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
