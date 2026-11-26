export type CollectorStatus = 'ok' | 'unavailable';

export interface CollectorOutcome<T> {
  status: CollectorStatus;
  data: T | null;
  /** Present when status is `unavailable`. Surfaced to the UI, never hidden. */
  error?: string;
  durationMs: number;
}

export interface HttpSignals {
  statusCode: number | null;
  redirectsToHttps: boolean;
  server: string | null;
  poweredBy: string | null;
  securityHeaders: Record<string, string | null>;
  insecureCookies: string[];
  technologies: string[];
  /**
   * The platform the site is built on, when one is identifiable.
   *
   * This is not trivia: it decides how the visitor will prove ownership in the
   * next step. A WordPress site can install the plugin and be verified in one
   * click; a site behind Cloudflare will do a DNS TXT record. Knowing it here
   * means the verification screen can lead with the easy path.
   */
  platform: string | null;
  pageTitle: string | null;
  generator: string | null;
  /**
   * WordPress plugins and themes referenced by the markup, when the site is
   * WordPress. Plugins — not core — are what actually gets these sites
   * compromised, so this is the difference between a WordPress advisory feed
   * being matchable and being unusable.
   */
  wordpressPlugins?: Array<{ slug: string; version: string | null; confidence: number }>;
  wordpressThemes?: Array<{ slug: string; version: string | null; confidence: number }>;
  responseMs: number | null;
  hasSecurityTxt: boolean;
  securityTxt?: {
    contacts: string[];
    expiresAt: string | null;
    expired: boolean;
    policy: string | null;
    canonical: string | null;
  };
  robotsDisallowed: string[];
  /**
   * URLs listed in sitemap.xml, or null when there is no sitemap.
   *
   * The best cheap measure of how large a site actually is. A domain with four
   * thousand indexed pages is a very different surface from a landing page, and
   * nothing else we collect conveys that.
   */
  sitemapUrlCount: number | null;
}
