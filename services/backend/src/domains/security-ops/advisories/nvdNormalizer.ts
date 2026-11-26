import type {
  AdvisoryApplicability,
  ComponentEcosystem,
  VersionScheme,
} from '@/db/schema';

/**
 * NVD 2.0 → our advisory model.
 *
 * The important decision in this file is what we refuse to normalize. NVD
 * applicability is a tree — `AND`/`OR` nodes, `negate`, and `vulnerable:false`
 * entries that *exclude* configurations — and flattening it into independent
 * version ranges overmatches conditional advisories ("product X, but only when
 * running on platform Y"). Rather than build a boolean evaluator up front, we
 * classify: anything we cannot flatten faithfully becomes `complex` and never
 * auto-matches (PRD R6). The count of `complex` advisories that matter to real
 * customers is what would justify an evaluator later — measurement first.
 */

export type NvdCpeMatch = {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
};

export type NvdNode = {
  operator?: string;
  negate?: boolean;
  cpeMatch?: NvdCpeMatch[];
};

export type NvdConfiguration = {
  operator?: string;
  negate?: boolean;
  nodes?: NvdNode[];
};

export type NvdCve = {
  id?: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang?: string; value?: string }>;
  metrics?: {
    cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string; vectorString?: string } }>;
    cvssMetricV30?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string; vectorString?: string } }>;
  };
  weaknesses?: Array<{ description?: Array<{ lang?: string; value?: string }> }>;
  configurations?: NvdConfiguration[];
};

export type DerivedAffectedRange = {
  ecosystem: ComponentEcosystem;
  componentKey: string;
  versionScheme: VersionScheme;
  introducedVersion: string | null;
  introducedInclusive: boolean;
  fixedVersion: string | null;
  fixedInclusive: boolean;
  rawConstraint: string;
};

/**
 * Classify how faithfully an advisory's applicability can be flattened.
 *
 * Conservative by construction: any structure that expresses a *condition*
 * rather than a plain list of affected products disqualifies the advisory from
 * automatic matching.
 */
export const classifyApplicability = (cve: NvdCve): AdvisoryApplicability => {
  const configurations = cve.configurations ?? [];
  if (configurations.length === 0) return 'absent';

  let sawVulnerableMatch = false;

  for (const configuration of configurations) {
    // A configuration-level AND means "all of these must hold at once" — the
    // canonical conditional advisory.
    if (configuration.operator?.toUpperCase() === 'AND') return 'complex';
    if (configuration.negate === true) return 'complex';

    const nodes = configuration.nodes ?? [];
    if (nodes.length === 0) continue;

    for (const node of nodes) {
      if (node.operator?.toUpperCase() === 'AND') return 'complex';
      if (node.negate === true) return 'complex';

      for (const match of node.cpeMatch ?? []) {
        // `vulnerable: false` entries carve exceptions out of the set; honouring
        // them requires evaluating the tree, so their presence is disqualifying.
        if (match.vulnerable === false) return 'complex';
        if (match.vulnerable === true) sawVulnerableMatch = true;
      }
    }
  }

  return sawVulnerableMatch ? 'simple' : 'absent';
};

/**
 * Parse `cpe:2.3:part:vendor:product:version:...` into our component key.
 *
 * Returns null for malformed criteria rather than salvaging part of it: a
 * half-parsed CPE is how you end up matching a different project's advisories.
 */
export const parseCpeCriteria = (
  criteria: string,
): { componentKey: string; pinnedVersion: string | null } | null => {
  const parts = criteria.split(':');
  // cpe:2.3:<part>:<vendor>:<product>:<version>:...
  if (parts.length < 6) return null;
  if (parts[0] !== 'cpe' || parts[1] !== '2.3') return null;

  const vendor = parts[3];
  const product = parts[4];
  const version = parts[5];
  if (!vendor || !product || vendor === '*' || product === '*') return null;

  const pinnedVersion = version && version !== '*' && version !== '-' ? version : null;

  return { componentKey: `cpe:${vendor}:${product}`, pinnedVersion };
};

