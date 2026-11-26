import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  FeedUnavailable,
  fetchEpssScores,
  fetchKevCatalog,
  parseEpssCsv,
  parseKevCatalog,
} from '@/domains/security-ops/advisories/kevEpssFeeds';

/**
 * Real catalogs run to thousands of entries and the parser now rejects anything
 * suspiciously small as a truncated fetch, so fixtures are padded to a
 * believable size around whatever the test actually cares about.
 */
const padding = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    cveID: `CVE-2020-${String(10_000 + index)}`,
    dateAdded: '2026-01-01',
  }));

const kevPayload = (vulnerabilities: unknown[], { pad = true } = {}) => ({
  catalogVersion: '2026.08.09',
  vulnerabilities: pad ? [...vulnerabilities, ...padding(600)] : vulnerabilities,
});

/**
 * Node Buffers sit inside a shared pool, so `buffer.buffer` hands back far more
 * than the bytes written. The slice is what makes the fake behave like a real
 * `Response.arrayBuffer()`.
 */
const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const response = (body: unknown, init: { status?: number; binary?: Buffer } = {}) =>
  ({
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    json: async () => body,
    arrayBuffer: async () => toArrayBuffer(init.binary ?? Buffer.from(String(body))),
  }) as unknown as Response;

describe('parseKevCatalog', () => {
  it('parses entries and the ransomware flag', () => {
    const entries = parseKevCatalog(
      kevPayload([
        { cveID: 'CVE-2026-1000', dateAdded: '2026-02-01', knownRansomwareCampaignUse: 'Known' },
        { cveID: 'CVE-2026-1001', dateAdded: '2026-03-01', knownRansomwareCampaignUse: 'Unknown' },
      ]),
    );

    expect(entries.slice(0, 2)).toEqual([
      { cveId: 'CVE-2026-1000', addedAt: new Date('2026-02-01'), knownRansomware: true },
      { cveId: 'CVE-2026-1001', addedAt: new Date('2026-03-01'), knownRansomware: false },
    ]);
  });

  it('skips malformed identifiers rather than guessing', () => {
    const entries = parseKevCatalog(
      kevPayload([{ cveID: 'CVE-2026-1000' }, { cveID: 'not-a-cve' }, { cveID: '' }]),
    );
    expect(entries.map((entry) => entry.cveId)).toContain('CVE-2026-1000');
    expect(entries.map((entry) => entry.cveId)).not.toContain('not-a-cve');
  });

  it('rejects a suspiciously small catalog as a truncated fetch', () => {
    // The dangerous case: structurally valid, non-empty, and applying it as a
    // full replacement would clear KEV from nearly every advisory we hold.
    expect(() =>
      parseKevCatalog(kevPayload([{ cveID: 'CVE-2026-1000' }], { pad: false })),
    ).toThrow(/truncated fetch/u);
  });

  it('rejects an empty catalog instead of treating it as truth', () => {
    // KEV is never legitimately empty. Accepting it would clear every KEV flag
    // we hold — silently defusing the strongest priority signal in the model.
    expect(() => parseKevCatalog(kevPayload([], { pad: false }))).toThrow(FeedUnavailable);
  });

  it('rejects a response with no vulnerabilities array', () => {
    expect(() => parseKevCatalog({})).toThrow(FeedUnavailable);
  });
});

describe('fetchKevCatalog', () => {
  it('fetches and parses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(kevPayload([{ cveID: 'CVE-2026-1000', dateAdded: '2026-02-01' }])));

    const entries = await fetchKevCatalog({ fetchImpl, endpoint: 'https://kev.test' });
    expect(entries.map((entry) => entry.cveId)).toContain('CVE-2026-1000');
  });

  it('reports an HTTP failure as unavailable, not as an empty catalog', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, { status: 503 }));
    await expect(fetchKevCatalog({ fetchImpl })).rejects.toBeInstanceOf(FeedUnavailable);
  });
});

describe('parseEpssCsv', () => {
  const csv = [
    '#model_version:v2026.03.01,score_date:2026-08-09T00:00:00Z',
    'cve,epss,percentile',
    'CVE-2026-1000,0.97423,0.99981',
    'CVE-2026-1001,0.00042,0.10112',
  ].join('\n');

  it('parses rows past the comment and header', () => {
    expect(parseEpssCsv(csv)).toEqual([
      { cveId: 'CVE-2026-1000', score: 0.97423, percentile: 0.99981 },
      { cveId: 'CVE-2026-1001', score: 0.00042, percentile: 0.10112 },
    ]);
  });

  it('skips rows it cannot parse cleanly', () => {
    // A mis-parsed percentile silently reorders a customer's queue, so a
    // questionable row is dropped rather than coerced.
    const entries = parseEpssCsv(
      [
        'cve,epss,percentile',
        'CVE-2026-1000,0.5,0.5',
        'CVE-2026-1001,not-a-number,0.5',
        'CVE-2026-1002,1.5,0.5',
        'garbage line',
      ].join('\n'),
    );
    expect(entries.map((entry) => entry.cveId)).toEqual(['CVE-2026-1000']);
  });

  it('rejects a file with no usable rows', () => {
    expect(() => parseEpssCsv('#model_version\ncve,epss,percentile\n')).toThrow(FeedUnavailable);
  });
});

describe('fetchEpssScores', () => {
  const csv = ['cve,epss,percentile', 'CVE-2026-1000,0.5,0.6'].join('\n');

  it('decompresses a gzipped feed', async () => {
    const gz = gzipSync(Buffer.from(csv, 'utf8'));
    const fetchImpl = vi.fn().mockResolvedValue(response(null, { binary: gz }));

    await expect(fetchEpssScores({ fetchImpl })).resolves.toEqual([
      { cveId: 'CVE-2026-1000', score: 0.5, percentile: 0.6 },
    ]);
  });

  it('accepts plain CSV when something upstream already inflated it', async () => {
    // A mirror or a proxy may hand back plain text; assuming gzip would break
    // on a body that is otherwise perfectly usable.
    const fetchImpl = vi.fn().mockResolvedValue(response(null, { binary: Buffer.from(csv, 'utf8') }));

    await expect(fetchEpssScores({ fetchImpl })).resolves.toHaveLength(1);
  });

  it('reports an HTTP failure as unavailable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(null, { status: 500 }));
    await expect(fetchEpssScores({ fetchImpl })).rejects.toBeInstanceOf(FeedUnavailable);
  });
});
