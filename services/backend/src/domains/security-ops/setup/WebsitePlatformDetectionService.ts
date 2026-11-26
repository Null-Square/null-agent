import { lookup as dnsLookup, resolveCname as dnsResolveCname } from 'dns/promises';
import { isIP } from 'net';

import { normalizeScopeTargetValue } from '@/domains/security-ops/scopes/ScopeService';
import { isCloudBlockedHost, isCloudBlockedIpv4Address } from '@/domains/security-ops/scopes/networkTargetPolicy';

export type WebsitePlatformDetectionConfidence = 'high' | 'medium' | 'low';
export type WebsiteVerificationRecommendationMethod = 'manual';
export type WebsitePlatformProvider = 'wordpress' | 'shopify' | 'wix' | 'squarespace';

/**
 * Names the platform a site is built on. Ownership is always proven by a DNS TXT record or an
 * HTTP file: there are no platform connections in Null AI.
 */
export type WebsitePlatformDetectionRecommendation = {
  method: WebsiteVerificationRecommendationMethod;
  provider: WebsitePlatformProvider | null;
  confidence: WebsitePlatformDetectionConfidence;
  label: string;
  description: string;
  evidence: string[];
  fallbackMethods: Array<'dns_txt' | 'http_well_known'>;
};

export type WebsitePlatformDetectionResult = {
  domain: string;
  siteUrl: string;
  detectedProvider: WebsitePlatformProvider | null;
  recommendation: WebsitePlatformDetectionRecommendation;
  signals: {
    statusCode: number | null;
    finalUrl: string | null;
    cnameRecords: string[];
    matchedMarkers: string[];
  };
};

export type WebsitePlatformDetectionOptions = {
  fetchImpl?: typeof fetch;
  lookupHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  resolveCname?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBodyBytes?: number;
};

type SupportedDetectedProvider = WebsitePlatformProvider;

const normalizeSiteUrl = (rawUrl: string): { origin: string; normalizedDomain: string } => {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('siteUrl is required');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('siteUrl must use http or https');
  }
  if (isIP(parsed.hostname) !== 0 || isCloudBlockedHost(parsed.hostname)) {
    throw new Error('siteUrl must use a public domain hostname');
  }
  const normalizedDomain = normalizeScopeTargetValue('domain', parsed.hostname);
  if (!normalizedDomain) throw new Error('siteUrl must use a public domain hostname');
  return { origin: parsed.origin, normalizedDomain };
};

type Score = {
  provider: SupportedDetectedProvider;
  score: number;
  evidence: string[];
};

const SUPPORTED_PROVIDERS: SupportedDetectedProvider[] = [
  'wordpress',
  'shopify',
  'wix',
  'squarespace',
];

const PROVIDER_LABELS: Record<SupportedDetectedProvider, string> = {
  wordpress: 'WordPress',
  shopify: 'Shopify',
  wix: 'Wix',
  squarespace: 'Squarespace',
};

const MANUAL_RECOMMENDATION: WebsitePlatformDetectionRecommendation = {
  method: 'manual',
  provider: null,
  confidence: 'low',
  label: 'Manual verification',
  description: 'Use DNS TXT or HTTP file verification for this domain.',
  evidence: [],
  fallbackMethods: ['dns_txt', 'http_well_known'],
};

const normalizeMarker = (value: string): string => value.toLowerCase();

const pushEvidence = (score: Score, evidence: string, weight = 1) => {
  score.score += weight;
  if (!score.evidence.includes(evidence)) {
    score.evidence.push(evidence);
  }
};

const createScores = (): Record<SupportedDetectedProvider, Score> =>
  SUPPORTED_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = { provider, score: 0, evidence: [] };
    return acc;
  }, {} as Record<SupportedDetectedProvider, Score>);

const isBlockedResolvedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    return isCloudBlockedIpv4Address(address);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      /^f[cd][0-9a-f]{2}:/i.test(normalized)
    );
  }
  return true;
};

const manualResult = (
  domain: string,
  siteUrl: string,
  reason: string,
  signals?: Partial<WebsitePlatformDetectionResult['signals']>,
): WebsitePlatformDetectionResult => ({
  domain,
  siteUrl,
  detectedProvider: null,
  recommendation: {
    ...MANUAL_RECOMMENDATION,
    evidence: [reason],
  },
  signals: {
    statusCode: signals?.statusCode ?? null,
    finalUrl: signals?.finalUrl ?? null,
    cnameRecords: signals?.cnameRecords ?? [],
    matchedMarkers: signals?.matchedMarkers ?? [],
  },
});

const addCnameSignals = (
  scores: Record<SupportedDetectedProvider, Score>,
  cnameRecords: string[],
) => {
  for (const record of cnameRecords.map(normalizeMarker)) {
    if (record.includes('myshopify.com')) {
      pushEvidence(scores.shopify, 'CNAME points to Shopify', 3);
    }
    if (record.includes('wixdns.net') || record.includes('wixsite.com') || record.includes('wixstatic.com')) {
      pushEvidence(scores.wix, 'CNAME points to Wix', 3);
    }
    if (record.includes('squarespace.com')) {
      pushEvidence(scores.squarespace, 'CNAME points to Squarespace', 3);
    }
    if (record.includes('wordpress.com') || record.includes('wpengine.com') || record.includes('flywheelsites.com')) {
      pushEvidence(scores.wordpress, 'CNAME points to a WordPress host', 2);
    }
  }
};

