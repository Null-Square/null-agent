import {
  readHttpHistoryEntries,
  type HttpHistoryEntry,
} from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import type {
  StructuredHttpEvidenceInput,
} from '@/domains/security-ops/tools/evidence/EvidenceResolver';

export type CurrentSessionHttpHistoryEvidence = {
  aliases: string[];
  input: StructuredHttpEvidenceInput;
};

const normalizeReference = (value: string): string => value.trim();

const historyIdFromReference = (reference: string): string => {
  const normalized = normalizeReference(reference);
  return normalized.toLowerCase().startsWith('http:')
    ? normalized.slice('http:'.length)
    : normalized;
};

const parseHeaders = (raw: string): Array<{ name: string; value: string }> => {
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name && value) headers.push({ name, value });
  }
  return headers;
};

const requestHeaders = (
  entry: HttpHistoryEntry,
): Array<{ name: string; value: string }> =>
  Object.entries(entry.request.headers).map(([name, value]) => ({ name, value }));

const entryIsCurrentSession = (entry: HttpHistoryEntry, sessionStartedAt: number): boolean => {
  const capturedAt = Date.parse(entry.ts);
  return Number.isFinite(capturedAt) && capturedAt >= sessionStartedAt;
};

const toStructuredEvidence = (entry: HttpHistoryEntry): StructuredHttpEvidenceInput | null => {
  if (entry.status_code === null) return null;
  return {
    kind: 'http_exchange',
    label: `${entry.request.method.toUpperCase()} ${entry.request.url}`,
    source: 'request_tool',
    ...(entry.response_time_ms !== undefined ? { durationMs: entry.response_time_ms } : {}),
    request: {
      method: entry.request.method,
      url: entry.request.url,
      ...(requestHeaders(entry).length > 0 ? { headers: requestHeaders(entry) } : {}),
      ...(entry.request.body !== undefined ? { body: entry.request.body } : {}),
    },
    response: {
      statusCode: entry.status_code,
      ...(parseHeaders(entry.response_headers).length > 0
        ? { headers: parseHeaders(entry.response_headers) }
        : {}),
      ...(entry.response_body ? { body: entry.response_body } : {}),
    },
  };
};

/**
 * Materializes only HTTP history entries produced after this agent session
 * started. A focused verification can therefore cite http_payload's
 * history_entry_id directly without accepting stale evidence from a prior
 * phase or session that shares the same Run workspace.
 */
export const resolveCurrentSessionHttpHistoryEvidence = async (params: {
  workspaceDir: string;
  evidenceReferences: readonly string[];
  sessionStartedAt: number;
}): Promise<CurrentSessionHttpHistoryEvidence[]> => {
  if (!Number.isFinite(params.sessionStartedAt) || params.evidenceReferences.length === 0) {
    return [];
  }

  const requestedReferencesById = new Map<string, Set<string>>();
  for (const rawReference of params.evidenceReferences) {
    const reference = normalizeReference(rawReference);
    const id = historyIdFromReference(reference);
    if (!id) continue;
    const references = requestedReferencesById.get(id) ?? new Set<string>();
    references.add(reference);
    references.add(id);
    references.add(`http:${id}`);
    requestedReferencesById.set(id, references);
  }

  const history = await readHttpHistoryEntries(params.workspaceDir);
  const resolved: CurrentSessionHttpHistoryEvidence[] = [];
  const seenIds = new Set<string>();
  for (const entry of history) {
    const aliases = requestedReferencesById.get(entry.id);
    if (!aliases || seenIds.has(entry.id) || !entryIsCurrentSession(entry, params.sessionStartedAt)) {
      continue;
    }
    const input = toStructuredEvidence(entry);
    if (!input) continue;
    seenIds.add(entry.id);
    resolved.push({
      aliases: Array.from(aliases),
      input,
    });
  }
  return resolved;
};
