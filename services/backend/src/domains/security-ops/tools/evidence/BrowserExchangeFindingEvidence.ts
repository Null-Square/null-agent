import {
  BROWSER_EXCHANGE_REFERENCE_PREFIX,
  readBrowserExchangeRecords,
  type BrowserExchangeRecord,
} from '@/domains/agent-brain/adapters/tools/runtime/browserExchangeHistory';
import type {
  StructuredHttpEvidenceInput,
} from '@/domains/security-ops/tools/evidence/EvidenceResolver';

export type BrowserExchangeFindingEvidence = {
  aliases: string[];
  input: StructuredHttpEvidenceInput;
};

const normalizeReference = (value: string): string => value.trim();

const exchangeIdFromReference = (reference: string): string => {
  const normalized = normalizeReference(reference);
  return normalized.toLowerCase().startsWith(BROWSER_EXCHANGE_REFERENCE_PREFIX)
    ? normalized.slice(BROWSER_EXCHANGE_REFERENCE_PREFIX.length)
    : normalized;
};

const recordIsCurrentSession = (record: BrowserExchangeRecord, sessionStartedAt: number): boolean => {
  const capturedAt = Date.parse(record.capturedAt);
  return Number.isFinite(capturedAt) && capturedAt >= sessionStartedAt;
};

const toStructuredEvidence = (record: BrowserExchangeRecord): StructuredHttpEvidenceInput => ({
  kind: 'http_exchange',
  ...(record.label ? { label: record.label } : {}),
  source: 'browser',
  ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
  request: {
    method: record.request.method,
    url: record.request.url,
    ...(record.request.contentType ? { contentType: record.request.contentType } : {}),
    ...(record.request.headers ? { headers: record.request.headers } : {}),
    ...(record.request.body !== undefined ? { body: record.request.body } : {}),
  },
  response: {
    statusCode: record.response.statusCode,
    ...(record.response.contentType ? { contentType: record.response.contentType } : {}),
    ...(record.response.headers ? { headers: record.response.headers } : {}),
    ...(record.response.body !== undefined ? { body: record.response.body } : {}),
  },
});

/**
 * Materializes durable browser exchanges captured by browser_action
 * capture_exchange. Unlike the in-memory browser network buffer, these
 * artifacts survive session eviction and carry source: 'browser', which the
 * CORS validation gate requires for credentialed-read proof.
 */
export const resolveBrowserExchangeEvidence = async (params: {
  workspaceDir: string;
  evidenceReferences: readonly string[];
  sessionStartedAt?: number;
}): Promise<BrowserExchangeFindingEvidence[]> => {
  if (params.evidenceReferences.length === 0) {
    return [];
  }

  const requestedReferencesById = new Map<string, Set<string>>();
  for (const rawReference of params.evidenceReferences) {
    const reference = normalizeReference(rawReference);
    const id = exchangeIdFromReference(reference);
    if (!id) continue;
    const references = requestedReferencesById.get(id) ?? new Set<string>();
    references.add(reference);
    references.add(id);
    references.add(`${BROWSER_EXCHANGE_REFERENCE_PREFIX}${id}`);
    requestedReferencesById.set(id, references);
  }

  const records = await readBrowserExchangeRecords(params.workspaceDir);
  const resolved: BrowserExchangeFindingEvidence[] = [];
  const seenIds = new Set<string>();
  for (const record of records) {
    const aliases = requestedReferencesById.get(record.id);
    if (!aliases || seenIds.has(record.id)) {
      continue;
    }
    if (
      params.sessionStartedAt !== undefined
      && Number.isFinite(params.sessionStartedAt)
      && !recordIsCurrentSession(record, params.sessionStartedAt)
    ) {
      continue;
    }
    seenIds.add(record.id);
    resolved.push({
      aliases: Array.from(aliases),
      input: toStructuredEvidence(record),
    });
  }
  return resolved;
};
