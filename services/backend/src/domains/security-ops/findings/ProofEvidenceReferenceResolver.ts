import { promises as fs } from 'fs';
import path from 'path';

import { findHttpHistoryEntry } from '@/domains/agent-brain/adapters/tools/runtime/httpHistory';
import {
  BROWSER_EXCHANGE_REFERENCE_PREFIX,
  findBrowserExchangeRecord,
} from '@/domains/agent-brain/adapters/tools/runtime/browserExchangeHistory';
import { resolveEvidencePath } from '@/domains/security-ops/tools/evidence/EvidenceResolver';

export type ProofEvidenceSourceType =
  | 'known_evidence'
  | 'compliance_evidence'
  | 'raw_http'
  | 'http_history'
  | 'browser_exchange'
  | 'workspace_file'
  | 'unresolved';

export type ResolvedProofEvidenceFile = {
  relativePath: string;
  mimeType: string;
  content: Buffer;
};

export type ProofEvidenceResolution = {
  originalReference: string;
  normalizedReference: string;
  resolutionStatus: 'resolved' | 'unresolved' | 'oversized';
  sourceType: ProofEvidenceSourceType;
  sourceRef: string;
  files: ResolvedProofEvidenceFile[];
  redacted: boolean;
  warning: string | null;
};

const MAX_PROOF_FILE_BYTES = 8 * 1024 * 1024;
const SENSITIVE_HTTP_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

const mimeTypeForPath = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return 'application/json';
  if (extension === '.ndjson') return 'application/x-ndjson';
  if (extension === '.md') return 'text/markdown';
  if (extension === '.txt' || extension === '.log') return 'text/plain';
  if (extension === '.html') return 'text/html';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.csv') return 'text/csv';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

const readBoundedFile = async (
  absolutePath: string,
  relativePath: string,
  includeContent: boolean,
): Promise<ResolvedProofEvidenceFile | null> => {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > MAX_PROOF_FILE_BYTES) return null;
  return {
    relativePath,
    mimeType: mimeTypeForPath(relativePath),
    content: includeContent ? await fs.readFile(absolutePath) : Buffer.alloc(0),
  };
};

const redactHttpHistoryEntry = (entry: Awaited<ReturnType<typeof findHttpHistoryEntry>>): unknown => {
  if (!entry) return null;
  return {
    ...entry,
    request: {
      ...entry.request,
      headers: Object.fromEntries(
        Object.entries(entry.request.headers).map(([name, value]) => [
          name,
          SENSITIVE_HTTP_HEADERS.has(name.toLowerCase()) ? '[REDACTED]' : value,
        ]),
      ),
    },
  };
};

export const normalizeProofEvidenceId = (value: string): string => {
  let normalized = value.trim().replace(/\\/g, '/');
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
  } else if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  }
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

