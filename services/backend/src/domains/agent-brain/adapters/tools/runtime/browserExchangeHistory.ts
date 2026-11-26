import * as fs from 'fs/promises';
import * as path from 'path';

export const BROWSER_EXCHANGE_REFERENCE_PREFIX = 'browser-network:';
export const BROWSER_EXCHANGE_DIR = '.artifacts/browser/exchanges';

export type BrowserExchangeHeader = {
  name: string;
  value: string;
};

/**
 * Durable, tool-recorded HTTP exchange captured through the live browser
 * context (the browser cookie jar applies, so ambient authority is real).
 * Persisted by browser_action capture_exchange and consumed by security-ops
 * evidence resolvers. Sensitive header values are redacted at capture time,
 * so artifacts never carry raw credential material.
 */
export type BrowserExchangeRecord = {
  id: string;
  capturedAt: string;
  kind: 'http_exchange';
  source: 'browser';
  label?: string;
  durationMs?: number;
  request: {
    method: string;
    url: string;
    contentType?: string;
    headers?: BrowserExchangeHeader[];
    body?: string;
  };
  response: {
    statusCode: number;
    contentType?: string;
    headers?: BrowserExchangeHeader[];
    body?: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseHeaders = (value: unknown): BrowserExchangeHeader[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const headers: BrowserExchangeHeader[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.name === 'string' && typeof entry.value === 'string') {
      headers.push({ name: entry.name, value: entry.value });
    }
  }
  return headers.length > 0 ? headers : undefined;
};

const parseBrowserExchangeRecord = (value: unknown): BrowserExchangeRecord | null => {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.response)) {
    return null;
  }
  if (typeof value.id !== 'string' || typeof value.capturedAt !== 'string') {
    return null;
  }
  if (typeof value.request.method !== 'string' || typeof value.request.url !== 'string') {
    return null;
  }
  if (typeof value.response.statusCode !== 'number' || !Number.isFinite(value.response.statusCode)) {
    return null;
  }
  const requestHeaders = parseHeaders(value.request.headers);
  const responseHeaders = parseHeaders(value.response.headers);
  return {
    id: value.id,
    capturedAt: value.capturedAt,
    kind: 'http_exchange',
    source: 'browser',
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? { durationMs: value.durationMs }
      : {}),
    request: {
      method: value.request.method,
      url: value.request.url,
      ...(typeof value.request.contentType === 'string' ? { contentType: value.request.contentType } : {}),
      ...(requestHeaders ? { headers: requestHeaders } : {}),
      ...(typeof value.request.body === 'string' ? { body: value.request.body } : {}),
    },
    response: {
      statusCode: value.response.statusCode,
      ...(typeof value.response.contentType === 'string' ? { contentType: value.response.contentType } : {}),
      ...(responseHeaders ? { headers: responseHeaders } : {}),
      ...(typeof value.response.body === 'string' ? { body: value.response.body } : {}),
    },
  };
};

export const readBrowserExchangeRecords = async (
  workspaceDir: string,
): Promise<BrowserExchangeRecord[]> => {
  const dir = path.resolve(workspaceDir, BROWSER_EXCHANGE_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const records: BrowserExchangeRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      const record = parseBrowserExchangeRecord(
        JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')),
      );
      if (record) {
        records.push(record);
      }
    } catch {
      // Skip unreadable or malformed artifacts; reference resolution just misses them.
    }
  }
  return records;
};

export const findBrowserExchangeRecord = async (
  workspaceDir: string,
  id: string,
): Promise<BrowserExchangeRecord | undefined> => {
  const records = await readBrowserExchangeRecords(workspaceDir);
  return records.find((record) => record.id === id);
};
