import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Locator, Page } from 'playwright-core';
import {
  BrowserUnavailableError,
  browserSessionManager,
  redactHeaders,
  type BrowserConsoleEntry,
  type BrowserNetworkEntry,
  type BrowserSession,
} from '../runtime/browserSessionManager';
import {
  BROWSER_EXCHANGE_DIR,
  BROWSER_EXCHANGE_REFERENCE_PREFIX,
  type BrowserExchangeHeader,
  type BrowserExchangeRecord,
} from '../runtime/browserExchangeHistory';
import {
  classifyBrowserChallenge,
  type BrowserChallengeClassification,
} from '../runtime/browserChallengeClassifier';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import {
  isScopeRunnerBinding,
  resolveRunnerSessionBinding,
  resolveRunnerWorkspaceKey,
} from '@/domains/security-ops/runners/runnerSession';
import { remoteExecAdapter } from '@/domains/security-ops/runners/RemoteExecAdapter';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import { findCloudBlockedNetworkTargetInUrl } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { ScopeBoundaryService } from '@/domains/security-ops/scopes/ScopeBoundaryService';
import { db } from '@/db/client';

const INTERACTIVE_SELECTOR = 'input, button, a[href], select, textarea, [role="button"]';
const DEFAULT_WAIT_MS = 2_000;
const LOAD_SETTLE_TIMEOUT_MS = 5_000;
const MAX_SOURCE_CHARS = 100_000;
const MAX_JS_RESULT_CHARS = 5_000;
const MAX_BUNDLE_SOURCE_CHARS = 250_000;
const MAX_HAR_EVENTS = 1_000;
const scopeBoundaryService = new ScopeBoundaryService(db);

const BROWSER_ACTION_NAMES = [
  'launch',
  'navigate',
  'click',
  'type',
  'submit',
  'execute_js',
  'get_source',
  'get_console',
  'wait',
  'close',
  'screenshot',
  'get_network',
  'clear_network',
  'save_har',
  'replay_suggestion',
  'save_state',
  'load_state',
  'start_trace',
  'stop_trace',
  'capture_evidence_bundle',
  'capture_exchange',
] as const;

const BROWSER_ACTION_DESCRIPTION = [
  'Control a persistent headless Chromium session for rendered web testing and evidence collection.',
  '',
  'LIFECYCLE: launch then (navigate | click | type | submit | execute_js | get_source | get_console | get_network | screenshot | save_state | start_trace | stop_trace | wait)* then close.',
  '- Call `launch` with a URL first. The browser session persists across calls until you `close` it.',
  '- Every action except get_source, get_console, and close returns the current page state: URL, title, interactive elements, forms, and a text preview.',
  '- Use @N index notation (e.g., @0, @3) from the returned elements array to target interactive elements. CSS selectors are also supported.',
  '',
  'OUTPUT INTERPRETATION:',
  '- Returned page state is for navigation and triage, not final proof by itself. Capture get_source, get_console, or execute_js output when you need durable evidence.',
  '- elements[] is a working map for the next action, not a full DOM dump. Use get_source when exact rendered HTML matters.',
  '- text_preview is only a quick summary. Do not cite it as the sole proof of a vulnerability.',
  '',
  'WHEN TO USE vs other tools:',
  '- Use browser_action for: JavaScript-rendered pages (SPAs, React/Angular apps), multi-step form flows that require state, cookie/session management through a real browser, visual DOM inspection.',
  '- Use http_payload for: normal API endpoints, header/body manipulation, and curl-compatible request/response evidence. Use http_raw_send only for byte-exact malformed transport probes such as smuggling/desync, duplicate headers, CRLF/header injection, or parser differentials.',
  '- If the target responds with the same HTML regardless of path (SPA shell), that is ONE result. Switch to browser_action to test the rendered client-side routing, or pivot to API testing.',
  '',
  'EVIDENCE CAPTURE:',
  '- Use `screenshot` after meaningful browser-rendered state changes, especially for visual blockers or UI-only evidence. The image is saved as an artifact; the tool result returns metadata only.',
  '- Use `get_source` to capture the full rendered DOM after a meaningful state change (e.g., after login, after injecting a payload). This is your evidence for reflected XSS, DOM manipulation, or content injection.',
  '- Use `get_console` to capture JavaScript errors, debug output, or stack traces that reveal server-side details. Set `clear: true` after reading to avoid duplicate logs.',
  '- Use `get_network` to inspect browser-observed navigation/XHR/fetch requests. Use `replay_suggestion` to turn an interesting browser request into starting args for http_payload.',
  '- Use `save_har` only when a durable browser network artifact is needed; headers are redacted and bodies are not captured by default.',
  '- Use `capture_exchange` to issue a request through the browser context (the browser cookie jar applies) and persist it as durable source:browser http_exchange evidence — this is the required proof shape for CORS / credentialed-read findings; attach the returned http_exchange in report_finding or cite the returned evidence_ref in proof.evidenceIds.',
  '- Use `capture_evidence_bundle` when automation reaches a challenge wall or ambiguous browser-only blocker. It saves screenshot, DOM, console, network summary, and challenge classification metadata.',
  '- Use `start_trace` before a failed, ambiguous, or challenge-prone flow and `stop_trace` immediately after. Trace zips are artifacts; do not trace every normal action.',
  '- Use `execute_js` to extract specific data from the DOM (e.g., `document.cookie`, `localStorage`, hidden form fields, JWT tokens in memory).',
  '- After a browser step gives you durable cookies, tokens, or request shape, pivot back to http_payload for repeatable request-response evidence when possible.',
  '- Capture evidence AFTER meaningful state changes, not after every trivial click.',
  '',
  'AUTH FLOW TESTING:',
  '- For login form testing: launch, navigate to login, type username, type password, submit, verify post-login state.',
  '- For session testing: after an authorized login, use `save_state` for same-run browser reuse and pivot to http_payload for cleaner repeatable HTTP evidence when possible.',
  '- Use `load_state` only with authorized storage-state artifacts for the scoped target. Storage-state artifacts are sensitive and not report-safe by default.',
  '- For OAuth flows: browser_action handles the redirect chain that http_payload cannot follow through JavaScript.',
  '',
  'SELECTOR GUIDANCE:',
  '- Prefer @N index from the elements array (e.g., @0 for first input, @3 for submit button) as it is reliable across page loads.',
  '- Use CSS selectors (#id, .class, input[name="field"]) when the @N index changes between actions.',
  '- Use execute_js for complex element targeting that CSS selectors cannot express.',
  '',
  'JAVASCRIPT USAGE:',
  '- Use execute_js for extraction, inspection, or small deterministic actions. Prefer read-oriented scripts over page-wide mutation.',
  '- Good uses: reading localStorage, extracting JWTs/tokens, checking window state, counting DOM matches, reading hidden values.',
  '- Do not build brute-force loops or wide scanning logic inside execute_js. Use the browser step-by-step so evidence stays understandable.',
  '',
  'ERROR RECOVERY:',
  '- If click/type fails with "element not found": the page may not have finished loading. Call `wait` with ms=3000 then retry.',
  '- If navigate times out: the target may be slow or blocking headless browsers. Try adding a User-Agent header via execute_js.',
  '- If the session is lost: call `launch` again with the target URL. The previous session is automatically cleaned up.',
  '- If repeated routes land on the same shell, auth wall, or challenge wall, capture an evidence bundle, record the blocker, and pivot to other in-scope coverage instead of looping.',
  'Use this tool for browser-backed validation, not for blind path brute forcing. Capture evidence after meaningful state changes and pivot when repeated paths land on the same shell or auth wall.',
  'Prefer concise, deliberate interactions. Read console output or source when you need proof, not after every trivial action.',
].join('\n');

