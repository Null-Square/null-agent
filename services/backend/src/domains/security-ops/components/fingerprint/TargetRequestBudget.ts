import { assertPublicHost, type HostGuardResult } from '@/shared/net/publicHostGuard';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

/**
 * Enforces the Tier 0 contact limit (PRD §3).
 *
 * Anonymous reconnaissance may make at most five requests to the target, and
 * every one must be a request a browser or public crawler makes anyway. That is
 * what keeps it lawful without the owner's authorization, so it cannot be left
 * to reviewer discipline: collectors physically cannot exceed it because they
 * have no other way to reach the network.
 *
 * Enforced here, together:
 *   - a hard request count
 *   - an allowlist of paths, so a future edit cannot quietly add `/.env`
 *   - the SSRF guard on every hop, including redirects
 */

/**
 * Paths that exist to be fetched by machines. `robots.txt` is defined for
 * crawlers; `security.txt` (RFC 9116) exists specifically so security
 * researchers can retrieve it. Requesting these is not probing.
 *
 * Anything absent from this list is a probe for misconfiguration on a host we
 * have no permission to test — exactly what a WAF flags as an attack — and is
 * Tier 1 work.
 */
export const ALLOWED_PATHS = Object.freeze([
  '/',
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
  '/.well-known/security.txt',
]);

export const MAX_TARGET_REQUESTS = 5;
export const MAX_REDIRECTS = 2;
export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;

export class TargetRequestBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetRequestBudgetExceeded';
  }
}

export class DisallowedTargetPath extends Error {
  constructor(path: string) {
    super(`Path "${path}" is not permitted during anonymous reconnaissance`);
    this.name = 'DisallowedTargetPath';
  }
}

export interface BudgetedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The URL actually fetched after redirects, for evidence strings. */
  finalUrl: string;
}

type Fetcher = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
  pinned: { hostname: string; address: string },
) => Promise<Response>;

const pinnedAgents = new WeakMap<Response, Agent>();

const pinnedFetch: Fetcher = async (url, init, pinned) => {
  const connector = buildConnector({});
  const agent = new Agent({
    connect: (options, callback) => {
      connector(
        {
          ...options,
          hostname: pinned.address,
          host: pinned.address,
          // The socket goes to the approved address while TLS still verifies
          // and sends SNI for the requested public hostname.
          servername: pinned.hostname,
        },
        callback,
      );
    },
  });

  try {
    const response = await undiciFetch(url, { ...init, dispatcher: agent });
    // Keep the dispatcher associated with this response until the capped body
    // has been consumed. A WeakMap avoids mutating the platform Response.
    pinnedAgents.set(response as unknown as Response, agent);
    return response as unknown as Response;
  } catch (error) {
    await agent.destroy();
    throw error;
  }
};

const releasePinnedResponse = async (response: Response | null): Promise<void> => {
  if (!response) return;
  const agent = pinnedAgents.get(response);
  pinnedAgents.delete(response);
  if (agent) await agent.destroy();
};

export interface TargetRequestBudgetOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: Fetcher;
  /** Injectable for tests. Defaults to the real SSRF guard. */
  guard?: (host: string) => Promise<HostGuardResult>;
}

export class TargetRequestBudget {
  private spent = 0;

  private readonly fetchImpl: Fetcher;

  private readonly guard: (host: string) => Promise<HostGuardResult>;

  constructor(
    private readonly hostname: string,
    options: TargetRequestBudgetOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? pinnedFetch;
    this.guard = options.guard ?? ((host) => assertPublicHost(host));
  }

  get requestsSpent(): number {
    return this.spent;
  }

  get requestsRemaining(): number {
    return Math.max(0, MAX_TARGET_REQUESTS - this.spent);
  }

  /**
   * Fetches one allowlisted path from the target.
   *
   * Returns null when the request could not be made safely — a rejected host, a
   * timeout, a redirect off the allowlist. Callers treat null as "signal
   * unavailable" and say so in the UI rather than hiding it.
   */
  async fetchPath(path: string, scheme: 'https' | 'http' = 'https'): Promise<BudgetedResponse | null> {
    if (!ALLOWED_PATHS.includes(path)) {
      throw new DisallowedTargetPath(path);
    }
    if (this.spent >= MAX_TARGET_REQUESTS) {
      throw new TargetRequestBudgetExceeded(
        `Anonymous reconnaissance is limited to ${MAX_TARGET_REQUESTS} requests per target`,
      );
    }

    let url = `${scheme}://${this.hostname}${path}`;
    let redirects = 0;

    // Each hop costs a request and is re-validated: a redirect to an internal
    // address is the classic way past a guard that only checks the first URL.
    for (;;) {
      if (this.spent >= MAX_TARGET_REQUESTS) return null;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      if (!ALLOWED_PATHS.includes(parsed.pathname)) return null;

      const verdict = await this.guard(parsed.hostname);
      if (verdict.status !== 'allowed') return null;
      const address = verdict.addresses[0];
      if (!address) return null;

      this.spent += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response | null = null;
      try {
        response = await this.fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            // Identify honestly. A domain owner reading their logs should be
            // able to tell who this was and how to opt out.
            'user-agent': 'NullAI-Recon/1.0',
            accept: '*/*',
          },
        }, { hostname: parsed.hostname, address });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('location');
        if (isRedirect && location) {
          if (redirects >= MAX_REDIRECTS) return null;
          redirects += 1;
          try {
            url = new URL(location, url).toString();
          } catch {
            return null;
          }
          continue;
        }

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        return {
          status: response.status,
          headers,
          body: await readCapped(response),
          finalUrl: url,
        };
      } catch {
        return null;
      } finally {
        // The timeout covers both response headers and the capped response
        // body. Otherwise a peer could return headers promptly and hold the
        // connection open forever while the body is read.
        clearTimeout(timer);
        await releasePinnedResponse(response);
      }
    }
  }

  /**
   * Whether the origin redirects http to https. Costs one request and is
   * deliberately separate so callers see the price.
   */
  async checkHttpsRedirect(): Promise<boolean | null> {
    if (this.spent >= MAX_TARGET_REQUESTS) return null;
    const response = await this.fetchPath('/', 'http');
    if (!response) return null;
    return response.finalUrl.startsWith('https://');
  }
}

const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_RESPONSE_BYTES)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};
