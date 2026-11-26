import * as fs from 'fs/promises';
import * as path from 'path';

import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { executeHttpRequest } from '../runtime/httpRequestExecutor';
import { readHttpHistoryEntries, type HttpHistoryEntry } from '../runtime/httpHistory';
import { readRawHttpHistoryEntries, type RawHttpHistoryEntry } from '../runtime/rawHttpHistory';
import { getEnumerationWorkerUrlBlockReason } from '@/domains/agent-brain/domain/workers/enumerationRuntimeGuard';

const PROXY_CAPTURE_FILE = '.http-proxy.ndjson';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PAGE_BYTES = 12_000;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']);

type CaptureEntry = {
  id: string;
  ts: string;
  source: string;
  request: {
    method: string;
    url: string;
    host?: string;
    path?: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    status_code: number | null;
    headers?: Record<string, string> | string;
    body?: string;
    body_truncated?: boolean;
  };
  response_time_ms?: number;
  body_size?: number;
  replayed_from?: string;
  raw?: {
    manifest_path: string;
    request_paths: string[];
    response_paths: string[];
    request_sha256: string[];
    response_sha256: string[];
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
};

const fromHistory = (entry: HttpHistoryEntry): CaptureEntry => ({
  id: entry.id,
  ts: entry.ts,
  source: 'http_payload',
  request: {
    method: entry.request.method,
    url: entry.request.url,
    headers: entry.request.headers,
    ...(entry.request.body ? { body: entry.request.body } : {}),
  },
  response: {
    status_code: entry.status_code,
    headers: entry.response_headers,
    body: entry.response_body,
    body_truncated: entry.body_truncated,
  },
  response_time_ms: entry.response_time_ms,
  body_size: entry.body_size,
  ...(entry.replayed_from ? { replayed_from: entry.replayed_from } : {}),
});

const fromRawHistory = (entry: RawHttpHistoryEntry): CaptureEntry => ({
  id: entry.id,
  ts: entry.ts,
  source: 'http_raw_send',
  request: {
    method: 'RAW',
    url: entry.target.url,
    host: entry.target.host,
    headers: {},
    body: entry.request_preview,
  },
  response: {
    status_code: entry.status_code,
    headers: '',
    body: entry.response_preview,
    body_truncated: entry.response_truncated,
  },
  response_time_ms: entry.response_time_ms,
  body_size: entry.body_size,
  raw: {
    manifest_path: entry.manifest_path,
    request_paths: entry.request_artifacts.map((artifact) => artifact.path),
    response_paths: entry.response_artifacts.map((artifact) => artifact.path),
    request_sha256: entry.request_artifacts.map((artifact) => artifact.sha256),
    response_sha256: entry.response_artifacts.map((artifact) => artifact.sha256),
  },
});

const parseProxyLine = (line: string): CaptureEntry | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || !isRecord(parsed.request) || !isRecord(parsed.response)) {
      return null;
    }
    const request = parsed.request;
    const response = parsed.response;
    if (typeof request.method !== 'string' || typeof request.url !== 'string') {
      return null;
    }
    return {
      id: parsed.id,
      ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
      source: typeof parsed.source === 'string' ? parsed.source : 'proxy',
      request: {
        method: request.method,
        url: request.url,
        ...(typeof request.host === 'string' ? { host: request.host } : {}),
        ...(typeof request.path === 'string' ? { path: request.path } : {}),
        headers: toStringMap(request.headers),
        ...(typeof request.body === 'string' ? { body: request.body } : {}),
      },
      response: {
        status_code: typeof response.status_code === 'number' ? response.status_code : null,
        headers: toStringMap(response.headers),
        ...(typeof response.body === 'string' ? { body: response.body } : {}),
        ...(typeof response.body_truncated === 'boolean' ? { body_truncated: response.body_truncated } : {}),
      },
    };
  } catch {
    return null;
  }
};