const BROWSER_ACTION_CONTRACT = registerToolContract({
  name: 'browser_action',
  description: BROWSER_ACTION_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: BROWSER_ACTION_NAMES,
      },
      url: { type: 'string', description: 'URL used by launch and navigate actions.' },
      method: { type: 'string', description: 'HTTP method for capture_exchange. Default: GET.' },
      headers: { type: 'object', description: 'Optional request headers for capture_exchange (e.g. an Origin header for CORS proof).' },
      selector: { type: 'string', description: 'CSS selector or @N index from prior page state.' },
      text: { type: 'string', description: 'Text to fill for the type action.' },
      code: { type: 'string', description: 'JavaScript source to execute for execute_js.' },
      ms: { type: 'number', description: 'Milliseconds to wait for wait action. Default: 2000.' },
      clear: { type: 'boolean', description: 'Clear buffered console logs after reading them.' },
      fullPage: { type: 'boolean', description: 'Capture a full-page screenshot when action=screenshot.' },
      maskSensitive: { type: 'boolean', description: 'Mask obvious sensitive fields in screenshots. Default: true.' },
      label: { type: 'string', description: 'Optional short artifact label.' },
      limit: { type: 'number', description: 'Maximum browser network events to return.' },
      offset: { type: 'number', description: 'Browser network pagination offset.' },
      requestId: { type: 'string', description: 'Browser network event id for replay_suggestion.' },
      statePath: { type: 'string', description: 'Workspace path to a browser storage-state artifact for load_state.' },
      includeSnapshots: { type: 'boolean', description: 'Include DOM snapshots when action=start_trace. Default: true.' },
      includeScreenshots: { type: 'boolean', description: 'Include trace screenshots when action=start_trace. Default: true.' },
    },
    required: ['action'],
  },
});

