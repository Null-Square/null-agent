/**
 * WordPress plugin and theme discovery from markup we already hold.
 *
 * Gate 0 asks whether we can see plugin versions at all, and until now the
 * answer was structurally "no": the HTTP collector identified the *platform*
 * and stopped. That mattered because plugins — not core — are what actually
 * gets WordPress sites compromised, and a WordPress advisory feed we cannot
 * match against is a feed not worth licensing.
 *
 * This reads the homepage HTML that was already fetched. It sends no requests,
 * probes no paths, and therefore stays inside the existing request budget and
 * the "read what the server volunteers" rule the anonymous scan is built on.
 *
 * The honest limit is the version. WordPress appends `?ver=` to enqueued
 * assets, and *by convention* plugins pass their own version — but nothing
 * enforces it. Plugins that pass the core version, a cache-buster, or a build
 * hash are common. So versions here are candidates with a confidence, never
 * assertions, and the caller decides what that is worth.
 */

export type WordPressAsset = {
  /** Directory slug, which is the plugin's identity on wordpress.org. */
  slug: string;
  /** Candidate version from `?ver=`, or null when none was present or usable. */
  version: string | null;
  /** 0..1 — see `scoreVersionConfidence`. */
  confidence: number;
};

export type WordPressAssetSignals = {
  plugins: WordPressAsset[];
  themes: WordPressAsset[];
  /** Core version from the generator meta tag, when present. */
  coreVersion: string | null;
};

/**
 * Matches `/wp-content/plugins/<slug>/…` and the themes equivalent, in either
 * quote style and with or without a scheme and host.
 */
