import { randomUUID } from 'crypto';
import { appendHttpHistoryEntry, type HttpHistoryEntry } from './httpHistory';
import { parseCurlHttpResponse, getHeaderValue } from './httpResponse';
import { HttpSessionManager } from './HttpSessionManager';
import { HttpRequestValidator } from '@/domains/agent-brain/application/tools/runtime/HttpRequestValidator';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolResult } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import { promises as fs } from 'fs';
import { resolveRunnerSessionBindingFromFlags } from '@/domains/security-ops/runners/runnerSession';
import { findCloudBlockedNetworkTargetInUrl } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { ScopeBoundaryService } from '@/domains/security-ops/scopes/ScopeBoundaryService';
import { db } from '@/db/client';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_BODY_BYTES = 2_048;
const MAX_HISTORY_BODY_BYTES = 12_000;
const MAX_HISTORY_HEADERS_BYTES = 8_192;
const HISTORY_PREVIEW_BYTES = 2_048;
const CURL_ERROR_MAX_CHARS = 500;
const REDACTED_VALUE = '[REDACTED]';
const scopeBoundaryService = new ScopeBoundaryService(db);

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const REDACTED_HEADERS = new Set(['authorization', 'cookie']);
const REDACTED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
  'authentication-info',
  'proxy-authorization',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSecurityOpsCloudSession = (
  session: { flags?: Record<string, unknown> } | undefined,
): boolean => {
  if (!isRecord(session?.flags) || !isRecord(session.flags.securityops)) {
    return false;
  }
  return resolveRunnerSessionBindingFromFlags(session.flags).executionTarget === 'cloud';
};
const INTERESTING_RESPONSE_HEADERS = [
  'content-type',
  'location',
  'server',
  'www-authenticate',
  'content-length',
  'content-disposition',
  'cache-control',
  'content-security-policy',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'access-control-allow-origin',
  'access-control-allow-credentials',
] as const;

export interface HttpRequestExecutionArgs {
  url?: string;
  raw_request?: string;
  rawRequest?: string;
  technique?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  follow_redirects?: boolean;
  insecure?: boolean;
  max_body_bytes?: number;
}

export interface HttpRequestExecutionOptions {
  toolName: string;
  replayedFrom?: string;
  modificationsApplied?: Record<string, unknown>;
  historyRequestBody?: string;
}

/**
 * D1 - curl writes a route record after this sentinel so a later reader can explain which
 * network path an exchange actually took. It is stripped before the response is parsed and
 * never reaches the model-visible stream.
 */
const ROUTE_SENTINEL_PREFIX = '\n__NS_ROUTE_PROVENANCE__';

/**
 * The marker carries a per-invocation nonce because a constant marker is content the target
 * controls. A response body containing the marker followed by a JSON object would otherwise be
 * split as though it were curl's own record: the exchange would be truncated at the forged
 * marker, and the target would choose the resolved IP and final URL this run records about
 * itself. The nonce is generated on the host per request and never appears in the request, so
 * a body cannot forge it.
 */
const newRouteSentinel = (): string =>
  `${ROUTE_SENTINEL_PREFIX}${randomUUID().replace(/-/g, '')}:`;

const ROUTE_WRITE_OUT = [
  '{"remote_ip":"%{remote_ip}"',
  '"remote_port":"%{remote_port}"',
  '"final_url":"%{url_effective}"',
  '"redirect_count":"%{num_redirects}"',
  '"redirect_url":"%{redirect_url}"',
  '"http_version":"%{http_version}"',
  '"scheme":"%{scheme}"',
  '"ssl_verify_result":"%{ssl_verify_result}"}',
].join(',');

export interface HttpRouteProvenance {
  /** Whether the request went through the session proxy, and whether it fell back. */
  proxy_used: boolean;
  proxy_fallback: boolean;
  proxy_url_host: string | null;
  /** The address curl actually connected to. */
  resolved_ip: string | null;
  remote_port: string | null;
  /** The URL after redirects, which is not necessarily the URL that was requested. */
  final_url: string | null;
  redirect_count: number | null;
  redirect_url: string | null;
  http_version: string | null;
  /** The name presented for TLS, taken from the requested URL. */
  tls_sni: string | null;
  ssl_verify_result: string | null;
}

