import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { ComplianceEvidenceItemRow } from '@/db/schema';

const DEFAULT_PREVIEW_CHARS = 12_000;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const COMPLIANCE_EVIDENCE_REF_PREFIX = 'compliance-evidence:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ComplianceEvidenceArtifactDescriptor = NonNullable<ComplianceEvidenceItemRow['artifact']>;

export type ComplianceEvidenceArtifactFile = {
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageRef: string | null;
  sourceRef: string | null;
};

export type ReadComplianceEvidenceArtifactResult =
  | {
      status: 'resolved';
      artifact: ComplianceEvidenceArtifactFile;
      absolutePath: string;
      content: Buffer;
      sha256: string;
      sizeBytes: number;
    }
  | {
      status: 'not_available' | 'invalid_ref' | 'missing' | 'oversized' | 'sha256_mismatch';
      artifact: ComplianceEvidenceArtifactFile;
      warning: string;
    };

export type ComplianceEvidenceTextExtraction = {
  extractionStatus: 'extracted' | 'not_requested' | 'not_available' | 'unsupported_media_type';
  textPreview: string | null;
  textTruncated: boolean;
  textRedacted: boolean;
};

export const complianceEvidenceStorageRoot = (): string =>
  path.resolve(
    process.cwd(),
    process.env.COMPLIANCE_EVIDENCE_STORAGE_ROOT ?? 'storage/compliance-evidence',
  );

export const parseComplianceEvidenceReference = (value: string): string | null => {
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith(COMPLIANCE_EVIDENCE_REF_PREFIX)
    ? trimmed.slice(COMPLIANCE_EVIDENCE_REF_PREFIX.length).trim()
    : trimmed;
  return UUID_PATTERN.test(candidate) ? candidate : null;
};

export const parseComplianceEvidenceArtifact = (
  value: unknown,
): ComplianceEvidenceArtifactFile => {
  const artifact = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    fileName: typeof artifact.fileName === 'string' ? artifact.fileName : null,
    mimeType: typeof artifact.mimeType === 'string' ? artifact.mimeType : null,
    sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : null,
    sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null,
    storageRef: typeof artifact.storageRef === 'string' ? artifact.storageRef : null,
    sourceRef: typeof artifact.sourceRef === 'string' ? artifact.sourceRef : null,
  };
};

export const resolveComplianceEvidenceStoragePath = (
  storageRef: string,
  root = complianceEvidenceStorageRoot(),
): string => {
  const normalized = storageRef.trim().replace(/\\/g, '/').replace(/^\/+/u, '');
  const storageRoot = path.resolve(root);
  const absolutePath = path.resolve(storageRoot, normalized);
  const relative = path.relative(storageRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid compliance evidence storage reference');
  }
  return absolutePath;
};

const sha256 = (content: Buffer): string =>
  createHash('sha256').update(content).digest('hex');

const fileExtension = (fileName: string | null): string =>
  fileName ? path.extname(fileName).toLowerCase() : '';

export const isTextLikeComplianceEvidence = (
  mimeType: string | null,
  fileName: string | null,
): boolean => {
  const normalizedMime = mimeType?.toLowerCase() ?? '';
  if (
    normalizedMime.startsWith('text/') ||
    [
      'application/json',
      'application/x-ndjson',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      'application/csv',
    ].includes(normalizedMime)
  ) {
    return true;
  }
  return [
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.ndjson',
    '.csv',
    '.xml',
    '.yaml',
    '.yml',
    '.log',
  ].includes(fileExtension(fileName));
};

const redactPromptUnsafeSecrets = (value: string): { text: string; redacted: boolean } => {
  let redacted = false;
  const replacements: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [REDACTED]'],
    [/\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[^"',\s;]{6,}/giu, '$1=[REDACTED]'],
    [/\b(authorization|x-api-key)\s*[:=]\s*["']?[^"',\n\r]{6,}/giu, '$1=[REDACTED]'],
  ];
  let text = value;
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, () => {
      redacted = true;
      return replacement;
    });
  }
  return { text, redacted };
};

export const extractComplianceEvidenceText = (
  result: ReadComplianceEvidenceArtifactResult,
  options: { maxChars?: number; requested?: boolean } = {},
): ComplianceEvidenceTextExtraction => {
  const requested = options.requested ?? true;
  if (!requested) {
    return {
      extractionStatus: 'not_requested',
      textPreview: null,
      textTruncated: false,
      textRedacted: false,
    };
  }
  if (result.status !== 'resolved') {
    return {
      extractionStatus: 'not_available',
      textPreview: null,
      textTruncated: false,
      textRedacted: false,
    };
  }
  if (!isTextLikeComplianceEvidence(result.artifact.mimeType, result.artifact.fileName)) {
    return {
      extractionStatus: 'unsupported_media_type',
      textPreview: null,
      textTruncated: false,
      textRedacted: false,
    };
  }

  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_CHARS;
  const raw = result.content.toString('utf8');
  const truncated = raw.length > maxChars;
  const { text, redacted } = redactPromptUnsafeSecrets(raw.slice(0, maxChars));
  return {
    extractionStatus: 'extracted',
    textPreview: text,
    textTruncated: truncated,
    textRedacted: redacted,
  };
};

export const readComplianceEvidenceArtifact = async (
  artifactValue: unknown,
  options: { maxBytes?: number; root?: string } = {},
): Promise<ReadComplianceEvidenceArtifactResult> => {
  const artifact = parseComplianceEvidenceArtifact(artifactValue);
  if (!artifact.storageRef || !artifact.fileName) {
    return {
      status: 'not_available',
      artifact,
      warning: 'Compliance evidence item has no durable uploaded file.',
    };
  }

  let absolutePath: string;
  try {
    absolutePath = resolveComplianceEvidenceStoragePath(artifact.storageRef, options.root);
  } catch (error) {
    return {
      status: 'invalid_ref',
      artifact,
      warning: error instanceof Error ? error.message : 'Invalid compliance evidence storage reference.',
    };
  }

  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return {
      status: 'missing',
      artifact,
      warning: 'Compliance evidence file is missing from storage.',
    };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  if (stat.size > maxBytes) {
    return {
      status: 'oversized',
      artifact,
      warning: `Compliance evidence file exceeds the ${maxBytes} byte read limit.`,
    };
  }

  const content = await fs.readFile(absolutePath);
  const actualSha256 = sha256(content);
  if (artifact.sha256 && artifact.sha256.toLowerCase() !== actualSha256) {
    return {
      status: 'sha256_mismatch',
      artifact,
      warning: 'Compliance evidence file hash does not match the stored evidence metadata.',
    };
  }

  return {
    status: 'resolved',
    artifact,
    absolutePath,
    content,
    sha256: actualSha256,
    sizeBytes: stat.size,
  };
};
