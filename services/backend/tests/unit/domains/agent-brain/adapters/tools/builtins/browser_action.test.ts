import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { BrowserAction } from '@/domains/agent-brain/adapters/tools/builtins/browser_action';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { BrowserUnavailableError } from '@/domains/agent-brain/adapters/tools/runtime/browserSessionManager';

const browserSessionManagerMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  relaunch: vi.fn(),
  requireLiveSession: vi.fn(),
  cleanup: vi.fn(),
  getSession: vi.fn(),
  getNetworkEvents: vi.fn(),
  clearNetworkEvents: vi.fn(),
}));

vi.mock('@/domains/agent-brain/adapters/tools/runtime/browserSessionManager', () => ({
  BrowserUnavailableError: class BrowserUnavailableError extends Error {
    constructor(reason: string) {
      super(`browser_unavailable: ${reason}`);
    }
  },
  browserSessionManager: browserSessionManagerMocks,
  redactHeaders: (headers: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/iu.test(name)
          ? '[REDACTED]'
          : value,
      ]),
    ),
}));

const SANDBOX_CONTAINER_ID = 'sandbox-container-1';

const makeContext = (sessionOverrides: Record<string, unknown> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: {
      stopSidecars: vi.fn().mockResolvedValue(undefined),
      // Starting the session's sandbox binds its container to the session, as ContainerLifecycleManager does.
      create: vi.fn(async (session: { containerId?: string }) => {
        session.containerId = SANDBOX_CONTAINER_ID;
      }),
    } as any,
    sessionStore: {
      get: vi.fn().mockReturnValue({
        id: 'session-1',
        turn: 1,
        workspaceDir: '/tmp/workspace',
        ...sessionOverrides,
      }),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 1_000_000, timeoutMs: 30_000 },
    flags: {},
    planRuntime: { appendProvenanceSnippet: vi.fn() } as any,
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 1024 } } as any,
  }) as ToolContext;

const pageState = {
  url: 'https://example.com',
  title: 'Example',
  elements: [],
  forms: [],
  text_preview: 'Example body',
};

const makePage = () => {
  const indexedLocator = {
    click: vi.fn().mockResolvedValue(undefined),
  };
  const cssLocator = {
    first: vi.fn().mockReturnValue({
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const interactiveLocator = {
    nth: vi.fn().mockReturnValue(indexedLocator),
  };

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html>Example</html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 2, 0, 0, 0, 3,
    ])),
    title: vi.fn().mockResolvedValue('Example'),
    url: vi.fn().mockReturnValue('https://example.com'),
    locator: vi.fn((selector: string) => (selector.includes('input, button') ? interactiveLocator : cssLocator)),
    evaluate: vi.fn(async (_fn: unknown, code?: string) => {
      if (typeof code === 'string') {
        return JSON.stringify({ echoed: code });
      }
      return pageState;
    }),
    on: vi.fn(),
  };
};