const parseRouteProvenance = (raw: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (typeof parsed !== 'object' || parsed === null) return {};
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') output[key] = value;
    }
    return output;
  } catch {
    return {};
  }
};

/** Splits curl stdout into the HTTP exchange and the route record appended after it. */
const splitRouteProvenance = (
  stdout: string,
  sentinel: string,
): { exchange: string; route: Record<string, string> } => {
  const index = stdout.lastIndexOf(sentinel);
  if (index < 0) {
    return { exchange: stdout, route: {} };
  }
  return {
    exchange: stdout.slice(0, index),
    route: parseRouteProvenance(stdout.slice(index + sentinel.length)),
  };
};

const hostOf = (value: string | undefined | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

const asOptionalInt = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const asOptionalString = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * D3 - how many bytes of curl stdout may reach the model-visible stream, the provenance
 * buffer and the trace.
 *
 * `max_body_bytes` documented itself as capping the response, and the tool told the agent to
 * keep it small to avoid context bloat. It only capped `body_preview`, which is computed
 * after curl finishes; every byte curl produced had already been streamed. A 500 KB bundle
 * showed a 4 KB preview after hundreds of KB had passed through the conversation.
 *
 * The allowance covers the status line and headers, which the cap was never meant to hide.
 */
const STREAM_HEADER_ALLOWANCE_BYTES = 8_192;

const normalizeBodyCap = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  return Math.max(0, Math.floor(value));
};

const truncateUtf8ByBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0 || !value) {
    return '';
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  const sliced = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return sliced.endsWith('\uFFFD') ? sliced.slice(0, -1) : sliced;
};

const truncateText = (value: string, maxChars: number): string => {
  if (!value) {
    return '';
  }
  return value.length > maxChars ? value.slice(0, maxChars) : value;
};

