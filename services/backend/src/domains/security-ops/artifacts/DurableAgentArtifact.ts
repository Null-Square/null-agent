import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { DatabaseClient } from '@/db/client';
import { agentArtifacts } from '@/db/schema';

const safePathPart = (value: string): string => {
  const normalized = value.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return normalized.slice(0, 120) || 'artifact';
};

const defaultArtifactStorageRoot = (): string =>
  path.resolve(process.cwd(), process.env.WORKSPACE_ARTIFACTS_ROOT ?? 'storage/artifacts');

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

export type PersistDurableAgentArtifactResult = {
  id: string;
  filePath: string;
  originalName: string;
  sha256: string;
};

export const normalizeDurableArtifactOriginalName = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/u, '');
  return normalized || 'artifact';
};

export const persistDurableAgentArtifactBuffer = async (params: {
  db: DatabaseClient;
  sessionId: string;
  originalName: string;
  content: Buffer;
  fileType?: string | null;
  artifactStorageRoot?: string;
}): Promise<PersistDurableAgentArtifactResult> => {
  const root = path.resolve(process.cwd(), params.artifactStorageRoot ?? defaultArtifactStorageRoot());
  const originalName = normalizeDurableArtifactOriginalName(params.originalName);
  const sha256 = createHash('sha256').update(params.content).digest('hex');
  const parts = originalName.split('/').filter(Boolean).map(safePathPart);
  const basename = parts.pop() ?? 'artifact';
  const relativeDir = path.posix.join(params.sessionId, ...parts);
  const relativePath = path.posix.join(relativeDir, `${sha256.slice(0, 16)}-${basename}`);
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('Refusing to persist artifact outside artifact storage root');
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, params.content);
  const [row] = await params.db.insert(agentArtifacts).values({
    sessionId: params.sessionId,
    filePath: relativePath,
    originalName,
    fileType: params.fileType ?? mimeTypeForPath(originalName),
    sizeBytes: params.content.length,
  }).returning({ id: agentArtifacts.id });
  if (!row) {
    throw new Error('Failed to persist durable agent artifact');
  }
  return { id: row.id, filePath: relativePath, originalName, sha256 };
};

export const persistDurableAgentArtifactFile = async (params: {
  db: DatabaseClient;
  sessionId: string;
  absolutePath: string;
  originalName: string;
  fileType?: string | null;
  artifactStorageRoot?: string;
}): Promise<PersistDurableAgentArtifactResult | null> => {
  const stat = await fs.stat(params.absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }
  const content = await fs.readFile(params.absolutePath);
  return persistDurableAgentArtifactBuffer({
    db: params.db,
    sessionId: params.sessionId,
    originalName: params.originalName,
    content,
    fileType: params.fileType,
    artifactStorageRoot: params.artifactStorageRoot,
  });
};
