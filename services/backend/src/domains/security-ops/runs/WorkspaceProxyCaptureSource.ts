import { promises as fs } from 'fs';
import path from 'path';
import { inArray } from 'drizzle-orm';

import { readHttpHistoryEntries, type HttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import type { DatabaseClient } from '@/db/client';
import { agentSessions } from '@/db/schema';
import type { ProxyCaptureEvent, ProxyCaptureSourcePort } from './RunActivityService';

const PROXY_CAPTURE_FILE = '.http-proxy.ndjson';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const extractContentType = (rawHeaders: string): string | null => {
  if (!rawHeaders) return null;
  const match = rawHeaders.match(/^content-type:\s*([^\r\n;]+)/im);
  return match?.[1] ? match[1].trim().toLowerCase() : null;
};

const parseLine = (line: string): ProxyCaptureEvent | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const ts = getString(parsed.ts);
    const request = isRecord(parsed.request) ? parsed.request : null;
    const response = isRecord(parsed.response) ? parsed.response : null;
    if (!ts || !request) return null;

    const method = getString(request.method)?.toUpperCase();
    const url = getString(request.url);
    if (!method || !url) return null;

    let host: string;
    let pathName: string;
    try {
      const parsedUrl = new URL(url);
      host = parsedUrl.host.toLowerCase();
      pathName = parsedUrl.pathname || '/';
    } catch {
      return null;
    }

    const statusCode =
      response && typeof response.status_code === 'number' ? response.status_code : null;
    const rawResponseHeaders = response && typeof response.headers === 'string'
      ? response.headers
      : '';
    const contentType = extractContentType(rawResponseHeaders);
    const durationMs =
      typeof parsed.response_time_ms === 'number' && Number.isFinite(parsed.response_time_ms)
        ? parsed.response_time_ms
        : 0;

    return {
      ts,
      method,
      host,
      path: pathName,
      statusCode,
      contentType,
      durationMs,
      rawResponseHeaders,
    };
  } catch {
    return null;
  }
};

const historyEntryToCaptureEvent = (entry: HttpHistoryEntry): ProxyCaptureEvent | null => {
  const method = entry.request.method?.toUpperCase();
  const url = entry.request.url;
  if (!method || !url) return null;

  let host: string;
  let pathName: string;
  try {
    const parsedUrl = new URL(url);
    host = parsedUrl.host.toLowerCase();
    pathName = parsedUrl.pathname || '/';
  } catch {
    return null;
  }

  const rawResponseHeaders = entry.response_headers ?? '';
  const durationMs =
    typeof entry.response_time_ms === 'number' && Number.isFinite(entry.response_time_ms)
      ? entry.response_time_ms
      : 0;

  return {
    ts: entry.ts,
    method,
    host,
    path: pathName,
    statusCode: entry.status_code,
    contentType: extractContentType(rawResponseHeaders),
    durationMs,
    rawResponseHeaders,
  };
};

const readProxyCaptureFile = async (workspaceDir: string): Promise<ProxyCaptureEvent[]> => {
  const target = path.resolve(workspaceDir, PROXY_CAPTURE_FILE);
  try {
    const raw = await fs.readFile(target, 'utf8');
    const events: ProxyCaptureEvent[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      const parsed = parseLine(line);
      if (parsed) events.push(parsed);
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

const readHttpHistoryCaptureFile = async (workspaceDir: string): Promise<ProxyCaptureEvent[]> =>
  (await readHttpHistoryEntries(workspaceDir))
    .map((entry) => historyEntryToCaptureEvent(entry))
    .filter((entry): entry is ProxyCaptureEvent => entry !== null);

const readWorkspaceCaptures = async (workspaceDir: string): Promise<ProxyCaptureEvent[]> => {
  const [historyEvents, proxyEvents] = await Promise.all([
    readHttpHistoryCaptureFile(workspaceDir),
    readProxyCaptureFile(workspaceDir),
  ]);
  return [...historyEvents, ...proxyEvents];
};

export class WorkspaceProxyCaptureSource implements ProxyCaptureSourcePort {
  constructor(private readonly db: DatabaseClient) {}

  async listEventsForSessions(sessionIds: readonly string[]): Promise<ProxyCaptureEvent[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.db
      .select({ id: agentSessions.id, workspaceDir: agentSessions.workspaceDir })
      .from(agentSessions)
      .where(inArray(agentSessions.id, [...sessionIds]));

    const lists = await Promise.all(
      rows.map(async (row) => {
        try {
          return await readWorkspaceCaptures(row.workspaceDir);
        } catch {
          return [] as ProxyCaptureEvent[];
        }
      }),
    );
    return lists.flat();
  }
}
