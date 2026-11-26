import * as net from 'net';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
} from 'playwright-core';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import { DockerDriver } from '@/domains/agent-brain/adapters/sandbox/DockerDriver';

/*
 * The agent's browser runs inside the session's sandbox container, never in the backend process, so every page
 * it loads leaves through the sandbox's own network: under docker compose, the sealed network whose only way out
 * is sandbox-gateway. The backend only drives it. Chromium's DevTools listens on the sandbox's own loopback, and
 * each DevTools connection travels as bytes through `docker exec -i <sandbox> socat`, so the backend never joins
 * the sandbox network. When the sandbox cannot run the browser, the browser is unavailable; nothing falls back.
 */

const CONNECT_TIMEOUT_MS = 30_000;
const SANDBOX_BROWSER_START_TIMEOUT_MS = 30_000;
const CONSOLE_BUFFER_LIMIT = 500;
const NETWORK_BUFFER_LIMIT = 1_000;

// The sandbox's root filesystem is read-only; /dev/shm is its writable tmpfs (sized for Chromium by the
// container lifecycle), so the profile, home and temporary files live there and vanish with the container.
const SANDBOX_BROWSER_DIR = '/dev/shm/nullai-browser';

const SANDBOX_CHROMIUM_ARGS = [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-popup-blocking',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--hide-scrollbars',
  // DevTools on the sandbox's loopback only; the port is Chromium's choice, read from DevToolsActivePort.
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${SANDBOX_BROWSER_DIR}/profile`,
];

// Starts Chromium in the sandbox once and prints its DevTools port; a browser already listening is reused.
const SANDBOX_BROWSER_START_SCRIPT = [
  `dir=${SANDBOX_BROWSER_DIR}`,
  'port_file="$dir/profile/DevToolsActivePort"',
  'listening() { [ -s "$port_file" ] && socat -u /dev/null "TCP:127.0.0.1:$(head -n 1 "$port_file"),connect-timeout=1" >/dev/null 2>&1; }',
  'running() { s=$(ps -o stat= -p "$(cat "$dir/chromium.pid" 2>/dev/null)" 2>/dev/null | tr -d " "); [ -n "$s" ] && [ "${s#Z}" = "$s" ]; }',
  'if listening; then echo "NULLAI_BROWSER_PORT=$(head -n 1 "$port_file")"; exit 0; fi',
  'if running; then kill -9 "$(cat "$dir/chromium.pid")" >/dev/null 2>&1; fi',
  'rm -rf "$dir" && mkdir -p "$dir/home" "$dir/profile" "$dir/tmp" || exit 1',
  `HOME="$dir/home" XDG_CONFIG_HOME="$dir/home/.config" XDG_CACHE_HOME="$dir/home/.cache" TMPDIR="$dir/tmp" nohup chromium ${SANDBOX_CHROMIUM_ARGS.join(' ')} about:blank > "$dir/chromium.log" 2>&1 &`,
  'echo $! > "$dir/chromium.pid"',
  'i=0',
  'while [ "$i" -lt 200 ]; do',
  '  if listening; then echo "NULLAI_BROWSER_PORT=$(head -n 1 "$port_file")"; exit 0; fi',
  '  running || break',
  '  i=$((i + 1)); sleep 0.1',
  'done',
  'echo NULLAI_BROWSER_PORT=unavailable',
  'tail -n 20 "$dir/chromium.log" >&2',
  'exit 1',
].join('\n');

export class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `browser_unavailable: ${reason}. The browser runs only inside this session's sandbox, ` +
        'so it is unavailable until the sandbox can run it.',
    );
    this.name = 'BrowserUnavailableError';
  }
}

export type BrowserConsoleEntry = {
  type: string;
  text: string;
  location?: string;
};

export type BrowserNetworkEntry = {
  id: string;
  ts: string;
  method: string;
  url: string;
  resourceType: string;
  initiatorType: string;
  requestHeaders: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
  redirectTarget?: string;
  failureText?: string;
};

