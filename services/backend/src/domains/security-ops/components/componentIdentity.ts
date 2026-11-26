import type {
  ComponentEcosystem,
  ComponentObservationSource,
  VersionScheme,
} from '@/db/schema';

/**
 * Component identity — turning what a scanner said into something matchable.
 *
 * This module is the single hardest part of Threat Watch and the one that
 * decides whether the product is trustworthy or noisy, so every function here
 * is pure and directly testable. The governing rule (PRD R1) is that an
 * unrecognised product produces *silence*, never a guess: reporting another
 * project's CVEs against someone's server is worse than reporting nothing.
 */

export type ResolvedComponentIdentity = {
  ecosystem: ComponentEcosystem;
  componentKey: string;
  displayName: string;
  /** Distro-packaged software can carry a backported fix at an old version. */
  backportRisk: boolean;
};

export type ComponentAliasLookup = (
  aliasText: string,
) => { ecosystem: ComponentEcosystem; componentKey: string; confidence: number } | undefined;

/**
 * Normalize a scanner-reported product string into an alias lookup key.
 *
 * Scanners disagree on case, spacing and decoration ("Nginx", "nginx",
 * "NGINX (Ubuntu)"), and the agent writes free text. Everything collapses to
 * one lowercase, single-spaced token so the alias table stays small.
 */
