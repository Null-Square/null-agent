/**
 * Target ownership verification I/O — DNS TXT and HTTP well-known checks.
 *
 * Kept as pure, dependency-injectable functions (separate from ScopeService's
 * DB work) so they can be unit-tested and smoke-tested against a real local HTTP
 * server. All record host / file path / expected value logic comes from the
 * shared `@null-ai/contracts` spec, so the server can never check for something
 * different than the instructions the UI shows the user.
 */
import { Resolver } from 'dns/promises';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import {
  dnsVerificationHost,
  expectedVerificationValue,
  httpVerificationUrls,
  txtRecordsMatchToken,
  valueMatchesToken,
} from '@null-ai/contracts';
import { localSettings } from '@/config/configSchema';
import { assertPublicHost, type HostGuardResult } from '@/shared/net/publicHostGuard';

export type VerificationReason =
  | 'verified'
  | 'not_found' // record/file genuinely absent (not added, or DNS not propagated yet)
  | 'mismatch' // record/file present but value is wrong
  | 'transient' // resolver/network hiccup — safe to retry
  | 'unreachable' // host/TLS could not be reached
  | 'invalid'; // bad input (e.g. missing token)

export interface VerificationCheck {
  verified: boolean;
  reason: VerificationReason;
  message: string;
}

export type ResolveTxtFn = (host: string) => Promise<string[][]>;

const DNS_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const invalid = (): VerificationCheck => ({
  verified: false,
  reason: 'invalid',
  message: 'Missing verification token. Re-add the target to generate one.',
});

const defaultResolveTxt: ResolveTxtFn = (host) => {
  // A dedicated resolver gives us a bounded timeout (the bare dns/promises
  // resolveTxt has none). System DNS servers are used.
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return resolver.resolveTxt(host);
};

export async function checkDnsTxt(
  domain: string,
  token: string | null,
  opts: { resolveTxt?: ResolveTxtFn } = {},
): Promise<VerificationCheck> {
  if (!token) {
    return invalid();
  }
  const host = dnsVerificationHost(domain);
  const expected = expectedVerificationValue(token);
  const resolveTxt = opts.resolveTxt ?? defaultResolveTxt;

  try {
    const records = await resolveTxt(host);
    if (txtRecordsMatchToken(records, token)) {
      return { verified: true, reason: 'verified', message: 'DNS verification successful.' };
    }
    return {
      verified: false,
      reason: 'mismatch',
      message: `A TXT record exists at ${host} but the value doesn't match. Set it to: ${expected}`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return {
        verified: false,
        reason: 'not_found',
        message: `No TXT record found yet at ${host}. Add: ${host} TXT "${expected}". DNS can take a few minutes to propagate, then check again.`,
      };
    }
    return {
      verified: false,
      reason: 'transient',
      message: `DNS lookup for ${host} failed temporarily${code ? ` (${code})` : ''}. This is usually transient — check again shortly.`,
    };
  }
}