const readProxyCaptures = async (workspaceDir: string): Promise<CaptureEntry[]> => {
  try {
    const raw = await fs.readFile(path.resolve(workspaceDir, PROXY_CAPTURE_FILE), 'utf8');
    return raw
      .split(/\r?\n/u)
      .map((line) => parseProxyLine(line))
      .filter((entry): entry is CaptureEntry => entry !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const readAllCaptures = async (workspaceDir: string): Promise<CaptureEntry[]> => {
  const [history, proxy, raw] = await Promise.all([
    readHttpHistoryEntries(workspaceDir).then((entries) => entries.map(fromHistory)),
    readProxyCaptures(workspaceDir),
    readRawHttpHistoryEntries(workspaceDir).then((entries) => entries.map(fromRawHistory)),
  ]);
  const byId = new Map<string, CaptureEntry>();
  for (const entry of [...history, ...proxy, ...raw]) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
};

const getCapture = async (workspaceDir: string, id: string): Promise<CaptureEntry | undefined> =>
  (await readAllCaptures(workspaceDir)).find((entry) => entry.id === id);

const matchesGlob = (value: string, glob: string): boolean => {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*');
  return new RegExp(`^${pattern}$`, 'iu').test(value);
};

const normalizeLimit = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
    : DEFAULT_LIMIT;

const parseUrlOrNull = (rawUrl: string): URL | null => {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
};

const applyParamModifications = (rawUrl: string, params: Record<string, string>): string => {
  if (Object.keys(params).length === 0) {
    return rawUrl;
  }
  const url = parseUrlOrNull(rawUrl);
  if (!url) {
    return rawUrl;
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

export const HttpList: ToolImpl = {
  meta: {
    name: 'http_list',
    description: 'List captured HTTP exchanges from proxy capture, http_payload history, and http_raw_send raw-exchange history with structured filters.',
    category: 'web',
    schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            path_glob: { type: 'string' },
            method: { type: 'string' },
            status_min: { type: 'number' },
            status_max: { type: 'number' },
            has_param: { type: 'string' },
            content_type: { type: 'string' },
          },
        },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx) {
    return runWithGuards(HttpList.meta, ctx, async () => {
      const session = getSessionFromContext(ctx);
      if (!session?.workspaceDir) {
        return { ok: false, data: { error: 'Session workspace is not available' } };
      }
      const filter = isRecord(args.filter) ? args.filter : {};
      const limit = normalizeLimit(args.limit);
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const entries = (await readAllCaptures(session.workspaceDir)).filter((entry) => {
        const url = parseUrlOrNull(entry.request.url);
        if (!url) {
          return false;
        }
        if (getEnumerationWorkerUrlBlockReason(session, entry.request.url)) return false;
        if (typeof filter.host === 'string' && !url.hostname.includes(filter.host)) return false;
        if (typeof filter.path_glob === 'string' && !matchesGlob(url.pathname, filter.path_glob)) return false;
        if (typeof filter.method === 'string' && entry.request.method.toUpperCase() !== filter.method.toUpperCase()) return false;
        if (typeof filter.status_min === 'number' && (entry.response.status_code ?? 0) < filter.status_min) return false;
        if (typeof filter.status_max === 'number' && (entry.response.status_code ?? 999) > filter.status_max) return false;
        if (typeof filter.has_param === 'string' && !url.searchParams.has(filter.has_param)) return false;
        if (typeof filter.content_type === 'string') {
          const headers = entry.response.headers;
          const contentType = typeof headers === 'string' ? headers : headers?.['content-type'] ?? headers?.['Content-Type'] ?? '';
          if (!String(contentType).toLowerCase().includes(filter.content_type.toLowerCase())) return false;
        }
        return true;
      });
      return {
        ok: true,
        data: {
          entries: entries.slice(offset, offset + limit).map((entry) => ({
            id: entry.id,
            ts: entry.ts,
            source: entry.source,
            method: entry.request.method,
            url: entry.request.url,
            status_code: entry.response.status_code,
            response_time_ms: entry.response_time_ms,
            body_size: entry.body_size ?? Buffer.byteLength(entry.response.body ?? '', 'utf8'),
            replayed_from: entry.replayed_from,
            raw_manifest_path: entry.raw?.manifest_path,
          })),
          totalCount: entries.length,
          limit,
          offset,
        },
      };
    }, {}, {});
  },
};

export const HttpView: ToolImpl = {
  meta: {
    name: 'http_view',
    description: 'Inspect the request or response side of a captured HTTP exchange.',
    category: 'web',
    schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        part: { type: 'string', enum: ['request', 'response'] },
        search_pattern: { type: 'string' },
        page: { type: 'number' },
      },
      required: ['request_id'],
    },
    risks: ['read'],
    returns: 'json',
  },
  async run(args, ctx) {
    return runWithGuards(HttpView.meta, ctx, async () => {
      const session = getSessionFromContext(ctx);
      const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      if (!session?.workspaceDir || !requestId) {
        return { ok: false, data: { error: 'workspace and request_id are required' } };
      }
      const entry = await getCapture(session.workspaceDir, requestId);
      if (!entry) {
        return { ok: false, data: { error: `HTTP capture ${requestId} not found` } };
      }
      const scopeBlockReason = getEnumerationWorkerUrlBlockReason(session, entry.request.url);
      if (scopeBlockReason) {
        return { ok: false, data: { error: scopeBlockReason } };
      }
      const part = args.part === 'request' ? 'request' : 'response';
      const body = part === 'request' ? entry.request.body ?? '' : entry.response.body ?? '';
      const page = typeof args.page === 'number' && Number.isFinite(args.page) ? Math.max(0, Math.floor(args.page)) : 0;
      const start = page * PAGE_BYTES;
      const bodyPage = body.slice(start, start + PAGE_BYTES);
      const searchPattern = typeof args.search_pattern === 'string' ? args.search_pattern : '';
      return {
        ok: true,
        data: {
          id: entry.id,
          part,
          request: part === 'request' ? entry.request : { method: entry.request.method, url: entry.request.url },
          response: part === 'response' ? { ...entry.response, body: bodyPage } : { status_code: entry.response.status_code },
          raw: entry.raw,
          page,
          hasMore: start + PAGE_BYTES < body.length,
          ...(searchPattern ? { searchMatch: body.toLowerCase().includes(searchPattern.toLowerCase()) } : {}),
        },
      };
    }, {}, {});
  },
};

export const HttpRepeat: ToolImpl = {
  meta: {
    name: 'http_repeat',
    description: 'Replay a captured HTTP request with optional header, query parameter, or body modifications.',
    category: 'web',
    schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        modifications: {
          type: 'object',
          properties: {
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            params: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string' },
          },
        },
        max_body_bytes: { type: 'number' },
      },
      required: ['request_id'],
    },
    risks: ['network', 'read'],
    returns: 'json',
  },
  async run(args, ctx) {
    return runWithGuards(HttpRepeat.meta, ctx, async () => {
      const session = getSessionFromContext(ctx);
      const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
      if (!session?.workspaceDir || !requestId) {
        return { ok: false, data: { error: 'workspace and request_id are required' } };
      }
      const entry = await getCapture(session.workspaceDir, requestId);
      if (!entry) {
        return { ok: false, data: { error: `HTTP capture ${requestId} not found` } };
      }
      const scopeBlockReason = getEnumerationWorkerUrlBlockReason(session, entry.request.url);
      if (scopeBlockReason) {
        return { ok: false, data: { error: scopeBlockReason } };
      }
      if (
        session.coordination?.role === 'worker' &&
        session.coordination.workerType === 'enumeration_worker' &&
        STATE_CHANGING_METHODS.has(entry.request.method.toUpperCase())
      ) {
        return {
          ok: false,
          data: { error: `enumeration_worker state_change_denied: ${entry.request.method} replay is not allowed` },
        };
      }
      if (entry.source === 'http_raw_send') {
        return {
          ok: false,
          data: {
            error:
              'http_raw_send captures cannot be replayed with http_repeat because that would normalize bytes. Use http_raw_send with the raw request artifact instead.',
            raw: entry.raw,
          },
        };
      }
      const modifications = isRecord(args.modifications) ? args.modifications : {};
      const headers = { ...entry.request.headers, ...toStringMap(modifications.headers) };
      const url = applyParamModifications(entry.request.url, toStringMap(modifications.params));
      return executeHttpRequest(
        {
          url,
          method: entry.request.method,
          headers,
          body: typeof modifications.body === 'string' ? modifications.body : entry.request.body,
          ...(typeof args.max_body_bytes === 'number' ? { max_body_bytes: args.max_body_bytes } : {}),
        },
        ctx,
        {
          toolName: 'http_repeat',
          replayedFrom: entry.id,
          modificationsApplied: modifications,
        },
      );
    }, {}, {});
  },
};