export const normalizeAliasText = (rawProduct: string): string =>
  rawProduct
    .trim()
    .toLowerCase()
    .replace(/[‐-―]/gu, '-')
    .replace(/[(),;]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu;
const DOTTED_PATTERN = /^\d+(?:\.\d+){0,3}$/u;

/**
 * Detect which comparison rules a version string obeys.
 *
 * Schemes are not interchangeable: semver orders prereleases below their
 * release, CPE compares component-wise, and WordPress routinely ships
 * four-part versions that are not semver at all. Comparing across schemes
 * produces wrong answers in both directions, so anything unrecognised is
 * `unknown` — and `unknown` never matches (PRD §8.5).
 */
export const detectVersionScheme = (normalizedVersion: string): VersionScheme => {
  if (SEMVER_PATTERN.test(normalizedVersion)) return 'semver';
  if (DOTTED_PATTERN.test(normalizedVersion)) return 'dotted';
  return 'unknown';
};

/**
 * Strip decoration a version string may carry, without inventing precision.
 *
 * Returns null when nothing comparable survives. A version we cannot compare
 * is worth less than no version: it would produce a match we cannot defend.
 */
export const normalizeVersion = (rawVersion: string | null | undefined): string | null => {
  if (!rawVersion) return null;

  const trimmed = rawVersion.trim().replace(/^v(?=\d)/iu, '');
  if (!trimmed) return null;

  // Distribution packaging suffixes tell us the packager, not the upstream
  // release the advisory speaks about: "1.18.0-0ubuntu1.4", "2.4.52-1~deb11u2".
  // Those are stripped, and `backportRisk` carries the caveat.
  //
  // But two things that look like suffixes are *upstream* and must survive,
  // because an earlier version of this function dropped both and silently
  // defeated the comparators built to order them:
  //
  //   - CPE letter releases — OpenSSL "1.0.2k" is a different release from
  //     "1.0.2", and collapsing them matched the wrong range.
  //   - Semver prereleases — "2.0.0-rc.1" sorts *below* "2.0.0", so dropping
  //     the tag turned a prerelease into the release it precedes.
  // Telling a semver prerelease from a distribution revision matters because
  // both sit after a hyphen: "2.0.0-rc.1" is upstream and must survive, while
  // "1.18.0-0ubuntu1.4" is packaging and must not. Only recognised prerelease
  // tokens — or a bare numeric series — are treated as upstream; anything else
  // is assumed to be a packager's suffix.
  const semver = /^(\d+\.\d+\.\d+)-([0-9A-Za-z][0-9A-Za-z.]*)$/u.exec(trimmed);
  if (semver) {
    const prerelease = semver[2]!.toLowerCase();
    const isKnownPrerelease = /^(alpha|beta|rc|pre|preview|dev|next|canary|snapshot|m|a|b)\b/u.test(
      prerelease,
    );
    const isNumericSeries = /^\d+(?:\.\d+)*$/u.test(prerelease);
    if (isKnownPrerelease || isNumericSeries) return trimmed;
  }

  const cpeLetterRelease = /^\d+(?:\.\d+)*[a-z]$/u.exec(trimmed);
  if (cpeLetterRelease) return trimmed;

  const upstream = trimmed.match(/^\d+(?:\.\d+)*/u)?.[0];
  if (!upstream) return null;

  return upstream;
};

/**
 * Products typically installed from a distribution's repositories.
 *
 * Debian and RHEL backport security fixes without changing the version string,
 * so a version-only match against these is systematically unreliable. They are
 * not excluded — they are flagged, and the severity policy (PRD R5) requires
 * verification before any interrupt-grade alert about them.
 */
const BACKPORT_RISK_KEYS: ReadonlySet<string> = new Set([
  'cpe:f5:nginx',
  'cpe:apache:http_server',
  'cpe:apache:tomcat',
  'cpe:php:php',
  'cpe:openssl:openssl',
  'cpe:lighttpd:lighttpd',
  'cpe:haproxy:haproxy',
  'cpe:gunicorn:gunicorn',
]);

export const hasBackportRisk = (componentKey: string): boolean =>
  BACKPORT_RISK_KEYS.has(componentKey);

/**
 * Fingerprints that identify a *service*, not a versioned component.
 *
 * A site fronted by Cloudflare tells us nothing we could ever match an advisory
 * against: there is no customer-controlled version, and the provider patches
 * their own edge. These are recognised deliberately so they are neither
 * counted as coverage gaps nor queued as alias work — they are correctly
 * unmatched, which is a different thing from unidentified.
 *
 * This distinction matters most in Gate 0: CDN and host fingerprints are common
 * enough that scoring them as failures would understate real coverage and could
 * fail a viable project.
 */
const NON_MATCHABLE_PRODUCTS: ReadonlySet<string> = new Set([
  'cloudflare',
  'cloudfront',
  'akamai',
  'fastly',
  'vercel',
  'netlify',
  'heroku',
  'shopify',
  'wix',
  'squarespace',
  'webflow',
  'github pages',
  'amazon s3',
  'google frontend',
  'varnish',
  'sucuri',
  'incapsula',
  'imperva',
]);

export const isNonMatchableProduct = (product: string): boolean =>
  NON_MATCHABLE_PRODUCTS.has(normalizeAliasText(product));

/**
 * Resolve a reported product to a canonical component, or nothing.
 *
 * `lookup` is injected so the alias table can come from the database at
 * runtime and from a fixture in tests.
 */
export const resolveComponentIdentity = (params: {
  product: string;
  lookup: ComponentAliasLookup;
  /** Set by discovery when the source already knows what kind of thing this is. */
  category?: string | null;
}): ResolvedComponentIdentity | null => {
  const aliasText = normalizeAliasText(params.product);
  if (!aliasText) return null;

  const mapped = params.lookup(aliasText);

  if (!mapped) {
    // WordPress plugin and theme slugs are not guesses — a directory slug *is*
    // the identity, both on wordpress.org and in every WordPress advisory feed.
    // Requiring a seeded alias for each one meant discovery could find hundreds
    // of plugins and resolve almost none, so a future WordPress feed would have
    // had nothing to match against. Every other product still requires an
    // explicit alias (PRD R1).
    const conventional = resolveWordPressSlug(aliasText, params.category);
    if (conventional) {
      return { ...conventional, displayName: params.product.trim(), backportRisk: false };
    }
    return null;
  }

  return {
    ecosystem: mapped.ecosystem,
    componentKey: mapped.componentKey,
    displayName: params.product.trim(),
    backportRisk: hasBackportRisk(mapped.componentKey),
  };
};

/**
 * Identity for a WordPress plugin or theme, derived from its slug.
 *
 * Only applies when discovery already told us the category — we never infer
 * "this looks like a plugin" from the name alone.
 */
const resolveWordPressSlug = (
  aliasText: string,
  category: string | null | undefined,
): { ecosystem: ComponentEcosystem; componentKey: string } | null => {
  const normalized = category?.trim().toLowerCase();
  if (!normalized) return null;

  const slug = aliasText.replace(/\s+/gu, '-');
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(slug)) return null;

  if (normalized === 'wordpress-plugin' || normalized === 'wordpress_plugin') {
    return { ecosystem: 'wordpress_plugin', componentKey: `pkg:wordpress-plugin/${slug}` };
  }
  if (normalized === 'wordpress-theme' || normalized === 'wordpress_theme') {
    return { ecosystem: 'wordpress_theme', componentKey: `pkg:wordpress-theme/${slug}` };
  }
  return null;
};

