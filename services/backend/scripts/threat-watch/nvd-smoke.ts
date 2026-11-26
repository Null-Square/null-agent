/**
 * One bounded live call to NVD.
 *
 * Everything about the advisory pipeline has so far been proven against
 * fixtures. This answers the questions fixtures cannot:
 *
 *   - does the API key work, and what rate limit does it grant;
 *   - does the normalizer survive real payloads rather than my hand-written ones;
 *   - and what share of real advisories are `complex` — the classifier refuses
 *     to match those, so if the share is high, most of NVD is unusable to us and
 *     that is a product-shaping fact worth knowing before building further.
 *
 * Deliberately small: one page, a narrow window. Reads the key from
 * THREAT_WATCH_NVD_API_KEY and never prints it.
 */
import { NvdClient } from '@/domains/security-ops/advisories/NvdClient';
import {
  classifyApplicability,
  deriveAffectedRanges,
  normalizeNvdAdvisory,
} from '@/domains/security-ops/advisories/nvdNormalizer';

const main = async () => {
  const apiKey = process.env.THREAT_WATCH_NVD_API_KEY?.trim() || null;
  const pageSize = Number(process.env.NVD_SMOKE_PAGE_SIZE ?? 200);
  const windowHours = Number(process.env.NVD_SMOKE_WINDOW_HOURS ?? 24);

  const client = new NvdClient({ apiKey });
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);

  process.stdout.write(
    `key: ${apiKey ? 'present' : 'ABSENT (keyless: 5 req/30s)'}  rateLimit=${client.rateLimitPer30s}/30s\n` +
      `window: last ${windowHours}h  pageSize=${pageSize}\n\n`,
  );

  const started = Date.now();
  const page = await client.fetchPage({
    queryMode: 'modification',
    windowStart,
    windowEnd,
    startIndex: 0,
    resultsPerPage: pageSize,
  });
  const elapsedMs = Date.now() - started;

  const applicability = { simple: 0, complex: 0, absent: 0 };
  let normalized = 0;
  let withRanges = 0;
  let totalRanges = 0;
  const statusCounts = new Map<string, number>();
  const sampleComponents = new Set<string>();

  for (const cve of page.cves) {
    const shape = classifyApplicability(cve);
    applicability[shape] += 1;

    if (normalizeNvdAdvisory(cve)) normalized += 1;

    const ranges = deriveAffectedRanges(cve);
    if (ranges.length > 0) {
      withRanges += 1;
      totalRanges += ranges.length;
      for (const range of ranges.slice(0, 2)) sampleComponents.add(range.componentKey);
    }
    const status = cve.vulnStatus ?? 'unknown';
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  const pct = (n: number) => (page.cves.length === 0 ? '0.0' : ((n / page.cves.length) * 100).toFixed(1));

  process.stdout.write(
    [
      `HTTP ok in ${elapsedMs}ms`,
      `totalResults in window : ${page.totalResults}`,
      `returned this page     : ${page.returnedCount} (usable: ${page.cves.length})`,
      `normalized cleanly     : ${normalized} (${pct(normalized)}%)`,
      '',
      '--- applicability (decides how much of NVD we can actually match) ---',
      `simple  : ${applicability.simple} (${pct(applicability.simple)}%)   <-- matchable`,
      `complex : ${applicability.complex} (${pct(applicability.complex)}%)   <-- refused, never auto-matches`,
      `absent  : ${applicability.absent} (${pct(applicability.absent)}%)`,
      '',
      `advisories yielding ranges: ${withRanges}   total ranges: ${totalRanges}`,
      `sample components: ${[...sampleComponents].slice(0, 8).join(', ') || 'none'}`,
      '',
      '--- vulnStatus (NVD only attaches CPE configurations during analysis) ---',
      ...[...statusCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([status, count]) => `${status.padEnd(24)} ${count} (${pct(count)}%)`),
      '',
    ].join('\n'),
  );
};

void main().catch((error: unknown) => {
  process.stderr.write(`NVD smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
