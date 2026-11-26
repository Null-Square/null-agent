import type { CollectorOutcome, HttpSignals } from './types';
import { extractWordPressAssets } from './wordpressAssets';
import type { TargetRequestBudget } from './TargetRequestBudget';

/**
 * HTTP collector — the only collector that touches the target's application.
 *
 * Every request goes through TargetRequestBudget, so the path allowlist and the
 * five-request cap apply structurally. We read what the server volunteers in
 * response to requests a browser makes anyway; we never probe for paths.
 */

const SECURITY_HEADER_NAMES = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
];

/** Cookie names set without both Secure and HttpOnly. */
export const findInsecureCookies = (setCookie: string | null): string[] => {
  if (!setCookie) return [];
  // Multiple cookies arrive comma-joined; split only where a new name= starts.
  return setCookie
    .split(/,(?=\s*[^;=\s]+=)/u)
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .filter((cookie) => !/;\s*secure/iu.test(cookie) || !/;\s*httponly/iu.test(cookie))
    .map((cookie) => cookie.split('=')[0].trim())
    .filter(Boolean);
};

/** Best-effort stack identification from headers alone. No content probing. */
export const fingerprintTechnologies = (headers: Record<string, string>): string[] => {
  const found = new Set<string>();
  const server = (headers.server ?? '').toLowerCase();
  const powered = (headers['x-powered-by'] ?? '').toLowerCase();

  if (server.includes('nginx')) found.add('nginx');
  if (server.includes('apache')) found.add('Apache');
  if (server.includes('cloudflare') || headers['cf-ray']) found.add('Cloudflare');
  if (server.includes('vercel') || headers['x-vercel-id']) found.add('Vercel');
  if (headers['x-amz-cf-id'] || server.includes('cloudfront')) found.add('CloudFront');
  if (powered.includes('php')) found.add('PHP');
  if (powered.includes('express')) found.add('Express');
  if (powered.includes('asp.net')) found.add('ASP.NET');
  if (headers['x-shopify-stage']) found.add('Shopify');
  if (/wordpress|wp-/u.test(headers.link ?? '')) found.add('WordPress');

  return [...found];
};

/**
 * Identifies the platform from the HTML we already fetched.
 *
 * Ordered most specific first: a Shopify store also emits generic markers, so
 * whichever matches first wins. Read only from the homepage response — this is
 * fingerprinting what the site volunteers, never probing for admin paths.
 */