export const HttpSitemap: ToolImpl = {
  meta: {
    name: 'http_sitemap',
    description: 'Build a host/path tree from captured HTTP traffic.',
    category: 'web',
    schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Optional hostname substring.' },
        depth: { type: 'number' },
      },
    },
    risks: ['read'],
    returns: 'json',
  },
  async run(args, ctx) {
    return runWithGuards(HttpSitemap.meta, ctx, async () => {
      const session = getSessionFromContext(ctx);
      if (!session?.workspaceDir) {
        return { ok: false, data: { error: 'Session workspace is not available' } };
      }
      const scope = typeof args.scope === 'string' ? args.scope.toLowerCase() : '';
      const depth = typeof args.depth === 'number' && Number.isFinite(args.depth) ? Math.max(1, Math.floor(args.depth)) : 4;
      const tree: Record<string, Record<string, number>> = {};
      for (const entry of await readAllCaptures(session.workspaceDir)) {
        if (getEnumerationWorkerUrlBlockReason(session, entry.request.url)) {
          continue;
        }
        const url = parseUrlOrNull(entry.request.url);
        if (!url) {
          continue;
        }
        if (scope && !url.hostname.toLowerCase().includes(scope)) {
          continue;
        }
        const segments = url.pathname.split('/').filter(Boolean).slice(0, depth);
        const key = `/${segments.join('/')}`;
        tree[url.hostname] = tree[url.hostname] ?? {};
        tree[url.hostname][key || '/'] = (tree[url.hostname][key || '/'] ?? 0) + 1;
      }
      return { ok: true, data: { sitemap: tree } };
    }, {}, {});
  },
};

export const tools: ToolModuleDefinition[] = [HttpList, HttpView, HttpRepeat, HttpSitemap].map(fromToolImpl);
