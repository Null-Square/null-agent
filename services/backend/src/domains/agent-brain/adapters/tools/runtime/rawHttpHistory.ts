import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '@/shared/logger';

export const RAW_HTTP_HISTORY_FILE_NAME = '.raw-http-history.ndjson';
export const RAW_HTTP_ARTIFACT_ROOT = '.artifacts/raw-http';

export interface RawHttpArtifactRef {
  path: string;
  sha256: string;
  size: number;
}

export interface RawHttpHistoryEntry {
  id: string;
  ts: string;
  source: 'http_raw_send';
  target: {
    url: string;
    host: string;
    port: number;
    tls: boolean;
  };
  request_count: number;
  read_strategy: 'after_each' | 'after_all';
  status_code: number | null;
  success: boolean;
  response_time_ms: number;
  request_artifacts: RawHttpArtifactRef[];
  response_artifacts: RawHttpArtifactRef[];
  manifest_path: string;
  request_preview: string;
  response_preview: string;
  body_size: number;
  response_truncated: boolean;
  error?: string;
}

const historyLog = logger.child({ scope: 'rawHttpHistory' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isArtifactRef = (value: unknown): value is RawHttpArtifactRef => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size)
  );
};

const toHistoryPath = (workspaceDir: string): string =>
  path.resolve(workspaceDir, RAW_HTTP_HISTORY_FILE_NAME);

const parseEntry = (line: string): RawHttpHistoryEntry | null => {
  if (!line.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.target)) {
      return null;
    }

    const target = parsed.target;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.ts !== 'string' ||
      parsed.source !== 'http_raw_send' ||
      typeof target.url !== 'string' ||
      typeof target.host !== 'string' ||
      typeof target.port !== 'number' ||
      typeof target.tls !== 'boolean' ||
      typeof parsed.request_count !== 'number' ||
      (parsed.read_strategy !== 'after_each' && parsed.read_strategy !== 'after_all') ||
      typeof parsed.success !== 'boolean' ||
      typeof parsed.response_time_ms !== 'number' ||
      typeof parsed.manifest_path !== 'string' ||
      typeof parsed.request_preview !== 'string' ||
      typeof parsed.response_preview !== 'string' ||
      typeof parsed.body_size !== 'number' ||
      typeof parsed.response_truncated !== 'boolean' ||
      !Array.isArray(parsed.request_artifacts) ||
      !Array.isArray(parsed.response_artifacts)
    ) {
      return null;
    }

    const requestArtifacts = parsed.request_artifacts.filter(isArtifactRef);
    const responseArtifacts = parsed.response_artifacts.filter(isArtifactRef);

    return {
      id: parsed.id,
      ts: parsed.ts,
      source: 'http_raw_send',
      target: {
        url: target.url,
        host: target.host,
        port: target.port,
        tls: target.tls,
      },
      request_count: parsed.request_count,
      read_strategy: parsed.read_strategy,
      status_code:
        typeof parsed.status_code === 'number' && Number.isFinite(parsed.status_code)
          ? parsed.status_code
          : null,
      success: parsed.success,
      response_time_ms: parsed.response_time_ms,
      request_artifacts: requestArtifacts,
      response_artifacts: responseArtifacts,
      manifest_path: parsed.manifest_path,
      request_preview: parsed.request_preview,
      response_preview: parsed.response_preview,
      body_size: parsed.body_size,
      response_truncated: parsed.response_truncated,
      ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
    };
  } catch (error) {
    historyLog.warn({ err: error }, 'Failed to parse raw HTTP history line');
    return null;
  }
};

export async function appendRawHttpHistoryEntry(
  workspaceDir: string,
  entry: RawHttpHistoryEntry,
): Promise<void> {
  const historyPath = toHistoryPath(workspaceDir);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readRawHttpHistoryEntries(workspaceDir: string): Promise<RawHttpHistoryEntry[]> {
  const historyPath = toHistoryPath(workspaceDir);

  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    return raw
      .split(/\r?\n/u)
      .map((line) => parseEntry(line))
      .filter((entry): entry is RawHttpHistoryEntry => entry !== null);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
