import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildHttpBodyPreview,
  buildStructuredHttpEvidenceDisplayPath,
  buildStructuredHttpEvidencePath,
  redactFindingHttpHeaders,
  type FindingCodeLocation,
  type FindingHttpExchange,
  type FindingHttpEvidenceSource,
} from '@/domains/security-ops/findings/findingContracts';
import type { CodeSourceService } from '@/domains/security-ops/code-sources/CodeSourceService';
import { logger } from '@/shared/logger';
import { normalizeAndValidatePath } from '@/shared/utils/path-utils';

export type EvidenceRefInput = {
  path: string;
  label?: string;
};

export type EvidenceWithExcerptInput = EvidenceRefInput & {
  excerpt?: string;
};

type HttpHeaderInput = {
  name: string;
  value: string;
  redacted?: boolean;
};

export type StructuredHttpEvidenceInput = {
  kind: 'http_exchange';
  label?: string;
  source?: string;
  durationMs?: number;
  request: {
    method: string;
    url: string;
    contentType?: string;
    headers?: HttpHeaderInput[];
    body?: string;
  };
  response: {
    statusCode: number;
    contentType?: string;
    headers?: HttpHeaderInput[];
    body?: string;
  };
};

export type FindingEvidenceInput = EvidenceWithExcerptInput | StructuredHttpEvidenceInput;

export type FindingCodeLocationInput = {
  pathKind: 'repository' | 'workspace';
  repository?: string | null;
  ref?: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  label?: string | null;
  fixBefore: string;
  fixAfter: string;
};

export type ResolvedEvidence = {
  relativePath: string;
  absolutePath: string;
};

export type ResolvedEvidenceRef = EvidenceRefInput & { path: string };
export type ResolvedEvidenceWithExcerpt = EvidenceWithExcerptInput & {
  path: string;
  fileMissing?: boolean;
};

export type ResolvedArtifactFindingEvidence = ResolvedEvidenceWithExcerpt & {
  kind: 'artifact';
  displayPath: string;
};

export type ResolvedStructuredHttpFindingEvidence = {
  kind: 'http_exchange';
  path: string;
  displayPath: string;
  label?: string;
  data: FindingHttpExchange;
};

export type ResolvedFindingEvidence = ResolvedArtifactFindingEvidence | ResolvedStructuredHttpFindingEvidence;

export type SecurityOpsEvidenceResolverDeps = {
  /** The scope's code source, which names the one repository a finding may point into. */
  codeSourceService?: Pick<CodeSourceService, 'listScopeRepositories'>;
};

const normalizeToolText = (value: string): string => value.trim();

const normalizeOptionalToolText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeToolText(value);
  return normalized.length > 0 ? normalized : undefined;
};

const isMissingFileError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code === 'ENOENT';
};

export const resolveEvidencePath = (rawPath: string, workspaceDir: string): ResolvedEvidence => {
  const trimmed = normalizeToolText(rawPath);
  if (!trimmed) {
    throw new Error('evidence.path is required');
  }

  // Accept container-style paths from prompts/tasks.
  let candidate = trimmed;
  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  } else if (candidate.startsWith('workspace/')) {
    candidate = candidate.slice('workspace/'.length);
  }

  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }

  const absolutePath = normalizeAndValidatePath(candidate, workspaceDir);
  const relativePath = path.relative(workspaceDir, absolutePath).replace(/\\/g, '/');

  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
    throw new Error(`Evidence path resolves outside workspace: ${rawPath}`);
  }

  return { relativePath, absolutePath };
};

const normalizeRepositoryRelativePath = (rawPath: string): string => {
  let candidate = normalizeToolText(rawPath).replace(/\\/g, '/');
  if (!candidate) {
    throw new Error('filePath is required');
  }
  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }
  if (!candidate || candidate === '.' || candidate.split('/').some((segment) => segment === '..')) {
    throw new Error(`Invalid repository-relative filePath: ${rawPath}`);
  }
  return candidate;
};

const resolveWorkspaceCodeLocationPath = (rawPath: string, workspaceDir: string): string => {
  const trimmed = normalizeToolText(rawPath);
  if (!trimmed) {
    throw new Error('filePath is required');
  }

  let candidate = trimmed;
  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  } else if (candidate.startsWith('workspace/')) {
    candidate = candidate.slice('workspace/'.length);
  }
  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }

  const absolutePath = normalizeAndValidatePath(candidate, workspaceDir);
  const relativePath = path.relative(workspaceDir, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
    throw new Error(`Code location resolves outside workspace: ${rawPath}`);
  }
  return relativePath;
};