describe('BrowserAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserSessionManagerMocks.getNetworkEvents.mockReturnValue([]);
    browserSessionManagerMocks.clearNetworkEvents.mockReturnValue(0);
  });

  it('launches the browser in the session sandbox and returns page state', async () => {
    const ctx = makeContext();
    const page = makePage();
    browserSessionManagerMocks.launch.mockResolvedValue({ page });

    const result = await BrowserAction.run({ action: 'launch', url: 'https://example.com' }, ctx);

    expect(ctx.sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }));
    expect(browserSessionManagerMocks.launch).toHaveBeenCalledWith('session-1', 'https://example.com', {
      containerId: SANDBOX_CONTAINER_ID,
      proxyUrl: undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'launch',
        url: 'https://example.com',
        title: 'Example',
      }),
    );
  });

  it('blocks private network URLs in SecurityOps cloud browser sessions', async () => {
    const ctx = makeContext({
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    });

    const result = await BrowserAction.run({ action: 'launch', url: 'http://localhost:3000' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('private runner'),
    });
    expect(browserSessionManagerMocks.launch).not.toHaveBeenCalled();
  });

  it('blocks alternate private URL host encodings in SecurityOps cloud browser sessions', async () => {
    const ctx = makeContext({
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    });

    const result = await BrowserAction.run({ action: 'launch', url: 'http://127.1' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: expect.stringContaining('127.0.0.1'),
    });
    expect(browserSessionManagerMocks.launch).not.toHaveBeenCalled();
  });

  it("sends the browser through the sandbox's own capture proxy", async () => {
    const ctx = makeContext({
      flags: {
        httpProxy: {
          enabled: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    });
    const page = makePage();
    browserSessionManagerMocks.launch.mockResolvedValue({ page });

    const result = await BrowserAction.run({ action: 'launch', url: 'https://example.com' }, ctx);

    expect(browserSessionManagerMocks.launch).toHaveBeenCalledWith('session-1', 'https://example.com', {
      containerId: SANDBOX_CONTAINER_ID,
      proxyUrl: 'http://127.0.0.1:8080',
    });
    expect(result.ok).toBe(true);
  });

  it('loads the page uncaptured from the same sandbox when the capture proxy fails', async () => {
    const ctx = makeContext({
      flags: {
        httpProxy: {
          enabled: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    });
    const page = makePage();
    browserSessionManagerMocks.launch
      .mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
      .mockResolvedValueOnce({ page });

    const result = await BrowserAction.run({ action: 'launch', url: 'https://example.com' }, ctx);

    expect(browserSessionManagerMocks.launch).toHaveBeenNthCalledWith(1, 'session-1', 'https://example.com', {
      containerId: SANDBOX_CONTAINER_ID,
      proxyUrl: 'http://127.0.0.1:8080',
    });
    expect(browserSessionManagerMocks.launch).toHaveBeenNthCalledWith(2, 'session-1', 'https://example.com', {
      containerId: SANDBOX_CONTAINER_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ proxyFallback: true }));
  });

  it('fails with a clear message and opens no browser when the session sandbox cannot start', async () => {
    const ctx = makeContext();
    (ctx.sandbox.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sandbox_unavailable: no image'));

    const result = await BrowserAction.run({ action: 'launch', url: 'https://example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: "browser_unavailable: the session's sandbox could not start (sandbox_unavailable: no image)",
    });
    expect(browserSessionManagerMocks.launch).not.toHaveBeenCalled();
  });

  it('never retries elsewhere when the sandbox cannot run the browser', async () => {
    const ctx = makeContext({
      flags: {
        httpProxy: {
          enabled: true,
          url: 'http://127.0.0.1:8080',
        },
      },
    });
    browserSessionManagerMocks.launch.mockRejectedValueOnce(
      new BrowserUnavailableError('Chromium did not start in the sandbox (out of memory)'),
    );

    const result = await BrowserAction.run({ action: 'launch', url: 'https://example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      success: false,
      error: 'browser_unavailable: Chromium did not start in the sandbox (out of memory)',
    });
    expect(browserSessionManagerMocks.launch).toHaveBeenCalledTimes(1);
  });

  it('clicks an indexed interactive element and returns updated page state', async () => {
    const ctx = makeContext();
    const page = makePage();
    const interactiveLocator = page.locator(
      'input, button, a[href], select, textarea, [role="button"]',
    ) as { nth: ReturnType<typeof vi.fn> };

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
    });

    const result = await BrowserAction.run({ action: 'click', selector: '@3' }, ctx);

    expect(interactiveLocator.nth).toHaveBeenCalledWith(3);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'click',
        title: 'Example',
      }),
    );
  });

  it('returns page state plus javascript execution output', async () => {
    const ctx = makeContext();
    const page = makePage();

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
    });

    const result = await BrowserAction.run({ action: 'execute_js', code: 'window.location.href' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'execute_js',
        js_result: JSON.stringify({ echoed: 'window.location.href' }),
      }),
    );
  });

  it('returns and clears console output', async () => {
    const ctx = makeContext();
    const page = makePage();
    const consoleLogs = [{ type: 'log', text: 'hello' }];

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs,
    });

    const result = await BrowserAction.run({ action: 'get_console', clear: true }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      success: true,
      action: 'get_console',
      console: [{ type: 'log', text: 'hello' }],
      cleared: true,
    });
    expect(consoleLogs).toHaveLength(0);
  });

  it('returns rendered source for inspection', async () => {
    const ctx = makeContext();
    const page = makePage();

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
    });

    const result = await BrowserAction.run({ action: 'get_source' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'get_source',
        source: '<html>Example</html>',
        source_truncated: false,
      }),
    );
  });

  it('waits for the requested duration before returning page state', async () => {
    const ctx = makeContext();
    const page = makePage();

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
    });

    const result = await BrowserAction.run({ action: 'wait', ms: 750 }, ctx);

    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'wait',
        title: 'Example',
      }),
    );
  });

  it('returns an actionable error when no browser session exists yet', async () => {
    const ctx = makeContext();
    browserSessionManagerMocks.requireLiveSession.mockRejectedValue(
      new Error('browser not launched. call launch first'),
    );

    const result = await BrowserAction.run({ action: 'navigate', url: 'https://example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      success: false,
      error: 'browser not launched. call launch first',
      action: 'navigate',
    });
  });

  it('closes the live browser session', async () => {
    const ctx = makeContext();

    const result = await BrowserAction.run({ action: 'close' }, ctx);

    expect(browserSessionManagerMocks.cleanup).toHaveBeenCalledWith('session-1');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ success: true, action: 'close', closed: true });
  });

  it('captures screenshot artifacts as metadata only', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-action-shot-'));
    const ctx = makeContext();
    ctx.workspaceDir = workspaceDir;
    const page = makePage();
    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
      networkEvents: [],
    });

    const result = await BrowserAction.run({ action: 'screenshot', label: 'login page', fullPage: true }, ctx);

    expect(result.ok).toBe(true);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining(path.join('.artifacts', 'browser', 'screenshots')),
      fullPage: true,
    }));
    expect(result.data).toEqual(expect.objectContaining({
      success: true,
      action: 'screenshot',
      artifact_path: expect.stringContaining('/workspace/.artifacts/browser/screenshots/'),
      mime_type: 'image/png',
      sha256: expect.any(String),
      bytes: expect.any(Number),
      width: 2,
      height: 3,
      masked_sensitive: true,
    }));

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('returns compact browser network events with pagination', async () => {
    const ctx = makeContext();
    const page = makePage();
    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({ page, consoleLogs: [], networkEvents: [] });
    browserSessionManagerMocks.getNetworkEvents.mockReturnValue([
      {
        id: 'browser-1',
        ts: '2026-06-15T00:00:00.000Z',
        method: 'GET',
        url: 'https://example.com/api',
        resourceType: 'fetch',
        initiatorType: 'fetch',
        status: 200,
        requestHeaders: { authorization: '[REDACTED]' },
        responseHeaders: { 'content-type': 'application/json' },
      },
    ]);

    const result = await BrowserAction.run({ action: 'get_network', limit: 1 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      success: true,
      action: 'get_network',
      total_count: 1,
      limit: 1,
      events: [
        expect.objectContaining({
          id: 'browser-1',
          resource_type: 'fetch',
          request_headers: { authorization: '[REDACTED]' },
        }),
      ],
    }));
  });

  it('saves browser storage state as a sensitive artifact', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-action-state-'));
    const ctx = makeContext();
    ctx.workspaceDir = workspaceDir;
    const page = makePage();
    const context = {
      storageState: vi.fn(async ({ path: outputPath }: { path: string }) => {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(
          outputPath,
          JSON.stringify({ cookies: [{ domain: 'example.com', name: 'sid', value: 'secret' }], origins: [] }),
          'utf8',
        );
        return { cookies: [{ domain: 'example.com', name: 'sid', value: 'secret' }], origins: [] };
      }),
    };
    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      context,
      consoleLogs: [],
      networkEvents: [],
    });

    const result = await BrowserAction.run({ action: 'save_state', label: 'auth' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      success: true,
      action: 'save_state',
      sensitive: true,
      report_safe: false,
      domains: ['example.com'],
      cookie_count: 1,
      origin_count: 0,
    }));

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('captures opt-in trace artifacts as metadata', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-action-trace-'));
    const ctx = makeContext();
    ctx.workspaceDir = workspaceDir;
    const page = makePage();
    const context = {
      tracing: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(async ({ path: outputPath }: { path: string }) => {
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, 'trace-zip');
        }),
      },
    };
    const session = {
      page,
      context,
      consoleLogs: [],
      networkEvents: [],
      traceActive: false,
    };
    browserSessionManagerMocks.requireLiveSession.mockResolvedValue(session);

    const started = await BrowserAction.run({ action: 'start_trace', label: 'challenge' }, ctx);
    const stopped = await BrowserAction.run({ action: 'stop_trace', label: 'challenge' }, ctx);

    expect(started.ok).toBe(true);
    expect(context.tracing.start).toHaveBeenCalledWith({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    expect(stopped.ok).toBe(true);
    expect(stopped.data).toEqual(expect.objectContaining({
      success: true,
      action: 'stop_trace',
      artifact_path: expect.stringContaining('/workspace/.artifacts/browser/traces/'),
      mime_type: 'application/zip',
      sha256: expect.any(String),
      bytes: 'trace-zip'.length,
      report_safe: true,
    }));

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('allows typing into password fields without legacy access-material gating', async () => {
    const ctx = makeContext();
    ctx.flags = {
      securityops: {
        accessMaterials: {
          availableCount: 1,
          listChecked: false,
          usedByHost: {},
          materials: [
            {
              id: 'material-1',
              kind: 'login_credential',
              label: 'App Login',
              username: 'demo@example.com',
              headerName: null,
              notes: null,
              appliesToHosts: ['app.nullsquare.net'],
            },
          ],
        },
      },
    };

    const fill = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'password',
        name: 'password',
        id: 'password',
        placeholder: 'Password',
        autocomplete: 'current-password',
      })
      .mockResolvedValue(pageState);
    const page = {
      ...makePage(),
      url: vi.fn().mockReturnValue('https://app.nullsquare.net/login'),
      locator: vi.fn(() => ({
        first: vi.fn().mockReturnValue({
          fill,
          evaluate,
        }),
      })),
    };

    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page,
      consoleLogs: [],
    });

    const result = await BrowserAction.run({ action: 'type', selector: '#password', text: 'guess' }, ctx);

    expect(result.ok).toBe(true);
    expect(fill).toHaveBeenCalledWith('guess', { timeout: 10_000 });
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        action: 'type',
        title: 'Example',
      }),
    );
  });

  it('captures a credentialed exchange sent by the browser itself as durable browser-sourced evidence', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-capture-exchange-'));
    const ctx = makeContext();
    ctx.workspaceDir = workspaceDir;
    const mainFrame = {};
    const tab = {
      route: vi.fn().mockResolvedValue(undefined),
      mainFrame: () => mainFrame,
      goto: vi.fn().mockResolvedValue({
        status: () => 200,
        headers: () => ({
          'content-type': 'application/json',
          'access-control-allow-origin': 'https://evil.example.test',
          'access-control-allow-credentials': 'true',
        }),
        text: vi.fn().mockResolvedValue('{"email":"evaluator@example.test"}'),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // Playwright's context.request is an HTTP client in the backend process, outside the sandbox.
    const backendFetch = vi.fn();
    const cookiesMock = vi.fn().mockResolvedValue([{ name: 'sid', value: 'secret' }]);
    browserSessionManagerMocks.requireLiveSession.mockResolvedValue({
      page: makePage(),
      context: { request: { fetch: backendFetch }, cookies: cookiesMock, newPage: vi.fn().mockResolvedValue(tab) },
      consoleLogs: [],
      networkEvents: [],
    });

    const result = await BrowserAction.run({
      action: 'capture_exchange',
      url: 'https://api.example.test/profile',
      method: 'post',
      headers: { Origin: 'https://evil.example.test' },
      label: 'cors proof',
    }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, any>;
    expect(data.success).toBe(true);
    expect(data.status).toBe(200);
    expect(data.evidence_ref).toMatch(/^browser-network:bx-/u);
    expect(data.artifact_path).toContain('/workspace/.artifacts/browser/exchanges/');
    expect(backendFetch).not.toHaveBeenCalled();
    expect(tab.goto).toHaveBeenCalledWith('https://api.example.test/profile', expect.objectContaining({
      waitUntil: 'commit',
    }));
    expect(tab.close).toHaveBeenCalledTimes(1);

    const routeHandler = tab.route.mock.calls[0][1] as (route: unknown) => Promise<void>;
    const makeRoute = (request: Record<string, unknown>) => ({
      request: () => ({ redirectedFrom: () => null, ...request }),
      fallback: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    });
    const exchange = makeRoute({
      isNavigationRequest: () => true,
      frame: () => mainFrame,
      headers: () => ({ 'user-agent': 'Chromium', origin: 'https://api.example.test' }),
    });
    await routeHandler(exchange);
    expect(exchange.fallback).toHaveBeenCalledWith({
      method: 'POST',
      headers: { 'user-agent': 'Chromium', Origin: 'https://evil.example.test' },
    });
    const subresource = makeRoute({ isNavigationRequest: () => false, frame: () => mainFrame, headers: () => ({}) });
    await routeHandler(subresource);
    expect(subresource.abort).toHaveBeenCalledWith('blockedbyclient');

    const persisted = JSON.parse(await fs.readFile(path.join(workspaceDir, data.relative_path), 'utf8'));
    expect(persisted.kind).toBe('http_exchange');
    expect(persisted.source).toBe('browser');
    expect(`browser-network:${persisted.id}`).toBe(data.evidence_ref);
    expect(persisted.request.headers).toEqual(expect.arrayContaining([
      { name: 'Origin', value: 'https://evil.example.test' },
      { name: 'Cookie', value: '[REDACTED]' },
    ]));
    expect(persisted.response.statusCode).toBe(200);
    expect(persisted.response.headers).toEqual(expect.arrayContaining([
      { name: 'access-control-allow-origin', value: 'https://evil.example.test' },
      { name: 'access-control-allow-credentials', value: 'true' },
    ]));
    expect(persisted.response.body).toContain('evaluator@example.test');

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
