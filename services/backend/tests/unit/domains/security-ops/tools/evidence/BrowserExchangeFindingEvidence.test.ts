import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveBrowserExchangeEvidence,
} from '@/domains/security-ops/tools/evidence/BrowserExchangeFindingEvidence';

describe('resolveBrowserExchangeEvidence', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-exchange-evidence-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const writeExchange = async (record: Record<string, unknown>): Promise<void> => {
    const dir = path.join(workspaceDir, '.artifacts', 'browser', 'exchanges');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${record.id as string}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  };

  const corsExchange = {
    id: 'bx-2026-07-30-20-00-05-000-cors-proof',
    capturedAt: '2026-07-30T20:00:05.000Z',
    kind: 'http_exchange',
    source: 'browser',
    label: 'cors-proof',
    durationMs: 42,
    request: {
      method: 'GET',
      url: 'https://api.example.test/profile',
      headers: [
        { name: 'Origin', value: 'https://evil.example.test' },
        { name: 'Cookie', value: '[REDACTED]' },
      ],
    },
    response: {
      statusCode: 200,
      contentType: 'application/json',
      headers: [
        { name: 'access-control-allow-origin', value: 'https://evil.example.test' },
        { name: 'access-control-allow-credentials', value: 'true' },
      ],
      body: '{"email":"evaluator@example.test"}',
    },
  };

  it('resolves browser-network references and bare ids to browser-sourced exchanges', async () => {
    await writeExchange(corsExchange);

    const byPrefix = await resolveBrowserExchangeEvidence({
      workspaceDir,
      evidenceReferences: [`browser-network:${corsExchange.id}`],
    });

    expect(byPrefix).toHaveLength(1);
    expect(byPrefix[0]?.aliases).toEqual(expect.arrayContaining([
      `browser-network:${corsExchange.id}`,
      corsExchange.id,
    ]));
    expect(byPrefix[0]?.input).toMatchObject({
      kind: 'http_exchange',
      source: 'browser',
      label: 'cors-proof',
      durationMs: 42,
      request: {
        method: 'GET',
        url: 'https://api.example.test/profile',
        headers: [
          { name: 'Origin', value: 'https://evil.example.test' },
          { name: 'Cookie', value: '[REDACTED]' },
        ],
      },
      response: {
        statusCode: 200,
        contentType: 'application/json',
        body: '{"email":"evaluator@example.test"}',
      },
    });

    const byBareId = await resolveBrowserExchangeEvidence({
      workspaceDir,
      evidenceReferences: [corsExchange.id],
    });
    expect(byBareId).toHaveLength(1);
    expect(byBareId[0]?.input.source).toBe('browser');
  });

  it('ignores unknown references and malformed artifacts', async () => {
    await writeExchange(corsExchange);
    const dir = path.join(workspaceDir, '.artifacts', 'browser', 'exchanges');
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');

    const result = await resolveBrowserExchangeEvidence({
      workspaceDir,
      evidenceReferences: ['browser-network:does-not-exist', 'http:abc123'],
    });

    expect(result).toEqual([]);
  });

  it('returns nothing when no exchanges are persisted', async () => {
    const result = await resolveBrowserExchangeEvidence({
      workspaceDir,
      evidenceReferences: [`browser-network:${corsExchange.id}`],
    });

    expect(result).toEqual([]);
  });

  it('filters stale exchanges when sessionStartedAt is provided', async () => {
    await writeExchange({ ...corsExchange, capturedAt: '2026-07-30T19:59:00.000Z' });

    const result = await resolveBrowserExchangeEvidence({
      workspaceDir,
      evidenceReferences: [`browser-network:${corsExchange.id}`],
      sessionStartedAt: Date.parse('2026-07-30T20:00:00.000Z'),
    });

    expect(result).toEqual([]);
  });
});