export type BrowserSession = {
  context: BrowserContext;
  page: Page;
  consoleLogs: BrowserConsoleEntry[];
  networkEvents: BrowserNetworkEntry[];
  // WeakMap so evicted/in-flight Request objects are not pinned for the whole
  // session lifetime once Playwright and the bounded networkEvents buffer drop
  // them. The bounded buffer caps id strings; the WeakMap caps the keys.
  requestIds: WeakMap<Request, string>;
  requestIdCounter: number;
  launchOptions: BrowserLaunchOptions;
  traceActive: boolean;
  traceStartedAt?: string;
  traceLabel?: string;
};

export type BrowserLaunchOptions = {
  /** The session's sandbox container. The browser runs in it and nowhere else. */
  containerId: string;
  /** A proxy as the sandbox sees it, such as its own mitmproxy capture at http://127.0.0.1:8080. */
  proxyUrl?: string;
  storageStatePath?: string;
  authorizeRequest?: (input: {
    url: string;
    method: string;
    resourceType: string;
    isNavigationRequest: boolean;
  }) => Promise<boolean>;
};

export type SandboxBrowserDocker = Pick<DockerDriver, 'exec' | 'execStream'>;

type SandboxBrowserHost = {
  containerId: string;
  browser: Browser;
  bridge: net.Server;
};

const log = logger.child({ scope: 'BrowserSessionManager' });

const serializeConsoleLocation = (location: { url?: string; lineNumber?: number; columnNumber?: number }) => {
  if (!location.url) {
    return undefined;
  }

  const line = typeof location.lineNumber === 'number' ? location.lineNumber + 1 : undefined;
  const column = typeof location.columnNumber === 'number' ? location.columnNumber + 1 : undefined;
  if (!line) {
    return location.url;
  }
  return `${location.url}:${line}${column ? `:${column}` : ''}`;
};

export const shouldRedactHeader = (name: string): boolean =>
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/iu.test(name) ||
  /\b(?:token|secret|password|passcode|session|credential|jwt|apikey|api-key)\b/iu.test(name);

export const redactHeaders = (headers: Record<string, string>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    output[name] = shouldRedactHeader(name) ? '[REDACTED]' : value;
  }
  return output;
};

const pushNetworkEvent = (session: BrowserSession, event: BrowserNetworkEntry): void => {
  session.networkEvents.push(event);
  if (session.networkEvents.length > NETWORK_BUFFER_LIMIT) {
    session.networkEvents.splice(0, session.networkEvents.length - NETWORK_BUFFER_LIMIT);
  }
};

