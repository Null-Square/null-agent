/**
 * TargetRequestBudget Unit Tests
 *
 * The Tier 0 contact limit is a legal boundary, not a performance tuning knob
 * (PRD §3). These tests assert it holds under the ways it would actually be
 * broken: a redirect chain, a loop, a future collector adding a probe path.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_PATHS,
  DisallowedTargetPath,
  MAX_TARGET_REQUESTS,
  REQUEST_TIMEOUT_MS,
  TargetRequestBudget,
  TargetRequestBudgetExceeded,
} from '@/domains/security-ops/components/fingerprint/TargetRequestBudget';
import type { HostGuardResult } from '@/shared/net/publicHostGuard';

const allowAll = async (): Promise<HostGuardResult> => ({
  status: 'allowed',
  hostname: 'acme.com',
  addresses: ['93.184.216.34'],
});

const okResponse = (headers: Record<string, string> = {}) =>
  new Response('hello', { status: 200, headers });

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

const budgetWith = (fetchImpl: ReturnType<typeof vi.fn>, guard = allowAll) =>
  new TargetRequestBudget('acme.com', { fetchImpl: fetchImpl as never, guard });

describe('TargetRequestBudget', () => {
  it('fetches an allowlisted path and returns normalised headers', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ Server: 'nginx/1.18.0' }));
    const budget = budgetWith(fetchImpl);

    const response = await budget.fetchPath('/');

    expect(response?.status).toBe(200);
    expect(response?.headers.server).toBe('nginx/1.18.0');
    expect(budget.requestsSpent).toBe(1);
  });

  it('refuses any path outside the allowlist', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const budget = budgetWith(fetchImpl);

    // These are the probes that make an unauthorized request an attack.
    for (const path of ['/.env', '/.git/HEAD', '/admin', '/wp-config.php.bak']) {
      await expect(budget.fetchPath(path)).rejects.toBeInstanceOf(DisallowedTargetPath);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(budget.requestsSpent).toBe(0);
  });

  it('only allowlists paths published for automated retrieval', () => {
    // A guard against someone widening the list without reading the PRD.
    expect([...ALLOWED_PATHS].sort()).toEqual(
      ['/', '/.well-known/security.txt', '/favicon.ico', '/robots.txt', '/sitemap.xml'].sort(),
    );
  });

  it('throws once the request budget is spent', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const budget = budgetWith(fetchImpl);

    for (let i = 0; i < MAX_TARGET_REQUESTS; i += 1) {
      await budget.fetchPath('/');
    }
    expect(budget.requestsRemaining).toBe(0);

    await expect(budget.fetchPath('/')).rejects.toBeInstanceOf(TargetRequestBudgetExceeded);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_TARGET_REQUESTS);
  });

  it('counts every redirect hop against the budget', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://acme.com/robots.txt'))
      .mockResolvedValueOnce(okResponse());
    const budget = budgetWith(fetchImpl);

    await budget.fetchPath('/');

    expect(budget.requestsSpent).toBe(2);
  });

  it('stops following redirects past the limit instead of looping', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('https://acme.com/'));
    const budget = budgetWith(fetchImpl);

    const response = await budget.fetchPath('/');

    expect(response).toBeNull();
    expect(budget.requestsSpent).toBeLessThanOrEqual(MAX_TARGET_REQUESTS);
  });

  it('re-runs the SSRF guard on every redirect hop', async () => {
    // The classic bypass: a public host that 302s to an internal address.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('http://169.254.169.254/'))
      .mockResolvedValueOnce(okResponse());

    const guard = vi.fn(async (host: string): Promise<HostGuardResult> =>
      host === 'acme.com'
        ? { status: 'allowed', hostname: host, addresses: ['93.184.216.34'] }
        : { status: 'rejected', reason: 'private_address', detail: 'blocked' },
    );

    const budget = new TargetRequestBudget('acme.com', { fetchImpl: fetchImpl as never, guard });
    const response = await budget.fetchPath('/');

    expect(response).toBeNull();
    expect(guard).toHaveBeenCalledWith('169.254.169.254');
    // The metadata endpoint was never actually requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pins every network request to the address approved for that redirect hop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.acme.com/'))
      .mockResolvedValueOnce(okResponse());
    const guard = vi.fn(async (host: string): Promise<HostGuardResult> => ({
      status: 'allowed',
      hostname: host,
      addresses: [host === 'acme.com' ? '93.184.216.34' : '203.0.113.20'],
    }));
    const budget = new TargetRequestBudget('acme.com', {
      fetchImpl: fetchImpl as never,
      guard,
    });

    await budget.fetchPath('/');

    expect(fetchImpl.mock.calls[0]?.[2]).toEqual({
      hostname: 'acme.com',
      address: '93.184.216.34',
    });
    expect(fetchImpl.mock.calls[1]?.[2]).toEqual({
      hostname: 'cdn.acme.com',
      address: '203.0.113.20',
    });
  });

  it('refuses a redirect that leaves the anonymous path allowlist', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectTo('https://acme.com/admin'));
    const budget = budgetWith(fetchImpl);

    expect(await budget.fetchPath('/')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to follow a redirect to a non-http scheme', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('file:///etc/passwd'));
    const budget = budgetWith(fetchImpl);

    expect(await budget.fetchPath('/')).toBeNull();
  });

  it('returns null rather than throwing when the host is rejected', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const guard = async (): Promise<HostGuardResult> => ({
      status: 'rejected',
      reason: 'private_address',
      detail: 'blocked',
    });

    const budget = new TargetRequestBudget('acme.com', { fetchImpl: fetchImpl as never, guard });

    expect(await budget.fetchPath('/')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(budget.requestsSpent).toBe(0);
  });

  it('keeps the timeout active while a response body is being read', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
        const body = new ReadableStream({
          start(controller) {
            init.signal.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          },
        });
        return new Response(body, { status: 200 });
      });
      const budget = budgetWith(fetchImpl);
      const pending = budget.fetchPath('/');

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('identifies itself as Null AI so a domain owner can tell who sent the request', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const budget = budgetWith(fetchImpl);

    await budget.fetchPath('/');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers['user-agent']).toBe('NullAI-Recon/1.0');
  });

  it('reports an https redirect via the http probe', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://acme.com/'))
      .mockResolvedValueOnce(okResponse());
    const budget = budgetWith(fetchImpl);

    expect(await budget.checkHttpsRedirect()).toBe(true);
  });
});
