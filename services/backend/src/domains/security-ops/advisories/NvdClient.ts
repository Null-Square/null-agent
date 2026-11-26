import type { NvdCve } from './nvdNormalizer';

/**
 * NVD 2.0 API client.
 *
 * Three properties of the API shape this class, and getting any of them wrong
 * produces either a ban or silently incomplete data:
 *
 *  1. **The modification window is capped at 120 days.** A request spanning
 *     more is rejected, so a historical backfill has to walk windows.
 *  2. **Results are paginated** with `startIndex`/`resultsPerPage`, and the
 *     total is only known after the first page.
 *  3. **Rate limits are strict** — 5 requests per 30s without an API key, 50
 *     with one. Exceeding them returns 403/429, which must be treated as "we
 *     could not look", never as "nothing on record".
 *
 * That last distinction is the same one the anonymous scan collector already
 * makes, and for the same reason: an empty result we did not actually earn
 * would silently mark customers unaffected.
 */

export const NVD_ENDPOINT = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

/** NVD rejects a modification window wider than 120 days. */
export const MAX_WINDOW_DAYS = 120;

/** The API caps page size at 2000 for this endpoint. */
export const MAX_RESULTS_PER_PAGE = 2000;

export type NvdPage = {
  /** Usable advisories, i.e. those carrying an id. */
  cves: NvdCve[];
  /**
   * How many entries the API actually returned, before unusable ones were
   * dropped. This is the paging unit; `cves.length` is not.
   */
  returnedCount: number;
  totalResults: number;
  startIndex: number;
  resultsPerPage: number;
};

export type NvdQueryMode = 'publication' | 'modification';

export class NvdRateLimited extends Error {
  constructor(public readonly status: number) {
    super(`NVD rate limited (${status})`);
    this.name = 'NvdRateLimited';
  }
}

export class NvdUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NvdUnavailable';
  }
}

export type NvdClientOptions = {
  apiKey?: string | null;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override only for deterministic tests. */
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
};

/** Clamp a window to what the API will accept, preserving the start. */
export const clampWindowEnd = (start: Date, end: Date): Date => {
  const maxEnd = new Date(start.getTime() + MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return end.getTime() > maxEnd.getTime() ? maxEnd : end;
};

/** NVD expects an ISO-8601 timestamp with no trailing `Z`. */
export const formatNvdTimestamp = (value: Date): string =>
  value.toISOString().replace(/Z$/u, '');

export class NvdClient {
  private readonly endpoint: string;

  private readonly fetchImpl: typeof fetch;

  private readonly timeoutMs: number;

  private readonly minRequestIntervalMs: number;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly nowMs: () => number;

  private lastRequestStartedAt = 0;

  constructor(private readonly options: NvdClientOptions = {}) {
    this.endpoint = options.endpoint ?? NVD_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // NVD recommends spacing requests. Keyless traffic is kept below five in
    // any rolling 30-second window; keyed traffic retains broad headroom below
    // its higher allowance instead of treating the published ceiling as a
    // target. The sync loop is sequential, so this one client-side gate owns
    // the provider budget for both scheduled sync and the backfill command.
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? (options.apiKey ? 2_000 : 6_100);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Requests per 30 seconds this client is entitled to. */
  get rateLimitPer30s(): number {
    return this.options.apiKey ? 50 : 5;
  }

  buildUrl(params: {
    queryMode: NvdQueryMode;
    windowStart: Date;
    windowEnd: Date;
    startIndex: number;
    resultsPerPage: number;
  }): string {
    const startKey = params.queryMode === 'publication' ? 'pubStartDate' : 'lastModStartDate';
    const endKey = params.queryMode === 'publication' ? 'pubEndDate' : 'lastModEndDate';
    const search = new URLSearchParams({
      [startKey]: formatNvdTimestamp(params.windowStart),
      [endKey]: formatNvdTimestamp(clampWindowEnd(params.windowStart, params.windowEnd)),
      startIndex: String(params.startIndex),
      resultsPerPage: String(Math.min(params.resultsPerPage, MAX_RESULTS_PER_PAGE)),
    });
    return `${this.endpoint}?${search.toString()}`;
  }

  /**
   * Fetch one page of modified CVEs.
   *
   * Throws rather than returning an empty page on failure: the caller must be
   * able to tell "no results in this window" from "we could not ask", because
   * only the first is safe to checkpoint past.
   */
  async fetchPage(params: {
    queryMode: NvdQueryMode;
    windowStart: Date;
    windowEnd: Date;
    startIndex: number;
    resultsPerPage?: number;
  }): Promise<NvdPage> {
    const elapsed = this.nowMs() - this.lastRequestStartedAt;
    if (this.lastRequestStartedAt > 0 && elapsed < this.minRequestIntervalMs) {
      await this.sleep(this.minRequestIntervalMs - elapsed);
    }
    this.lastRequestStartedAt = this.nowMs();

    const url = this.buildUrl({
      queryMode: params.queryMode,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      startIndex: params.startIndex,
      resultsPerPage: params.resultsPerPage ?? MAX_RESULTS_PER_PAGE,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.options.apiKey) headers.apiKey = this.options.apiKey;

      const response = await this.fetchImpl(url, { signal: controller.signal, headers });

      if (response.status === 403 || response.status === 429) {
        throw new NvdRateLimited(response.status);
      }
      if (!response.ok) {
        throw new NvdUnavailable(`NVD returned ${response.status}`);
      }

      const payload = (await response.json()) as {
        totalResults?: number;
        startIndex?: number;
        resultsPerPage?: number;
        vulnerabilities?: Array<{ cve?: NvdCve }>;
      };

      // A 200 carrying no pagination fields is a malformed response, not an
      // empty window. Defaulting it to zero made it look like a completed page,
      // which advanced the cursor past data we never read.
      if (
        typeof payload.totalResults !== 'number'
        || !Array.isArray(payload.vulnerabilities)
      ) {
        throw new NvdUnavailable('NVD returned a response without pagination fields');
      }

      const returned = payload.vulnerabilities.length;
      const cves = payload.vulnerabilities
        .map((entry) => entry.cve)
        .filter((cve): cve is NvdCve => Boolean(cve?.id));

      return {
        cves,
        // `returnedCount` is the paging unit, deliberately separate from
        // `cves.length`: entries without an id are dropped, and advancing by the
        // filtered count would re-read the difference on the next page.
        returnedCount: returned,
        totalResults: payload.totalResults,
        startIndex: payload.startIndex ?? params.startIndex,
        resultsPerPage: payload.resultsPerPage ?? returned,
      };
    } catch (error) {
      if (error instanceof NvdRateLimited || error instanceof NvdUnavailable) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NvdUnavailable('NVD request timed out');
      }
      throw new NvdUnavailable(
        error instanceof Error ? error.message : 'NVD request failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether more pages remain in the current window.
 *
 * Kept as a named function because an off-by-one here either drops the tail of
 * a window silently or loops forever.
 */
export const hasMorePages = (page: NvdPage): boolean =>
  page.startIndex + page.returnedCount < page.totalResults && page.returnedCount > 0;
