import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceProxyCaptureSource } from '@/domains/security-ops/runs/WorkspaceProxyCaptureSource';
import { appendHttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function buildDb(rows: Array<{ id: string; workspaceDir: string }>) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => rows),
    })),
  }));
  return {
    db: { select } as never,
    select,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'null-ai-proxy-capture-'));
  tempDirs.push(dir);
  return dir;
}

describe('WorkspaceProxyCaptureSource', () => {
  it('loads and normalizes sandbox proxy capture events from session workspaces', async () => {
    const workspaceDir = await makeWorkspace();
    await writeFile(
      path.join(workspaceDir, '.http-proxy.ndjson'),
      [
        JSON.stringify({
          ts: '2026-04-02T10:08:00.000Z',
          request: {
            method: 'get',
            url: 'https://Example.com/admin?tab=users',
          },
          response: {
            status_code: 403,
            headers: [
              'Content-Type: application/json; charset=utf-8',
              'X-Frame-Options: DENY',
            ].join('\r\n'),
          },
          response_time_ms: 55,
        }),
        'not-json',
        JSON.stringify({
          ts: '2026-04-02T10:09:00.000Z',
          request: {
            method: 'POST',
            url: 'not-a-url',
          },
        }),
      ].join('\n'),
    );
    const { db } = buildDb([
      { id: 'session-1', workspaceDir },
      { id: 'session-missing-capture', workspaceDir: path.join(workspaceDir, 'missing') },
    ]);
    const source = new WorkspaceProxyCaptureSource(db);

    const events = await source.listEventsForSessions(['session-1', 'session-missing-capture']);

    expect(events).toEqual([
      {
        ts: '2026-04-02T10:08:00.000Z',
        method: 'GET',
        host: 'example.com',
        path: '/admin',
        statusCode: 403,
        contentType: 'application/json',
        durationMs: 55,
        rawResponseHeaders: expect.stringContaining('X-Frame-Options: DENY'),
      },
    ]);
  });

  it('loads http_payload history entries as captured response-header telemetry', async () => {
    const workspaceDir = await makeWorkspace();
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'history-1',
      ts: '2026-04-02T10:11:00.000Z',
      request: {
        method: 'get',
        url: 'https://Example.com/login?next=/admin',
        headers: {},
      },
      success: true,
      status_code: 200,
      response_time_ms: 88,
      body_size: 18,
      body_truncated: false,
      body_preview: '<html></html>',
      response_body: '<html></html>',
      response_headers: [
        'HTTP/2 200',
        'Content-Type: text/html; charset=utf-8',
        'Strict-Transport-Security: max-age=31536000',
        "Content-Security-Policy: default-src 'self'",
        'X-Frame-Options: DENY',
        'X-Content-Type-Options: nosniff',
      ].join('\r\n'),
    });
    await appendHttpHistoryEntry(workspaceDir, {
      id: 'history-bad-url',
      ts: '2026-04-02T10:12:00.000Z',
      request: {
        method: 'GET',
        url: 'not-a-url',
        headers: {},
      },
      success: true,
      status_code: 200,
      response_time_ms: 10,
      body_size: 0,
      body_truncated: false,
      body_preview: '',
      response_body: '',
      response_headers: 'HTTP/2 200',
    });
    const { db } = buildDb([{ id: 'session-1', workspaceDir }]);
    const source = new WorkspaceProxyCaptureSource(db);

    const events = await source.listEventsForSessions(['session-1']);

    expect(events).toEqual([
      {
        ts: '2026-04-02T10:11:00.000Z',
        method: 'GET',
        host: 'example.com',
        path: '/login',
        statusCode: 200,
        contentType: 'text/html',
        durationMs: 88,
        rawResponseHeaders: expect.stringContaining('Strict-Transport-Security: max-age=31536000'),
      },
    ]);
  });

  it('does not query storage when no sessions are provided', async () => {
    const { db, select } = buildDb([]);
    const source = new WorkspaceProxyCaptureSource(db);

    await expect(source.listEventsForSessions([])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