type BrowserActionArgs = {
  action?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  selector?: string;
  text?: string;
  code?: string;
  ms?: number;
  clear?: boolean;
  fullPage?: boolean;
  maskSensitive?: boolean;
  label?: string;
  limit?: number;
  offset?: number;
  requestId?: string;
  statePath?: string;
  includeSnapshots?: boolean;
  includeScreenshots?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The sandbox's own mitmproxy capture, as the sandbox sees it. The browser runs in that sandbox, so the
// address that the sandbox's own commands use is the browser's too.
const resolveBrowserProxyUrl = (session: { flags?: Record<string, unknown> } | null | undefined): string | undefined => {
  const proxy = session?.flags?.httpProxy;
  if (!isRecord(proxy) || proxy.enabled !== true || typeof proxy.url !== 'string') {
    return undefined;
  }
  const trimmed = proxy.url.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The session's sandbox container, started if it is not running yet. The browser runs only there: with no
 * sandbox there is no browser, never one in the backend process.
 */
const ensureSandboxContainer = async (
  ctx: ToolContext,
): Promise<{ containerId: string; session: SessionState }> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    throw new BrowserUnavailableError('this session has no sandbox');
  }
  try {
    await ctx.sandbox.create(session);
  } catch (error) {
    throw new BrowserUnavailableError(
      `the session's sandbox could not start (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const current = getSessionFromContext(ctx) ?? session;
  const containerId = current.containerId ?? session.containerId;
  if (!containerId) {
    throw new BrowserUnavailableError('the session has no sandbox container');
  }
  return { containerId, session: current };
};

const rejectBlockedCloudBrowserUrl = (
  url: string,
): { ok: false; data: { success: false; error: string } } | null => {
  const blockedTarget = findCloudBlockedNetworkTargetInUrl(url);
  if (!blockedTarget) {
    return null;
  }
  return {
    ok: false,
    data: {
      success: false,
      error:
        `Cloud execution cannot target private or reserved network addresses (${blockedTarget}). ` +
        'Select an attached private runner for internal CIDR assessment.',
    },
  };
};

type PageState = {
  url: string;
  title: string;
  elements: Array<{
    idx: number;
    tag: string;
    type?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    text?: string;
    href?: string;
    value?: string;
  }>;
  forms: Array<{
    action: string;
    method: string;
    fields: string[];
  }>;
  text_preview: string;
};

type BrowserDomForm = {
  action?: string;
  method?: string;
  elements?: ArrayLike<unknown> | Iterable<unknown>;
  requestSubmit?: () => void;
  submit?: () => void;
};

type BrowserDomElement = {
  tagName?: string;
  id?: string;
  textContent?: string | null;
  href?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  form?: BrowserDomForm | null;
  click?: () => void;
};

type BrowserDomDocument = {
  querySelectorAll: (selector: string) => ArrayLike<unknown>;
  forms: ArrayLike<unknown>;
  title?: string;
  body?: {
    innerText?: string | null;
  } | null;
};

type BrowserDomLocation = {
  href?: string;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const normalizeWaitMs = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.round(value), 30_000);
};

const normalizeLimit = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;

const normalizeOffset = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const slugifyLabel = (value: unknown, fallback: string): string => {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  const slug = raw
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
    .toLowerCase();
  return slug || fallback;
};

const timestampSlug = (): string =>
  new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '-').replace('Z', '');

const sha256Buffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

const sha256Text = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const parsePngDimensions = (buffer: Buffer): { width: number; height: number } => {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return { width: 0, height: 0 };
};

const buildBrowserArtifactPath = (input: {
  workspaceDir: string;
  category: string;
  label: unknown;
  fallbackLabel: string;
  extension: string;
}): { absolutePath: string; relativePath: string; workspacePath: string } => {
  const relativePath = path
    .join(
      '.artifacts',
      'browser',
      input.category,
      `${timestampSlug()}-${slugifyLabel(input.label, input.fallbackLabel)}.${input.extension}`,
    )
    .replace(/\\/gu, '/');
  const workspaceRoot = path.resolve(input.workspaceDir);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('browser artifact path resolved outside workspace');
  }
  return {
    absolutePath,
    relativePath,
    workspacePath: `/workspace/${relativePath}`,
  };
};

const writeJsonArtifact = async (input: {
  workspaceDir: string;
  category: string;
  label: unknown;
  fallbackLabel: string;
  value: unknown;
}): Promise<{
  artifact_path: string;
  relative_path: string;
  mime_type: string;
  sha256: string;
  bytes: number;
}> => {
  const artifact = buildBrowserArtifactPath({
    workspaceDir: input.workspaceDir,
    category: input.category,
    label: input.label,
    fallbackLabel: input.fallbackLabel,
    extension: 'json',
  });
  const content = `${JSON.stringify(input.value, null, 2)}\n`;
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

const normalizeWorkspaceFilePath = (workspaceDir: string, rawPath: string): string => {
  let candidate = rawPath.trim().replace(/\\/gu, '/');
  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  } else if (candidate.startsWith('workspace/')) {
    candidate = candidate.slice('workspace/'.length);
  }
  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }
  if (!candidate || candidate === '.' || candidate.split('/').some((segment) => segment === '..')) {
    throw new Error(`invalid workspace file path: ${rawPath}`);
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const absolutePath = path.resolve(workspaceRoot, candidate);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`workspace file path resolves outside workspace: ${rawPath}`);
  }
  return absolutePath;
};

const findLatestBrowserStatePath = async (workspaceDir: string): Promise<string | null> => {
  const stateDir = path.resolve(workspaceDir, '.artifacts', 'browser', 'state');
  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.resolve(stateDir, entry.name));
  if (jsonFiles.length === 0) {
    return null;
  }
  const stats = await Promise.all(
    jsonFiles.map(async (filePath) => ({
      filePath,
      mtimeMs: await fs.stat(filePath).then((stat) => stat.mtimeMs).catch(() => 0),
    })),
  );
  stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return stats[0]?.filePath ?? null;
};

const summarizeStorageState = (state: unknown): { domains: string[]; cookie_count: number; origin_count: number } => {
  if (!isRecord(state)) {
    return { domains: [], cookie_count: 0, origin_count: 0 };
  }
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const origins = Array.isArray(state.origins) ? state.origins : [];
  const domains = new Set<string>();
  for (const cookie of cookies) {
    if (isRecord(cookie) && typeof cookie.domain === 'string' && cookie.domain.length > 0) {
      domains.add(cookie.domain);
    }
  }
  for (const origin of origins) {
    if (!isRecord(origin) || typeof origin.origin !== 'string') {
      continue;
    }
    try {
      domains.add(new URL(origin.origin).hostname);
    } catch {
      domains.add(origin.origin);
    }
  }
  return {
    domains: Array.from(domains).sort().slice(0, 50),
    cookie_count: cookies.length,
    origin_count: origins.length,
  };
};

const summarizeNetworkEvent = (entry: BrowserNetworkEntry) => ({
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

const capInlineHeaders = (headers: Record<string, string> | undefined): Record<string, string> | undefined => {
  if (!headers) {
    return undefined;
  }
  const capped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers).slice(0, 20)) {
    capped[name] = value.length > 300 ? `${value.slice(0, 300).trimEnd()}...[header truncated]` : value;
  }
  return capped;
};

const settlePage = async (page: Page) => {
  await page.waitForLoadState('domcontentloaded', { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => undefined);
};

const resolveLocator = (page: Page, selector: string): Locator => {
  const trimmed = selector.trim();
  if (trimmed.startsWith('@')) {
    const index = Number.parseInt(trimmed.slice(1), 10);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('selector index must be a non-negative integer (e.g. @0, @1, @2)');
    }
    return page.locator(INTERACTIVE_SELECTOR).nth(index);
  }
  // Bare integers are not valid CSS selectors — catch the common LLM mistake of
  // passing "5" instead of "@5".
  if (/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid selector "${trimmed}". To select by element index use @${trimmed} (e.g. @0 for the first interactive element). CSS selectors and @N indexes are supported.`,
    );
  }
  return page.locator(trimmed).first();
};


