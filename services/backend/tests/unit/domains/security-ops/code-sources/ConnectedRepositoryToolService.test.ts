import { describe, expect, it, vi } from 'vitest';

import { ConnectedRepositoryToolService } from '@/domains/security-ops/code-sources/ConnectedRepositoryToolService';

describe('ConnectedRepositoryToolService', () => {
  it('lists repositories with total count', async () => {
    const gateway = {
      listScopeRepositories: vi.fn(async () => [
        {
          id: 'repo-1',
          fullName: 'acme/app',
          defaultBranch: 'main',
          ownerLogin: 'acme',
          name: 'app',
          htmlUrl: 'https://github.example/acme/app',
        },
      ]),
      searchConnectedRepository: vi.fn(),
      readRepositoryFile: vi.fn(),
      resolveCodeReviewRepositorySnapshot: vi.fn(),
    };
    const service = new ConnectedRepositoryToolService(gateway);

    const result = await service.listConnectedRepositories({
      orgId: 'org-1',
      scopeId: 'scope-1',
      input: undefined,
    });

    expect(gateway.listScopeRepositories).toHaveBeenCalledWith('org-1', 'scope-1');
    expect(result.totalCount).toBe(1);
    expect(result.repositories[0]?.fullName).toBe('acme/app');
  });

  it('parses search input and delegates repository search', async () => {
    const gateway = {
      listScopeRepositories: vi.fn(),
      searchConnectedRepository: vi.fn(async () => ({
        repository: 'acme/app',
        results: [
          {
            repository: 'acme/app',
            path: 'src/app.ts',
            htmlUrl: null,
            snippet: 'handler',
          },
        ],
      })),
      readRepositoryFile: vi.fn(),
      resolveCodeReviewRepositorySnapshot: vi.fn(),
    };
    const service = new ConnectedRepositoryToolService(gateway);

    const result = await service.searchConnectedRepository({
      orgId: 'org-1',
      scopeId: 'scope-1',
      input: {
        repository: 'acme/app',
        query: 'handler',
        limit: 3,
      },
    });

    expect(gateway.searchConnectedRepository).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: 'scope-1',
      repository: 'acme/app',
      query: 'handler',
      limit: 3,
    });
    expect(result.results).toHaveLength(1);
  });

  it('parses file input and delegates repository file reads', async () => {
    const gateway = {
      listScopeRepositories: vi.fn(),
      searchConnectedRepository: vi.fn(),
      readRepositoryFile: vi.fn(async () => ({
        repository: 'acme/app',
        path: 'README.md',
        ref: 'main',
        content: '# App',
      })),
      resolveCodeReviewRepositorySnapshot: vi.fn(),
    };
    const service = new ConnectedRepositoryToolService(gateway);

    const result = await service.readConnectedRepositoryFile({
      orgId: 'org-1',
      scopeId: 'scope-1',
      input: {
        repository: 'acme/app',
        path: 'README.md',
        ref: 'main',
      },
    });

    expect(gateway.readRepositoryFile).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: 'scope-1',
      repository: 'acme/app',
      path: 'README.md',
      ref: 'main',
    });
    expect(result.content).toBe('# App');
  });

  it('lists Code Review files as the pinned snapshot: repository id, full name, commit, blob ids', async () => {
    const gateway = {
      listScopeRepositories: vi.fn(),
      searchConnectedRepository: vi.fn(),
      readRepositoryFile: vi.fn(),
      resolveCodeReviewRepositorySnapshot: vi.fn(async () => ({
        installationId: 'local-code-source',
        repositoryId: 'source-1',
        fullName: 'acme/app',
        visibility: 'public' as const,
        defaultBranch: 'main',
        requestedRef: 'main',
        immutableCommitSha: 'a'.repeat(40),
        files: [{ path: 'src/app.ts', blobSha: 'b'.repeat(40), size: 12 }],
        completeness: 'complete' as const,
        reviewBrief: null,
      })),
    };
    const service = new ConnectedRepositoryToolService(gateway);

    const result = await service.listCodeReviewRepositoryFiles({
      orgId: 'org-1',
      scopeId: 'scope-1',
      input: { repository: 'source-1', ref: 'a'.repeat(40) },
    });

    expect(gateway.resolveCodeReviewRepositorySnapshot).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: 'scope-1',
      repository: 'source-1',
      ref: 'a'.repeat(40),
    });
    expect(result).toEqual({
      repositoryId: 'source-1',
      repository: 'acme/app',
      ref: 'a'.repeat(40),
      files: [{ path: 'src/app.ts', blobSha: 'b'.repeat(40), size: 12 }],
      completeness: 'complete',
    });
  });

  it('rejects too-short search queries before dispatch', async () => {
    const gateway = {
      listScopeRepositories: vi.fn(),
      searchConnectedRepository: vi.fn(),
      readRepositoryFile: vi.fn(),
      resolveCodeReviewRepositorySnapshot: vi.fn(),
    };
    const service = new ConnectedRepositoryToolService(gateway);

    await expect(
      service.searchConnectedRepository({
        orgId: 'org-1',
        scopeId: 'scope-1',
        input: {
          repository: 'acme/app',
          query: 'x',
        },
      }),
    ).rejects.toThrow();
    expect(gateway.searchConnectedRepository).not.toHaveBeenCalled();
  });
});