export const resolveProofEvidenceReference = async (params: {
  workspaceDir: string;
  evidenceId: string;
  knownEvidenceIds?: ReadonlySet<string>;
  includeContent?: boolean;
}): Promise<ProofEvidenceResolution> => {
  const normalized = normalizeProofEvidenceId(params.evidenceId);
  const includeContent = params.includeContent !== false;
  const base = {
    originalReference: params.evidenceId,
    normalizedReference: normalized,
    sourceRef: normalized,
  };
  if (params.knownEvidenceIds?.has(params.evidenceId) || params.knownEvidenceIds?.has(normalized)) {
    return {
      ...base,
      resolutionStatus: 'resolved',
      sourceType: 'known_evidence',
      files: [],
      redacted: false,
      warning: null,
    };
  }

  const rawHttpMatch = /^raw-http:([a-z0-9_-]+)$/iu.exec(normalized);
  if (rawHttpMatch?.[1]) {
    const artifactRoot = path.resolve(params.workspaceDir, '.artifacts', 'raw-http', rawHttpMatch[1]);
    try {
      const names = await fs.readdir(artifactRoot);
      const files: ResolvedProofEvidenceFile[] = [];
      let oversized = false;
      for (const name of names.sort()) {
        const absolutePath = path.resolve(artifactRoot, name);
        if (path.dirname(absolutePath) !== artifactRoot) continue;
        const file = await readBoundedFile(absolutePath, name, includeContent);
        if (file) files.push(file);
        else oversized = true;
      }
      if (files.some((file) => file.relativePath === 'manifest.json')) {
        return {
          ...base,
          resolutionStatus: oversized ? 'oversized' : 'resolved',
          sourceType: 'raw_http',
          files,
          redacted: false,
          warning: oversized ? 'One or more raw HTTP files exceeded the per-file bundle limit.' : null,
        };
      }
    } catch {
      // Return the canonical unresolved result below.
    }
  }

  const httpHistoryId = /^http:([a-z0-9_-]+)$/iu.exec(normalized)?.[1] ?? normalized;
  if (/^[a-z0-9][a-z0-9_-]{5,}$/iu.test(httpHistoryId)) {
    try {
      const entry = await findHttpHistoryEntry(params.workspaceDir, httpHistoryId);
      if (entry) {
        return {
          ...base,
          resolutionStatus: 'resolved',
          sourceType: 'http_history',
          files: [{
            relativePath: `${httpHistoryId}.json`,
            mimeType: 'application/json',
            content: includeContent
              ? Buffer.from(JSON.stringify(redactHttpHistoryEntry(entry), null, 2), 'utf8')
              : Buffer.alloc(0),
          }],
          redacted: true,
          warning: 'Sensitive HTTP request headers were redacted from the portable evidence copy.',
        };
      }
    } catch {
      // Fall through to workspace artifact resolution.
    }
  }

  const browserExchangeId = normalized.toLowerCase().startsWith(BROWSER_EXCHANGE_REFERENCE_PREFIX)
    ? normalized.slice(BROWSER_EXCHANGE_REFERENCE_PREFIX.length)
    : null;
  if (browserExchangeId) {
    try {
      const record = await findBrowserExchangeRecord(params.workspaceDir, browserExchangeId);
      if (record) {
        return {
          ...base,
          resolutionStatus: 'resolved',
          sourceType: 'browser_exchange',
          files: [{
            relativePath: `${record.id}.json`,
            mimeType: 'application/json',
            content: includeContent
              ? Buffer.from(JSON.stringify(record, null, 2), 'utf8')
              : Buffer.alloc(0),
          }],
          redacted: true,
          warning: 'Sensitive HTTP headers were redacted when the browser exchange was captured.',
        };
      }
    } catch {
      // Fall through to workspace artifact resolution.
    }
  }

  if (
    normalized.startsWith('.artifacts/') ||
    normalized.startsWith('artifacts/') ||
    normalized.startsWith('evidence/')
  ) {
    try {
      const { absolutePath } = resolveEvidencePath(normalized, params.workspaceDir);
      const file = await readBoundedFile(absolutePath, path.basename(normalized), includeContent);
      if (file) {
        return {
          ...base,
          resolutionStatus: 'resolved',
          sourceType: 'workspace_file',
          files: [file],
          redacted: false,
          warning: null,
        };
      }
      return {
        ...base,
        resolutionStatus: 'oversized',
        sourceType: 'workspace_file',
        files: [],
        redacted: false,
        warning: 'Workspace evidence exceeded the per-file bundle limit.',
      };
    } catch {
      // Return the canonical unresolved result below.
    }
  }

  return {
    ...base,
    resolutionStatus: 'unresolved',
    sourceType: 'unresolved',
    files: [],
    redacted: false,
    warning: 'Evidence reference could not be resolved from known evidence, HTTP history, raw HTTP, or the session workspace.',
  };
};

export const proofEvidenceIdIsResolvable = async (params: {
  workspaceDir: string;
  evidenceId: string;
  knownEvidenceIds?: ReadonlySet<string>;
}): Promise<boolean> => {
  const resolution = await resolveProofEvidenceReference({ ...params, includeContent: false });
  return resolution.resolutionStatus !== 'unresolved';
};

export const assertProofEvidenceIdsResolvable = async (params: {
  workspaceDir: string;
  evidenceIds: string[];
  knownEvidenceIds?: ReadonlySet<string>;
  errorPrefix: string;
}): Promise<void> => {
  const unresolved: string[] = [];
  for (const evidenceId of params.evidenceIds) {
    if (!(await proofEvidenceIdIsResolvable({
      workspaceDir: params.workspaceDir,
      evidenceId,
      knownEvidenceIds: params.knownEvidenceIds,
    }))) {
      unresolved.push(evidenceId);
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `${params.errorPrefix}: proof.evidenceIds include unresolved reference(s): ${unresolved.join(', ')}. ` +
        'Use finding evidence paths, structured HTTP exchange IDs, raw-http:<exchangeId> with a persisted manifest, browser-network:<exchangeId> from browser_action capture_exchange, or a workspace artifact path.',
    );
  }
};