const serializeJsResult = async (page: Page, source: string): Promise<string> => {
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

export const extractPageState = async (page: Page): Promise<PageState> =>
  page.evaluate<PageState>(() => {
    const browser = globalThis as typeof globalThis & {
      document?: BrowserDomDocument;
      location?: BrowserDomLocation;
    };
    const documentRef = browser.document;
    if (!documentRef) {
      return {
        url: '',
        title: '',
        elements: [],
        forms: [],
        text_preview: '',
      };
    }

    const interactable = documentRef.querySelectorAll(
      'input, button, a[href], select, textarea, [role="button"]',
    );
    const elements = Array.from(interactable)
      .slice(0, 50)
      .map((rawElement, idx) => {
      const element = rawElement as BrowserDomElement;
      return {
        idx,
        tag: (element.tagName ?? '').toLowerCase(),
        type: element.type || undefined,
        name: element.name || undefined,
        id: element.id || undefined,
        placeholder: element.placeholder || undefined,
        text: (element.textContent ?? '').trim().slice(0, 100) || undefined,
        href: element.href || undefined,
        value: element.type === 'hidden' ? element.value : undefined,
      };
      });

    const forms = Array.from(documentRef.forms)
      .slice(0, 20)
      .map((rawForm) => {
      const form = rawForm as BrowserDomForm;
      const fields = Array.from(form.elements ?? [])
        .map((field) => {
          const namedField = field as { name?: string };
          return typeof namedField.name === 'string' && namedField.name
            ? namedField.name
            : null;
        })
        .filter((name): name is string => name !== null);

      return {
        action: form.action ?? '',
        method: (form.method || 'GET').toUpperCase(),
        fields,
      };
      });

    return {
      url: browser.location?.href ?? '',
      title: documentRef.title ?? '',
      elements,
      forms,
      text_preview: (documentRef.body?.innerText ?? '').slice(0, 2000),
    };
  });

const buildSuccess = (action: string, data: Record<string, unknown>) => ({
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

const captureScreenshotArtifact = async (input: {
  page: Page;
  workspaceDir: string;
  action: string;
  label?: string;
  fullPage?: boolean;
  maskSensitive?: boolean;
}): Promise<Record<string, unknown>> => {
  const artifact = buildBrowserArtifactPath({
    workspaceDir: input.workspaceDir,
    category: 'screenshots',
    label: input.label,
    fallbackLabel: 'screenshot',
    extension: 'png',
  });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  const maskedSensitive = input.maskSensitive !== false;
  const buffer = await input.page.screenshot({
    path: artifact.absolutePath,
    fullPage: input.fullPage === true,
    ...(maskedSensitive ? { mask: [input.page.locator(SENSITIVE_FIELD_SELECTOR)] } : {}),
  });
  const dimensions = parsePngDimensions(buffer);
  return buildSuccess(input.action, {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'image/png',
    sha256: sha256Buffer(buffer),
    bytes: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    full_page: input.fullPage === true,
    masked_sensitive: maskedSensitive,
    url: input.page.url(),
    title: await input.page.title().catch(() => ''),
  });
};

const buildHarDocument = (events: BrowserNetworkEntry[]) => ({
  log: {
    version: '1.2',
    creator: {
      name: 'Null-AI browser_action',
      version: '1',
    },
    entries: events.slice(0, MAX_HAR_EVENTS).map((entry) => ({
      startedDateTime: entry.ts,
      time: 0,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(entry.requestHeaders).map(([name, value]) => ({ name, value })),
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
        status: entry.status ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
        cookies: [],
        content: {
          size: 0,
          mimeType: entry.responseHeaders?.['content-type'] ?? entry.responseHeaders?.['Content-Type'] ?? '',
        },
        redirectURL: entry.redirectTarget ?? '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    })),
  },
});

const getNetworkResult = (action: string, events: BrowserNetworkEntry[], args: BrowserActionArgs) => {
  const limit = normalizeLimit(args.limit, 25, 100);
  const offset = normalizeOffset(args.offset);
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

const replaySuggestionResult = (action: string, events: BrowserNetworkEntry[], requestId: string) => {
  const event = events.find((entry) => entry.id === requestId);
  if (!event) {
    return { success: false, action, error: `browser network event not found: ${requestId}` };
  }
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

const saveStorageStateArtifact = async (input: {
  session: BrowserSession;
  workspaceDir: string;
  action: string;
  label?: string;
}): Promise<Record<string, unknown>> => {
  const artifact = buildBrowserArtifactPath({
    workspaceDir: input.workspaceDir,
    category: 'state',
    label: input.label,
    fallbackLabel: 'storage-state',
    extension: 'json',
  });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  const state = await input.session.context.storageState({ path: artifact.absolutePath });
  const raw = await fs.readFile(artifact.absolutePath);
  const summary = summarizeStorageState(state);
  return buildSuccess(input.action, {
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

const resolveStorageStateForLoad = async (workspaceDir: string, statePath: unknown): Promise<string> => {
  if (typeof statePath === 'string' && statePath.trim().length > 0) {
    return normalizeWorkspaceFilePath(workspaceDir, statePath);
  }
  const latest = await findLatestBrowserStatePath(workspaceDir);
  if (!latest) {
    throw new Error('load_state requires statePath or an existing .artifacts/browser/state/*.json artifact');
  }
  return latest;
};

const saveHarArtifact = async (input: {
  workspaceDir: string;
  action: string;
  label?: string;
  events: BrowserNetworkEntry[];
}): Promise<Record<string, unknown>> => {
  const truncated = input.events.length > MAX_HAR_EVENTS;
  const artifact = await writeJsonArtifact({
    workspaceDir: input.workspaceDir,
    category: 'network',
    label: input.label,
    fallbackLabel: 'browser.har',
    value: buildHarDocument(input.events),
  });
  return buildSuccess(input.action, {
    ...artifact,
    mime_type: 'application/json',
    har_version: '1.2',
    entries: Math.min(input.events.length, MAX_HAR_EVENTS),
    entries_truncated: truncated,
    sensitive_values_redacted: true,
  });
};

const startTrace = async (input: {
  session: BrowserSession;
  action: string;
  label?: string;
  includeSnapshots?: boolean;
  includeScreenshots?: boolean;
}): Promise<Record<string, unknown>> => {
  if (input.session.traceActive) {
    return {
      success: false,
      action: input.action,
      error: 'browser trace is already active; call stop_trace before starting a new trace',
    };
  }
  const startedAt = new Date().toISOString();
  await input.session.context.tracing.start({
    screenshots: input.includeScreenshots !== false,
    snapshots: input.includeSnapshots !== false,
    sources: false,
  });
  input.session.traceActive = true;
  input.session.traceStartedAt = startedAt;
  input.session.traceLabel = slugifyLabel(input.label, 'trace');
  return buildSuccess(input.action, {
    trace_active: true,
    started_at: startedAt,
    label: input.session.traceLabel,
    screenshots: input.includeScreenshots !== false,
    snapshots: input.includeSnapshots !== false,
    note: 'Call stop_trace after the failed, ambiguous, or challenge-blocked flow to write the trace artifact.',
  });
};

const stopTraceArtifact = async (input: {
  session: BrowserSession;
  workspaceDir: string;
  action: string;
  label?: string;
}): Promise<Record<string, unknown>> => {
  if (!input.session.traceActive) {
    return {
      success: false,
      action: input.action,
      error: 'browser trace is not active; call start_trace before stop_trace',
    };
  }
  const artifact = buildBrowserArtifactPath({
    workspaceDir: input.workspaceDir,
    category: 'traces',
    label: input.label ?? input.session.traceLabel,
    fallbackLabel: 'trace',
    extension: 'zip',
  });
  await fs.mkdir(path.dirname(artifact.absolutePath), { recursive: true });
  await input.session.context.tracing.stop({ path: artifact.absolutePath });
  input.session.traceActive = false;
  const raw = await fs.readFile(artifact.absolutePath);
  return buildSuccess(input.action, {
    artifact_path: artifact.workspacePath,
    relative_path: artifact.relativePath,
    mime_type: 'application/zip',
    sha256: sha256Buffer(raw),
    bytes: raw.length,
    started_at: input.session.traceStartedAt,
    stopped_at: new Date().toISOString(),
    report_safe: true,
    note: 'Trace artifact is intended for reviewer drill-down on failed, ambiguous, or challenge-blocked browser flows.',
  });
};

const classifyCurrentPage = async (input: {
  page: Page;
  pageState: PageState;
  consoleLogs: BrowserConsoleEntry[];
  networkEvents: BrowserNetworkEntry[];
  source?: string;
}): Promise<BrowserChallengeClassification | null> =>
  classifyBrowserChallenge({
    url: input.page.url(),
    title: input.pageState.title,
    text: input.pageState.text_preview,
    source: input.source,
    console: input.consoleLogs,
    network: input.networkEvents,
  });

const captureEvidenceBundle = async (input: {
  session: BrowserSession;
  workspaceDir: string;
  action: string;
  label?: string;
  fullPage?: boolean;
  maskSensitive?: boolean;
}): Promise<Record<string, unknown>> => {
  const pageState = await extractPageState(input.session.page);
  const source = await input.session.page.content();
  const sourceTruncated = source.length > MAX_BUNDLE_SOURCE_CHARS;
  const sourceArtifact = await writeJsonArtifact({
    workspaceDir: input.workspaceDir,
    category: 'bundles',
    label: input.label ? `${input.label}-rendered-dom` : undefined,
    fallbackLabel: 'rendered-dom',
    value: {
      url: input.session.page.url(),
      title: pageState.title,
      source: sourceTruncated ? source.slice(0, MAX_BUNDLE_SOURCE_CHARS) : source,
      source_truncated: sourceTruncated,
      source_original_chars: source.length,
    },
  });
  const consoleArtifact = await writeJsonArtifact({
    workspaceDir: input.workspaceDir,
    category: 'bundles',
    label: input.label ? `${input.label}-console` : undefined,
    fallbackLabel: 'console',
    value: {
      url: input.session.page.url(),
      console: input.session.consoleLogs,
    },
  });
  const sessionNetworkEvents = input.session.networkEvents.map((entry) => ({ ...entry }));
  const networkArtifact = await writeJsonArtifact({
    workspaceDir: input.workspaceDir,
    category: 'bundles',
    label: input.label ? `${input.label}-network-summary` : undefined,
    fallbackLabel: 'network-summary',
    value: {
      url: input.session.page.url(),
      total_count: sessionNetworkEvents.length,
      events: sessionNetworkEvents,
    },
  });
  const screenshot = await captureScreenshotArtifact({
    page: input.session.page,
    workspaceDir: input.workspaceDir,
    action: 'screenshot',
    label: input.label,
    fullPage: input.fullPage,
    maskSensitive: input.maskSensitive,
  });
  const screenshotPath = typeof screenshot.artifact_path === 'string' ? screenshot.artifact_path : undefined;
  const classification = await classifyCurrentPage({
    page: input.session.page,
    pageState,
    consoleLogs: input.session.consoleLogs,
    networkEvents: sessionNetworkEvents,
    source,
  });
  const bundle = await writeJsonArtifact({
    workspaceDir: input.workspaceDir,
    category: 'bundles',
    label: input.label ? `${input.label}-evidence-bundle` : undefined,
    fallbackLabel: 'evidence-bundle',
    value: {
      url: input.session.page.url(),
      title: pageState.title,
      page_state: pageState,
      artifacts: {
        screenshot: screenshotPath,
        rendered_dom: sourceArtifact.artifact_path,
        console: consoleArtifact.artifact_path,
        network_summary: networkArtifact.artifact_path,
      },
      challenge: classification,
      created_at: new Date().toISOString(),
    },
  });
  return buildSuccess(input.action, {
    bundle,
    artifacts: {
      screenshot,
      rendered_dom: sourceArtifact,
      console: consoleArtifact,
      network_summary: networkArtifact,
    },
    page_state: pageState,
    challenge: classification,
  });
};

const MAX_EXCHANGE_BODY_CHARS = 8 * 1024;
const EXCHANGE_FETCH_TIMEOUT_MS = 30_000;
const TEXTUAL_EXCHANGE_CONTENT_TYPE = /(?:json|text|xml|html|javascript|urlencoded)/iu;

const toExchangeHeaderList = (headers: Record<string, string>): BrowserExchangeHeader[] =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

/**
 * The exchange as Chromium itself sends it: a top-level load in a fresh tab of the session's context, so the
 * browser cookie jar (ambient authority) applies and the request leaves from the sandbox like every other page.
 * Playwright's context.request is not used: it is an HTTP client in the backend process, outside the sandbox.
 * The tab loads nothing but the exchange itself, and closes once the body is read.
 */
const fetchThroughBrowser = async (
  context: BrowserSession['context'],
  input: { url: string; method: string; headers: Record<string, string>; timeoutMs: number },
): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
  const tab = await context.newPage();
  try {
    let exchangeRequestSeen = false;
    await tab.route('**/*', async (route) => {
      const request = route.request();
      const isTopLevel = request.isNavigationRequest() && request.frame() === tab.mainFrame();
      if (isTopLevel && !exchangeRequestSeen) {
        exchangeRequestSeen = true;
        const headers = Object.fromEntries(
          Object.entries(request.headers()).filter(
            ([name]) => !Object.keys(input.headers).some((extra) => extra.toLowerCase() === name.toLowerCase()),
          ),
        );
        // fallback, not continue: the session's own scope route still decides whether it may leave.
        await route.fallback({ method: input.method, headers: { ...headers, ...input.headers } });
        return;
      }
      if (isTopLevel && request.redirectedFrom()) {
        await route.fallback();
        return;
      }
      await route.abort('blockedbyclient');
    });
    const response = await tab.goto(input.url, { waitUntil: 'commit', timeout: input.timeoutMs });
    if (!response) {
      throw new Error(`the browser returned no response for ${input.url}`);
    }
    return {
      status: response.status(),
      headers: response.headers(),
      body: await response.text().catch(() => ''),
    };
  } finally {
    await tab.close().catch(() => undefined);
  }
};

/**
 * capture_exchange performs the request through the live browser, so
 * the browser cookie jar (ambient authority) applies, then persists the
 * exchange as a durable source:browser http_exchange artifact. This is the
 * only tool-recorded evidence path that can satisfy the CORS validation gate.
 */
const captureExchangeArtifact = async (input: {
  session: BrowserSession;
  workspaceDir: string;
  action: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  label?: string;
}): Promise<Record<string, unknown>> => {
  const method = (typeof input.method === 'string' && input.method.trim() ? input.method : 'GET')
    .trim()
    .toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*$/u.test(method)) {
    return { success: false, action: input.action, error: `invalid HTTP method: ${input.method}` };
  }
  const extraHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (typeof value === 'string' && name.trim().length > 0) {
      extraHeaders[name.trim()] = value;
    }
  }

  const startedAt = Date.now();
  const response = await fetchThroughBrowser(input.session.context, {
    url: input.url,
    method,
    headers: extraHeaders,
    timeoutMs: EXCHANGE_FETCH_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;

  // The browser attaches the jar's cookies itself and does not echo the final
  // request headers back. Record the ambient Cookie header from the jar so the
  // evidence shows the ambient authority that was in play.
  const jarCookies = await input.session.context.cookies(input.url).catch(() => []);
  const recordedRequestHeaders = redactHeaders({
    ...(jarCookies.length > 0
      ? { Cookie: jarCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') }
      : {}),
    ...extraHeaders,
  });
  const rawResponseHeaders = response.headers;
  const contentType = rawResponseHeaders['content-type'];
  const bodyText = contentType && TEXTUAL_EXCHANGE_CONTENT_TYPE.test(contentType)
    ? response.body
    : '';
  const bodyTruncated = bodyText.length > MAX_EXCHANGE_BODY_CHARS;

  const id = `bx-${timestampSlug()}-${slugifyLabel(input.label, 'exchange')}`;
  const record: BrowserExchangeRecord = {
    id,
    capturedAt: new Date(startedAt).toISOString(),
    kind: 'http_exchange',
    source: 'browser',
    ...(typeof input.label === 'string' && input.label.trim()
      ? { label: slugifyLabel(input.label, 'exchange') }
      : {}),
    durationMs,
    request: {
      method,
      url: input.url,
      ...(Object.keys(recordedRequestHeaders).length > 0
        ? { headers: toExchangeHeaderList(recordedRequestHeaders) }
        : {}),
    },
    response: {
      statusCode: response.status,
      ...(contentType ? { contentType } : {}),
      ...(Object.keys(rawResponseHeaders).length > 0
        ? { headers: toExchangeHeaderList(redactHeaders(rawResponseHeaders)) }
        : {}),
      ...(bodyText
        ? { body: bodyTruncated ? bodyText.slice(0, MAX_EXCHANGE_BODY_CHARS) : bodyText }
        : {}),
    },
  };

  const relativePath = `${BROWSER_EXCHANGE_DIR}/${id}.json`;
  const absolutePath = normalizeWorkspaceFilePath(input.workspaceDir, relativePath);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');

  return buildSuccess(input.action, {
    evidence_ref: `${BROWSER_EXCHANGE_REFERENCE_PREFIX}${id}`,
    artifact_path: `/workspace/${relativePath}`,
    relative_path: relativePath,
    mime_type: 'application/json',
    sha256: sha256Text(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    status: response.status,
    duration_ms: durationMs,
    body_truncated: bodyTruncated,
    sensitive_values_redacted: true,
    http_exchange: record,
    note:
      'Durable browser-sourced http_exchange evidence captured through the browser context (cookie jar applied). ' +
      'Attach http_exchange to report_finding evidence, or cite evidence_ref in proof.evidenceIds for submit_validation_outcome / submit_finding_disposition_outcome.',
  });
};

export const BrowserAction: ToolImpl = {
  meta: {
    name: 'browser_action',
    description: BROWSER_ACTION_CONTRACT.description,
    category: 'web',
    progressKind: 'evidence',
    schema: BROWSER_ACTION_CONTRACT.schema,
    risks: ['network', 'read'],
  },

  async run(args: BrowserActionArgs, ctx) {
    const action = typeof args.action === 'string' ? args.action.trim() : '';

    return runWithGuards(
      BrowserAction.meta,
      ctx,
      async () => {
        if (!action) {
          return { ok: false, data: { success: false, error: 'action is required' } };
        }

        try {
          const currentBoundary = ctx.scopeId
            ? await scopeBoundaryService.getBoundaryByScopeId(ctx.scopeId)
            : null;
          const remoteScopeBoundary = currentBoundary
            ? {
                rulesDigest: currentBoundary.rulesDigest,
                roots: currentBoundary.roots,
                exclusions: currentBoundary.exclusions,
              }
            : undefined;
          const authorizeRequest = ctx.scopeId
            ? async (request: { url: string }) => {
                try {
                  await scopeBoundaryService.assertTarget(ctx.scopeId!, request.url);
                  return true;
                } catch {
                  return false;
                }
              }
            : undefined;
          if (ctx.scopeId && typeof args.url === 'string' && args.url.trim()) {
            try {
              await scopeBoundaryService.assertTarget(ctx.scopeId, args.url.trim());
            } catch (error) {
              return {
                ok: false,
                data: {
                  success: false,
                  action,
                  error: error instanceof Error ? error.message : 'Target is outside the verified pentest scope',
                },
              };
            }
          }
          const boundSession = getSessionFromContext(ctx);
          const runnerBinding = boundSession ? resolveRunnerSessionBinding(boundSession) : null;
          if (runnerBinding && isScopeRunnerBinding(runnerBinding) && runnerBinding.runnerId) {
            try {
              const data = await remoteExecAdapter.browserAction({
                runnerId: runnerBinding.runnerId,
                sessionId: ctx.sessionId,
                workspaceKey: boundSession ? resolveRunnerWorkspaceKey(boundSession) : undefined,
                action,
                payload: args as Record<string, unknown>,
                ...(remoteScopeBoundary ? { scopeBoundary: remoteScopeBoundary } : {}),
              });
              return {
                ok: data.success !== false,
                data,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : 'runner browser action failed';
              return {
                ok: false,
                data: {
                  success: false,
                  action,
                  error: message.includes('unsupported action')
                    ? `browser capability unavailable on this runner for action "${action}": ${message}`
                    : message,
                },
              };
            }
          }

          switch (action) {
            case 'launch': {
              const url = requireString(args.url, 'url');
              if (runnerBinding?.executionTarget === 'cloud') {
                const blocked = rejectBlockedCloudBrowserUrl(url);
                if (blocked) return blocked;
              }
              const sandbox = await ensureSandboxContainer(ctx);
              const proxyUrl = resolveBrowserProxyUrl(sandbox.session);
              try {
                const session = await browserSessionManager.launch(ctx.sessionId, url, {
                  containerId: sandbox.containerId,
                  proxyUrl,
                  ...(authorizeRequest ? { authorizeRequest } : {}),
                });
                return { ok: true, data: buildSuccess(action, await extractPageState(session.page)) };
              } catch (error) {
                if (!proxyUrl || error instanceof BrowserUnavailableError) {
                  throw error;
                }
                // The sandbox's capture proxy failed. The page still loads from the same sandbox, uncaptured.
                const session = await browserSessionManager.launch(ctx.sessionId, url, {
                  containerId: sandbox.containerId,
                  ...(authorizeRequest ? { authorizeRequest } : {}),
                });
                return {
                  ok: true,
                  data: buildSuccess(action, {
                    ...(await extractPageState(session.page)),
                    proxyFallback: true,
                  }),
                };
              }
            }

            case 'close': {
              await browserSessionManager.cleanup(ctx.sessionId);
              return { ok: true, data: { success: true, action, closed: true } };
            }

            case 'load_state': {
              const statePath = await resolveStorageStateForLoad(ctx.workspaceDir, args.statePath);
              const rawState = await fs.readFile(statePath, 'utf8');
              const parsedState = JSON.parse(rawState) as unknown;
              const summary = summarizeStorageState(parsedState);
              if (summary.cookie_count + summary.origin_count === 0) {
                return {
                  ok: false,
                  data: {
                    success: false,
                    action,
                    error: 'storage state is empty; refusing to load an unauthenticated/invalid browser state',
                  },
                };
              }
              const existing = browserSessionManager.getSession(ctx.sessionId);
              const url = typeof args.url === 'string' && args.url.trim().length > 0
                ? args.url.trim()
                : existing?.page.url();
              if (!url) {
                return {
                  ok: false,
                  data: { success: false, action, error: 'load_state requires url when no browser session is active' },
                };
              }
              if (runnerBinding?.executionTarget === 'cloud') {
                const blocked = rejectBlockedCloudBrowserUrl(url);
                if (blocked) return blocked;
              }
              const sandbox = await ensureSandboxContainer(ctx);
              const proxyUrl = existing?.launchOptions.proxyUrl ?? resolveBrowserProxyUrl(sandbox.session);
              const session = await browserSessionManager.relaunch(ctx.sessionId, url, {
                containerId: sandbox.containerId,
                ...(proxyUrl ? { proxyUrl } : {}),
                storageStatePath: statePath,
                ...(authorizeRequest ? { authorizeRequest } : {}),
              });
              return {
                ok: true,
                data: buildSuccess(action, {
                  state_artifact_path: `/workspace/${path.relative(ctx.workspaceDir, statePath).replace(/\\/gu, '/')}`,
                  sensitive: true,
                  report_safe: false,
                  domains: summary.domains,
                  cookie_count: summary.cookie_count,
                  origin_count: summary.origin_count,
                  ...(await extractPageState(session.page)),
                }),
              };
            }
          }

          const session = await browserSessionManager.requireLiveSession(ctx.sessionId);
          const { page, consoleLogs } = session;

          switch (action) {
            case 'navigate': {
              const url = requireString(args.url, 'url');
              if (runnerBinding?.executionTarget === 'cloud') {
                const blocked = rejectBlockedCloudBrowserUrl(url);
                if (blocked) return blocked;
              }
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              return { ok: true, data: buildSuccess(action, await extractPageState(page)) };
            }

            case 'click': {
              const selector = requireString(args.selector, 'selector');
              await resolveLocator(page, selector).click({ timeout: 10_000 });
              await settlePage(page);
              return { ok: true, data: buildSuccess(action, await extractPageState(page)) };
            }

            case 'type': {
              const selector = requireString(args.selector, 'selector');
              const text = requireString(args.text, 'text');
              const locator = resolveLocator(page, selector);
              await locator.fill(text, { timeout: 10_000 });
              return { ok: true, data: buildSuccess(action, await extractPageState(page)) };
            }

            case 'submit': {
              const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
              if (selector) {
                await resolveLocator(page, selector).evaluate((rawElement) => {
                  type BrowserForm = {
                    requestSubmit?: () => void;
                    submit?: () => void;
                  };

                  type BrowserElement = {
                    form?: BrowserForm | null;
                    click?: () => void;
                    requestSubmit?: () => void;
                    submit?: () => void;
                  };

                  const element = rawElement as BrowserElement;
                  const form =
                    typeof element.requestSubmit === 'function' || typeof element.submit === 'function'
                      ? element
                      : element.form ?? null;

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
                  const browser = globalThis as typeof globalThis & {
                    document?: {
                      forms?: ArrayLike<unknown>;
                    };
                  };
                  const form = (browser.document?.forms?.[0] ?? null) as BrowserDomForm | null;
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
              return { ok: true, data: buildSuccess(action, await extractPageState(page)) };
            }

            case 'execute_js': {
              const code = requireString(args.code, 'code');
              const jsResult = await serializeJsResult(page, code);
              return {
                ok: true,
                data: buildSuccess(action, {
                  ...(await extractPageState(page)),
                  js_result: jsResult,
                }),
              };
            }

            case 'get_source': {
              const source = await page.content();
              const truncated = source.length > MAX_SOURCE_CHARS;
              return {
                ok: true,
                data: buildSuccess(action, {
                  source: truncated ? `${source.slice(0, MAX_SOURCE_CHARS)}...` : source,
                  source_truncated: truncated,
                  ...(await extractPageState(page)),
                }),
              };
            }

            case 'get_console': {
              const logs = consoleLogs.map((entry) => ({ ...entry }));
              if (args.clear === true) {
                consoleLogs.splice(0, consoleLogs.length);
              }
              return {
                ok: true,
                data: buildSuccess(action, {
                  console: logs,
                  cleared: args.clear === true,
                }),
              };
            }

            case 'wait': {
              const ms = normalizeWaitMs(args.ms);
              await page.waitForTimeout(ms);
              return { ok: true, data: buildSuccess(action, await extractPageState(page)) };
            }

            case 'screenshot': {
              return {
                ok: true,
                data: await captureScreenshotArtifact({
                  page,
                  workspaceDir: ctx.workspaceDir,
                  action,
                  label: args.label,
                  fullPage: args.fullPage,
                  maskSensitive: args.maskSensitive,
                }),
              };
            }

            case 'get_network': {
              const events = browserSessionManager.getNetworkEvents(ctx.sessionId);
              return { ok: true, data: getNetworkResult(action, events, args) };
            }

            case 'clear_network': {
              const cleared = browserSessionManager.clearNetworkEvents(ctx.sessionId);
              return { ok: true, data: buildSuccess(action, { cleared }) };
            }

            case 'save_har': {
              const events = browserSessionManager.getNetworkEvents(ctx.sessionId);
              return {
                ok: true,
                data: await saveHarArtifact({
                  workspaceDir: ctx.workspaceDir,
                  action,
                  label: args.label,
                  events,
                }),
              };
            }

            case 'replay_suggestion': {
              const requestId = requireString(args.requestId, 'requestId');
              const events = browserSessionManager.getNetworkEvents(ctx.sessionId);
              const data = replaySuggestionResult(action, events, requestId);
              return { ok: data.success !== false, data };
            }

            case 'capture_exchange': {
              const url = requireString(args.url, 'url');
              if (runnerBinding?.executionTarget === 'cloud') {
                const blocked = rejectBlockedCloudBrowserUrl(url);
                if (blocked) return blocked;
              }
              const data = await captureExchangeArtifact({
                session,
                workspaceDir: ctx.workspaceDir,
                action,
                url,
                method: args.method,
                headers: args.headers,
                label: args.label,
              });
              return { ok: data.success !== false, data };
            }

            case 'save_state': {
              return {
                ok: true,
                data: await saveStorageStateArtifact({
                  session,
                  workspaceDir: ctx.workspaceDir,
                  action,
                  label: args.label,
                }),
              };
            }

            case 'start_trace': {
              const data = await startTrace({
                session,
                action,
                label: args.label,
                includeSnapshots: args.includeSnapshots,
                includeScreenshots: args.includeScreenshots,
              });
              return { ok: data.success !== false, data };
            }

            case 'stop_trace': {
              const data = await stopTraceArtifact({
                session,
                workspaceDir: ctx.workspaceDir,
                action,
                label: args.label,
              });
              return { ok: data.success !== false, data };
            }

            case 'capture_evidence_bundle': {
              return {
                ok: true,
                data: await captureEvidenceBundle({
                  session,
                  workspaceDir: ctx.workspaceDir,
                  action,
                  label: args.label,
                  fullPage: args.fullPage,
                  maskSensitive: args.maskSensitive,
                }),
              };
            }

            default:
              return { ok: false, data: { success: false, error: `unsupported action: ${action}` } };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'browser action failed';
          return { ok: false, data: { success: false, error: message, action } };
        }
      },
      {},
      { action },
    );
  },
};

export const BrowserActionBuiltins: ToolImpl[] = [BrowserAction];

export const tools: ToolModuleDefinition[] = BrowserActionBuiltins.map(fromToolImpl);