const PLATFORM_SIGNATURES: Array<{ platform: string; test: RegExp }> = [
  { platform: 'WordPress', test: /wp-content\/|wp-includes\/|name="generator" content="WordPress/iu },
  { platform: 'Shopify', test: /cdn\.shopify\.com|shopify-features/iu },
  { platform: 'Wix', test: /static\.wixstatic\.com|X-Wix-/iu },
  { platform: 'Squarespace', test: /squarespace\.com|static1\.squarespace/iu },
  { platform: 'Webflow', test: /webflow\.com|data-wf-page/iu },
  { platform: 'Drupal', test: /sites\/default\/files|Drupal\.settings/iu },
  { platform: 'Joomla', test: /\/media\/jui\/|name="generator" content="Joomla/iu },
  { platform: 'Ghost', test: /content\/themes\/|ghost-sdk/iu },
  { platform: 'HubSpot', test: /hs-scripts\.com|hubspot/iu },
  { platform: 'Next.js', test: /__NEXT_DATA__|\/_next\//u },
  { platform: 'Nuxt', test: /__NUXT__|\/_nuxt\//u },
  { platform: 'Gatsby', test: /___gatsby|gatsby-/u },
];

export const detectPlatform = (html: string, generator: string | null): string | null => {
  if (generator) {
    const named = PLATFORM_SIGNATURES.find(({ platform }) =>
      generator.toLowerCase().includes(platform.toLowerCase()),
    );
    if (named) return named.platform;
  }
  return PLATFORM_SIGNATURES.find(({ test }) => test.test(html))?.platform ?? null;
};

const readMeta = (html: string, name: string): string | null => {
  const pattern = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
    'iu',
  );
  return pattern.exec(html)?.[1]?.trim() ?? null;
};

export const readPageTitle = (html: string): string | null => {
  const title = /<title[^>]*>([^<]{1,140})<\/title>/iu.exec(html)?.[1]?.trim();
  return title || null;
};

/** Disallow rules, which sometimes name paths the owner did not mean to reveal. */
export const parseRobotsDisallow = (body: string): string[] =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^disallow:/iu.test(line))
    .map((line) => line.slice('disallow:'.length).trim())
    .filter((value) => value.length > 0 && value !== '/')
    .slice(0, 10);

/**
 * Counts entries in a sitemap. Handles both a URL set and a sitemap index —
 * a large site splits its sitemap, and counting only the index would report a
 * handful of pages for a site with thousands.
 */
export const countSitemapUrls = (xml: string): number | null => {
  if (!/<(urlset|sitemapindex)/iu.test(xml)) return null;
  const locs = xml.match(/<loc>/giu)?.length ?? 0;
  return locs > 0 ? locs : null;
};

export interface ParsedSecurityTxt {
  contacts: string[];
  expiresAt: string | null;
  expired: boolean;
  policy: string | null;
  canonical: string | null;
}

/** Parses only the RFC 9116 fields useful to the public-preview story. */
export const parseSecurityTxt = (body: string, now = Date.now()): ParsedSecurityTxt => {
  const fields = new Map<string, string[]>();
  for (const rawLine of body.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }

  const expiresAt = fields.get('expires')?.[0] ?? null;
  const expiresTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return {
    contacts: (fields.get('contact') ?? []).slice(0, 3),
    expiresAt,
    expired: Number.isFinite(expiresTime) && expiresTime < now,
    policy: fields.get('policy')?.[0] ?? null,
    canonical: fields.get('canonical')?.[0] ?? null,
  };
};

export const collectHttp = async (
  budget: TargetRequestBudget,
): Promise<CollectorOutcome<HttpSignals>> => {
  const started = Date.now();

  try {
    const requestedAt = Date.now();
    const root = await budget.fetchPath('/');
    const responseMs = Date.now() - requestedAt;
    if (!root) {
      return {
        status: 'unavailable',
        data: null,
        error: 'Site did not respond over HTTPS',
        durationMs: Date.now() - started,
      };
    }

    const securityHeaders: Record<string, string | null> = {};
    for (const name of SECURITY_HEADER_NAMES) {
      securityHeaders[name] = root.headers[name] ?? null;
    }

    // Remaining budget is spent on the two published-for-retrieval files, in
    // priority order. Either may be skipped if the budget ran out on redirects.
    let hasSecurityTxt = false;
    let securityTxt: ParsedSecurityTxt | undefined;
    let robotsDisallowed: string[] = [];
    let sitemapUrlCount: number | null = null;

    if (budget.requestsRemaining > 1) {
      const securityTxtResponse = await budget.fetchPath('/.well-known/security.txt');
      hasSecurityTxt = Boolean(securityTxtResponse && securityTxtResponse.status === 200);
      if (securityTxtResponse && securityTxtResponse.status === 200) {
        securityTxt = parseSecurityTxt(securityTxtResponse.body);
      }
    }
    if (budget.requestsRemaining > 1) {
      const robots = await budget.fetchPath('/robots.txt');
      if (robots && robots.status === 200) {
        robotsDisallowed = parseRobotsDisallow(robots.body);
      }
    }
    if (budget.requestsRemaining > 0) {
      const sitemap = await budget.fetchPath('/sitemap.xml');
      if (sitemap && sitemap.status === 200) {
        sitemapUrlCount = countSitemapUrls(sitemap.body);
      }
    }

    return {
      status: 'ok',
      data: {
        statusCode: root.status,
        // The root fetch started on https and did not leave it.
        redirectsToHttps: root.finalUrl.startsWith('https://'),
        server: root.headers.server ?? null,
        poweredBy: root.headers['x-powered-by'] ?? null,
        securityHeaders,
        insecureCookies: findInsecureCookies(root.headers['set-cookie'] ?? null),
        technologies: fingerprintTechnologies(root.headers),
        platform: detectPlatform(root.body, readMeta(root.body, 'generator')),
        pageTitle: readPageTitle(root.body),
        generator: readMeta(root.body, 'generator'),
        // Costs no extra request: the markup is already in hand.
        ...(() => {
          const wp = extractWordPressAssets(root.body);
          return wp.plugins.length > 0 || wp.themes.length > 0
            ? { wordpressPlugins: wp.plugins, wordpressThemes: wp.themes }
            : {};
        })(),
        responseMs,
        hasSecurityTxt,
        securityTxt,
        robotsDisallowed,
        sitemapUrlCount,
      },
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      data: null,
      error: error instanceof Error ? error.message : 'HTTP request failed',
      durationMs: Date.now() - started,
    };
  }
};