const rangeFromMatch = (match: NvdCpeMatch): DerivedAffectedRange | null => {
  if (match.vulnerable === false) return null;
  if (!match.criteria) return null;

  const parsed = parseCpeCriteria(match.criteria);
  if (!parsed) return null;

  const introducedVersion = match.versionStartIncluding ?? match.versionStartExcluding ?? null;
  const introducedInclusive = match.versionStartIncluding !== undefined;
  const fixedVersion = match.versionEndExcluding ?? match.versionEndIncluding ?? null;
  const fixedInclusive = match.versionEndIncluding !== undefined;

  if (!introducedVersion && !fixedVersion) {
    // No range fields. A criteria pinned to one version is an exact match; a
    // wildcard version means "every version ever", which we refuse to assert.
    if (!parsed.pinnedVersion) return null;

    return {
      ecosystem: 'cpe',
      componentKey: parsed.componentKey,
      versionScheme: 'cpe',
      introducedVersion: parsed.pinnedVersion,
      introducedInclusive: true,
      fixedVersion: parsed.pinnedVersion,
      fixedInclusive: true,
      rawConstraint: match.criteria,
    };
  }

  return {
    ecosystem: 'cpe',
    componentKey: parsed.componentKey,
    versionScheme: 'cpe',
    introducedVersion,
    introducedInclusive,
    fixedVersion,
    fixedInclusive,
    rawConstraint: JSON.stringify({
      criteria: match.criteria,
      versionStartIncluding: match.versionStartIncluding,
      versionStartExcluding: match.versionStartExcluding,
      versionEndIncluding: match.versionEndIncluding,
      versionEndExcluding: match.versionEndExcluding,
    }),
  };
};

const rangeIdentity = (range: DerivedAffectedRange): string =>
  [
    range.componentKey,
    range.introducedVersion ?? '',
    range.introducedInclusive,
    range.fixedVersion ?? '',
    range.fixedInclusive,
  ].join('|');

/**
 * Derive matchable ranges. Returns an empty array for anything not classified
 * `simple` — the classification is the gate, and this function honours it.
 */
export const deriveAffectedRanges = (cve: NvdCve): DerivedAffectedRange[] => {
  if (classifyApplicability(cve) !== 'simple') return [];

  const seen = new Set<string>();
  const ranges: DerivedAffectedRange[] = [];

  for (const configuration of cve.configurations ?? []) {
    for (const node of configuration.nodes ?? []) {
      for (const match of node.cpeMatch ?? []) {
        const range = rangeFromMatch(match);
        if (!range) continue;

        const identity = rangeIdentity(range);
        if (seen.has(identity)) continue;
        seen.add(identity);
        ranges.push(range);
      }
    }
  }

  return ranges;
};

export type NormalizedAdvisory = {
  canonicalId: string;
  /**
   * Nullable, matching the column and the reason it exists: Wordfence and
   * Patchstack advisories frequently carry no CVE at all, and those are the
   * ones that matter most in our primary segment. NVD always populates it.
   */
  cveId: string | null;
  title: string | null;
  summary: string | null;
  publishedAt: Date | null;
  lastModifiedAt: Date;
  state: 'active' | 'withdrawn' | 'disputed';
  severity: string | null;
  cvssV31Vector: string | null;
  cvssV31Score: number | null;
  cweIds: string[];
  applicability: AdvisoryApplicability;
};

const parseDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const englishDescription = (cve: NvdCve): string | null =>
  cve.descriptions?.find((entry) => entry.lang === 'en')?.value?.trim() || null;

/**
 * NVD marks retracted entries through `vulnStatus`. They must resolve any open
 * matches rather than linger as live exposure, so the state is carried through
 * rather than filtered out at ingest.
 */
const parseState = (vulnStatus: string | undefined): NormalizedAdvisory['state'] => {
  const status = vulnStatus?.toLowerCase() ?? '';
  if (status.includes('reject')) return 'withdrawn';
  if (status.includes('disput')) return 'disputed';
  return 'active';
};

export const normalizeNvdAdvisory = (cve: NvdCve): NormalizedAdvisory | null => {
  const cveId = cve.id?.trim();
  if (!cveId) return null;

  const lastModifiedAt = parseDate(cve.lastModified);
  if (!lastModifiedAt) return null;

  const metric = cve.metrics?.cvssMetricV31?.[0]?.cvssData ?? cve.metrics?.cvssMetricV30?.[0]?.cvssData;
  const summary = englishDescription(cve);

  const cweIds = (cve.weaknesses ?? [])
    .flatMap((weakness) => weakness.description ?? [])
    .map((entry) => entry.value?.trim())
    .filter((value): value is string => Boolean(value?.startsWith('CWE-')));

  return {
    canonicalId: cveId,
    cveId,
    // NVD has no title field; the first sentence of the description is the
    // closest honest equivalent.
    title: summary ? summary.split(/(?<=\.)\s/u)[0]!.slice(0, 300) : null,
    summary,
    publishedAt: parseDate(cve.published),
    lastModifiedAt,
    state: parseState(cve.vulnStatus),
    severity: metric?.baseSeverity?.toLowerCase() ?? null,
    cvssV31Vector: metric?.vectorString ?? null,
    cvssV31Score: typeof metric?.baseScore === 'number' ? metric.baseScore : null,
    cweIds: Array.from(new Set(cweIds)),
    applicability: classifyApplicability(cve),
  };
};
