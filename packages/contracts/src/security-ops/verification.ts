/**
 * Scope-target ownership verification — single source of truth.
 *
 * The backend verifier (ScopeService / verificationChecks) and every frontend
 * surface that shows verification instructions (onboarding wizard, scopes modal)
 * MUST derive the DNS host, file path, and expected value from these helpers.
 * That guarantees the instructions a user is told to publish can never drift
 * from what the server actually checks — the exact bug this module prevents.
 */

/** DNS TXT label, prepended to the domain → `_nullsquare-verify.example.com`. */
export const DNS_VERIFICATION_HOST_LABEL = '_nullsquare-verify';

/** HTTPS file path served at the domain root. */
export const HTTP_VERIFICATION_WELL_KNOWN_PATH = '/.well-known/null-ai-verification.txt';

/** Required prefix on the TXT value / file body. */
export const VERIFICATION_VALUE_PREFIX = 'ns-verify=';

export interface TargetVerificationInstructions {
  /** Full DNS host the TXT record must be created at. */
  dnsHost: string;
  /** Exact TXT value / file body the user must publish. */
  expectedValue: string;
  /** Primary HTTPS URL (apex) the file is fetched from. */
  httpUrl: string;
  /** All candidate HTTPS URLs the verifier tries (apex + www). */
  httpUrls: string[];
}

/** Strip protocol / path / port / `www.` so we always work with the apex host. */
export function normalizeVerificationDomain(domain: string): string {
  let d = (domain ?? '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (d.startsWith('www.')) {
    d = d.slice(4);
  }
  return d;
}

export function dnsVerificationHost(domain: string): string {
  return `${DNS_VERIFICATION_HOST_LABEL}.${normalizeVerificationDomain(domain)}`;
}

export function expectedVerificationValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`;
}

/** Apex first, then `www.` — many sites only serve HTTPS on one of the two. */
export function httpVerificationUrls(domain: string): string[] {
  const d = normalizeVerificationDomain(domain);
  if (!d) {
    return [];
  }
  return [d, `www.${d}`].map((host) => `https://${host}${HTTP_VERIFICATION_WELL_KNOWN_PATH}`);
}

export function buildTargetVerificationInstructions(
  domain: string,
  token: string,
): TargetVerificationInstructions {
  const httpUrls = httpVerificationUrls(domain);
  return {
    dnsHost: dnsVerificationHost(domain),
    expectedValue: expectedVerificationValue(token),
    httpUrl: httpUrls[0] ?? '',
    httpUrls,
  };
}

/**
 * Normalize a published TXT value / file body for comparison. `trim()` also
 * removes a leading/trailing UTF-8 BOM (U+FEFF is ECMAScript whitespace); we
 * then drop one layer of wrapping double quotes that some DNS panels add.
 */
export function normalizeChallengeValue(raw: string): string {
  let v = (raw ?? '').trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Tolerant match of one published value against the expected token. Accepts the
 * value with or without the `ns-verify=` prefix (a user pasting just the token
 * is the most common mistake), with flexible spacing around `=`. The token
 * itself must match exactly — tokens are random lowercase hex, so this is safe.
 */
export function valueMatchesToken(rawValue: string, token: string): boolean {
  if (!token) {
    return false;
  }
  const v = normalizeChallengeValue(rawValue);
  // Bare token (user pasted just the token without the prefix).
  if (v === token) {
    return true;
  }
  // `ns-verify=<token>`, tolerating spacing around `=`.
  const match = /^ns-verify\s*=\s*(.+)$/i.exec(v);
  return match?.[1].trim() === token;
}

/**
 * Match Node's `resolveTxt` shape (`string[][]` — one chunk array per record)
 * against the token. Chunks of a single record are joined before comparison,
 * per the DNS spec for multi-string TXT records.
 */
export function txtRecordsMatchToken(records: string[][], token: string): boolean {
  return records.some((chunks) => valueMatchesToken(chunks.join(''), token));
}