const updateNetworkEvent = (
  session: BrowserSession,
  request: Request,
  update: Partial<BrowserNetworkEntry>,
): void => {
  const id = session.requestIds.get(request);
  if (!id) {
    return;
  }
  const entry = session.networkEvents.find((candidate) => candidate.id === id);
  if (!entry) {
    return;
  }
  Object.assign(entry, update);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A loopback listener in the backend whose every connection is carried, byte for byte, to the DevTools port on
 * the sandbox's own loopback by `docker exec -i <sandbox> socat`.
 */
const openDevToolsBridge = async (
  docker: SandboxBrowserDocker,
  containerId: string,
  devToolsPort: number,
): Promise<net.Server> => {
  const server = net.createServer((socket) => {
    const stream = docker.execStream(containerId, ['socat', 'STDIO', `TCP:127.0.0.1:${devToolsPort}`]);
    const close = () => {
      socket.destroy();
      if (stream.exitCode === null && stream.signalCode === null) {
        stream.kill('SIGKILL');
      }
    };
    socket.on('error', close);
    socket.on('close', close);
    stream.on('error', close);
    stream.on('exit', close);
    stream.stdin.on('error', close);
    socket.pipe(stream.stdin);
    stream.stdout.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
};

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly hosts = new Map<string, SandboxBrowserHost>();
  private readonly connecting = new Map<string, Promise<SandboxBrowserHost>>();

  constructor(
    private readonly docker: SandboxBrowserDocker = new DockerDriver((message) =>
      log.trace({ message }, 'docker'),
    ),
  ) {}

  private async ensureBrowser(containerId: string): Promise<Browser> {
    const id = containerId.trim();
    if (!id) {
      throw new BrowserUnavailableError('this session has no sandbox container');
    }
    const existing = this.hosts.get(id);
    if (existing?.browser.isConnected()) {
      return existing.browser;
    }
    if (existing) {
      this.dropHost(existing);
    }
    let pending = this.connecting.get(id);
    if (!pending) {
      pending = this.connectSandboxBrowser(id).finally(() => {
        this.connecting.delete(id);
      });
      this.connecting.set(id, pending);
    }
    return (await pending).browser;
  }

  private async connectSandboxBrowser(containerId: string): Promise<SandboxBrowserHost> {
    const started = await this.docker
      .exec(containerId, {
        cmd: SANDBOX_BROWSER_START_SCRIPT,
        user: 'root',
        timeoutMs: SANDBOX_BROWSER_START_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        throw new BrowserUnavailableError(`the sandbox could not be reached (${errorMessage(error)})`);
      });
    const devToolsPort = Number(/NULLAI_BROWSER_PORT=(\d+)/u.exec(started.stdout)?.[1]);
    if (started.exitCode !== 0 || !Number.isInteger(devToolsPort) || devToolsPort <= 0) {
      const output = started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`;
      const detail = summarizeForNote(output.replace(/\s+/gu, ' '), 400);
      throw new BrowserUnavailableError(`Chromium did not start in the sandbox (${detail})`);
    }

    const bridge = await openDevToolsBridge(this.docker, containerId, devToolsPort);
    let browser: Browser;
    try {
      const { port } = bridge.address() as net.AddressInfo;
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      bridge.close();
      throw new BrowserUnavailableError(`the browser in the sandbox did not answer (${errorMessage(error)})`);
    }

    const host: SandboxBrowserHost = { containerId, browser, bridge };
    this.hosts.set(containerId, host);
    browser.on('disconnected', () => {
      this.dropHost(host);
      log.warn({ containerId }, 'Sandbox browser disconnected; cleared its browser sessions');
    });
    log.info({ containerId, version: browser.version() }, 'Browser running in the session sandbox');
    return host;
  }

  private dropHost(host: SandboxBrowserHost): void {
    if (this.hosts.get(host.containerId) === host) {
      this.hosts.delete(host.containerId);
    }
    host.bridge.close();
    for (const [sessionId, session] of this.sessions) {
      if (session.launchOptions.containerId === host.containerId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  getSession(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  private async createSession(
    sessionId: string,
    url: string,
    options: BrowserLaunchOptions,
  ): Promise<BrowserSession> {
    const browser = await this.ensureBrowser(options.containerId);
    const proxyUrl = options.proxyUrl?.trim();
    const contextOptions: BrowserContextOptions = {
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (proxyUrl) {
      contextOptions.proxy = { server: proxyUrl };
    }
    if (options.storageStatePath) {
      contextOptions.storageState = options.storageStatePath;
    }
    const context = await browser.newContext(contextOptions);

    if (options.authorizeRequest) {
      // On the context, so popups and every other page of the session are held to the same scope.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const method = request.method().toUpperCase();
        const protocol = (() => {
          try {
            return new URL(request.url()).protocol;
          } catch {
            return '';
          }
        })();
        // Browser-internal resources do not leave the process. Every network
        // destination, including passive subresources and redirect hops, must
        // still be inside the authorized namespace and outside exclusions.
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) {
          await route.continue();
          return;
        }
        const allowed = await options.authorizeRequest!({
          url: request.url(),
          method,
          resourceType: request.resourceType(),
          isNavigationRequest: request.isNavigationRequest(),
        }).catch(() => false);
        if (allowed) {
          await route.continue();
        } else {
          await route.abort('blockedbyclient');
        }
      });
    }
    const page = await context.newPage();
    const consoleLogs: BrowserConsoleEntry[] = [];
    const session: BrowserSession = {
      context,
      page,
      consoleLogs,
      networkEvents: [],
      requestIds: new WeakMap<Request, string>(),
      requestIdCounter: 0,
      launchOptions: {
        containerId: options.containerId,
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
        ...(options.authorizeRequest ? { authorizeRequest: options.authorizeRequest } : {}),
      },
      traceActive: false,
    };

    page.on('console', (message) => {
      consoleLogs.push({
        type: message.type(),
        text: message.text(),
        location: serializeConsoleLocation(message.location()),
      });
      if (consoleLogs.length > CONSOLE_BUFFER_LIMIT) {
        consoleLogs.splice(0, consoleLogs.length - CONSOLE_BUFFER_LIMIT);
      }
    });

    page.on('pageerror', (error) => {
      consoleLogs.push({
        type: 'pageerror',
        text: error.message,
      });
      if (consoleLogs.length > CONSOLE_BUFFER_LIMIT) {
        consoleLogs.splice(0, consoleLogs.length - CONSOLE_BUFFER_LIMIT);
      }
    });

    page.on('request', (request) => {
      const id = `browser-${++session.requestIdCounter}`;
      session.requestIds.set(request, id);
      pushNetworkEvent(session, {
        id,
        ts: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        initiatorType: request.isNavigationRequest() ? 'navigation' : request.resourceType(),
        requestHeaders: redactHeaders(request.headers()),
      });
    });

    page.on('response', (response) => {
      void (async () => {
        const request = response.request();
        const headers = await response.allHeaders().catch(() => response.headers());
        updateNetworkEvent(session, request, {
          status: response.status(),
          responseHeaders: redactHeaders(headers),
          ...(request.redirectedTo() ? { redirectTarget: request.redirectedTo()?.url() } : {}),
        });
      })();
    });

    page.on('requestfailed', (request) => {
      updateNetworkEvent(session, request, {
        failureText: request.failure()?.errorText ?? 'request failed',
      });
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }

    return session;
  }

  async launch(sessionId: string, url: string, options: BrowserLaunchOptions): Promise<BrowserSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error('browser already launched for this session');
    }

    const session = await this.createSession(sessionId, url, options);
    this.sessions.set(sessionId, session);
    return session;
  }

  async relaunch(sessionId: string, url: string, options: BrowserLaunchOptions): Promise<BrowserSession> {
    await this.cleanup(sessionId);
    const session = await this.createSession(sessionId, url, options);
    this.sessions.set(sessionId, session);
    return session;
  }

  async cleanup(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);
    try {
      if (session.traceActive) {
        await session.context.tracing.stop().catch(() => undefined);
        session.traceActive = false;
      }
      await session.context.close();
    } catch (error) {
      log.debug({ err: error, sessionId }, 'Failed to close browser context cleanly');
    }
  }

  /** Closes every session and disconnects from each sandbox browser; Chromium ends with its sandbox. */
  async shutdown(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.cleanup(sessionId);
    }

    const hosts = Array.from(this.hosts.values());
    for (const host of hosts) {
      this.dropHost(host);
      await host.browser.close().catch((error: unknown) => {
        log.debug({ err: error, containerId: host.containerId }, 'Failed to disconnect from a sandbox browser cleanly');
      });
    }
  }

  async requireLiveSession(sessionId: string): Promise<BrowserSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('browser not launched. call launch first');
    }

    const host = this.hosts.get(session.launchOptions.containerId);
    if (!host?.browser.isConnected() || session.page.isClosed()) {
      await this.cleanup(sessionId);
      throw new Error('browser session lost. call launch again');
    }

    return session;
  }

  getNetworkEvents(sessionId: string): BrowserNetworkEntry[] {
    return this.sessions.get(sessionId)?.networkEvents.map((entry) => ({ ...entry })) ?? [];
  }

  clearNetworkEvents(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return 0;
    }
    const count = session.networkEvents.length;
    session.networkEvents.splice(0, session.networkEvents.length);
    // WeakMap has no clear(); drop the whole map so pending request keys release.
    session.requestIds = new WeakMap<Request, string>();
    return count;
  }
}

export const browserSessionManager = new BrowserSessionManager();
