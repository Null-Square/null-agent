import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecurityOpsEvidenceResolver } from '@/domains/security-ops/tools/evidence/EvidenceResolver';
import { logger } from '@/shared/logger';

describe('SecurityOpsEvidenceResolver', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'evidence-resolver-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('normalizes existing evidence refs inside the workspace', async () => {
    await mkdir(join(workspaceDir, '.artifacts'), { recursive: true });
    await writeFile(join(workspaceDir, '.artifacts', 'proof.txt'), 'proof');

    const resolver = new SecurityOpsEvidenceResolver();

    await expect(
      resolver.resolveEvidenceRefs(workspaceDir, [
        { path: '/workspace/.artifacts/proof.txt', label: ' Proof ' },
      ]),
    ).resolves.toEqual([
      {
        path: '.artifacts/proof.txt',
        label: 'Proof',
      },
    ]);
  });

  it('keeps excerpt-only evidence when an evidence file is missing', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const resolver = new SecurityOpsEvidenceResolver();

    await expect(
      resolver.resolveEvidenceWithExcerpts(workspaceDir, [
        {
          path: '.artifacts/missing.txt',
          label: ' Missing ',
          excerpt: ' observed response ',
        },
      ]),
    ).resolves.toEqual([
      {
        path: '.artifacts/missing.txt',
        label: 'Missing',
        excerpt: 'observed response',
        fileMissing: true,
      },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: '.artifacts/missing.txt' }),
      '[security-ops] Missing evidence file; storing excerpt-only evidence',
    );
    warnSpy.mockRestore();
  });

  it('normalizes structured HTTP evidence and redacts sensitive headers', () => {
    const resolver = new SecurityOpsEvidenceResolver();

    const evidence = resolver.normalizeStructuredHttpEvidence({
      kind: 'http_exchange',
      label: ' Login probe ',
      source: 'request_tool',
      request: {
        method: ' get ',
        url: ' https://example.com/login ',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        body: ' username=demo ',
      },
      response: {
        statusCode: 200,
        headers: [{ name: 'Content-Type', value: ' text/html ' }],
      },
    });

    expect(evidence).toEqual(
      expect.objectContaining({
        kind: 'http_exchange',
        displayPath: 'GET https://example.com/login',
        label: 'Login probe',
        data: expect.objectContaining({
          source: 'request_tool',
          request: expect.objectContaining({
            method: 'GET',
            url: 'https://example.com/login',
            headers: [{ name: 'Authorization', value: '[REDACTED]', redacted: true }],
            body: { text: 'username=demo', truncated: false },
          }),
          response: expect.objectContaining({
            statusCode: 200,
            headers: [{ name: 'Content-Type', value: 'text/html' }],
          }),
        }),
      }),
    );
    expect(evidence.path).toMatch(/^http:[a-f0-9]{64}$/u);
  });

  it('normalizes workspace code locations', async () => {
    const resolver = new SecurityOpsEvidenceResolver();

    await expect(
      resolver.normalizeFindingCodeLocations({
        workspaceDir,
        organizationId: 'org-1',
        scopeId: 'scope-1',
        codeLocations: [
          {
            pathKind: 'workspace',
            repository: null,
            filePath: '/workspace/src/local.ts',
            startLine: 5,
            endLine: 5,
            fixBefore: ' a ',
            fixAfter: ' b ',
          },
        ],
      }),
    ).resolves.toEqual([
      {
        pathKind: 'workspace',
        repository: null,
        ref: null,
        filePath: 'src/local.ts',
        startLine: 5,
        endLine: 5,
        label: null,
        fixBefore: 'a',
        fixAfter: 'b',
      },
    ]);
  });

  it("accepts a repository code location only in the repository the scope's code source connects", async () => {
    const codeSourceService = {
      listScopeRepositories: vi.fn().mockResolvedValue([
        { id: 'source-1', fullName: 'acme/api', defaultBranch: null, ownerLogin: 'acme', name: 'api', htmlUrl: 'https://github.com/acme/api.git' },
      ]),
    };
    const resolver = new SecurityOpsEvidenceResolver({ codeSourceService });

    const locations = await resolver.normalizeFindingCodeLocations({
      workspaceDir,
      organizationId: 'org-1',
      scopeId: 'scope-1',
      codeLocations: [
        {
          pathKind: 'repository',
          repository: 'ACME/API',
          ref: 'main',
          filePath: './src\\app.ts',
          startLine: 2,
          endLine: 3,
          fixBefore: 'old',
          fixAfter: 'new',
        },
      ],
    });

    expect(codeSourceService.listScopeRepositories).toHaveBeenCalledWith('org-1', 'scope-1');
    expect(locations).toEqual([
      expect.objectContaining({ pathKind: 'repository', repository: 'ACME/API', ref: 'main', filePath: 'src/app.ts' }),
    ]);
  });

  it('refuses a repository code location when the scope has no code source', async () => {
    const resolver = new SecurityOpsEvidenceResolver();

    await expect(
      resolver.normalizeFindingCodeLocations({
        workspaceDir,
        organizationId: 'org-1',
        scopeId: 'scope-1',
        codeLocations: [
          {
            pathKind: 'repository',
            repository: 'ACME/API',
            ref: 'main',
            filePath: 'src/app.ts',
            startLine: 2,
            endLine: 3,
            fixBefore: 'old',
            fixAfter: 'new',
          },
        ],
      }),
    ).rejects.toThrow(/is not connected to this scope/u);
  });
});
