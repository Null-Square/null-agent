import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import { PassThrough } from 'stream';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  connectOverCDP: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: {
    launch: mocks.launch,
    connectOverCDP: mocks.connectOverCDP,
  },
}));

import {
  BrowserSessionManager,
  BrowserUnavailableError,
  type SandboxBrowserDocker,
} from '@/domains/agent-brain/adapters/tools/runtime/browserSessionManager';

type PageEventHandler = (payload: unknown) => void;

const makePage = () => {
  const handlers = new Map<string, PageEventHandler[]>();
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: PageEventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    isClosed: vi.fn().mockReturnValue(false),
    emitTestEvent: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
  return page;
};

const makeContext = (page = makePage()) => ({
  newPage: vi.fn().mockResolvedValue(page),
  route: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const makeBrowser = () => {
  const handlers = new Map<string, () => void>();
  const browser = {
    newContext: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    version: vi.fn().mockReturnValue('150.0.0.0'),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
  };

  return { browser, handlers };
};

const DEVTOOLS_PORT = 41234;

// A docker exec stream whose process echoes its stdin, standing in for socat inside the sandbox.
const makeEchoStream = () => {
  const stream = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  stream.stdin = new PassThrough();
  stream.stdout = new PassThrough();
  stream.stdin.pipe(stream.stdout);
  stream.exitCode = null;
  stream.signalCode = null;
  stream.kill = vi.fn(() => {
    stream.signalCode = 'SIGKILL';
    stream.stdout.end();
    stream.emit('exit', null, 'SIGKILL');
  });
  return stream;
};

const makeDocker = () => {
  const docker = {
    exec: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: `NULLAI_BROWSER_PORT=${DEVTOOLS_PORT}\n`,
      stderr: '',
      bytesOut: 0,
      bytesErr: 0,
    }),
    execStream: vi.fn(() => makeEchoStream()),
  };
  return docker as typeof docker & SandboxBrowserDocker;
};

const IN_SANDBOX = { containerId: 'sandbox-1' };

