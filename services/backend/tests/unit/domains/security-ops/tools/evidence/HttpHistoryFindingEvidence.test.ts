import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveCurrentSessionHttpHistoryEvidence,
} from '@/domains/security-ops/tools/evidence/HttpHistoryFindingEvidence';

describe('resolveCurrentSessionHttpHistoryEvidence', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disposition-http-evidence-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const appendHistory = async (entry: Record<string, unknown>): Promise<void> => {
    await fs.appendFile(
      path.join(workspaceDir, '.http-history.ndjson'),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    );
  };

  it('materializes a referenced current-session HTTP exchange with stable aliases', async () => {
    await appendHistory({
      id: 'current_request_1',
      ts: '2026-07-30T20:00:05.000Z',
      request: {
        method: 'POST',
        url: 'https://target.test/replay',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: '{"host":"safe"}',
      },
      status_code: 400,
      response_time_ms: 18,
      body_size: 21,
      body_truncated: false,
      body_preview: '{"error":"rejected"}',
      response_body: '{"error":"rejected"}',
      response_headers: 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nSet-Cookie: secret=1',
    });

    const result = await resolveCurrentSessionHttpHistoryEvidence({
      workspaceDir,
      evidenceReferences: ['current_request_1'],
      sessionStartedAt: Date.parse('2026-07-30T20:00:00.000Z'),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      aliases: ['current_request_1', 'http:current_request_1'],
      input: {
        kind: 'http_exchange',
        source: 'request_tool',
        durationMs: 18,
        request: {
          method: 'POST',
          url: 'https://target.test/replay',
        },
        response: {
          statusCode: 400,
        },
      },
    });
  });

  it('rejects stale, unreferenced, and transport-failed history entries', async () => {
    for (const entry of [
      {
        id: 'stale_request',
        ts: '2026-07-30T19:59:59.000Z',
        status_code: 200,
      },
      {
        id: 'unreferenced_request',
        ts: '2026-07-30T20:00:01.000Z',
        status_code: 200,
      },
      {
        id: 'transport_failure',
        ts: '2026-07-30T20:00:02.000Z',
        status_code: null,
      },
    ]) {
      await appendHistory({
        ...entry,
        request: { method: 'GET', url: 'https://target.test/', headers: {} },
        body_size: 0,
        body_truncated: false,
        body_preview: '',
        response_body: '',
        response_headers: '',
      });
    }

    const result = await resolveCurrentSessionHttpHistoryEvidence({
      workspaceDir,
      evidenceReferences: ['http:stale_request', 'transport_failure'],
      sessionStartedAt: Date.parse('2026-07-30T20:00:00.000Z'),
    });

    expect(result).toEqual([]);
  });
});
