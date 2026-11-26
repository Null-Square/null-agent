import { describe, expect, it } from 'vitest';

import {
  buildHttpExchangeMap,
  normalizePortableEvidenceReference,
} from '@/domains/security-ops/compliance/ComplianceRunBundleService';
import type { RunTraceResponse } from '@/domains/security-ops/runs/RunTraceService';

const trace = (events: unknown[]): RunTraceResponse =>
  ({ runId: 'run-1', sessionIds: ['s1'], generatedAt: '', events, total: events.length, stats: {} as never, summary: {} as never, pagination: { offset: 0, limit: events.length, hasMore: false } } as unknown as RunTraceResponse);

describe('buildHttpExchangeMap', () => {
  it('indexes http tool.finish exchanges by history_entry_id (durable evidence recovery)', () => {
    const map = buildHttpExchangeMap(trace([
      {
        event: 'tool.finish',
        ts: '2026-06-23T11:37:08.000Z',
        payload: {
          toolName: 'http_payload',
          result: {
            url: 'https://grafana.nullsquare.net/api/dashboards/home',
            method: 'GET',
            status_code: 401,
            body_size: 102,
            body_preview: '{"message":"Unauthorized"}',
            response_time_ms: 192,
            interesting_headers: { server: 'Caddy' },
            history_entry_id: '02703400-8e98-4a10-b711-3eaa069c41d2',
          },
        },
      },
      { event: 'model.call.finish', ts: '', payload: {} },
      { event: 'tool.finish', ts: '', payload: { toolName: 'file_read', result: { ok: true } } },
    ]));

    expect(map.size).toBe(1);
    const rec = map.get('02703400-8e98-4a10-b711-3eaa069c41d2');
    expect(rec).toBeDefined();
    expect(rec?.url).toBe('https://grafana.nullsquare.net/api/dashboards/home');
    expect(rec?.method).toBe('GET');
    expect(rec?.statusCode).toBe(401);
    expect(rec?.responseHeaders).toEqual({ server: 'Caddy' });
    expect(rec?.toolName).toBe('http_payload');
  });

  it('returns an empty map for an undefined trace or events without exchange ids', () => {
    expect(buildHttpExchangeMap(undefined).size).toBe(0);
    expect(buildHttpExchangeMap(trace([{ event: 'tool.finish', ts: '', payload: { result: {} } }])).size).toBe(0);
  });
});

describe('normalizePortableEvidenceReference', () => {
  it('removes workspace wrappers and exchange prefixes without losing the durable path', () => {
    expect(normalizePortableEvidenceReference('/workspace/.artifacts/scans/httpx/scope.json'))
      .toBe('.artifacts/scans/httpx/scope.json');
    expect(normalizePortableEvidenceReference('workspace/.artifacts/scans/httpx/scope.json'))
      .toBe('.artifacts/scans/httpx/scope.json');
    expect(normalizePortableEvidenceReference('./.artifacts/scans/httpx/scope.json'))
      .toBe('.artifacts/scans/httpx/scope.json');
    expect(normalizePortableEvidenceReference('exchange:02703400-8e98-4a10-b711-3eaa069c41d2'))
      .toBe('02703400-8e98-4a10-b711-3eaa069c41d2');
  });
});
