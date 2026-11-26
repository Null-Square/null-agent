const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const CONNECT_TIMEOUT_MS = 30_000;
const CONSOLE_BUFFER_LIMIT = 500;
const DEFAULT_WAIT_MS = 2_000;
const LOAD_SETTLE_TIMEOUT_MS = 5_000;
const MAX_SOURCE_CHARS = 100_000;
const MAX_JS_RESULT_CHARS = 5_000;
const MAX_BUNDLE_SOURCE_CHARS = 250_000;
const NETWORK_BUFFER_LIMIT = 1_000;
const MAX_HAR_EVENTS = 1_000;
const INTERACTIVE_SELECTOR = 'input, button, a[href], select, textarea, [role="button"]';
const CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
];

const sessions = new Map();
let browser = null;
let launchPromise = null;

const parseIpv4 = (value) => {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
};

const ipv4InCidr = (address, cidr) => {
  const [networkText, prefixText] = String(cidr || '').trim().split('/');
  const addressValue = parseIpv4(address);
  const networkValue = parseIpv4(networkText);
  const prefix = Number(prefixText);
  if (addressValue === null || networkValue === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
};

const domainContains = (container, candidate) =>
  candidate === container || candidate.endsWith(`.${container}`);

const normalizeScopePolicy = (input) => {
  if (!input || typeof input !== 'object' || typeof input.rulesDigest !== 'string') return null;
  const normalizeRules = (rules) => (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule && (rule.type === 'domain' || rule.type === 'cidr') && typeof rule.value === 'string')
    .map((rule) => ({ type: rule.type, value: rule.value.trim().toLowerCase() }))
    .filter((rule) => rule.value);
  const roots = normalizeRules(input.roots);
  if (roots.length === 0) return null;
  return {
    rulesDigest: input.rulesDigest,
    roots,
    exclusions: normalizeRules(input.exclusions),
  };
};

const isNetworkRequestInScope = (rawUrl, policy) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true;
  if (!policy) return false;
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
  const ip = parseIpv4(host);
  const matches = (rule) => ip === null
    ? rule.type === 'domain' && domainContains(rule.value, host)
    : rule.type === 'cidr' && ipv4InCidr(host, rule.value);
  if (policy.exclusions.some(matches)) return false;
  return policy.roots.some(matches);
};

const resolveExecutablePath = async () => {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error('Chromium executable not found');
};

const ensureBrowser = async () => {
  if (browser && browser.isConnected()) {
    return browser;
  }
  if (launchPromise) {
    return launchPromise;
  }

  launchPromise = resolveExecutablePath()
    .then((executablePath) =>
      chromium.launch({
        executablePath,
        headless: true,
        args: CHROMIUM_ARGS,
      }),
    )
    .then((launched) => {
      browser = launched;
      launched.on('disconnected', () => {
        browser = null;
        sessions.clear();
      });
      return launched;
    })
    .finally(() => {
      launchPromise = null;
    });

  return launchPromise;
};

const settlePage = async (page) => {
  await page.waitForLoadState('domcontentloaded', { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => undefined);
};

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const normalizeWaitMs = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.round(value), 30_000);
};

