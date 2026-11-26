import { gunzipSync } from 'node:zlib';

/**
 * CISA KEV and FIRST EPSS — the two feeds that turn severity into priority.
 *
 * Both are public, keyless, and published as complete snapshots rather than
 * deltas, which shapes everything here: a partial read must be rejected rather
 * than applied, because applying half a snapshot as if it were whole silently
 * un-flags every advisory the truncated portion would have covered.
 *
 * KEV answers "is this being exploited right now", which outranks CVSS in the
 * priority model. EPSS answers "how likely is it to be exploited", which is the
 * tiebreaker among everything KEV does not list.
 */

export const KEV_ENDPOINT =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

/** EPSS publishes a gzipped CSV of every scored CVE, refreshed daily. */
export const EPSS_ENDPOINT = 'https://epss.cyentia.com/epss_scores-current.csv.gz';

const DEFAULT_TIMEOUT_MS = 60_000;

export class FeedUnavailable extends Error {
  constructor(feed: string, message: string) {
    super(`${feed} feed unavailable: ${message}`);
    this.name = 'FeedUnavailable';
  }
}

export type KevEntry = {
  cveId: string;
  addedAt: Date | null;
  knownRansomware: boolean;
};

export type EpssEntry = {
  cveId: string;
  score: number;
  percentile: number;
};

export type FeedFetchOptions = {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

const withTimeout = async <T>(
  feed: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof FeedUnavailable) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FeedUnavailable(feed, 'request timed out');
    }
    throw new FeedUnavailable(feed, error instanceof Error ? error.message : 'request failed');
  } finally {
    clearTimeout(timer);
  }
};

const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/u;

/**
 * Floor below which a KEV catalog is assumed truncated rather than shrunken.
 *
 * Deliberately far under the real size (well over a thousand) so a genuine
 * catalog can never trip it, while a partial download always does.
 */
const MIN_PLAUSIBLE_KEV_ENTRIES = 500;

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Parse the KEV catalog.
 *
 * An empty vulnerability list is rejected rather than returned: KEV is never
 * legitimately empty, so an empty parse means a bad fetch — and treating that as
 * "nothing is exploited any more" would clear every KEV flag we hold.
 */
export const parseKevCatalog = (payload: unknown): KevEntry[] => {
  const root = payload as { vulnerabilities?: unknown } | null;
  const rows = Array.isArray(root?.vulnerabilities) ? root.vulnerabilities : null;

  if (!rows) {
    throw new FeedUnavailable('KEV', 'response had no vulnerabilities array');
  }
  if (rows.length === 0) {
    throw new FeedUnavailable('KEV', 'catalog was empty, which is never legitimate');
  }

  const entries: KevEntry[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const cveId = typeof record.cveID === 'string' ? record.cveID.trim().toUpperCase() : '';
    if (!CVE_PATTERN.test(cveId)) continue;

    entries.push({
      cveId,
      addedAt: parseDate(record.dateAdded),
      knownRansomware:
        typeof record.knownRansomwareCampaignUse === 'string' &&
        record.knownRansomwareCampaignUse.trim().toLowerCase() === 'known',
    });
  }

  if (entries.length === 0) {
    throw new FeedUnavailable('KEV', 'no usable entries after parsing');
  }

  // A structurally valid but truncated catalog is the dangerous case: it parses,
  // it is non-empty, and applying it as a full replacement would clear KEV from
  // nearly every advisory we hold. The published catalog has been well over a
  // thousand entries for years, so anything far below that is a bad fetch rather
  // than good news.
  if (entries.length < MIN_PLAUSIBLE_KEV_ENTRIES) {
    throw new FeedUnavailable(
      'KEV',
      `catalog had only ${entries.length} entries, below the ${MIN_PLAUSIBLE_KEV_ENTRIES} floor — treating as a truncated fetch`,
    );
  }

  return entries;
};

export const fetchKevCatalog = async (options: FeedFetchOptions = {}): Promise<KevEntry[]> => {
  const endpoint = options.endpoint ?? KEV_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  return withTimeout('KEV', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const response = await fetchImpl(endpoint, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new FeedUnavailable('KEV', `returned ${response.status}`);
    }
    return parseKevCatalog(await response.json());
  });
};

/**
 * Parse the EPSS CSV.
 *
 * The file opens with a `#model_version` comment line, then a header, then one
 * row per scored CVE. Rows that do not parse cleanly are skipped rather than
 * guessed at — a mis-parsed percentile silently reorders a customer's queue.
 */
export const parseEpssCsv = (csv: string): EpssEntry[] => {
  const lines = csv.split(/\r?\n/u);
  const entries: EpssEntry[] = [];

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;

    const [rawCve, rawScore, rawPercentile] = line.split(',');
    const cveId = rawCve?.trim().toUpperCase() ?? '';
    if (!CVE_PATTERN.test(cveId)) continue;

    const score = Number(rawScore);
    const percentile = Number(rawPercentile);
    if (!Number.isFinite(score) || !Number.isFinite(percentile)) continue;
    if (score < 0 || score > 1 || percentile < 0 || percentile > 1) continue;

    entries.push({ cveId, score, percentile });
  }

  if (entries.length === 0) {
    throw new FeedUnavailable('EPSS', 'no usable rows after parsing');
  }

  return entries;
};

export const fetchEpssScores = async (options: FeedFetchOptions = {}): Promise<EpssEntry[]> => {
  const endpoint = options.endpoint ?? EPSS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  return withTimeout('EPSS', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const response = await fetchImpl(endpoint, { signal });
    if (!response.ok) {
      throw new FeedUnavailable('EPSS', `returned ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // Gzipped in normal operation, but decompression is attempted rather than
    // assumed so a plain-CSV mirror or a proxy that already inflated it still works.
    const csv = buffer[0] === 0x1f && buffer[1] === 0x8b
      ? gunzipSync(buffer).toString('utf8')
      : buffer.toString('utf8');

    return parseEpssCsv(csv);
  });
};
