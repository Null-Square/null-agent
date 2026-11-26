import { isIP } from 'net';
import { type z } from 'zod';

import {
  type AssetKindSchema,
} from '@/domains/security-ops/assets/AssetReportingService';

export type ParsedTechFingerprint = {
  product: string;
  version?: string;
  category?: string;
  confidence?: number;
};

export type NormalizedFfufEndpoint = {
  url: string;
  dedupeKey: string;
  pathname: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const normalizeToolText = (value: string): string => value.trim();

const normalizeOptionalToolText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeToolText(value);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeAssetValue = (kind: z.infer<typeof AssetKindSchema>, rawValue: string): string => {
  const trimmed = normalizeToolText(rawValue);
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.trim();
      if (host) {
        return kind === 'domain' ? host.toLowerCase() : host;
      }
    } catch {
      // fall through
    }
  }

  if (kind === 'domain') {
    const withoutPath = trimmed.split('/')[0]?.trim() ?? trimmed;
    const withoutPort = withoutPath.split(':')[0]?.trim() ?? withoutPath;
    return withoutPort.toLowerCase().replace(/\.$/, '');
  }

  return trimmed.split('/')[0]?.trim() ?? trimmed;
};

const extractHostnameFromUrl = (rawUrl: string): string | undefined => {
  try {
    const url = new URL(rawUrl);
    return normalizeAssetValue('domain', url.hostname);
  } catch {
    return undefined;
  }
};

export const detectAssetKind = (value: string): z.infer<typeof AssetKindSchema> =>
  isIP(value) !== 0 ? 'ip' : 'domain';

export const normalizeArtifactHost = (rawValue: string | undefined): string | undefined => {
  const normalized = normalizeOptionalToolText(rawValue);
  if (!normalized) {
    return undefined;
  }

  const bracketedIpv6 = normalized.match(/^\[([^\]]+)\]$/u);
  const rawHost = bracketedIpv6?.[1] ?? normalized;

  if (isIP(rawHost) !== 0) {
    return normalizeAssetValue('ip', rawHost);
  }

  const fromUrl = extractHostnameFromUrl(normalized);
  if (fromUrl) {
    return fromUrl;
  }

  return normalizeAssetValue('domain', normalized);
};

export const normalizePort = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return undefined;
};

export const parseHostPortLine = (line: string): { host: string; port: number } | undefined => {
  const bracketedIpv6 = line.match(/^\[([^\]]+)\]:(\d+)$/u);
  if (bracketedIpv6) {
    const host = normalizeArtifactHost(bracketedIpv6[1]);
    const port = normalizePort(bracketedIpv6[2]);
    if (host && port) {
      return { host, port };
    }
    return undefined;
  }

  const separator = line.lastIndexOf(':');
  if (separator <= 0 || separator !== line.indexOf(':')) {
    return undefined;
  }

  const host = normalizeArtifactHost(line.slice(0, separator));
  const port = normalizePort(line.slice(separator + 1));
  if (!host || !port) {
    return undefined;
  }

  return { host, port };
};

/**
 * Split a scanner's product token into product and version.
 *
 * Three separators, because the tools we ingest disagree:
 *   - `/`  server banners            "nginx/1.18.0"
 *   - ` `  generator meta tags       "WordPress 6.4.2"
 *   - `:`  httpx -tech-detect JSON   "WordPress:6.4.2", "Elementor:3.21.5"
 *
 * The colon form was previously unhandled, which meant httpx tech detection —
 * the mechanical, non-LLM source covering most web technologies — produced no
 * version at all and glued it onto the product name instead ("wordpress:6.4.2").
 * That broke both version matching and note dedupe, since the dedupe key derives
 * from the product and every version bump minted a new row.
 *
 * The product side deliberately excludes all three separators so a token such as
 * "apache/2.4.52" cannot be read as product "apache/2.4" with version "52".
 */
export const splitProductVersion = (rawValue: string): { product: string; version?: string } => {
  const normalized = normalizeOptionalToolText(rawValue);
  if (!normalized) {
    return { product: '' };
  }

  const match = normalized.match(/^([^/\s:]+)[/\s:]v?([0-9][A-Za-z0-9._-]*)$/u);
  if (match) {
    return {
      product: match[1] ?? '',
      version: match[2] ?? undefined,
    };
  }

  return { product: normalized };
};