const ASSET_PATTERN =
  /\/wp-content\/(plugins|themes)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[^"'\s>]*/gu;

const VERSION_QUERY_PATTERN = /[?&]ver=([^"'&\s]+)/u;

const GENERATOR_PATTERN =
  /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([0-9][0-9.]*)["']/iu;

/** A plausible release version, as opposed to a cache-buster or build hash. */
const PLAUSIBLE_VERSION = /^\d+(?:\.\d+){0,3}$/u;

export const extractCoreVersion = (html: string): string | null =>
  GENERATOR_PATTERN.exec(html)?.[1] ?? null;

/**
 * How much to trust a `?ver=` value as the component's own version.
 *
 * The discriminator that matters is whether it equals the core version. When a
 * plugin enqueues without specifying a version, WordPress substitutes core's —
 * so `?ver=6.4.2` on twenty different plugins means "no plugin told us
 * anything", not "twenty plugins are all on 6.4.2". Treating those as real
 * would generate confident matches against versions nobody is running.
 */
export const scoreVersionConfidence = (params: {
  version: string | null;
  coreVersion: string | null;
}): number => {
  if (!params.version) return 0;
  if (!PLAUSIBLE_VERSION.test(params.version)) return 0;
  if (params.coreVersion && params.version === params.coreVersion) return 0.2;
  return 0.7;
};

/**
 * Below this, a candidate version is discarded rather than recorded weakly.
 *
 * There is no useful middle ground here. A version we half-believe would still
 * become an `exact_version` match downstream, which is the strongest claim the
 * system makes — so the choice is to trust it or to drop it, and a plugin whose
 * `?ver=` merely echoes core has told us nothing worth acting on. Dropping it
 * yields a slug with no version, which still matches, but only into the digest.
 */
const MIN_USABLE_VERSION_CONFIDENCE = 0.5;

const normalizeSlug = (raw: string): string | null => {
  const slug = raw.trim().toLowerCase();
  if (!slug || slug === '.' || slug === '..') return null;
  return slug;
};

/**
 * Extract plugin and theme identities, keeping the best-evidenced version for
 * each slug.
 *
 * A single plugin typically enqueues several assets, and they do not always
 * agree — one script may carry a real version while another carries none. The
 * highest-confidence sighting wins, which is the same rule the component
 * inventory applies.
 */
export const extractWordPressAssets = (html: string): WordPressAssetSignals => {
  const coreVersion = extractCoreVersion(html);

  const best = new Map<string, { kind: 'plugins' | 'themes'; asset: WordPressAsset }>();

  for (const match of html.matchAll(ASSET_PATTERN)) {
    const kind = match[1] as 'plugins' | 'themes';
    const slug = normalizeSlug(match[2] ?? '');
    if (!slug) continue;

    const rawVersion = VERSION_QUERY_PATTERN.exec(match[0])?.[1] ?? null;
    const version = rawVersion ? decodeURIComponent(rawVersion) : null;
    const confidence = scoreVersionConfidence({ version, coreVersion });

    const usable = confidence >= MIN_USABLE_VERSION_CONFIDENCE;
    const key = `${kind}:${slug}`;
    const existing = best.get(key);
    const effectiveConfidence = usable ? confidence : 0;
    if (existing && existing.asset.confidence >= effectiveConfidence) continue;

    best.set(key, {
      kind,
      asset: {
        slug,
        // The slug is always real; the version is only recorded when we would
        // defend it as this component's own.
        version: usable ? version : null,
        confidence: effectiveConfidence,
      },
    });
  }

  const plugins: WordPressAsset[] = [];
  const themes: WordPressAsset[] = [];
  for (const { kind, asset } of best.values()) {
    (kind === 'plugins' ? plugins : themes).push(asset);
  }

  const bySlug = (left: WordPressAsset, right: WordPressAsset) =>
    left.slug.localeCompare(right.slug);

  return { plugins: plugins.sort(bySlug), themes: themes.sort(bySlug), coreVersion };
};

/** Same shape as an HTML-derived asset, plus which directory it came from. */
export type WordPressAssetFromUrl = WordPressAsset & { kind: 'plugins' | 'themes' };

/**
 * Extract a WordPress plugin or theme from a single URL.
 *
 * The crawl path sees URLs rather than markup, and a crawler walking a
 * WordPress site surfaces `/wp-content/plugins/<slug>/...?ver=X` on nearly
 * every page. That makes the agent's own recon — not just the passive scan —
 * able to see plugins, which is the only source that actually feeds the
 * product.
 */
export const extractWordPressAssetFromUrl = (url: string): WordPressAssetFromUrl | null => {
  const match = new RegExp(ASSET_PATTERN.source, 'u').exec(url);
  if (!match) return null;

  const kind = match[1] as 'plugins' | 'themes';
  const slug = normalizeSlug(match[2] ?? '');
  if (!slug) return null;

  const rawVersion = VERSION_QUERY_PATTERN.exec(url)?.[1] ?? null;
  const version = rawVersion ? decodeURIComponent(rawVersion) : null;
  // No core version is available from a URL alone, so the core-equality check
  // cannot run here; `discountSharedVersions` recovers it across the set.
  const confidence = scoreVersionConfidence({ version, coreVersion: null });
  const usable = confidence >= MIN_USABLE_VERSION_CONFIDENCE;

  return { kind, slug, version: usable ? version : null, confidence: usable ? confidence : 0 };
};

/**
 * How many distinct plugins must share a version before it is assumed to be
 * WordPress core's rather than each plugin's own.
 */
const SHARED_VERSION_SUSPICION_THRESHOLD = 3;

/**
 * Drop versions that several unrelated plugins claim to share.
 *
 * WordPress substitutes the core version for any plugin that enqueues without
 * one, so a single value repeated across many different slugs is core leaking
 * through — not a coincidence. Without the generator tag we cannot compare
 * against core directly, but the repetition itself is the evidence.
 *
 * Getting this wrong is expensive in one direction only: a plugin wrongly
 * stamped with the core version produces confident matches against software
 * nobody is running.
 */
export const discountSharedVersions = (
  assets: readonly WordPressAssetFromUrl[],
): WordPressAssetFromUrl[] => {
  const slugsByVersion = new Map<string, Set<string>>();
  for (const asset of assets) {
    if (!asset.version) continue;
    const slugs = slugsByVersion.get(asset.version) ?? new Set<string>();
    slugs.add(asset.slug);
    slugsByVersion.set(asset.version, slugs);
  }

  const suspect = new Set(
    [...slugsByVersion.entries()]
      .filter(([, slugs]) => slugs.size >= SHARED_VERSION_SUSPICION_THRESHOLD)
      .map(([version]) => version),
  );

  return assets.map((asset) =>
    asset.version && suspect.has(asset.version)
      ? { ...asset, version: null, confidence: 0 }
      : asset,
  );
};
