import { describe, expect, it } from 'vitest';

import {
  discountSharedVersions,
  extractCoreVersion,
  extractWordPressAssetFromUrl,
  extractWordPressAssets,
  scoreVersionConfidence,
} from '@/domains/security-ops/components/fingerprint/wordpressAssets';

const page = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`;

describe('extractCoreVersion', () => {
  it('reads the generator meta tag', () => {
    expect(
      extractCoreVersion(page('<meta name="generator" content="WordPress 6.4.2" />')),
    ).toBe('6.4.2');
  });

  it('returns null when the generator is absent or not WordPress', () => {
    expect(extractCoreVersion(page(''))).toBeNull();
    expect(extractCoreVersion(page('<meta name="generator" content="Drupal 10" />'))).toBeNull();
  });
});

describe('scoreVersionConfidence', () => {
  it('trusts a plausible version that differs from core', () => {
    expect(scoreVersionConfidence({ version: '3.21.4', coreVersion: '6.4.2' })).toBeGreaterThan(0.5);
  });

  it('distrusts a version equal to core', () => {
    // WordPress substitutes the core version when a plugin enqueues without
    // one, so `?ver=6.4.2` across twenty plugins means nobody told us anything.
    expect(scoreVersionConfidence({ version: '6.4.2', coreVersion: '6.4.2' })).toBeLessThan(0.5);
  });

  it('rejects cache-busters and build hashes', () => {
    expect(scoreVersionConfidence({ version: '1699999999', coreVersion: '6.4.2' })).toBe(0.7);
    expect(scoreVersionConfidence({ version: 'a3f9c1e', coreVersion: '6.4.2' })).toBe(0);
    expect(scoreVersionConfidence({ version: null, coreVersion: '6.4.2' })).toBe(0);
  });
});

describe('extractWordPressAssets', () => {
  it('finds plugins with their versions', () => {
    const html = page(`
      <meta name="generator" content="WordPress 6.4.2" />
      <link href="https://site.test/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.21.4" />
      <script src="/wp-content/plugins/woocommerce/assets/js/frontend.js?ver=8.6.1"></script>
    `);

    const result = extractWordPressAssets(html);

    expect(result.coreVersion).toBe('6.4.2');
    expect(result.plugins).toEqual([
      { slug: 'elementor', version: '3.21.4', confidence: 0.7 },
      { slug: 'woocommerce', version: '8.6.1', confidence: 0.7 },
    ]);
  });

  it('separates themes from plugins', () => {
    const html = page(`
      <link href="/wp-content/themes/astra/style.css?ver=4.6.0" />
      <script src="/wp-content/plugins/wordpress-seo/js/main.js?ver=22.0"></script>
    `);

    const result = extractWordPressAssets(html);
    expect(result.plugins.map((p) => p.slug)).toEqual(['wordpress-seo']);
    expect(result.themes.map((t) => t.slug)).toEqual(['astra']);
  });

  it('records the slug but no version when the version is untrustworthy', () => {
    // A slug with no usable version is still real inventory and becomes a
    // version-acquisition objective; it cannot become an exposure match.
    const html = page(`
      <meta name="generator" content="WordPress 6.4.2" />
      <link href="/wp-content/plugins/contact-form-7/style.css?ver=6.4.2" />
      <script src="/wp-content/plugins/jetpack/main.js"></script>
    `);

    const result = extractWordPressAssets(html);
    expect(result.plugins).toEqual([
      { slug: 'contact-form-7', version: null, confidence: 0 },
      { slug: 'jetpack', version: null, confidence: 0 },
    ]);
  });

  it('keeps the best-evidenced sighting when a plugin enqueues several assets', () => {
    const html = page(`
      <meta name="generator" content="WordPress 6.4.2" />
      <script src="/wp-content/plugins/elementor/a.js"></script>
      <script src="/wp-content/plugins/elementor/b.js?ver=3.21.4"></script>
    `);

    expect(extractWordPressAssets(html).plugins).toEqual([
      { slug: 'elementor', version: '3.21.4', confidence: 0.7 },
    ]);
  });

  it('deduplicates a plugin referenced many times', () => {
    const html = page(
      Array.from({ length: 12 })
        .map((_, index) => `<script src="/wp-content/plugins/elementor/f${index}.js?ver=3.21.4"></script>`)
        .join(''),
    );

    expect(extractWordPressAssets(html).plugins).toHaveLength(1);
  });

  it('handles absolute URLs, single quotes and protocol-relative sources', () => {
    const html = page(`
      <link href='//cdn.site.test/wp-content/plugins/wp-rocket/x.css?ver=3.15.9' />
      <script src="https://site.test/wp-content/plugins/wordfence/y.js?ver=7.11.0"></script>
    `);

    expect(extractWordPressAssets(html).plugins.map((p) => p.slug)).toEqual([
      'wordfence',
      'wp-rocket',
    ]);
  });

  it('returns nothing for a site that is not WordPress', () => {
    expect(extractWordPressAssets(page('<script src="/static/app.js"></script>'))).toEqual({
      plugins: [],
      themes: [],
      coreVersion: null,
    });
  });

  it('ignores traversal-shaped slugs', () => {
    expect(extractWordPressAssets(page('<script src="/wp-content/plugins/../../x.js"></script>')).plugins).toEqual([]);
  });
});

describe('extractWordPressAssetFromUrl', () => {
  it('extracts a plugin and its version from a crawled URL', () => {
    expect(
      extractWordPressAssetFromUrl(
        'https://shop.example.com/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.21.4',
      ),
    ).toEqual({ kind: 'plugins', slug: 'elementor', version: '3.21.4', confidence: 0.7 });
  });

  it('extracts a theme', () => {
    expect(
      extractWordPressAssetFromUrl('https://shop.example.com/wp-content/themes/astra/style.css?ver=4.6.0'),
    ).toMatchObject({ kind: 'themes', slug: 'astra' });
  });

  it('returns the slug alone when the URL carries no version', () => {
    expect(
      extractWordPressAssetFromUrl('https://shop.example.com/wp-content/plugins/jetpack/main.js'),
    ).toEqual({ kind: 'plugins', slug: 'jetpack', version: null, confidence: 0 });
  });

  it('returns null for URLs that are not WordPress assets', () => {
    expect(extractWordPressAssetFromUrl('https://shop.example.com/about')).toBeNull();
  });
});

describe('discountSharedVersions', () => {
  const asset = (slug: string, version: string | null) => ({
    kind: 'plugins' as const,
    slug,
    version,
    confidence: version ? 0.7 : 0,
  });

  it('drops a version several unrelated plugins claim to share', () => {
    // WordPress substitutes the core version for plugins that enqueue without
    // one, so repetition across slugs is core leaking through — and a plugin
    // stamped with it produces confident matches against software nobody runs.
    const result = discountSharedVersions([
      asset('elementor', '6.4.2'),
      asset('woocommerce', '6.4.2'),
      asset('jetpack', '6.4.2'),
    ]);

    expect(result.every((entry) => entry.version === null)).toBe(true);
  });

  it('keeps a version shared by only two plugins', () => {
    // Two plugins genuinely at the same version is ordinary; three or more
    // unrelated ones is not.
    const result = discountSharedVersions([asset('a', '1.2.3'), asset('b', '1.2.3')]);
    expect(result.every((entry) => entry.version === '1.2.3')).toBe(true);
  });

  it('leaves distinct versions untouched', () => {
    const result = discountSharedVersions([
      asset('elementor', '3.21.4'),
      asset('woocommerce', '8.6.1'),
      asset('wordfence', '7.11.0'),
    ]);
    expect(result.map((entry) => entry.version)).toEqual(['3.21.4', '8.6.1', '7.11.0']);
  });

  it('does not count one plugin repeated across many URLs as sharing', () => {
    const result = discountSharedVersions([
      asset('elementor', '3.21.4'),
      asset('elementor', '3.21.4'),
      asset('elementor', '3.21.4'),
    ]);
    expect(result.every((entry) => entry.version === '3.21.4')).toBe(true);
  });
});
