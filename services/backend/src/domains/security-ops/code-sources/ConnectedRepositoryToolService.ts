import { z } from 'zod';

import type { CodeSourceService } from './CodeSourceService';

/**
 * The repository tools' input parsing and result shapes, unchanged from V3.2.
 * Only the gateway changed: the scope's code source instead of the GitHub App.
 */
export type ConnectedRepositoryGateway = Pick<
  CodeSourceService,
  | 'listScopeRepositories'
  | 'searchConnectedRepository'
  | 'readRepositoryFile'
  | 'resolveCodeReviewRepositorySnapshot'
>;

const ListConnectedRepositoriesSchema = z.object({}).optional().default({});

const SearchConnectedRepositorySchema = z.object({
  repository: z.string().min(1),
  query: z.string().min(2),
  limit: z.number().int().min(1).max(10).optional(),
});

const ReadConnectedRepositoryFileSchema = z.object({
  repository: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().min(1).optional(),
});

const ListCodeReviewRepositoryFilesSchema = z.object({
  repository: z.string().min(1),
  ref: z.string().min(1),
});

export type ListConnectedRepositoriesResult = {
  repositories: Array<{
    id: string;
    fullName: string;
    defaultBranch: string | null;
    ownerLogin: string;
    name: string;
    htmlUrl: string;
  }>;
  totalCount: number;
};

export type SearchConnectedRepositoryResult = {
  repository: string;
  results: Array<{
    repository: string;
    path: string;
    htmlUrl: string | null;
    snippet: string | null;
  }>;
};

export type ReadConnectedRepositoryFileResult = {
  repository: string;
  path: string;
  ref: string | null;
  content: string;
};

export type ListCodeReviewRepositoryFilesResult = {
  repositoryId: string;
  repository: string;
  ref: string;
  files: Array<{ path: string; blobSha: string; size: number | null }>;
  completeness: 'complete' | 'partial';
};

export class ConnectedRepositoryToolService {
  constructor(private readonly gateway: ConnectedRepositoryGateway) {}

  async listConnectedRepositories(params: {
    orgId: string;
    scopeId: string;
    input?: unknown;
  }): Promise<ListConnectedRepositoriesResult> {
    ListConnectedRepositoriesSchema.parse(params.input ?? {});
    const repositories = await this.gateway.listScopeRepositories(params.orgId, params.scopeId);
    return {
      repositories,
      totalCount: repositories.length,
    };
  }

  async searchConnectedRepository(params: {
    orgId: string;
    scopeId: string;
    input: unknown;
  }): Promise<SearchConnectedRepositoryResult> {
    const parsed = SearchConnectedRepositorySchema.parse(params.input);
    return this.gateway.searchConnectedRepository({
      orgId: params.orgId,
      scopeId: params.scopeId,
      repository: parsed.repository,
      query: parsed.query,
      limit: parsed.limit,
    });
  }

  async readConnectedRepositoryFile(params: {
    orgId: string;
    scopeId: string;
    input: unknown;
  }): Promise<ReadConnectedRepositoryFileResult> {
    const parsed = ReadConnectedRepositoryFileSchema.parse(params.input);
    return this.gateway.readRepositoryFile({
      orgId: params.orgId,
      scopeId: params.scopeId,
      repository: parsed.repository,
      path: parsed.path,
      ref: parsed.ref,
    });
  }

  async listCodeReviewRepositoryFiles(params: {
    orgId: string;
    scopeId: string;
    input: unknown;
  }): Promise<ListCodeReviewRepositoryFilesResult> {
    const parsed = ListCodeReviewRepositoryFilesSchema.parse(params.input);
    const snapshot = await this.gateway.resolveCodeReviewRepositorySnapshot({
      orgId: params.orgId,
      scopeId: params.scopeId,
      repository: parsed.repository,
      ref: parsed.ref,
    });
    return {
      repositoryId: snapshot.repositoryId,
      repository: snapshot.fullName,
      ref: snapshot.immutableCommitSha,
      files: snapshot.files,
      completeness: snapshot.completeness,
    };
  }
}
