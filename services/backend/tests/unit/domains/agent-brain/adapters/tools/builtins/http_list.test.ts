import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { HttpList } from '@/domains/agent-brain/adapters/tools/builtins';
import { appendHttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
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

describe('HttpList', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-list-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('lists most recent history entries first and supports filtering', async () => {
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'older',
      ts: '2026-03-08T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://example.com/a',
        headers: {},
      },
      success: true,
      status_code: 200,
      response_time_ms: 120,
      body_size: 10,
      body_truncated: false,
      body_preview: 'older',
      response_body: 'older-body',
      response_headers: 'HTTP/2 200',
    });

    await appendHttpHistoryEntry(workspaceDir, {
      id: 'newer',
      ts: '2026-03-08T10:01:00.000Z',
      request: {
        method: 'POST',
        url: 'https://example.com/api/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ok":true}',
      },
      success: false,
      status_code: 403,
      response_time_ms: 240,
      body_size: 600,
      body_truncated: false,
      body_preview: 'x'.repeat(600),
      response_body: 'x'.repeat(600),
      response_headers: 'HTTP/2 403',
      curl_error: 'forbidden',
    });

    const ctx = makeContext(workspaceDir);
    const result = await HttpList.run(
      { filter: { method: 'post', status_min: 403, status_max: 403 } },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      totalCount: 1,
      limit: 20,
      offset: 0,
      entries: [
        expect.objectContaining({
          id: 'newer',
          method: 'POST',
          url: 'https://example.com/api/users',
          status_code: 403,
          response_time_ms: 240,
          body_size: 600,
        }),
      ],
    });
  });

  it('includes raw HTTP captures with manifest references', async () => {
    await appendRawHttpHistoryEntry(workspaceDir, {
      id: 'raw-1',
      ts: '2026-03-08T10:02:00.000Z',
      source: 'http_raw_send',
      target: {
        url: 'https://example.com/raw',
        host: 'example.com',
        port: 443,
        tls: true,
      },
      request_count: 1,
      read_strategy: 'after_each',
      status_code: 200,
      success: true,
      response_time_ms: 75,
      request_artifacts: [
        {
          path: '.artifacts/raw-http/raw-1/request-1.bin',
          sha256: 'request-hash',
          size: 37,
        },
      ],
      response_artifacts: [
        {
          path: '.artifacts/raw-http/raw-1/response-1.bin',
          sha256: 'response-hash',
          size: 42,
        },
      ],
      manifest_path: '.artifacts/raw-http/raw-1/manifest.json',
      request_preview: 'GET /raw HTTP/1.1\r\nX-Test: 1\r\n\r\n',
      response_preview: 'HTTP/1.1 200 OK\r\n\r\nraw',
      body_size: 42,
      response_truncated: false,
    });

    const ctx = makeContext(workspaceDir);
    const result = await HttpList.run({ filter: { method: 'RAW' } }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      totalCount: 1,
      limit: 20,
      offset: 0,
      entries: [
        expect.objectContaining({
          id: 'raw-1',
          source: 'http_raw_send',
          method: 'RAW',
          url: 'https://example.com/raw',
          status_code: 200,
          raw_manifest_path: '.artifacts/raw-http/raw-1/manifest.json',
        }),
      ],
    });
  });
});