const addHeaderSignals = (
  scores: Record<SupportedDetectedProvider, Score>,
  headers: Headers,
) => {
  headers.forEach((rawValue, rawKey) => {
    const key = rawKey.toLowerCase();
    const value = rawValue.toLowerCase();
    if (key.startsWith('x-shopify') || value.includes('shopify')) {
      pushEvidence(scores.shopify, 'Shopify response header', 2);
    }
    if (key.startsWith('x-wix') || key === 'x-seen-by' || value.includes('wix')) {
      pushEvidence(scores.wix, 'Wix response header', 2);
    }
    if (value.includes('squarespace')) {
      pushEvidence(scores.squarespace, 'Squarespace response header', 2);
    }
    if (value.includes('wordpress')) {
      pushEvidence(scores.wordpress, 'WordPress response header', 2);
    }
  });
};

const addBodySignals = (
  scores: Record<SupportedDetectedProvider, Score>,
  body: string,
) => {
  const text = normalizeMarker(body);

  if (text.includes('/wp-content/') || text.includes('wp-content/') || text.includes('/wp-json')) {
    pushEvidence(scores.wordpress, 'WordPress page marker', 2);
  }
  if (text.includes('generator" content="wordpress') || text.includes("generator' content='wordpress")) {
    pushEvidence(scores.wordpress, 'WordPress generator tag', 3);
  }
  if (text.includes('cdn.shopify.com') || text.includes('myshopify.com') || text.includes('shopify.theme')) {
    pushEvidence(scores.shopify, 'Shopify page marker', 3);
  }
  if (text.includes('wixstatic.com') || text.includes('wix-code') || text.includes('wix.com')) {
    pushEvidence(scores.wix, 'Wix page marker', 3);
  }
  if (
    text.includes('static1.squarespace.com') ||
    text.includes('squarespace-cdn') ||
    text.includes('squarespace.com')
  ) {
    pushEvidence(scores.squarespace, 'Squarespace page marker', 3);
  }
};

const readResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = maxBytes - received;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.length;
      if (value.length > remaining) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
};

const chooseRecommendation = (
  scores: Record<SupportedDetectedProvider, Score>,
): WebsitePlatformDetectionRecommendation => {
  const ranked = Object.values(scores).sort((left, right) => right.score - left.score);
  const [top, second] = ranked;
  if (!top || top.score < 2 || (second && second.score === top.score)) {
    return MANUAL_RECOMMENDATION;
  }

  const confidence: WebsitePlatformDetectionConfidence = top.score >= 4 ? 'high' : 'medium';
  return {
    ...MANUAL_RECOMMENDATION,
    provider: top.provider,
    confidence,
    description: `This domain looks like ${PROVIDER_LABELS[top.provider]}. Use DNS TXT or HTTP file verification for this domain.`,
    evidence: top.evidence,
  };
};

export class WebsitePlatformDetectionService {
  private readonly fetchImpl: typeof fetch;
  private readonly lookupHost: NonNullable<WebsitePlatformDetectionOptions['lookupHost']>;
  private readonly resolveCname: NonNullable<WebsitePlatformDetectionOptions['resolveCname']>;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: WebsitePlatformDetectionOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupHost = options.lookupHost ?? ((hostname) => dnsLookup(hostname, { all: true }));
    this.resolveCname = options.resolveCname ?? dnsResolveCname;
    this.timeoutMs = options.timeoutMs ?? 3_500;
    this.maxBodyBytes = options.maxBodyBytes ?? 192_000;
  }

  async detect(rawDomain: string): Promise<WebsitePlatformDetectionResult> {
    let siteUrl = '';
    let domain = rawDomain.trim().toLowerCase();

    try {
      const normalized = normalizeSiteUrl(rawDomain);
      siteUrl = normalized.origin;
      domain = normalized.normalizedDomain;
    } catch {
      return manualResult(domain, siteUrl || rawDomain.trim(), 'Domain must be a public website hostname.');
    }

    const hostname = new URL(siteUrl).hostname;
    if (isCloudBlockedHost(hostname)) {
      return manualResult(domain, siteUrl, 'Domain must resolve to a public website hostname.');
    }

    const scores = createScores();
    let cnameRecords: string[] = [];
    let response: Response | null = null;
    let body = '';

    try {
      const addresses = await this.lookupHost(hostname);
      if (addresses.some((entry) => isBlockedResolvedAddress(entry.address))) {
        return manualResult(domain, siteUrl, 'Domain resolves to a private or reserved address.');
      }
    } catch {
      return manualResult(domain, siteUrl, 'Domain could not be resolved.');
    }

    try {
      cnameRecords = await this.resolveCname(hostname);
      addCnameSignals(scores, cnameRecords);
    } catch {
      cnameRecords = [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(siteUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'NullAI-Setup-Recommendation/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      addHeaderSignals(scores, response.headers);
      body = await readResponseText(response, this.maxBodyBytes);
      addBodySignals(scores, body);
    } catch {
      if (cnameRecords.length === 0) {
        return manualResult(domain, siteUrl, 'Website could not be fetched for platform detection.', {
          cnameRecords,
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const recommendation = chooseRecommendation(scores);
    const matchedMarkers = recommendation.evidence;

    return {
      domain,
      siteUrl,
      detectedProvider: recommendation.provider,
      recommendation,
      signals: {
        statusCode: response?.status ?? null,
        finalUrl: response?.url ?? null,
        cnameRecords,
        matchedMarkers,
      },
    };
  }
}