const normalizeTechFingerprintInput = (value: unknown): ParsedTechFingerprint | undefined => {
  if (typeof value === 'string') {
    const parsed = splitProductVersion(value);
    if (!parsed.product) {
      return undefined;
    }
    return parsed;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const rawProduct =
    getString(value['product']) ??
    getString(value['name']) ??
    getString(value['technology']) ??
    getString(value['value']);
  if (!rawProduct) {
    return undefined;
  }

  const parsed = splitProductVersion(rawProduct);
  if (!parsed.product) {
    return undefined;
  }

  const version = normalizeOptionalToolText(getString(value['version'])) ?? parsed.version;
  const category =
    normalizeOptionalToolText(getString(value['category'])) ??
    normalizeOptionalToolText(getString(value['type']));
  const confidence =
    typeof value['confidence'] === 'number'
      ? value['confidence']
      : typeof value['confidence'] === 'string' && Number.isFinite(Number(value['confidence']))
        ? Number(value['confidence'])
        : undefined;

  return {
    product: parsed.product,
    ...(version ? { version } : {}),
    ...(category ? { category } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
};

export const extractHttpxTechFingerprints = (value: Record<string, unknown>): ParsedTechFingerprint[] => {
  const candidates: unknown[] = [];
  const tech = value['tech'];
  const technologies = value['technologies'];
  const webserver = getString(value['webserver']) ?? getString(value['webServer']);

  if (Array.isArray(tech)) {
    candidates.push(...tech);
  } else if (tech !== undefined) {
    candidates.push(tech);
  }

  if (Array.isArray(technologies)) {
    candidates.push(...technologies);
  } else if (technologies !== undefined) {
    candidates.push(technologies);
  }

  if (webserver) {
    candidates.push({ product: webserver, category: 'web-server' });
  }

  const seen = new Set<string>();
  const fingerprints: ParsedTechFingerprint[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeTechFingerprintInput(candidate);
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.product.trim().toLowerCase();
    if (!dedupeKey || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    fingerprints.push(normalized);
  }
  return fingerprints;
};

const FFUF_HIGH_SIGNAL_PATH_PATTERN =
  /(?:^|\/)(?:api|apis|graphql|graphiql|swagger|openapi|api-docs|redoc|admin|login|auth|oauth|sso|signin|signup|register|user|users|account|accounts|session|sessions|token|tokens|jwt|\.well-known|config|backup|debug|console|dashboard|internal|metrics|health|status|actuator|server-status|robots\.txt|sitemap\.xml|\.env|\.git|wp-admin|wp-json)(?:$|[/._-])/iu;

export const normalizeFfufEndpointUrl = (rawUrl: string | undefined): NormalizedFfufEndpoint | undefined => {
  const normalized = normalizeOptionalToolText(rawUrl);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    if (parsed.search) {
      const params = Array.from(parsed.searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`),
      );
      parsed.search = '';
      for (const [key, value] of params) {
        parsed.searchParams.append(key, value);
      }
    }
    return {
      url: parsed.toString(),
      dedupeKey: `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`,
      pathname: parsed.pathname || '/',
    };
  } catch {
    return undefined;
  }
};

export const isHighSignalFfufPath = (pathname: string): boolean =>
  FFUF_HIGH_SIGNAL_PATH_PATTERN.test(pathname.toLowerCase());

const normalizeFfufRedirectKey = (entry: Record<string, unknown>): string => {
  const redirect = normalizeFfufEndpointUrl(getString(entry['redirectlocation']) ?? getString(entry['redirectLocation']));
  if (redirect) {
    return redirect.dedupeKey;
  }
  return normalizeOptionalToolText(getString(entry['redirectlocation']) ?? getString(entry['redirectLocation']))?.toLowerCase() ?? '';
};

const ffufMetric = (entry: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(Math.floor(value));
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

export const ffufResponseSignature = (entry: Record<string, unknown>): string =>
  [
    ffufMetric(entry, 'status'),
    ffufMetric(entry, 'length', 'content_length', 'contentLength'),
    ffufMetric(entry, 'words'),
    ffufMetric(entry, 'lines'),
    normalizeFfufRedirectKey(entry),
    normalizeOptionalToolText(getString(entry['content-type']) ?? getString(entry['contentType']))?.toLowerCase() ?? '',
  ].join('|');