export const buildCodeLocationKey = (location: FindingCodeLocation): string =>
  [
    location.pathKind,
    location.repository ?? '',
    location.ref ?? '',
    location.filePath,
    String(location.startLine),
    String(location.endLine),
  ].join(':');

const isStructuredHttpEvidenceInput = (
  value: FindingEvidenceInput,
): value is StructuredHttpEvidenceInput =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'http_exchange';

export class SecurityOpsEvidenceResolver {
  constructor(private readonly deps: SecurityOpsEvidenceResolverDeps = {}) {}

  async resolveEvidenceRefs(
    workspaceDir: string,
    evidence: EvidenceRefInput[] | undefined,
  ): Promise<ResolvedEvidenceRef[]> {
    if (!evidence || evidence.length === 0) {
      return [];
    }
    const resolved: ResolvedEvidenceRef[] = [];
    for (const item of evidence) {
      const { relativePath, absolutePath } = resolveEvidencePath(item.path, workspaceDir);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error(`Evidence path is not a file: ${item.path}`);
      }
      resolved.push({
        path: relativePath,
        ...(item.label ? { label: normalizeToolText(item.label) } : {}),
      });
    }
    return resolved;
  }

  async resolveEvidenceWithExcerpts(
    workspaceDir: string,
    evidence: EvidenceWithExcerptInput[],
  ): Promise<ResolvedEvidenceWithExcerpt[]> {
    const resolved: ResolvedEvidenceWithExcerpt[] = [];
    for (const item of evidence) {
      const { relativePath, absolutePath } = resolveEvidencePath(item.path, workspaceDir);
      const normalizedLabel = normalizeOptionalToolText(item.label);
      const normalizedExcerpt = normalizeOptionalToolText(item.excerpt);

      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) {
          throw new Error(`Evidence path is not a file: ${item.path}`);
        }
        resolved.push({
          path: relativePath,
          ...(normalizedLabel ? { label: normalizedLabel } : {}),
          ...(normalizedExcerpt ? { excerpt: normalizedExcerpt } : {}),
        });
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        if (normalizedExcerpt) {
          logger.warn(
            { evidencePath: item.path, relativePath },
            '[security-ops] Missing evidence file; storing excerpt-only evidence',
          );
          resolved.push({
            path: relativePath,
            ...(normalizedLabel ? { label: normalizedLabel } : {}),
            excerpt: normalizedExcerpt,
            fileMissing: true,
          });
          continue;
        }

        logger.warn(
          { evidencePath: item.path, relativePath },
          '[security-ops] Missing evidence file without excerpt; skipping evidence entry',
        );
      }
    }
    return resolved;
  }

  normalizeStructuredHttpEvidence(input: StructuredHttpEvidenceInput): ResolvedStructuredHttpFindingEvidence {
    const method = normalizeToolText(input.request.method).toUpperCase();
    const url = normalizeToolText(input.request.url);
    if (!method) {
      throw new Error('http_exchange request.method is required');
    }
    if (!url) {
      throw new Error('http_exchange request.url is required');
    }

    const responseStatusCode = input.response.statusCode;
    const http: FindingHttpExchange = {
      ...(input.source ? { source: input.source as FindingHttpEvidenceSource } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      request: {
        method,
        url,
        ...(input.request.contentType ? { contentType: normalizeToolText(input.request.contentType) } : {}),
        ...(redactFindingHttpHeaders(input.request.headers) ? { headers: redactFindingHttpHeaders(input.request.headers) } : {}),
        ...(buildHttpBodyPreview(input.request.body) ? { body: buildHttpBodyPreview(input.request.body) } : {}),
      },
      response: {
        statusCode: responseStatusCode,
        ...(input.response.contentType ? { contentType: normalizeToolText(input.response.contentType) } : {}),
        ...(redactFindingHttpHeaders(input.response.headers)
          ? { headers: redactFindingHttpHeaders(input.response.headers) }
          : {}),
        ...(buildHttpBodyPreview(input.response.body) ? { body: buildHttpBodyPreview(input.response.body) } : {}),
      },
    };

    const displayPath = buildStructuredHttpEvidenceDisplayPath(method, url);
    return {
      kind: 'http_exchange',
      path: buildStructuredHttpEvidencePath(http),
      displayPath,
      ...(input.label ? { label: normalizeToolText(input.label) } : {}),
      data: http,
    };
  }

  async resolveFindingEvidenceEntries(
    workspaceDir: string,
    evidence: FindingEvidenceInput[],
  ): Promise<ResolvedFindingEvidence[]> {
    const resolved: ResolvedFindingEvidence[] = [];
    for (const item of evidence) {
      if (isStructuredHttpEvidenceInput(item)) {
        resolved.push(this.normalizeStructuredHttpEvidence(item));
        continue;
      }

      const { relativePath, absolutePath } = resolveEvidencePath(item.path, workspaceDir);
      const normalizedLabel = normalizeOptionalToolText(item.label);
      const normalizedExcerpt = normalizeOptionalToolText(item.excerpt);

      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) {
          throw new Error(`Evidence path is not a file: ${item.path}`);
        }
        resolved.push({
          kind: 'artifact',
          path: relativePath,
          displayPath: relativePath,
          ...(normalizedLabel ? { label: normalizedLabel } : {}),
          ...(normalizedExcerpt ? { excerpt: normalizedExcerpt } : {}),
        });
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        if (normalizedExcerpt) {
          logger.warn(
            { evidencePath: item.path, relativePath },
            '[security-ops] Missing evidence file; storing excerpt-only evidence',
          );
          resolved.push({
            kind: 'artifact',
            path: relativePath,
            displayPath: relativePath,
            ...(normalizedLabel ? { label: normalizedLabel } : {}),
            excerpt: normalizedExcerpt,
            fileMissing: true,
          });
          continue;
        }

        logger.warn(
          { evidencePath: item.path, relativePath },
          '[security-ops] Missing evidence file without excerpt; skipping evidence entry',
        );
      }
    }
    return resolved;
  }

  async normalizeFindingCodeLocations(params: {
    workspaceDir: string;
    organizationId: string;
    scopeId: string;
    codeLocations?: FindingCodeLocationInput[];
  }): Promise<FindingCodeLocation[]> {
    if (!params.codeLocations || params.codeLocations.length === 0) {
      return [];
    }

    let connectedRepositories: Set<string> | null = null;
    const loadConnectedRepositories = async (): Promise<Set<string>> => {
      if (connectedRepositories) {
        return connectedRepositories;
      }
      const repositories = this.deps.codeSourceService
        ? await this.deps.codeSourceService.listScopeRepositories(params.organizationId, params.scopeId)
        : [];
      connectedRepositories = new Set(repositories.map((repository) => repository.fullName.toLowerCase()));
      return connectedRepositories;
    };

    const normalized = new Map<string, FindingCodeLocation>();
    for (const location of params.codeLocations) {
      if (location.endLine < location.startLine) {
        throw new Error(`codeLocation endLine must be >= startLine for ${location.filePath}`);
      }

      const fixBefore = normalizeToolText(location.fixBefore);
      const fixAfter = normalizeToolText(location.fixAfter);
      const label = normalizeOptionalToolText(location.label ?? undefined) ?? null;

      if (location.pathKind === 'repository') {
        const repository = normalizeOptionalToolText(location.repository ?? undefined);
        if (!repository) {
          throw new Error(`codeLocation repository is required for repository-backed file: ${location.filePath}`);
        }
        const connected = await loadConnectedRepositories();
        if (!connected.has(repository.toLowerCase())) {
          throw new Error(
            `codeLocation repository "${repository}" is not connected to this scope. Point the scope at the code first or use pathKind=workspace.`,
          );
        }

        const normalizedLocation: FindingCodeLocation = {
          pathKind: 'repository',
          repository,
          ref: normalizeOptionalToolText(location.ref ?? undefined) ?? null,
          filePath: normalizeRepositoryRelativePath(location.filePath),
          startLine: location.startLine,
          endLine: location.endLine,
          label,
          fixBefore,
          fixAfter,
        };
        normalized.set(buildCodeLocationKey(normalizedLocation), normalizedLocation);
        continue;
      }

      if (normalizeOptionalToolText(location.repository ?? undefined)) {
        throw new Error(`codeLocation repository must be null for workspace-backed file: ${location.filePath}`);
      }

      const normalizedLocation: FindingCodeLocation = {
        pathKind: 'workspace',
        repository: null,
        ref: null,
        filePath: resolveWorkspaceCodeLocationPath(location.filePath, params.workspaceDir),
        startLine: location.startLine,
        endLine: location.endLine,
        label,
        fixBefore,
        fixAfter,
      };
      normalized.set(buildCodeLocationKey(normalizedLocation), normalizedLocation);
    }

    return Array.from(normalized.values());
  }
}
