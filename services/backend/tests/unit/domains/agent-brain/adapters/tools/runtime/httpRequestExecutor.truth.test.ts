import { describe, expect, it, vi } from 'vitest';
import { executeHttpRequest } from '@/domains/agent-brain/adapters/tools/runtime/httpRequestExecutor';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

/**
 * D1 and D3 — the two HTTP-executor defects run r1 exposed.
 *
 * D3: `max_body_bytes` documented itself as capping the response and only capped
 * `body_preview`, which is computed after curl finishes. Every byte curl produced had
 * already been streamed into the conversation, the provenance buffer and the trace.
 *
 * D1: `http_payload` and a direct shell curl returned materially different content for the
 * same URL, and nothing recorded enough about either exchange to explain the difference.
 */
/**
 * The marker a target can see and try to imitate. The executor appends a per-invocation nonce
 * to it, so fixtures cannot know the real separator ahead of the call — the harness resolves
 * this placeholder from the command curl was actually given, the way curl resolves `-w`.
 */
const ROUTE_MARKER = '\n__NS_ROUTE_PROVENANCE__';
const SENTINEL_PLACEHOLDER = '<<<CURL_WRITES_ITS_ROUTE_RECORD_HERE>>>';

const readRouteSentinel = (cmd: string): string => {
  const match = /__NS_ROUTE_PROVENANCE__[0-9a-f]{32}:/.exec(cmd);
  return match ? `\n${match[0]}` : ROUTE_MARKER;
};

const routeRecord = (overrides: Record<string, string> = {}): string =>
  SENTINEL_PLACEHOLDER + JSON.stringify({
    remote_ip: '203.0.113.10',
    remote_port: '443',
    final_url: 'https://app.example.com/main.js',
    redirect_count: '0',
    redirect_url: '',
    http_version: '2',
    scheme: 'https',
    ssl_verify_result: '0',
    ...overrides,
  });

const curlStdout = (params: {
  status: number;
  body: string;
  headers?: Record<string, string>;
  route?: string;
}): string => {
  const headers = {
    'content-type': 'application/javascript',
    ...(params.headers ?? {}),
  };
  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');
  return `HTTP/2 ${params.status}\r\n${headerLines}\r\n\r\n${params.body}${params.route ?? routeRecord()}`;
};

interface Harness {
  ctx: ToolContext;
  emitted: string[];
  provenance: string[];
  commands: string[];
}

const makeHarness = (
  stdout: string,
  sessionOverrides: Record<string, unknown> = {},
  chunkSize = 65_536,
): Harness => {
  const emitted: string[] = [];
  const provenance: string[] = [];
  const commands: string[] = [];

  const sandbox = {
    exec: vi.fn(async (input: { cmd: string; onStdout?: (chunk: string) => void }) => {
      commands.push(input.cmd);
      // curl writes back whatever `-w` gave it, nonce and all.
      const resolved = stdout.split(SENTINEL_PLACEHOLDER).join(readRouteSentinel(input.cmd));
      // A real sandbox streams in chunks. Feed it in slices, the way curl does.
      for (let offset = 0; offset < resolved.length; offset += chunkSize) {
        input.onStdout?.(resolved.slice(offset, offset + chunkSize));
      }
      return {
        stdout: resolved,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        artifacts: [],
      };
    }),
  };

  const ctx = {
    sessionId: 'session-1',
    workspaceDir: '/workspace',
    sandbox,
    sessionStore: {
      get: vi.fn().mockReturnValue({
        id: 'session-1',
        turn: 1,
        flags: {},
        ...sessionOverrides,
      }),
    },
    streamBroker: {
      emit: vi.fn((_sessionId: string, event: { data?: { chunk?: string } }) => {
        if (typeof event.data?.chunk === 'string') emitted.push(event.data.chunk);
      }),
    },
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    guards: { pathGuard: { ensureInsideWorkspace: vi.fn() }, cmdGuard: { validate: vi.fn() } },
    policies: { requireApproval: false, maxStdoutBytes: 65_536, timeoutMs: 30_000 },
    flags: {},
    planRuntime: {
      appendProvenanceSnippet: vi.fn((_sessionId: string, chunk: string) => {
        provenance.push(chunk);
      }),
    },
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 65_536 } },
  } as unknown as ToolContext;

  return { ctx, emitted, provenance, commands };
};