export type NormalizedObservation = {
  identity: ResolvedComponentIdentity;
  versionRaw: string | null;
  versionNormalized: string | null;
  versionScheme: VersionScheme;
};

/**
 * Full normalization of one sighting: identity plus a comparable version.
 *
 * Returns null only when identity fails. A recognised product with an
 * unreadable version is still worth recording: it becomes a bounded version
 * acquisition objective, but never an exposure match (PRD R2).
 */
export const normalizeObservation = (params: {
  product: string;
  version?: string | null;
  lookup: ComponentAliasLookup;
  category?: string | null;
}): NormalizedObservation | null => {
  const identity = resolveComponentIdentity({
    product: params.product,
    lookup: params.lookup,
    category: params.category,
  });
  if (!identity) return null;

  const versionRaw = params.version?.trim() || null;
  const versionNormalized = normalizeVersion(versionRaw);

  return {
    identity,
    versionRaw,
    versionNormalized,
    versionScheme: versionNormalized ? detectVersionScheme(versionNormalized) : 'unknown',
  };
};

/**
 * Pick the version a component should present to the matcher.
 *
 * The newest observation defines the current time window; highest confidence
 * wins inside that window and ties break on recency. When two live observations
 * disagree on a comparable version the component is marked conflicted, which
 * bars it from interrupt-grade alerting — we would rather say nothing than
 * guess which sighting was right.
 */
/**
 * How close in time two sightings must be to count as describing the same
 * moment. Beyond this they are treated as a history, not a disagreement.
 */
export const CONCURRENT_OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const resolveComponentVersion = (
  observations: ReadonlyArray<{
    versionNormalized: string | null;
    versionScheme: VersionScheme;
    confidence: number | null;
    observedAt: Date;
    source?: ComponentObservationSource | null;
  }>,
  options: { concurrentWindowMs?: number } = {},
): {
  resolvedVersion: string | null;
  resolvedVersionScheme: VersionScheme;
  resolvedConfidence: number | null;
  resolvedObservationSource: ComponentObservationSource | null;
  resolvedVersionObservedAt: Date | null;
  versionConflict: boolean;
} => {
  const versioned = observations.filter((entry) => entry.versionNormalized !== null);

  if (versioned.length === 0) {
    return {
      resolvedVersion: null,
      resolvedVersionScheme: 'unknown',
      resolvedConfidence: null,
      resolvedObservationSource: null,
      resolvedVersionObservedAt: null,
      versionConflict: false,
    };
  }

  // Define one deterministic current cohort: versioned observations no more
  // than one concurrency window behind the newest. Confidence chooses within
  // that cohort and recency breaks ties.
  //
  // A pairwise "use confidence when these two are close, otherwise recency"
  // comparator is non-transitive across three overlapping timestamps and can
  // make the winner depend on input order. Defining the cohort once removes
  // that ambiguity and prevents an old high-confidence scanner result from
  // outranking evidence of a later upgrade forever.
  const windowMs = options.concurrentWindowMs ?? CONCURRENT_OBSERVATION_WINDOW_MS;
  const newestAt = Math.max(...versioned.map((entry) => entry.observedAt.getTime()));
  const concurrent = versioned.filter(
    (entry) => newestAt - entry.observedAt.getTime() <= windowMs,
  );
  const ranked = [...concurrent].sort((left, right) => {
    const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return right.observedAt.getTime() - left.observedAt.getTime();
  });

  const winner = ranked[0]!;

  // Conflict means *concurrent* sightings disagree about what is running right
  // now — two ports, or two sources contradicting each other on the same visit.
  //
  // It must not mean "this component was upgraded". Comparing against all
  // history marked every routine upgrade as a permanent conflict, and since a
  // conflicted component is barred from interrupt alerts, that silently and
  // permanently disabled alerting for exactly the customers who patch.
  const distinctConcurrentVersions = new Set(concurrent.map((entry) => entry.versionNormalized));

  return {
    resolvedVersion: winner.versionNormalized,
    resolvedVersionScheme: winner.versionScheme,
    resolvedConfidence: winner.confidence ?? null,
    resolvedObservationSource: winner.source ?? null,
    resolvedVersionObservedAt: winner.observedAt,
    versionConflict: distinctConcurrentVersions.size > 1,
  };
};
