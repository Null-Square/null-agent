/**
 * Production-representative smoke test for HTTP well-known target verification.
 *
 * This runs the REAL verifier against a REAL local HTTP server using the REAL
 * global `fetch` — exercising the actual network round-trip, redirect handling,
 * status handling, and body parsing a customer's site goes through. It is the
 * safety net that would have caught the onboarding/backend instruction drift.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDnsTxt,
  checkHttpWellKnown,
} from '@/domains/security-ops/scopes/verificationChecks';
import { HTTP_VERIFICATION_WELL_KNOWN_PATH, expectedVerificationValue } from '@null-ai/contracts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const EXPECTED = expectedVerificationValue(TOKEN);

describe('target verification — HTTP well-known (real server + real fetch)', () => {
  let server: http.Server;
  let port = 0;
  let handler: http.RequestListener = (_req, res) => {
    res.writeHead(404);
    res.end();
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const wellKnownUrl = () => `http://127.0.0.1:${port}${HTTP_VERIFICATION_WELL_KNOWN_PATH}`;
  const localGuard = async (hostname: string) => ({
    status: 'allowed' as const,
    hostname,
    addresses: ['127.0.0.1'],
  });
  const run = () => checkHttpWellKnown('example.com', TOKEN, {
    urls: [wellKnownUrl()],
    fetchImpl: fetch,
    guard: localGuard,
    allowedHostnames: ['127.0.0.1'],
  });

  it('verifies a correctly served file', async () => {
    handler = (req, res) => {
      if (req.url === HTTP_VERIFICATION_WELL_KNOWN_PATH) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(EXPECTED);
      } else {
        res.writeHead(404);
        res.end();
      }
    };
    expect((await run()).verified).toBe(true);
  });

  it('tolerates wrapping quotes and surrounding whitespace in the body', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(`  "${EXPECTED}"  \n`);
    };
    expect((await run()).verified).toBe(true);
  });

  it('follows redirects to the real file', async () => {
    handler = (req, res) => {
      if (req.url === HTTP_VERIFICATION_WELL_KNOWN_PATH) {
        res.writeHead(302, { location: '/redirected' });
        res.end();
      } else {
        res.writeHead(200);
        res.end(EXPECTED);
      }
    };
    expect((await run()).verified).toBe(true);
  });

  it('reports not_found on a 404', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    expect((await run()).reason).toBe('not_found');
  });

  it('reports mismatch on a wrong body', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('ns-verify=wrong');
    };
    expect((await run()).reason).toBe('mismatch');
  });

  it('reports unreachable when nothing is listening', async () => {
    const r = await checkHttpWellKnown('example.com', TOKEN, {
      urls: [`http://127.0.0.1:1${HTTP_VERIFICATION_WELL_KNOWN_PATH}`],
      fetchImpl: fetch,
      guard: localGuard,
      allowedHostnames: ['127.0.0.1'],
    });
    expect(r.reason).toBe('unreachable');
  });
});

/**
 * Opt-in real-DNS smoke. Publish a control record, then run:
 *   RUN_DNS_SMOKE=1 DNS_SMOKE_DOMAIN=<domain> DNS_SMOKE_TOKEN=<token> npm run test:unit
 * where `_nullsquare-verify.<domain>` TXT = "ns-verify=<token>".
 */
describe.skipIf(!process.env.RUN_DNS_SMOKE)('target verification — DNS (real resolver)', () => {
  it('verifies a real control TXT record', async () => {
    const r = await checkDnsTxt(process.env.DNS_SMOKE_DOMAIN ?? '', process.env.DNS_SMOKE_TOKEN ?? '');
    expect(r.verified).toBe(true);
  });
});