const shellQuote = (value: string): string => {
  if (!value) {
    return "''";
  }
  if (/^[a-zA-Z0-9_,./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const normalizeHeaderName = (name: string): string => name.trim().toLowerCase();

const sanitizeRequestHeaders = (headers: Record<string, string>): Record<string, string> => {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (value.trim() === REDACTED_VALUE) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

const redactHeadersForHistory = (
  headers: Record<string, string>,
  sensitiveHeaderNames: ReadonlySet<string>,
): Record<string, string> => {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaderNames.has(normalizeHeaderName(key))) {
      redacted[key] = REDACTED_VALUE;
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
};

const redactResponseHeadersForHistory = (headersRaw: string): string => {
  if (!headersRaw) {
    return '';
  }

  const lines = headersRaw.split(/\r?\n/u);
  const redacted = lines.map((line, index) => {
    if (index === 0 || !line.includes(':')) {
      return line;
    }
    const separator = line.indexOf(':');
    const headerName = line.slice(0, separator);
    if (REDACTED_RESPONSE_HEADERS.has(normalizeHeaderName(headerName))) {
      return `${headerName}: ${REDACTED_VALUE}`;
    }
    return line;
  });

  return truncateUtf8ByBytes(redacted.join('\r\n'), MAX_HISTORY_HEADERS_BYTES);
};

const buildSecurityObservations = (headersRaw: string): string[] => {
  const contentType = (getHeaderValue(headersRaw, 'content-type') ?? '').toLowerCase();
  const isHtml = contentType.includes('text/html') || contentType.length === 0;
  if (!isHtml) {
    return [];
  }

  const observations: string[] = [];
  const csp = getHeaderValue(headersRaw, 'content-security-policy');
  if (!getHeaderValue(headersRaw, 'strict-transport-security')) {
    observations.push('HSTS not set');
  }
  if (!csp) {
    observations.push('CSP not set');
  }
  const hasFrameGuard =
    Boolean(getHeaderValue(headersRaw, 'x-frame-options')) ||
    Boolean(csp?.toLowerCase().includes('frame-ancestors'));
  if (!hasFrameGuard) {
    observations.push('X-Frame-Options not set');
  }
  if (!getHeaderValue(headersRaw, 'x-content-type-options')) {
    observations.push('X-Content-Type-Options not set');
  }
  return observations;
};

const collectInterestingHeaders = (headersRaw: string): Record<string, string> => {
  const interestingHeaders: Record<string, string> = {};
  for (const headerName of INTERESTING_RESPONSE_HEADERS) {
    const value = getHeaderValue(headersRaw, headerName);
    if (value) {
      interestingHeaders[headerName] = value;
    }
  }
  return interestingHeaders;
};

const resolveSessionProxyUrl = (session: { flags?: Record<string, unknown> } | undefined): string | undefined => {
  const proxy = session?.flags?.httpProxy;
  if (!isRecord(proxy) || proxy.enabled !== true || typeof proxy.url !== 'string') {
    return undefined;
  }
  const trimmed = proxy.url.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toHistoryEntry = (input: {
  normalizedUrl: string;
  httpMethod: string;
  mergedHeaders: Record<string, string>;
  reqBody: string;
  timeoutSec: number;
  followRedirect: boolean;
  skipSsl: boolean;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  bodySize: number;
  bodyTruncated: boolean;
  responseBody: string;
  headersRaw: string;
  securityObservations: string[];
  curlError?: string;
  replayedFrom?: string;
  modificationsApplied?: Record<string, unknown>;
  sensitiveHeaderNames: ReadonlySet<string>;
  historyRequestBody?: string;
}): HttpHistoryEntry => ({
  id: randomUUID(),
  ts: new Date().toISOString(),
  request: {
    method: input.httpMethod,
    url: input.normalizedUrl,
    headers: redactHeadersForHistory(input.mergedHeaders, input.sensitiveHeaderNames),
    ...((input.historyRequestBody ?? input.reqBody).length > 0
      ? { body: input.historyRequestBody ?? input.reqBody }
      : {}),
    options: {
      timeout: input.timeoutSec,
      follow_redirects: input.followRedirect,
      insecure: input.skipSsl,
    },
  },
  success: input.success,
  status_code: input.statusCode,
  response_time_ms: input.responseTimeMs,
  body_size: input.bodySize,
  body_truncated: input.bodyTruncated,
  body_preview: truncateUtf8ByBytes(input.responseBody, HISTORY_PREVIEW_BYTES),
  response_body: input.responseBody,
  response_headers: input.headersRaw,
  ...(input.securityObservations.length > 0
    ? { security_observations: input.securityObservations }
    : {}),
  ...(input.curlError ? { curl_error: input.curlError } : {}),
  ...(input.replayedFrom ? { replayed_from: input.replayedFrom } : {}),
  ...(input.modificationsApplied ? { modifications_applied: input.modificationsApplied } : {}),
});

export async function executeHttpRequest(
  {
    url,
    raw_request,
    method,
    headers,
    body,
    timeout,
    follow_redirects,
    insecure,
    rawRequest,
    max_body_bytes,
  }: HttpRequestExecutionArgs,
  ctx: ToolContext,
  options: HttpRequestExecutionOptions,
): Promise<ToolResult> {
  const targetUrl = typeof url === 'string' ? url.trim() : '';
  if (!targetUrl) {
    return { ok: false, data: { success: false, error: 'url is required' } };
  }

  let httpMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
  let reqHeaders = headers && isRecord(headers) ? (headers as Record<string, string>) : {};
  reqHeaders = sanitizeRequestHeaders(reqHeaders);
  let reqBody = typeof body === 'string' ? body : '';
  const timeoutSec = typeof timeout === 'number' ? Math.max(1, timeout) : DEFAULT_TIMEOUT_SECONDS;
  const requestedFollowRedirect = follow_redirects !== false;
  const skipSsl = insecure === true;
  const maxBodyBytes = normalizeBodyCap(max_body_bytes);

  const session = getSessionFromContext(ctx);
  if (!session) {
    return { ok: false, data: { success: false, error: `Session ${ctx.sessionId} not found` } };
  }

  const config = ctx.config;
  const maxChunk = Math.max(1, config?.trace?.stdoutChunkSize || 65_536);
  const recorder = ctx.trace;
  const turn = ctx.turnNumber ?? (session.turn ?? 0) + 1;
  const log = logger.child({ scope: options.toolName, sessionId: ctx.sessionId });
  // curl cannot apply our namespace policy before each redirect hop. Scoped
  // sessions therefore expose Location and require an explicit next request,
  // which is checked against the same authorization before any traffic leaves.
  const followRedirect = requestedFollowRedirect && !ctx.scopeId;

  const rawRequestValue =
    typeof raw_request === 'string'
      ? raw_request
      : typeof rawRequest === 'string'
        ? rawRequest
        : '';

  let normalizedUrl = targetUrl;
  let requestCorrections: string[] = [];

  try {
    const normalized = HttpRequestValidator.normalize({
      targetUrl,
      method: httpMethod,
      headers: reqHeaders,
      body: reqBody,
      rawRequest: rawRequestValue,
    });

    normalizedUrl = normalized.url;
    httpMethod = normalized.method;
    reqHeaders = sanitizeRequestHeaders(normalized.headers);
    reqBody = normalized.body;
    requestCorrections = normalized.corrections;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid raw_request';
    return { ok: false, data: { success: false, error: message } };
  }

  if (ctx.scopeId) {
    try {
      await scopeBoundaryService.assertTarget(ctx.scopeId, normalizedUrl);
      if (requestedFollowRedirect) {
        requestCorrections.push(
          'Automatic redirects disabled for scoped pentest traffic; follow same-scope Location values explicitly',
        );
      }
    } catch (error) {
      return {
        ok: false,
        data: {
          success: false,
          error: error instanceof Error ? error.message : 'Target is outside the authorized pentest scope',
        },
      };
    }
  }

  if (isSecurityOpsCloudSession(session)) {
    const blockedTarget = findCloudBlockedNetworkTargetInUrl(normalizedUrl);
    if (blockedTarget) {
      return {
        ok: false,
        data: {
          success: false,
          error:
            `Cloud execution cannot target private or reserved network addresses (${blockedTarget}). ` +
            'Select an attached private runner for internal CIDR assessment.',
        },
      };
    }
  }

  if (!BODY_METHODS.has(httpMethod) && reqBody) {
    requestCorrections.push(`Dropped body for ${httpMethod} request`);
    reqBody = '';
  }

  // D3 - the live stream is bounded by the same cap the caller asked for. The full body is
  // still returned to this function for parsing and still reaches durable artifacts; what is
  // bounded is what enters the conversation, the provenance buffer and the trace.
  const streamBudgetBytes = maxBodyBytes + STREAM_HEADER_ALLOWANCE_BYTES;
  const routeSentinel = newRouteSentinel();
  let streamedStdoutBytes = 0;
  let streamTruncationNoticeSent = false;
  /**
   * Once curl starts writing its route record, nothing further on stdout is response content,
   * so suppression is sticky for the rest of the attempt rather than a per-chunk slice.
   */
  let routeRecordStreamStarted = false;
  /**
   * Bytes held back because they could be the beginning of the marker. A chunk boundary can
   * fall inside it, and a per-chunk search would then miss the marker entirely and stream the
   * whole record into the conversation. At most one marker-length of stdout is ever held, and
   * `flushPendingStdout` releases it once the attempt ends without a record.
   */
  let pendingStdoutTail = '';

  const emitStreamChunk = (type: 'stdout' | 'stderr', rawChunk: string): void => {
    if (!rawChunk) {
      return;
    }

    let chunk = rawChunk;
    if (type === 'stdout') {
      // The route record is diagnostic plumbing, not response content.
      if (routeRecordStreamStarted) {
        return;
      }
      chunk = pendingStdoutTail + chunk;
      pendingStdoutTail = '';
      const sentinelAt = chunk.indexOf(ROUTE_SENTINEL_PREFIX);
      if (sentinelAt >= 0) {
        routeRecordStreamStarted = true;
        chunk = chunk.slice(0, sentinelAt);
      } else {
        // Hold back the longest suffix that could still turn into the marker once the next
        // chunk arrives.
        const longestPartial = Math.min(ROUTE_SENTINEL_PREFIX.length - 1, chunk.length);
        for (let length = longestPartial; length > 0; length -= 1) {
          if (chunk.endsWith(ROUTE_SENTINEL_PREFIX.slice(0, length))) {
            pendingStdoutTail = chunk.slice(chunk.length - length);
            chunk = chunk.slice(0, chunk.length - length);
            break;
          }
        }
      }
      if (!chunk) {
        return;
      }
      const remaining = streamBudgetBytes - streamedStdoutBytes;
      if (remaining <= 0) {
        if (!streamTruncationNoticeSent) {
          streamTruncationNoticeSent = true;
          ctx.streamBroker.emit(ctx.sessionId, {
            type: 'tool_output',
            data: {
              name: options.toolName,
              chunk: `\n[response stream capped at ${streamBudgetBytes} bytes by max_body_bytes; full body preserved as an artifact]\n`,
            },
          });
        }
        return;
      }
      if (Buffer.byteLength(chunk, 'utf8') > remaining) {
        chunk = truncateUtf8ByBytes(chunk, remaining);
      }
      streamedStdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (!chunk) {
        return;
      }
    }

    for (let offset = 0; offset < chunk.length; offset += maxChunk) {
      const slice = chunk.slice(offset, offset + maxChunk);
      ctx.streamBroker.emit(ctx.sessionId, {
        type: 'tool_output',
        data: { name: options.toolName, chunk: slice },
      });
      if (type === 'stdout') {
        ctx.planRuntime.appendProvenanceSnippet(ctx.sessionId, slice);
      }
      if (!recorder) {
        continue;
      }
      recorder
        .write(ctx.sessionId, turn, {
          event: `tool.${type}`,
          severity: 'debug',
          payload: { name: options.toolName, chunk: slice },
          note: summarizeForNote(`${type} len=${slice.length}`),
        })
        .catch((error) => {
          log.warn({ err: error }, `Failed to record tool.${type} chunk`);
        });
    }
  };

  let httpSession = null;
  if (typeof session.workspaceDir === 'string' && session.workspaceDir.trim().length > 0) {
    try {
      httpSession = await HttpSessionManager.getSession({
        url: normalizedUrl,
        workspaceDir: session.workspaceDir,
      });
    } catch (error) {
      log.warn({ err: error }, 'Failed to initialize http session state');
    }
  }

  if (httpSession && typeof ctx.sandbox.writeFile === 'function') {
    HttpSessionManager.updateFromRequest(httpSession, reqHeaders);
    try {
      const cookieJar = await fs.readFile(httpSession.cookieJarPath);
      await ctx.sandbox.writeFile(session, httpSession.cookieJarRelativePath, cookieJar);
    } catch {
      // Best effort: runner/local cookie jar will be created by curl if missing.
    }
  }

  const sensitiveHeaderNames = new Set<string>(
    Array.from(
      new Set([
        ...REDACTED_HEADERS,
        ...HttpSessionManager.getSensitiveHeaderNames(httpSession),
      ]),
    ),
  );

  let mergedHeaders = httpSession
    ? HttpSessionManager.applyPersistentHeaders(httpSession, reqHeaders)
    : reqHeaders;

  const contentLengthFix = HttpRequestValidator.ensureContentLength(
    mergedHeaders,
    reqBody,
    requestCorrections,
  );
  mergedHeaders = contentLengthFix.headers;

  if (requestCorrections.length > 0) {
    log.debug({ corrections: requestCorrections, url: normalizedUrl }, 'Auto-corrected HTTP request payload');
  }

  const proxyUrl = resolveSessionProxyUrl(session);
  const buildCurlCommand = (useProxy: boolean): string => {
    const curlArgs = [
      'curl',
      '-sS',
      '-i',
      '-X',
      shellQuote(httpMethod),
      '--max-time',
      String(timeoutSec),
    ];

    if (useProxy && proxyUrl) {
      curlArgs.push('--proxy', shellQuote(proxyUrl));
    }

    if (httpSession) {
      curlArgs.push('-b', shellQuote(httpSession.cookieJarContainerPath));
      curlArgs.push('-c', shellQuote(httpSession.cookieJarContainerPath));
    }

    for (const [key, value] of Object.entries(mergedHeaders)) {
      curlArgs.push('-H', shellQuote(`${key}: ${value}`));
    }

    if (reqBody && BODY_METHODS.has(httpMethod)) {
      curlArgs.push('-d', shellQuote(reqBody));
    }

    if (followRedirect) {
      curlArgs.push('-L');
    }

    if (skipSsl || (useProxy && proxyUrl)) {
      curlArgs.push('-k');
    }

    // D1 - record which network path this exchange actually took, so a disagreement between
    // http_payload, the browser and shell curl can be explained instead of guessed at.
    curlArgs.push('-w', shellQuote(`${routeSentinel}${ROUTE_WRITE_OUT}`));

    curlArgs.push(shellQuote(normalizedUrl));
    return curlArgs.join(' ');
  };

  /** Releases held-back bytes that never became the marker, so nothing is lost from view. */
  const flushPendingStdout = (): void => {
    const held = pendingStdoutTail;
    pendingStdoutTail = '';
    if (held && !routeRecordStreamStarted) {
      emitStreamChunk('stdout', held);
      pendingStdoutTail = '';
    }
  };

  const runCurl = async (useProxy: boolean) => {
    const startedAt = Date.now();
    routeRecordStreamStarted = false;
    pendingStdoutTail = '';
    const execResult = await ctx.sandbox.exec({
      session,
      cmd: buildCurlCommand(useProxy),
      timeoutMs: (timeoutSec + 5) * 1000,
      signal: ctx.abortSignal,
      onStdout: (chunk: string) => emitStreamChunk('stdout', chunk),
      onStderr: (chunk: string) => emitStreamChunk('stderr', chunk),
    });
    flushPendingStdout();
    return {
      execResult,
      responseTimeMs: Date.now() - startedAt,
      usedProxy: useProxy,
    };
  };

  let execution = await runCurl(Boolean(proxyUrl));
  let proxyFallback = false;
  let success = !execution.execResult.timedOut && !execution.execResult.aborted && execution.execResult.exitCode === 0;
  if (proxyUrl && !success && !execution.execResult.timedOut && !execution.execResult.aborted) {
    execution = await runCurl(false);
    proxyFallback = true;
    success = !execution.execResult.timedOut && !execution.execResult.aborted && execution.execResult.exitCode === 0;
  }

  const { execResult, responseTimeMs } = execution;
  if (execResult.aborted) {
    const abortError = new Error(execResult.abortReason ?? 'Aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  const { exchange: curlExchangeOutput, route: routeRecord } =
    splitRouteProvenance(execResult.stdout || '', routeSentinel);
  const parsedResponse = parseCurlHttpResponse(curlExchangeOutput);
  const headersRaw = parsedResponse.headersRaw;
  const bodyRaw = parsedResponse.bodyRaw;
  const statusCode = parsedResponse.statusCode;
  const bodySize = Buffer.byteLength(bodyRaw, 'utf8');
  const bodyTruncated = bodySize > maxBodyBytes;
  const responseBodyPreview = bodyTruncated ? truncateUtf8ByBytes(bodyRaw, maxBodyBytes) : bodyRaw;
  const historyBodyTruncated = bodySize > MAX_HISTORY_BODY_BYTES;
  const storedResponseBody = historyBodyTruncated
    ? truncateUtf8ByBytes(bodyRaw, MAX_HISTORY_BODY_BYTES)
    : bodyRaw;
  const storedResponseHeaders = redactResponseHeadersForHistory(headersRaw);
  const securityObservations = buildSecurityObservations(headersRaw);
  const interestingHeaders = collectInterestingHeaders(headersRaw);
  const curlError =
    !success && execResult.stderr
      ? truncateText(execResult.stderr, CURL_ERROR_MAX_CHARS)
      : undefined;

  if (httpSession && typeof ctx.sandbox.readFile === 'function') {
    HttpSessionManager.updateFromResponse(httpSession, headersRaw);
    try {
      const cookieJar = await ctx.sandbox.readFile(session, httpSession.cookieJarRelativePath);
      await fs.writeFile(httpSession.cookieJarPath, cookieJar);
    } catch (error) {
      log.warn({ err: error }, 'Failed to sync HTTP cookie jar from execution environment');
    }
  }

  const routeProvenance: HttpRouteProvenance = {
    proxy_used: Boolean(proxyUrl) && execution.usedProxy,
    proxy_fallback: proxyFallback,
    proxy_url_host: hostOf(proxyUrl),
    resolved_ip: asOptionalString(routeRecord.remote_ip),
    remote_port: asOptionalString(routeRecord.remote_port),
    final_url: asOptionalString(routeRecord.final_url) ?? normalizedUrl,
    redirect_count: asOptionalInt(routeRecord.redirect_count),
    redirect_url: asOptionalString(routeRecord.redirect_url),
    http_version: asOptionalString(routeRecord.http_version),
    tls_sni: hostOf(normalizedUrl),
    ssl_verify_result: asOptionalString(routeRecord.ssl_verify_result),
  };

  const data: Record<string, unknown> = {
    success,
    url: normalizedUrl,
    method: httpMethod,
    status_code: statusCode,
    body_preview: responseBodyPreview,
    body_size: bodySize,
    body_truncated: bodyTruncated,
    response_time_ms: responseTimeMs,
    code: execResult.exitCode,
    timedOut: execResult.timedOut,
    aborted: execResult.aborted,
    abortReason: execResult.abortReason,
    artifacts: execResult.artifacts,
    ...(curlError ? { curl_error: curlError } : {}),
    route_provenance: routeProvenance,
    ...(proxyUrl ? { proxy_used: execution.usedProxy, proxy_fallback: proxyFallback } : {}),
    ...(requestCorrections.length > 0 ? { request_corrections: requestCorrections } : {}),
    ...(Object.keys(interestingHeaders).length > 0 ? { interesting_headers: interestingHeaders } : {}),
    ...(securityObservations.length > 0 ? { security_observations: securityObservations } : {}),
    ...(options.replayedFrom ? { replayed_from: options.replayedFrom, replayed: true } : {}),
    ...(options.modificationsApplied ? { modifications_applied: options.modificationsApplied } : {}),
  };

  if (typeof session.workspaceDir === 'string' && session.workspaceDir.trim().length > 0) {
    const historyEntry = toHistoryEntry({
      normalizedUrl,
      httpMethod,
      mergedHeaders,
      reqBody,
      timeoutSec,
      followRedirect,
      skipSsl,
      success,
      statusCode,
      responseTimeMs,
      bodySize,
      bodyTruncated: historyBodyTruncated,
      responseBody: storedResponseBody,
      headersRaw: storedResponseHeaders,
      securityObservations,
      sensitiveHeaderNames,
      ...(options.historyRequestBody !== undefined ? { historyRequestBody: options.historyRequestBody } : {}),
      ...(curlError ? { curlError } : {}),
      ...(options.replayedFrom ? { replayedFrom: options.replayedFrom } : {}),
      ...(options.modificationsApplied ? { modificationsApplied: options.modificationsApplied } : {}),
    });

    try {
      await appendHttpHistoryEntry(session.workspaceDir, historyEntry);
      data.history_entry_id = historyEntry.id;
    } catch (error) {
      log.warn({ err: error }, 'Failed to append HTTP history entry');
    }
  }

  return {
    ok: success,
    data,
  };
}