const resolveLocator = (page, selector) => {
  const trimmed = selector.trim();
  if (trimmed.startsWith('@')) {
    const index = Number.parseInt(trimmed.slice(1), 10);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('selector index must be a non-negative integer');
    }
    return page.locator(INTERACTIVE_SELECTOR).nth(index);
  }
  if (/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid selector "${trimmed}". Use @${trimmed} for an indexed interactive element.`);
  }
  return page.locator(trimmed).first();
};

const extractPageState = async (page) =>
  page.evaluate(() => {
    const interactable = document.querySelectorAll(
      'input, button, a[href], select, textarea, [role="button"]',
    );
    const elements = Array.from(interactable)
      .slice(0, 50)
      .map((element, idx) => ({
        idx,
        tag: (element.tagName || '').toLowerCase(),
        type: element.type || undefined,
        name: element.name || undefined,
        id: element.id || undefined,
        placeholder: element.placeholder || undefined,
        text: (element.textContent || '').trim().slice(0, 100) || undefined,
        href: element.href || undefined,
        value: element.type === 'hidden' ? element.value : undefined,
      }));

    const forms = Array.from(document.forms)
      .slice(0, 20)
      .map((form) => ({
        action: form.action || '',
        method: (form.method || 'GET').toUpperCase(),
        fields: Array.from(form.elements)
          .map((field) => (typeof field.name === 'string' && field.name ? field.name : null))
          .filter(Boolean),
      }));

    return {
      url: window.location.href || '',
      title: document.title || '',
      elements,
      forms,
      text_preview: (document.body?.innerText || '').slice(0, 2000),
    };
  });

const serializeJsResult = async (page, source) => {
  const result = await page.evaluate(async (code) => {
    try {
      const value = await (0, eval)(code);
      const json = JSON.stringify(value);
      if (typeof json === 'string') {
        return json;
      }
      return String(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: message });
    }
  }, source);

  return result.length > MAX_JS_RESULT_CHARS ? `${result.slice(0, MAX_JS_RESULT_CHARS)}...` : result;
};

const getConsoleLocation = (location) => {
  if (!location || !location.url) {
    return undefined;
  }
  const line = typeof location.lineNumber === 'number' ? location.lineNumber + 1 : undefined;
  const column = typeof location.columnNumber === 'number' ? location.columnNumber + 1 : undefined;
  if (!line) {
    return location.url;
  }
  return `${location.url}:${line}${column ? `:${column}` : ''}`;
};

const shouldRedactHeader = (name) =>
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/iu.test(name) ||
  /\b(?:token|secret|password|passcode|session|credential|jwt|apikey|api-key)\b/iu.test(name);

const redactHeaders = (headers = {}) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, shouldRedactHeader(name) ? '[REDACTED]' : String(value)]));

const pushNetworkEvent = (session, event) => {
  session.networkEvents.push(event);
  if (session.networkEvents.length > NETWORK_BUFFER_LIMIT) {
    session.networkEvents.splice(0, session.networkEvents.length - NETWORK_BUFFER_LIMIT);
  }
};

const updateNetworkEvent = (session, request, update) => {
  const id = session.requestIds.get(request);
  if (!id) return;
  const entry = session.networkEvents.find((candidate) => candidate.id === id);
  if (!entry) return;
  Object.assign(entry, update);
};

const slugifyLabel = (value, fallback) => {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const slug = raw.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80).toLowerCase();
  return slug || fallback;
};

const timestampSlug = () => new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '-').replace('Z', '');
const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sha256Text = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const parsePngDimensions = (buffer) => {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
};

const requireWorkspaceDir = (options) => {
  if (!options || typeof options.workspaceDir !== 'string' || !options.workspaceDir) {
    throw new Error('browser artifact action requires workspaceDir');
  }
  return options.workspaceDir;
};

const buildBrowserArtifactPath = ({ workspaceDir, category, label, fallbackLabel, extension }) => {
  const relativePath = path.join(
    '.artifacts',
    'browser',
    category,
    `${timestampSlug()}-${slugifyLabel(label, fallbackLabel)}.${extension}`,
  ).replace(/\\/gu, '/');
  const root = path.resolve(workspaceDir);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('browser artifact path resolved outside workspace');
  }
  return { absolutePath, relativePath, workspacePath: `/workspace/${relativePath}` };
};

const writeJsonArtifact = async ({ workspaceDir, category, label, fallbackLabel, value }) => {
  const artifact = buildBrowserArtifactPath({ workspaceDir, category, label, fallbackLabel, extension: 'json' });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  await fs.writeFile(artifact.absolutePath, content, 'utf8');
  return {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'application/json',
    sha256: sha256Text(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
};

const normalizeWorkspaceFilePath = (workspaceDir, rawPath) => {
  let candidate = String(rawPath || '').trim().replace(/\\/gu, '/');
  if (candidate.startsWith('/workspace/')) candidate = candidate.slice('/workspace/'.length);
  else if (candidate.startsWith('workspace/')) candidate = candidate.slice('workspace/'.length);
  if (candidate.startsWith('./')) candidate = candidate.slice(2);
  while (candidate.startsWith('/')) candidate = candidate.slice(1);
  if (!candidate || candidate === '.' || candidate.split('/').some((segment) => segment === '..')) {
    throw new Error(`invalid workspace file path: ${rawPath}`);
  }
  const root = path.resolve(workspaceDir);
  const absolutePath = path.resolve(root, candidate);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`workspace file path resolves outside workspace: ${rawPath}`);
  }
  return absolutePath;
};

const findLatestBrowserStatePath = async (workspaceDir) => {
  const stateDir = path.resolve(workspaceDir, '.artifacts', 'browser', 'state');
  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => path.resolve(stateDir, entry.name));
  if (files.length === 0) return null;
  const stats = await Promise.all(files.map(async (filePath) => ({ filePath, mtimeMs: await fs.stat(filePath).then((stat) => stat.mtimeMs).catch(() => 0) })));
  stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return stats[0]?.filePath || null;
};

const summarizeStorageState = (state) => {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  const domains = new Set();
  for (const cookie of cookies) {
    if (cookie && typeof cookie.domain === 'string' && cookie.domain) domains.add(cookie.domain);
  }
  for (const origin of origins) {
    if (!origin || typeof origin.origin !== 'string') continue;
    try {
      domains.add(new URL(origin.origin).hostname);
    } catch {
      domains.add(origin.origin);
    }
  }
  return { domains: Array.from(domains).sort().slice(0, 50), cookie_count: cookies.length, origin_count: origins.length };
};

const capInlineHeaders = (headers) => {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).slice(0, 20).map(([name, value]) => [
      name,
      String(value).length > 300 ? `${String(value).slice(0, 300).trimEnd()}...[header truncated]` : String(value),
    ]),
  );
};

const summarizeNetworkEvent = (entry) => ({
  id: entry.id,
  ts: entry.ts,
  method: entry.method,
  url: entry.url,
  resource_type: entry.resourceType,
  initiator_type: entry.initiatorType,
  status: entry.status ?? null,
  redirect_target: entry.redirectTarget,
  failure_text: entry.failureText,
});

const buildHarDocument = (events) => ({
  log: {
    version: '1.2',
    creator: { name: 'Null-AI browser_action', version: '1' },
    entries: events.slice(0, MAX_HAR_EVENTS).map((entry) => ({
      startedDateTime: entry.ts,
      time: 0,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(entry.requestHeaders || {}).map(([name, value]) => ({ name, value })),
        queryString: (() => {
          try {
            return Array.from(new URL(entry.url).searchParams.entries()).map(([name, value]) => ({ name, value }));
          } catch {
            return [];
          }
        })(),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: entry.status || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(entry.responseHeaders || {}).map(([name, value]) => ({ name, value })),
        cookies: [],
        content: { size: 0, mimeType: entry.responseHeaders?.['content-type'] || entry.responseHeaders?.['Content-Type'] || '' },
        redirectURL: entry.redirectTarget || '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    })),
  },
});

const classifyBrowserChallenge = ({ url = '', title = '', text = '', source = '', consoleLogs = [], network = [] }) => {
  const combined = [url, title, text, source, consoleLogs.map((entry) => entry.text).join('\n')].join('\n').toLowerCase();
  const failed = network.find((entry) => entry.failureText || entry.status === 0);
  if (failed) {
    return {
      kind: 'network_block',
      confidence: 'medium',
      blocking_stage: 'network',
      evidence_summary: `network_block: ${failed.method} ${failed.url} failed: ${failed.failureText || 'network failure'}`,
      recommended_authorized_path: 'Confirm target availability and route this assessment through an authorized private runner if needed.',
      retryable: false,
    };
  }
  const blockedPost = network.find((entry) => String(entry.method).toUpperCase() === 'POST' && [401, 403, 429].includes(entry.status || 0));
  if (blockedPost) {
    return {
      kind: 'auth_post_blocked',
      confidence: 'medium',
      blocking_stage: 'form_submit',
      evidence_summary: `auth_post_blocked: ${blockedPost.method} ${blockedPost.url} returned ${blockedPost.status}`,
      recommended_authorized_path: 'Use customer-approved credentials/session state or a private runner from an allowlisted network before retrying authenticated POST flows.',
      retryable: false,
    };
  }
  const checks = [
    ['cloudflare_challenge', 'high', [/cloudflare/u, /cf-chl/u, /checking your browser/u, /verify you are human/u, /\/cdn-cgi\/challenge-platform\//u]],
    ['radware_challenge', 'high', [/radware/u, /perimeterx/u, /bot manager/u]],
    ['akamai_challenge', 'high', [/akamai/u, /abck/u, /bm_sz/u, /ak_bmsc/u]],
    ['turnstile_or_captcha', 'high', [/turnstile/u, /captcha/u, /recaptcha/u, /hcaptcha/u, /data-sitekey/u]],
    ['waf_block', 'medium', [/waf/u, /web application firewall/u, /access denied/u, /request blocked/u]],
    ['login_wall', 'medium', [/sign in/u, /log in/u, /authentication required/u, /please authenticate/u]],
    ['generic_bot_management', 'medium', [/bot detection/u, /automated traffic/u, /unusual traffic/u, /security check/u]],
  ];
  for (const [kind, confidence, patterns] of checks) {
    if (!patterns.some((pattern) => pattern.test(combined))) continue;
    return {
      kind,
      confidence,
      blocking_stage: kind === 'login_wall' ? 'authentication' : 'render',
      evidence_summary: `${kind}: challenge indicators detected in rendered browser state`,
      recommended_authorized_path: 'Use an authorized path such as test-account cookies, browser storage state, IP allowlisting, or a private runner; do not attempt generic challenge evasion.',
      retryable: kind === 'login_wall',
    };
  }
  const protectedStatus = network.find((entry) => [401, 403, 429, 503].includes(entry.status || 0));
  if (!protectedStatus) return null;
  return {
    kind: protectedStatus.status === 401 ? 'login_wall' : 'unknown_challenge',
    confidence: 'low',
    blocking_stage: 'render',
    evidence_summary: `unknown_challenge: ${protectedStatus.method} ${protectedStatus.url} returned ${protectedStatus.status}`,
    recommended_authorized_path: 'Use an authorized path such as test-account cookies, browser storage state, IP allowlisting, or a private runner.',
    retryable: false,
  };
};

const createSession = async (sessionId, url, options = {}) => {
  const sharedBrowser = await ensureBrowser();
  const contextOptions = {
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (options.storageStatePath) contextOptions.storageState = options.storageStatePath;
  const context = await sharedBrowser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleLogs = [];
  const session = {
    context,
    page,
    consoleLogs,
    networkEvents: [],
    requestIds: new Map(),
    requestIdCounter: 0,
    launchOptions: { ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}) },
    traceActive: false,
    traceStartedAt: undefined,
    traceLabel: undefined,
    scopePolicy: normalizeScopePolicy(options.scopePolicy),
  };

  if (options.scopePolicy && !session.scopePolicy) {
    await context.close().catch(() => undefined);
    throw new Error('browser scope policy is invalid or has no verified roots');
  }
  if (session.scopePolicy) {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (isNetworkRequestInScope(request.url(), session.scopePolicy)) {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });
  }

  page.on('console', (message) => {
    consoleLogs.push({
      type: message.type(),
      text: message.text(),
      location: getConsoleLocation(message.location()),
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
    updateNetworkEvent(session, request, { failureText: request.failure()?.errorText || 'request failed' });
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }

  return session;
};

const launchSession = async (sessionId, url, options = {}) => {
  if (sessions.has(sessionId)) {
    throw new Error('browser already launched for this session');
  }
  const session = await createSession(sessionId, url, options);
  sessions.set(sessionId, session);
  return session;
};

const relaunchSession = async (sessionId, url, options = {}) => {
  await cleanupSession(sessionId);
  const session = await createSession(sessionId, url, options);
  sessions.set(sessionId, session);
  return session;
};

const cleanupSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  sessions.delete(sessionId);
  if (session.traceActive) {
    await session.context.tracing.stop().catch(() => undefined);
    session.traceActive = false;
  }
  await session.context.close().catch(() => undefined);
};

const requireSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('browser not launched. call launch first');
  }
  if (!browser || !browser.isConnected() || session.page.isClosed()) {
    await cleanupSession(sessionId);
    throw new Error('browser session lost. call launch again');
  }
  return session;
};

const buildSuccess = (action, data) => ({
  success: true,
  action,
  ...data,
});

const SENSITIVE_FIELD_SELECTOR = [
  'input[type="password"]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[autocomplete*="token" i]',
  'input[name*="secret" i]',
  'input[id*="secret" i]',
  'input[autocomplete*="secret" i]',
  'input[name*="password" i]',
  'input[id*="password" i]',
  'input[autocomplete*="password" i]',
  'input[name*="passcode" i]',
  'input[id*="passcode" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="mfa" i]',
  'input[id*="mfa" i]',
  'input[name*="authorization" i]',
  'input[id*="authorization" i]',
  'input[name*="cookie" i]',
  'input[id*="cookie" i]',
  'input[name*="session" i]',
  'input[id*="session" i]',
  'textarea[name*="token" i]',
  'textarea[id*="token" i]',
  'textarea[name*="secret" i]',
  'textarea[id*="secret" i]',
].join(',');

const captureScreenshotArtifact = async ({ page, workspaceDir, action, label, fullPage, maskSensitive }) => {
  const artifact = buildBrowserArtifactPath({ workspaceDir, category: 'screenshots', label, fallbackLabel: 'screenshot', extension: 'png' });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  const maskedSensitive = maskSensitive !== false;
  const buffer = await page.screenshot({
    path: artifact.absolutePath,
    fullPage: fullPage === true,
    ...(maskedSensitive ? { mask: [page.locator(SENSITIVE_FIELD_SELECTOR)] } : {}),
  });
  const dimensions = parsePngDimensions(buffer);
  return buildSuccess(action, {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'image/png',
    sha256: sha256Buffer(buffer),
    bytes: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    full_page: fullPage === true,
    masked_sensitive: maskedSensitive,
    url: page.url(),
    title: await page.title().catch(() => ''),
  });
};

const normalizeLimit = (value, fallback, max) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;

const normalizeOffset = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const getNetworkResult = (action, events, payload) => {
  const limit = normalizeLimit(payload.limit, 25, 100);
  const offset = normalizeOffset(payload.offset);
  const page = events.slice(offset, offset + limit);
  return buildSuccess(action, {
    events: page.map((entry) => ({
      ...summarizeNetworkEvent(entry),
      request_headers: capInlineHeaders(entry.requestHeaders),
      response_headers: capInlineHeaders(entry.responseHeaders),
    })),
    total_count: events.length,
    limit,
    offset,
    has_more: offset + limit < events.length,
  });
};

const replaySuggestionResult = (action, events, requestId) => {
  const event = events.find((entry) => entry.id === requestId);
  if (!event) return { success: false, action, error: `browser network event not found: ${requestId}` };
  return buildSuccess(action, {
    request_id: requestId,
    http_payload_args: {
      url: event.url,
      method: event.method,
      headers: capInlineHeaders(event.requestHeaders),
      technique: 'browser-observed-request',
    },
    omitted: ['request_body'],
    note: 'Browser request bodies are not captured by default. Use this as a replay starting point and add authorized body/auth material only when in scope.',
  });
};

const saveStorageStateArtifact = async ({ session, workspaceDir, action, label }) => {
  const artifact = buildBrowserArtifactPath({ workspaceDir, category: 'state', label, fallbackLabel: 'storage-state', extension: 'json' });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  const state = await session.context.storageState({ path: artifact.absolutePath });
  const raw = await fs.readFile(artifact.absolutePath);
  const summary = summarizeStorageState(state);
  return buildSuccess(action, {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'application/json',
    sha256: sha256Buffer(raw),
    bytes: raw.length,
    sensitive: true,
    report_safe: false,
    domains: summary.domains,
    cookie_count: summary.cookie_count,
    origin_count: summary.origin_count,
    created_at: new Date().toISOString(),
  });
};

const resolveStorageStateForLoad = async (workspaceDir, statePath) => {
  if (typeof statePath === 'string' && statePath.trim()) return normalizeWorkspaceFilePath(workspaceDir, statePath);
  const latest = await findLatestBrowserStatePath(workspaceDir);
  if (!latest) throw new Error('load_state requires statePath or an existing .artifacts/browser/state/*.json artifact');
  return latest;
};

const saveHarArtifact = async ({ workspaceDir, action, label, events }) => {
  const artifact = await writeJsonArtifact({
    workspaceDir,
    category: 'network',
    label,
    fallbackLabel: 'browser.har',
    value: buildHarDocument(events),
  });
  return buildSuccess(action, {
    ...artifact,
    har_version: '1.2',
    entries: Math.min(events.length, MAX_HAR_EVENTS),
    entries_truncated: events.length > MAX_HAR_EVENTS,
    sensitive_values_redacted: true,
  });
};

const startTrace = async ({ session, action, label, includeSnapshots, includeScreenshots }) => {
  if (session.traceActive) {
    return { success: false, action, error: 'browser trace is already active; call stop_trace before starting a new trace' };
  }
  const startedAt = new Date().toISOString();
  await session.context.tracing.start({
    screenshots: includeScreenshots !== false,
    snapshots: includeSnapshots !== false,
    sources: false,
  });
  session.traceActive = true;
  session.traceStartedAt = startedAt;
  session.traceLabel = slugifyLabel(label, 'trace');
  return buildSuccess(action, {
    trace_active: true,
    started_at: startedAt,
    label: session.traceLabel,
    screenshots: includeScreenshots !== false,
    snapshots: includeSnapshots !== false,
    note: 'Call stop_trace after the failed, ambiguous, or challenge-blocked flow to write the trace artifact.',
  });
};

const stopTraceArtifact = async ({ session, workspaceDir, action, label }) => {
  if (!session.traceActive) {
    return { success: false, action, error: 'browser trace is not active; call start_trace before stop_trace' };
  }
  const artifact = buildBrowserArtifactPath({
    workspaceDir,
    category: 'traces',
    label: label || session.traceLabel,
    fallbackLabel: 'trace',
    extension: 'zip',
  });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  await session.context.tracing.stop({ path: artifact.absolutePath });
  session.traceActive = false;
  const raw = await fs.readFile(artifact.absolutePath);
  return buildSuccess(action, {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'application/zip',
    sha256: sha256Buffer(raw),
    bytes: raw.length,
    started_at: session.traceStartedAt,
    stopped_at: new Date().toISOString(),
    report_safe: true,
    note: 'Trace artifact is intended for reviewer drill-down on failed, ambiguous, or challenge-blocked browser flows.',
  });
};

const captureEvidenceBundle = async ({ session, workspaceDir, action, label, fullPage, maskSensitive }) => {
  const pageState = await extractPageState(session.page);
  const source = await session.page.content();
  const sourceTruncated = source.length > MAX_BUNDLE_SOURCE_CHARS;
  const sourceArtifact = await writeJsonArtifact({
    workspaceDir,
    category: 'bundles',
    label: label ? `${label}-rendered-dom` : undefined,
    fallbackLabel: 'rendered-dom',
    value: {
      url: session.page.url(),
      title: pageState.title,
      source: sourceTruncated ? source.slice(0, MAX_BUNDLE_SOURCE_CHARS) : source,
      source_truncated: sourceTruncated,
      source_original_chars: source.length,
    },
  });
  const consoleArtifact = await writeJsonArtifact({
    workspaceDir,
    category: 'bundles',
    label: label ? `${label}-console` : undefined,
    fallbackLabel: 'console',
    value: { url: session.page.url(), console: session.consoleLogs },
  });
  const sessionNetworkEvents = session.networkEvents.map((entry) => ({ ...entry }));
  const networkArtifact = await writeJsonArtifact({
    workspaceDir,
    category: 'bundles',
    label: label ? `${label}-network-summary` : undefined,
    fallbackLabel: 'network-summary',
    value: { url: session.page.url(), total_count: sessionNetworkEvents.length, events: sessionNetworkEvents },
  });
  const screenshot = await captureScreenshotArtifact({ page: session.page, workspaceDir, action: 'screenshot', label, fullPage, maskSensitive });
  const classification = classifyBrowserChallenge({
    url: session.page.url(),
    title: pageState.title,
    text: pageState.text_preview,
    source,
    consoleLogs: session.consoleLogs,
    network: sessionNetworkEvents,
  });
  const bundle = await writeJsonArtifact({
    workspaceDir,
    category: 'bundles',
    label: label ? `${label}-evidence-bundle` : undefined,
    fallbackLabel: 'evidence-bundle',
    value: {
      url: session.page.url(),
      title: pageState.title,
      page_state: pageState,
      artifacts: {
        screenshot: screenshot.artifact_path,
        rendered_dom: sourceArtifact.artifact_path,
        console: consoleArtifact.artifact_path,
        network_summary: networkArtifact.artifact_path,
      },
      challenge: classification,
      created_at: new Date().toISOString(),
    },
  });
  return buildSuccess(action, {
    bundle,
    artifacts: { screenshot, rendered_dom: sourceArtifact, console: consoleArtifact, network_summary: networkArtifact },
    page_state: pageState,
    challenge: classification,
  });
};

const performBrowserAction = async (sessionId, action, payload = {}, options = {}) => {
  const suppliedPolicy = normalizeScopePolicy(options.scopePolicy);
  if (options.scopePolicy && !suppliedPolicy) {
    throw new Error('browser scope policy is invalid or has no verified roots');
  }
  const existingSession = sessions.get(sessionId);
  if (existingSession && suppliedPolicy) {
    existingSession.scopePolicy = suppliedPolicy;
  }
  switch (action) {
    case 'launch': {
      const url = requireString(payload.url, 'url');
      const session = await launchSession(sessionId, url, { scopePolicy: suppliedPolicy });
      return buildSuccess(action, await extractPageState(session.page));
    }
    case 'close': {
      await cleanupSession(sessionId);
      return { success: true, action, closed: true };
    }
    case 'load_state': {
      const workspaceDir = requireWorkspaceDir(options);
      const statePath = await resolveStorageStateForLoad(workspaceDir, payload.statePath);
      const parsedState = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const summary = summarizeStorageState(parsedState);
      if (summary.cookie_count + summary.origin_count === 0) {
        return { success: false, action, error: 'storage state is empty; refusing to load an unauthenticated/invalid browser state' };
      }
      const existing = sessions.get(sessionId);
      const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : existing?.page.url();
      if (!url) return { success: false, action, error: 'load_state requires url when no browser session is active' };
      const session = await relaunchSession(sessionId, url, {
        storageStatePath: statePath,
        scopePolicy: suppliedPolicy,
      });
      return buildSuccess(action, {
        state_artifact_path: `/workspace/${path.relative(workspaceDir, statePath).replace(/\\/gu, '/')}`,
        sensitive: true,
        report_safe: false,
        domains: summary.domains,
        cookie_count: summary.cookie_count,
        origin_count: summary.origin_count,
        ...(await extractPageState(session.page)),
      });
    }
    default:
      break;
  }

  const session = await requireSession(sessionId);
  const { page, consoleLogs } = session;

  switch (action) {
    case 'navigate': {
      const url = requireString(payload.url, 'url');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONNECT_TIMEOUT_MS });
      return buildSuccess(action, await extractPageState(page));
    }
    case 'click': {
      const selector = requireString(payload.selector, 'selector');
      await resolveLocator(page, selector).click({ timeout: 10_000 });
      await settlePage(page);
      return buildSuccess(action, await extractPageState(page));
    }
    case 'type': {
      const selector = requireString(payload.selector, 'selector');
      const text = requireString(payload.text, 'text');
      await resolveLocator(page, selector).fill(text, { timeout: 10_000 });
      return buildSuccess(action, await extractPageState(page));
    }
    case 'submit': {
      const selector = typeof payload.selector === 'string' ? payload.selector.trim() : '';
      if (selector) {
        await resolveLocator(page, selector).evaluate((element) => {
          const form =
            typeof element.requestSubmit === 'function' || typeof element.submit === 'function'
              ? element
              : element.form || null;
          if (form) {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
            } else if (typeof form.submit === 'function') {
              form.submit();
            } else {
              throw new Error('submit target has no submit method');
            }
            return;
          }
          if (typeof element.click === 'function') {
            element.click();
            return;
          }
          throw new Error('submit target is not actionable');
        });
      } else {
        await page.evaluate(() => {
          const form = document.forms?.[0] || null;
          if (!form) {
            throw new Error('no form found to submit');
          }
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else if (typeof form.submit === 'function') {
            form.submit();
          } else {
            throw new Error('no form found to submit');
          }
        });
      }
      await settlePage(page);
      return buildSuccess(action, await extractPageState(page));
    }
    case 'execute_js': {
      const code = requireString(payload.code, 'code');
      const jsResult = await serializeJsResult(page, code);
      return buildSuccess(action, {
        ...(await extractPageState(page)),
        js_result: jsResult,
      });
    }
    case 'get_source': {
      const source = await page.content();
      const truncated = source.length > MAX_SOURCE_CHARS;
      return buildSuccess(action, {
        source: truncated ? `${source.slice(0, MAX_SOURCE_CHARS)}...` : source,
        source_truncated: truncated,
        ...(await extractPageState(page)),
      });
    }
    case 'get_console': {
      const logs = consoleLogs.map((entry) => ({ ...entry }));
      if (payload.clear === true) {
        consoleLogs.splice(0, consoleLogs.length);
      }
      return buildSuccess(action, {
        console: logs,
        cleared: payload.clear === true,
      });
    }
    case 'wait': {
      const ms = normalizeWaitMs(payload.ms);
      await page.waitForTimeout(ms);
      return buildSuccess(action, await extractPageState(page));
    }
    case 'screenshot': {
      return captureScreenshotArtifact({
        page,
        workspaceDir: requireWorkspaceDir(options),
        action,
        label: payload.label,
        fullPage: payload.fullPage,
        maskSensitive: payload.maskSensitive,
      });
    }
    case 'get_network': {
      return getNetworkResult(action, session.networkEvents.map((entry) => ({ ...entry })), payload);
    }
    case 'clear_network': {
      const cleared = session.networkEvents.length;
      session.networkEvents.splice(0, session.networkEvents.length);
      session.requestIds.clear();
      return buildSuccess(action, { cleared });
    }
    case 'save_har': {
      return saveHarArtifact({
        workspaceDir: requireWorkspaceDir(options),
        action,
        label: payload.label,
        events: session.networkEvents.map((entry) => ({ ...entry })),
      });
    }
    case 'replay_suggestion': {
      const requestId = requireString(payload.requestId, 'requestId');
      return replaySuggestionResult(action, session.networkEvents, requestId);
    }
    case 'save_state': {
      return saveStorageStateArtifact({
        session,
        workspaceDir: requireWorkspaceDir(options),
        action,
        label: payload.label,
      });
    }
    case 'start_trace': {
      return startTrace({
        session,
        action,
        label: payload.label,
        includeSnapshots: payload.includeSnapshots,
        includeScreenshots: payload.includeScreenshots,
      });
    }
    case 'stop_trace': {
      return stopTraceArtifact({
        session,
        workspaceDir: requireWorkspaceDir(options),
        action,
        label: payload.label,
      });
    }
    case 'capture_evidence_bundle': {
      return captureEvidenceBundle({
        session,
        workspaceDir: requireWorkspaceDir(options),
        action,
        label: payload.label,
        fullPage: payload.fullPage,
        maskSensitive: payload.maskSensitive,
      });
    }
    default:
      throw new Error(`unsupported action: ${action}`);
  }
};

const shutdownBrowserSessions = async () => {
  const sessionIds = Array.from(sessions.keys());
  for (const sessionId of sessionIds) {
    await cleanupSession(sessionId);
  }
  if (!browser) {
    return;
  }
  const closingBrowser = browser;
  browser = null;
  await closingBrowser.close().catch(() => undefined);
};

module.exports = {
  cleanupSession,
  ensureBrowser,
  isNetworkRequestInScope,
  normalizeScopePolicy,
  performBrowserAction,
  shutdownBrowserSessions,
};