export async function checkHttpWellKnown(
  domain: string,
  token: string | null,
  opts: {
    fetchImpl?: typeof fetch;
    urls?: string[];
    guard?: (host: string) => Promise<HostGuardResult>;
    /** Dependency-injection escape hatch for local network smoke tests only. */
    allowedHostnames?: readonly string[];
  } = {},
): Promise<VerificationCheck> {
  if (!token) {
    return invalid();
  }
  const expected = expectedVerificationValue(token);
  const urls = opts.urls ?? httpVerificationUrls(domain);

  let reachedAnyHost = false;
  let sawNotFound = false;
  let sawMismatch = false;
  let mismatchUrl = '';

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const result = await fetchHttpVerificationUrl(url, domain, controller.signal, opts);
      if (!result) continue;
      const { response: res, body, finalUrl } = result;
      reachedAnyHost = true;

      if (!res.ok) {
        sawNotFound = true;
        continue;
      }

      const declaredLength = Number(res.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_BODY_BYTES) {
        sawMismatch = true;
        mismatchUrl = finalUrl;
        continue;
      }

      if (valueMatchesToken(body, token)) {
        return { verified: true, reason: 'verified', message: 'File verification successful.' };
      }
      sawMismatch = true;
      mismatchUrl = finalUrl;
    } catch {
      // Connection refused / TLS error / timeout for this candidate — try the next.
    } finally {
      clearTimeout(timer);
    }
  }

  if (sawMismatch) {
    return {
      verified: false,
      reason: 'mismatch',
      message: `The file at ${mismatchUrl} didn't contain the expected value. Publish exactly: ${expected}`,
    };
  }
  if (sawNotFound) {
    return {
      verified: false,
      reason: 'not_found',
      message: `Verification file not found. Publish ${urls[0]} with the body: ${expected}`,
    };
  }
  if (reachedAnyHost) {
    return {
      verified: false,
      reason: 'mismatch',
      message: `Could not read the verification file. Publish ${urls[0]} with the body: ${expected}`,
    };
  }
  const hosts = urls.map((u) => safeHost(u)).filter(Boolean).join(' or ');
  return {
    verified: false,
    reason: 'unreachable',
    message: `Couldn't reach ${hosts || domain} over HTTPS. Make sure the site serves HTTPS, then publish ${urls[0]} with the body: ${expected}`,
  };
}

/**
 * A practice target the person runs beside Null AI (the compose `lab` profile's Juice Shop) has no
 * DNS zone or web root they could put a proof on. Its proof is that the person named its host, exactly,
 * in NULL_AI_LAB_TARGETS (comma-separated host names). Nothing else verifies this way.
 */
export const labTargetHosts = (env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> =>
  new Set(localSettings(env).NULL_AI_LAB_TARGETS);

export const isLabTarget = (host: string, hosts: ReadonlySet<string> = labTargetHosts()): boolean =>
  hosts.has(host.trim().toLowerCase());

const canonicalVerificationHost = (value: string): string =>
  value.trim().toLowerCase().replace(/^www\./u, '');

const isAllowedVerificationHost = (domain: string, hostname: string): boolean =>
  canonicalVerificationHost(domain) === canonicalVerificationHost(hostname);

const readCappedBody = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = MAX_BODY_BYTES - total;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value);
    total += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/** Fetches ownership evidence with public-IP pinning and per-hop validation. */
const fetchHttpVerificationUrl = async (
  initialUrl: string,
  domain: string,
  signal: AbortSignal,
  opts: {
    fetchImpl?: typeof fetch;
    guard?: (host: string) => Promise<HostGuardResult>;
    allowedHostnames?: readonly string[];
  },
): Promise<{ response: Response; body: string; finalUrl: string } | null> => {
  let currentUrl = initialUrl;
  const guard = opts.guard ?? assertPublicHost;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return null;
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (
      !isAllowedVerificationHost(domain, parsed.hostname)
      && !opts.allowedHostnames?.some((host) => host.toLowerCase() === parsed.hostname.toLowerCase())
    ) return null;

    const verdict = await guard(parsed.hostname);
    if (verdict.status !== 'allowed' || !verdict.addresses[0]) return null;

    let agent: Agent | null = null;
    try {
      const response = opts.fetchImpl
        ? await opts.fetchImpl(currentUrl, {
          headers: { accept: 'text/plain, text/*;q=0.9' },
          redirect: 'manual',
          signal,
        })
        : await (async () => {
          const connector = buildConnector({});
          agent = new Agent({
            connect: (options, callback) => connector({
              ...options,
              hostname: verdict.addresses[0],
              host: verdict.addresses[0],
              servername: parsed.hostname,
            }, callback),
          });
          return undiciFetch(currentUrl, {
            headers: { accept: 'text/plain, text/*;q=0.9' },
            redirect: 'manual',
            signal,
            dispatcher: agent,
          }) as unknown as Response;
        })();

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) return null;
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return null;
        }
        continue;
      }

      return {
        response,
        body: await readCappedBody(response),
        finalUrl: currentUrl,
      };
    } finally {
      await (agent as Agent | null)?.destroy();
    }
  }
  return null;
};

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