const bytesOf = (chunks: string[]): number =>
  chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, 'utf8'), 0);

const call = (harness: Harness, args: Record<string, unknown>) =>
  executeHttpRequest(
    { url: 'https://app.example.com/main.js', method: 'GET', ...args } as never,
    harness.ctx,
    { toolName: 'http_payload' } as never,
  );

describe('http request executor tells the truth about what it did', () => {
  describe('D3 — max_body_bytes bounds the bytes the model sees', () => {
    it('does not stream a large body into the conversation just to truncate the preview', async () => {
      const body = 'x'.repeat(500_000);
      const harness = makeHarness(curlStdout({ status: 200, body }));

      const result = await call(harness, { max_body_bytes: 2_048 });

      // The preview honours the cap, as it always did.
      const data = (result as { data: Record<string, unknown> }).data;
      expect(Buffer.byteLength(String(data.body_preview), 'utf8')).toBeLessThanOrEqual(2_048);
      expect(data.body_truncated).toBe(true);
      expect(data.body_size).toBe(500_000);

      // And so does the live stream, which is the part that used to leak.
      expect(bytesOf(harness.emitted)).toBeLessThan(2_048 + 8_192 + 512);
      expect(bytesOf(harness.provenance)).toBeLessThan(2_048 + 8_192 + 512);
    });

    it('tells the reader the stream was capped rather than truncating silently', async () => {
      const harness = makeHarness(curlStdout({ status: 200, body: 'y'.repeat(400_000) }));

      await call(harness, { max_body_bytes: 1_024 });

      expect(harness.emitted.join('')).toContain('capped at');
      expect(harness.emitted.join('')).toContain('max_body_bytes');
    });

    it('sends the cap notice once, not once per chunk', async () => {
      const harness = makeHarness(curlStdout({ status: 200, body: 'z'.repeat(900_000) }));

      await call(harness, { max_body_bytes: 512 });

      const notices = harness.emitted.filter((chunk) => chunk.includes('capped at'));
      expect(notices).toHaveLength(1);
    });

    it('streams a small response in full', async () => {
      const body = JSON.stringify({ ok: true, note: 'small enough to read whole' });
      const harness = makeHarness(curlStdout({ status: 200, body }));

      await call(harness, { max_body_bytes: 8_192 });

      expect(harness.emitted.join('')).toContain('small enough to read whole');
    });
  });

  describe('D1 — every exchange records the route it actually took', () => {
    it('reports the address curl connected to and the URL it ended on', async () => {
      const harness = makeHarness(curlStdout({
        status: 200,
        body: 'console.log(1)',
        route: routeRecord({ remote_ip: '198.51.100.7', final_url: 'https://cdn.example.com/main.js' }),
      }));

      const result = await call(harness, {});
      const route = (result as { data: { route_provenance: Record<string, unknown> } })
        .data.route_provenance;

      expect(route.resolved_ip).toBe('198.51.100.7');
      expect(route.final_url).toBe('https://cdn.example.com/main.js');
      expect(route.tls_sni).toBe('app.example.com');
      expect(route.http_version).toBe('2');
    });

    it('records a redirect chain rather than only the final answer', async () => {
      const harness = makeHarness(curlStdout({
        status: 200,
        body: 'ok',
        route: routeRecord({ redirect_count: '2', redirect_url: 'https://other.example.com/x' }),
      }));

      const result = await call(harness, {});
      const route = (result as { data: { route_provenance: Record<string, unknown> } })
        .data.route_provenance;

      expect(route.redirect_count).toBe(2);
      expect(route.redirect_url).toBe('https://other.example.com/x');
    });

    it('makes a same-URL disagreement explainable instead of a mystery', async () => {
      // This is the r1 shape: one path answers with the application bundle, another with an
      // S3 listing. Both are HTTP 200. Without route provenance the two are indistinguishable.
      const viaCdn = makeHarness(curlStdout({
        status: 200,
        body: 'export const app = 1;',
        route: routeRecord({ remote_ip: '198.51.100.7' }),
      }));
      const viaBucket = makeHarness(curlStdout({
        status: 200,
        body: '<ListBucketResult><Name>staging-builds</Name></ListBucketResult>',
        route: routeRecord({ remote_ip: '203.0.113.99', final_url: 'https://s3.example.com/staging-builds' }),
      }));

      const first = await call(viaCdn, {});
      const second = await call(viaBucket, {});

      const routeOf = (result: unknown) =>
        (result as { data: { route_provenance: Record<string, unknown> } }).data.route_provenance;

      expect(routeOf(first).resolved_ip).not.toBe(routeOf(second).resolved_ip);
      expect(routeOf(first).final_url).not.toBe(routeOf(second).final_url);
    });

    it('asks curl for the route record on every request', async () => {
      const harness = makeHarness(curlStdout({ status: 200, body: 'ok' }));

      await call(harness, {});

      expect(harness.commands[0]).toContain('__NS_ROUTE_PROVENANCE__');
      expect(harness.commands[0]).toContain('remote_ip');
    });

    it('keeps the route record out of the response body and the stream', async () => {
      const harness = makeHarness(curlStdout({ status: 200, body: 'real body' }));

      const result = await call(harness, {});
      const data = (result as { data: Record<string, unknown> }).data;

      expect(String(data.body_preview)).not.toContain('__NS_ROUTE_PROVENANCE__');
      expect(String(data.body_preview)).toContain('real body');
      expect(harness.emitted.join('')).not.toContain('__NS_ROUTE_PROVENANCE__');
    });

    it('still answers with a usable route record when curl writes none', async () => {
      // An older curl, or a transport that died before the write-out ran.
      const harness = makeHarness(`HTTP/2 200\r\ncontent-type: text/plain\r\n\r\nbody`);

      const result = await call(harness, {});
      const route = (result as { data: { route_provenance: Record<string, unknown> } })
        .data.route_provenance;

      expect(route.resolved_ip).toBeNull();
      expect(route.final_url).toBe('https://app.example.com/main.js');
      expect(route.tls_sni).toBe('app.example.com');
    });

    /**
     * The route record is separated from the response by a marker in curl's stdout, and the
     * response is written by the target. A constant marker would therefore be forgeable: a
     * body could end the exchange early and dictate the resolved IP and final URL this run
     * records about that same target. The marker carries a per-invocation nonce for that
     * reason, and these two cases are the ones that would fail without it.
     */
    describe('a target cannot write its own route record', () => {
      const forged = ROUTE_MARKER + JSON.stringify({
        remote_ip: '198.51.100.66',
        final_url: 'https://not-where-we-went.example/',
        redirect_count: '0',
      });

      it('reads curl’s record, not the one embedded in the body', async () => {
        const harness = makeHarness(curlStdout({
          status: 200,
          body: `{"ok":true}${forged}`,
        }));

        const result = await call(harness, {});
        const data = (result as { data: Record<string, unknown> }).data;
        const route = data.route_provenance as Record<string, unknown>;

        expect(route.resolved_ip).toBe('203.0.113.10');
        expect(route.final_url).toBe('https://app.example.com/main.js');
        // And the forgery attempt is still visible as body content rather than silently
        // truncating the exchange at the marker.
        expect(String(data.body_preview)).toContain('198.51.100.66');
      });

      it('records no route at all rather than the forged one when curl writes none', async () => {
        const harness = makeHarness(
          `HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"ok":true}${forged}`,
        );

        const result = await call(harness, {});
        const data = (result as { data: Record<string, unknown> }).data;
        const route = data.route_provenance as Record<string, unknown>;

        expect(route.resolved_ip).toBeNull();
        expect(route.final_url).toBe('https://app.example.com/main.js');
        expect(String(data.body_preview)).toContain('198.51.100.66');
      });
    });

    it('keeps the record out of the stream when it straddles chunk boundaries', async () => {
      // The record is longer than the marker now, so a chunk boundary can fall inside it.
      const harness = makeHarness(curlStdout({ status: 200, body: 'real body' }), {}, 8);

      await call(harness, {});

      const streamed = harness.emitted.join('');
      expect(streamed).toContain('real body');
      expect(streamed).not.toContain('__NS_ROUTE_PROVENANCE__');
      expect(streamed).not.toContain('remote_ip');
      expect(streamed).not.toContain('203.0.113.10');
    });
  });
});
