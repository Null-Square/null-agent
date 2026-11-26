import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '@/shared/logger';

export const HTTP_HISTORY_FILE_NAME = '.http-history.ndjson';

export interface HttpHistoryRequestOptions {
  timeout?: number;
  follow_redirects?: boolean;
  insecure?: boolean;
}

export interface HttpHistoryRequestEnvelope {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  options?: HttpHistoryRequestOptions;
}

export interface HttpHistoryEntry {
  id: string;
  ts: string;
  request: HttpHistoryRequestEnvelope;
  success?: boolean;
  status_code: number | null;
  response_time_ms?: number;
  body_size: number;
  body_truncated: boolean;
  body_preview: string;
  response_body: string;
  response_headers: string;
  security_observations?: string[];
  curl_error?: string;
  replayed_from?: string;
  modifications_applied?: Record<string, unknown>;
}

const historyLog = logger.child({ scope: 'httpHistory' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
};

const isRequestOptions = (value: unknown): value is HttpHistoryRequestOptions => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(([key, entry]) => {
    if (key === 'timeout') {
      return typeof entry === 'number' && Number.isFinite(entry);
    }
    if (key === 'follow_redirects' || key === 'insecure') {
      return typeof entry === 'boolean';
    }
    return false;
  });
};

const toHistoryPath = (workspaceDir: string): string =>
  path.resolve(workspaceDir, HTTP_HISTORY_FILE_NAME);

const parseEntry = (line: string): HttpHistoryEntry | null => {
  if (!line.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const request = parsed.request;
    if (!isRecord(request) || typeof parsed.id !== 'string' || typeof parsed.ts !== 'string') {
      return null;
    }
    if (
      typeof request.method !== 'string' ||
      typeof request.url !== 'string' ||
      !isStringMap(request.headers) ||
      typeof parsed.body_size !== 'number' ||
      typeof parsed.body_truncated !== 'boolean' ||
      typeof parsed.body_preview !== 'string' ||
      typeof parsed.response_body !== 'string' ||
      typeof parsed.response_headers !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      ts: parsed.ts,
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers,
        ...(typeof request.body === 'string' && request.body.length > 0 ? { body: request.body } : {}),
        ...(isRequestOptions(request.options) ? { options: request.options } : {}),
      },
      ...(typeof parsed.success === 'boolean' ? { success: parsed.success } : {}),
      status_code:
        typeof parsed.status_code === 'number' && Number.isFinite(parsed.status_code)
          ? parsed.status_code
          : null,
      ...(typeof parsed.response_time_ms === 'number' && Number.isFinite(parsed.response_time_ms)
        ? { response_time_ms: parsed.response_time_ms }
        : {}),
      body_size: parsed.body_size,
      body_truncated: parsed.body_truncated,
      body_preview: parsed.body_preview,
      response_body: parsed.response_body,
      response_headers: parsed.response_headers,
      ...(Array.isArray(parsed.security_observations)
        ? {
            security_observations: parsed.security_observations.filter(
              (entry): entry is string => typeof entry === 'string' && entry.length > 0,
            ),
          }
        : {}),
      ...(typeof parsed.curl_error === 'string' && parsed.curl_error.length > 0
        ? { curl_error: parsed.curl_error }
        : {}),
      ...(typeof parsed.replayed_from === 'string' && parsed.replayed_from.length > 0
        ? { replayed_from: parsed.replayed_from }
        : {}),
      ...(isRecord(parsed.modifications_applied)
        ? { modifications_applied: parsed.modifications_applied }
        : {}),
    };
  } catch (error) {
    historyLog.warn({ err: error }, 'Failed to parse HTTP history line');
    return null;
  }
};

export async function appendHttpHistoryEntry(
  workspaceDir: string,
  entry: HttpHistoryEntry,
): Promise<void> {
  const historyPath = toHistoryPath(workspaceDir);
  const serialized = JSON.stringify(entry);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${serialized}\n`, 'utf8');
}

export async function readHttpHistoryEntries(workspaceDir: string): Promise<HttpHistoryEntry[]> {
  const historyPath = toHistoryPath(workspaceDir);

  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => parseEntry(line))
      .filter((entry): entry is HttpHistoryEntry => entry !== null);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function findHttpHistoryEntry(
  workspaceDir: string,
  requestId: string,
): Promise<HttpHistoryEntry | undefined> {
  const entries = await readHttpHistoryEntries(workspaceDir);
  return entries.find((entry) => entry.id === requestId);
}