describe('BrowserSessionManager', () => {
  const managers: BrowserSessionManager[] = [];
  const newManager = (docker = makeDocker()) => {
    const manager = new BrowserSessionManager(docker);
    managers.push(manager);
    return { manager, docker };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  });

  it('runs the browser inside the session sandbox and never in the backend process', async () => {
    const { manager, docker } = newManager();
    const { browser } = makeBrowser();
    const pageOne = makePage();
    const pageTwo = makePage();
    browser.newContext
      .mockResolvedValueOnce(makeContext(pageOne))
      .mockResolvedValueOnce(makeContext(pageTwo));
    mocks.connectOverCDP.mockResolvedValue(browser);

    await manager.launch('session-1', 'https://example.com', IN_SANDBOX);
    await manager.launch('session-2', 'https://example.org', IN_SANDBOX);

    expect(docker.exec).toHaveBeenCalledTimes(1);
    expect(docker.exec).toHaveBeenCalledWith(
      'sandbox-1',
      expect.objectContaining({
        cmd: expect.stringContaining('--remote-debugging-address=127.0.0.1'),
      }),
    );
    expect(docker.exec.mock.calls[0][1].cmd).toContain('nohup chromium');
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(mocks.connectOverCDP).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      expect.any(Object),
    );
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(pageOne.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(pageTwo.goto).toHaveBeenCalledWith('https://example.org', expect.any(Object));

    await manager.shutdown();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('carries each DevTools connection into the sandbox through docker exec socat', async () => {
    const { manager, docker } = newManager();
    const { browser } = makeBrowser();
    browser.newContext.mockResolvedValue(makeContext());
    let echoed = '';
    mocks.connectOverCDP.mockImplementation(async (endpoint: string) => {
      const { port } = new URL(endpoint);
      echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(Number(port), '127.0.0.1', () => socket.write('GET /json/version/'));
        socket.once('data', (data) => {
          resolve(data.toString('utf8'));
          socket.destroy();
        });
        socket.once('error', reject);
      });
      return browser;
    });

    await manager.launch('session-1', 'https://example.com', IN_SANDBOX);

    expect(docker.execStream).toHaveBeenCalledWith('sandbox-1', ['socat', 'STDIO', `TCP:127.0.0.1:${DEVTOOLS_PORT}`]);
    expect(echoed).toBe('GET /json/version/');
  });

  it('refuses to open a browser for a session without a sandbox container', async () => {
    const { manager, docker } = newManager();

    await expect(manager.launch('session-1', 'https://example.com', { containerId: ' ' })).rejects.toBeInstanceOf(
      BrowserUnavailableError,
    );
    expect(docker.exec).not.toHaveBeenCalled();
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('fails with a clear message when Chromium cannot start in the sandbox, with no fallback browser', async () => {
    const docker = makeDocker();
    docker.exec.mockResolvedValue({
      exitCode: 1,
      stdout: 'NULLAI_BROWSER_PORT=unavailable\n',
      stderr: 'chromium: cannot open shared object file',
      bytesOut: 0,
      bytesErr: 0,
    });
    const { manager } = newManager(docker);

    await expect(manager.launch('session-1', 'https://example.com', IN_SANDBOX)).rejects.toThrow(
      /^browser_unavailable: Chromium did not start in the sandbox \(.*cannot open shared object file.*\)\. The browser runs only inside this session's sandbox/u,
    );
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(manager.getSession('session-1')).toBeUndefined();
  });

  it('fails with a clear message when the sandbox browser does not answer, with no fallback browser', async () => {
    const { manager } = newManager();
    mocks.connectOverCDP.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(manager.launch('session-1', 'https://example.com', IN_SANDBOX)).rejects.toThrow(
      /^browser_unavailable: the browser in the sandbox did not answer \(connect ECONNREFUSED\)/u,
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('cleans up a session context without closing the sandbox browser', async () => {
    const { manager } = newManager();
    const { browser } = makeBrowser();
    const context = makeContext();
    browser.newContext.mockResolvedValue(context);
    mocks.connectOverCDP.mockResolvedValue(browser);

    await manager.launch('session-1', 'https://example.com', IN_SANDBOX);
    await manager.cleanup('session-1');

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    expect(manager.getSession('session-1')).toBeUndefined();
  });

  it('configures a context proxy as the sandbox sees it when launch options include proxyUrl', async () => {
    const { manager } = newManager();
    const { browser } = makeBrowser();
    browser.newContext.mockResolvedValue(makeContext());
    mocks.connectOverCDP.mockResolvedValue(browser);

    await manager.launch('session-1', 'https://example.com', {
      ...IN_SANDBOX,
      proxyUrl: 'http://127.0.0.1:8080',
    });

    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { server: 'http://127.0.0.1:8080' },
      }),
    );
  });

  it('holds every page of the session to its scope, popups included', async () => {
    const { manager } = newManager();
    const { browser } = makeBrowser();
    const context = makeContext();
    browser.newContext.mockResolvedValue(context);
    mocks.connectOverCDP.mockResolvedValue(browser);
    const authorizeRequest = vi.fn().mockResolvedValue(false);

    await manager.launch('session-1', 'https://example.com', { ...IN_SANDBOX, authorizeRequest });

    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    const handler = context.route.mock.calls[0][1] as (route: unknown) => Promise<void>;
    const route = {
      request: () => ({
        method: () => 'GET',
        url: () => 'http://outside.example/',
        resourceType: () => 'document',
        isNavigationRequest: () => true,
      }),
      continue: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    await handler(route);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('throws a recoverable error when the live page is gone', async () => {
    const { manager } = newManager();
    const { browser } = makeBrowser();
    const page = makePage();
    const context = makeContext(page);
    browser.newContext.mockResolvedValue(context);
    mocks.connectOverCDP.mockResolvedValue(browser);

    await manager.launch('session-1', 'https://example.com', IN_SANDBOX);
    page.isClosed.mockReturnValue(true);

    await expect(manager.requireLiveSession('session-1')).rejects.toThrow('browser session lost. call launch again');
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(manager.getSession('session-1')).toBeUndefined();
  });

  it('clears only that sandbox browser sessions when it disconnects', async () => {
    const { manager } = newManager();
    const first = makeBrowser();
    const second = makeBrowser();
    first.browser.newContext.mockResolvedValue(makeContext());
    second.browser.newContext.mockResolvedValue(makeContext());
    mocks.connectOverCDP.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);

    await manager.launch('session-1', 'https://example.com', { containerId: 'sandbox-1' });
    await manager.launch('session-2', 'https://example.com', { containerId: 'sandbox-2' });
    first.handlers.get('disconnected')?.();

    expect(manager.getSession('session-1')).toBeUndefined();
    await expect(manager.requireLiveSession('session-1')).rejects.toThrow('browser not launched. call launch first');
    await expect(manager.requireLiveSession('session-2')).resolves.toBeDefined();
  });

  it('records redacted browser network request/response events', async () => {
    const { manager } = newManager();
    const { browser } = makeBrowser();
    const page = makePage();
    browser.newContext.mockResolvedValue(makeContext(page));
    mocks.connectOverCDP.mockResolvedValue(browser);

    await manager.launch('session-1', 'https://example.com', IN_SANDBOX);

    const request = {
      method: vi.fn().mockReturnValue('GET'),
      url: vi.fn().mockReturnValue('https://example.com/api'),
      resourceType: vi.fn().mockReturnValue('fetch'),
      isNavigationRequest: vi.fn().mockReturnValue(false),
      headers: vi.fn().mockReturnValue({ authorization: 'Bearer secret', accept: 'application/json' }),
      redirectedTo: vi.fn().mockReturnValue(null),
      failure: vi.fn().mockReturnValue(null),
    };
    const response = {
      request: vi.fn().mockReturnValue(request),
      allHeaders: vi.fn().mockResolvedValue({ 'content-type': 'application/json', 'set-cookie': 'sid=secret' }),
      headers: vi.fn().mockReturnValue({}),
      status: vi.fn().mockReturnValue(200),
    };

    page.emitTestEvent('request', request);
    page.emitTestEvent('response', response);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getNetworkEvents('session-1')).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'https://example.com/api',
        resourceType: 'fetch',
        status: 200,
        requestHeaders: expect.objectContaining({ authorization: '[REDACTED]' }),
        responseHeaders: expect.objectContaining({ 'set-cookie': '[REDACTED]' }),
      }),
    ]);
  });
});
