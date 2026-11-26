import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodeSourceRow } from '@/db/schema';
import {
  CodeSourceService,
  toPublicCodeSource,
  type CodeSourceStore,
} from '@/domains/security-ops/code-sources/CodeSourceService';
import {
  parseStrictGitUrl,
  type GitUrlPolicy,
} from '@/domains/security-ops/code-sources/codeSourceLocation';
import {
  commitFiles,
  fileUrlFor,
  git,
  makeGitRepo,
  makeTempDir,
  removeTempDir,
  writeFiles,
} from '../../../../helpers/gitTestRepo';

const ORG = '00000000-0000-4000-8000-000000000001';
const SCOPE = '00000000-0000-4000-8000-000000000002';

/** Test-only URL seam: also admits a local file:// repository, so no test needs the internet. */
const localRepositoryPolicy: GitUrlPolicy = {
  transports: ['file'],
  parse(raw) {
    if (!raw.startsWith('file://')) return parseStrictGitUrl(raw);
    const name = raw.replace(/\/+$/u, '').split('/').pop() ?? 'repo';
    return { url: raw, transport: 'file', fullName: `local/${name}`, name, ownerLogin: 'local' };
  },
};

const memoryStore = (): CodeSourceStore & { rows: Map<string, CodeSourceRow> } => {
  const rows = new Map<string, CodeSourceRow>();
  const byScope = (organizationId: string, scopeId: string) =>
    [...rows.values()].find((row) => row.organizationId === organizationId && row.scopeId === scopeId) ?? null;
  return {
    rows,
    async findByScope(organizationId, scopeId) {
      return byScope(organizationId, scopeId);
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async listByScopes(scopeIds) {
      return [...rows.values()].filter((row) => scopeIds.includes(row.scopeId));
    },
    async upsertForScope(organizationId, scopeId, fields) {
      const existing = byScope(organizationId, scopeId);
      const now = new Date();
      const row: CodeSourceRow = existing
        ? { ...existing, ...fields, updatedAt: now }
        : { id: randomUUID(), organizationId, scopeId, ...fields, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return row;
    },
    async update(id, patch, expected) {
      const row = rows.get(id);
      if (!row) return null;
      if (
        expected
        && (row.kind !== expected.kind
          || row.location !== expected.location
          || row.status !== expected.status
          || (row.ref ?? null) !== (expected.ref ?? null))
      ) {
        return null;
      }
      const next = { ...row, ...patch, updatedAt: new Date() };
      rows.set(id, next);
      return next;
    },
    async deleteForScope(organizationId, scopeId) {
      const row = byScope(organizationId, scopeId);
      if (row) rows.delete(row.id);
      return row;
    },
  };
};

describe('CodeSourceService', () => {
  const temps: string[] = [];
  const temp = (prefix: string) => {
    const directory = makeTempDir(prefix);
    temps.push(directory);
    return directory;
  };
  afterEach(() => {
    while (temps.length) removeTempDir(temps.pop() as string);
  });

  const setup = (options: { cloneMaxBytes?: number; policy?: GitUrlPolicy | null } = {}) => {
    const store = memoryStore();
    const clonesRoot = temp('clones');
    const service = new CodeSourceService(null, {
      store,
      clonesRoot,
      codeRoot: null,
      gitUrlPolicy: options.policy === null ? undefined : options.policy ?? localRepositoryPolicy,
      cloneMaxBytes: options.cloneMaxBytes,
    });
    return { store, service, clonesRoot };
  };

  it('clones a git source in the background: cloning, then ready at the remote HEAD', async () => {
    const remote = makeGitRepo({ 'src/app.ts': 'export const a = 1;\n' });
    temps.push(remote);
    const { service, clonesRoot } = setup();

    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    expect(started.status).toBe('cloning');
    expect(toPublicCodeSource(started)).toEqual({
      kind: 'git',
      location: fileUrlFor(remote),
      ref: null,
      status: 'cloning',
      headCommit: null,
      error: null,
      reviewBrief: null,
    });

    await service.settled(started.id);
    const ready = await service.getForScope(ORG, SCOPE);
    expect(ready).toMatchObject({ status: 'ready', error: null, headCommit: git(remote, 'rev-parse', 'HEAD') });
    expect(fs.existsSync(path.join(clonesRoot, started.id, 'src', 'app.ts'))).toBe(true);
    expect(fs.readdirSync(clonesRoot).filter((entry) => entry.includes('.cloning-'))).toEqual([]);
  });

  it('starts no second clone when the same git source is set again', async () => {
    const remote = makeGitRepo({ 'README.md': '# a\n' });
    temps.push(remote);
    const { service, store } = setup();
    const upsert = vi.spyOn(store, 'upsertForScope');

    const first = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    const again = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('cloning');
    await service.settled(first.id);
    const repeatedWhenReady = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });

    expect(repeatedWhenReady.status).toBe('ready');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('records a failed clone with git\'s reason', async () => {
    const missing = path.join(temp('missing'), 'nothing-here');
    const { service } = setup();
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(missing) });
    await service.settled(started.id);
    const failed = await service.getForScope(ORG, SCOPE);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBeTruthy();
    expect(failed?.headCommit).toBeNull();
  });

  it('fails a clone past the size limit and leaves no directory behind', async () => {
    const remote = makeGitRepo({ 'big.txt': 'x'.repeat(50_000) });
    temps.push(remote);
    const { service, clonesRoot } = setup({ cloneMaxBytes: 1_000 });
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    await service.settled(started.id);
    const failed = await service.getForScope(ORG, SCOPE);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/larger than .* the clone limit\. Clone it yourself and add it as a folder/u);
    expect(fs.readdirSync(clonesRoot).filter((entry) => !entry.startsWith('.'))).toEqual([]);
  });

  it('stops a clone past the time limit and records why', async () => {
    const remote = makeGitRepo({ 'a.txt': 'a' });
    temps.push(remote);
    const store = memoryStore();
    const clonesRoot = temp('clones');
    const service = new CodeSourceService(null, {
      store,
      clonesRoot,
      codeRoot: null,
      gitUrlPolicy: localRepositoryPolicy,
      cloneTimeoutMs: 1,
    });
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    await service.settled(started.id);
    const failed = await service.getForScope(ORG, SCOPE);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/took longer than 1 seconds and was stopped/u);
    expect(fs.existsSync(path.join(clonesRoot, started.id))).toBe(false);
  });

  it('refuses a file:// URL under the production policy before anything is stored', async () => {
    const { service, store } = setup({ policy: null });
    await expect(service.put(ORG, SCOPE, { kind: 'git', location: 'file:///tmp/repo' })).rejects.toThrow(
      /file:\/\/ scheme is not allowed/u,
    );
    expect(store.rows.size).toBe(0);
  });

  it('refreshes a clone by fetch and reset, and a review pinned at the old commit can still read it', async () => {
    const remote = makeGitRepo({ 'src/app.ts': 'version one\n' });
    temps.push(remote);
    const { service } = setup();
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    await service.settled(started.id);
    const oldCommit = (await service.getForScope(ORG, SCOPE))?.headCommit as string;

    const newCommit = commitFiles(remote, { 'src/app.ts': 'version two\n' });
    const refreshing = await service.refresh(ORG, SCOPE);
    expect(refreshing.status).toBe('cloning');
    await service.settled(started.id);
    expect(await service.getForScope(ORG, SCOPE)).toMatchObject({ status: 'ready', headCommit: newCommit });

    const current = await service.readRepositoryFile({ orgId: ORG, scopeId: SCOPE, repository: started.id, path: 'src/app.ts' });
    expect(current).toEqual({ repository: 'local/' + path.basename(remote), path: 'src/app.ts', ref: newCommit, content: 'version two\n' });
    const pinned = await service.readRepositoryFile({
      orgId: ORG,
      scopeId: SCOPE,
      repository: started.id,
      path: 'src/app.ts',
      ref: oldCommit,
    });
    expect(pinned.content).toBe('version one\n');
  });

  it('pins a clone commit with git blob ids for Code Review', async () => {
    const remote = makeGitRepo({ 'src/app.ts': 'const a = 1;\n', 'README.md': '# r\n' });
    temps.push(remote);
    const { service } = setup();
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote), reviewBrief: 'Focus on auth.' });
    await service.settled(started.id);

    const snapshot = await service.resolveCodeReviewRepositorySnapshot({ orgId: ORG, scopeId: SCOPE, repository: started.id });
    expect(snapshot).toMatchObject({
      installationId: 'local-code-source',
      repositoryId: started.id,
      fullName: `local/${path.basename(remote)}`,
      defaultBranch: 'main',
      requestedRef: 'main',
      immutableCommitSha: git(remote, 'rev-parse', 'HEAD'),
      completeness: 'complete',
      reviewBrief: 'Focus on auth.',
    });
    expect(snapshot.files).toEqual([
      { path: 'README.md', blobSha: git(remote, 'rev-parse', 'HEAD:README.md'), size: 4 },
      { path: 'src/app.ts', blobSha: git(remote, 'rev-parse', 'HEAD:src/app.ts'), size: 13 },
    ]);
  });

  it('scans a folder at once, keeps every read inside it, and refuses a pinned read after the folder changed', async () => {
    const folder = temp('folder');
    writeFiles(folder, { 'src/app.ts': 'const a = 1;\n', '.gitignore': 'secret.env\n', 'secret.env': 'KEY=1\n' });
    writeFiles(path.dirname(folder), { [`${path.basename(folder)}-outside.txt`]: 'outside' });
    temps.push(path.join(path.dirname(folder), `${path.basename(folder)}-outside.txt`));
    const { service } = setup();

    const row = await service.put(ORG, SCOPE, { kind: 'folder', location: folder });
    expect(row).toMatchObject({ kind: 'folder', status: 'ready', location: folder });
    expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(toPublicCodeSource(row)?.headCommit).toBe(row.contentHash);

    const snapshot = await service.resolveCodeReviewRepositorySnapshot({ orgId: ORG, scopeId: SCOPE, repository: row.id });
    expect(snapshot.immutableCommitSha).toBe(row.contentHash);
    expect(snapshot.fullName).toBe(path.basename(folder));
    expect(snapshot.files.map((file) => file.path)).toEqual(['.gitignore', 'src/app.ts']);

    const read = (filePath: string, extra: { repository?: string; ref?: string } = {}) =>
      service.readRepositoryFile({ orgId: ORG, scopeId: SCOPE, repository: extra.repository ?? row.id, path: filePath, ref: extra.ref });
    await expect(read('src/app.ts', { ref: snapshot.immutableCommitSha })).resolves.toMatchObject({ content: 'const a = 1;\n' });
    await expect(read(`../${path.basename(folder)}-outside.txt`)).rejects.toThrow(/Invalid repository-relative path/u);
    await expect(read('src/app.ts', { repository: 'someone/else' })).rejects.toThrow(/not connected to this scope/u);
    await expect(read('src/app.ts', { ref: 'main' })).rejects.toThrow(/A folder has no branches or tags/u);
    await expect(read('secret.env', { ref: snapshot.immutableCommitSha })).rejects.toThrow(/not part of the pinned code/u);

    writeFiles(folder, { 'src/app.ts': 'const a = 2;\n' });
    await expect(read('src/app.ts', { ref: snapshot.immutableCommitSha })).rejects.toThrow(/changed after the review pinned it/u);
    await expect(read('src/app.ts')).resolves.toMatchObject({ content: 'const a = 2;\n', ref: null });
  });

  it('refuses a relative folder path as typed, before resolving it against the backend directory', async () => {
    const { service, store } = setup();
    await expect(service.put(ORG, SCOPE, { kind: 'folder', location: 'relative/dir' })).rejects.toThrow(/must be absolute/u);
    expect(store.rows.size).toBe(0);
  });

  it('removes the row and the clone directory', async () => {
    const remote = makeGitRepo({ 'a.txt': 'a' });
    temps.push(remote);
    const { service, clonesRoot } = setup();
    const started = await service.put(ORG, SCOPE, { kind: 'git', location: fileUrlFor(remote) });
    await service.settled(started.id);
    expect(fs.existsSync(path.join(clonesRoot, started.id))).toBe(true);

    await service.remove(ORG, SCOPE);
    await service.settled(started.id);
    expect(await service.getForScope(ORG, SCOPE)).toBeNull();
    expect(fs.existsSync(path.join(clonesRoot, started.id))).toBe(false);
  });

  it('resumes a clone a restart left in cloning when the source is read', async () => {
    const remote = makeGitRepo({ 'a.txt': 'a' });
    temps.push(remote);
    const { service, store } = setup();
    const interrupted = await store.upsertForScope(ORG, SCOPE, {
      kind: 'git',
      location: fileUrlFor(remote),
      ref: null,
      reviewBrief: null,
      status: 'cloning',
      error: null,
      headCommit: null,
      contentHash: null,
    });

    await service.getForScope(ORG, SCOPE);
    await service.settled(interrupted.id);
    expect(await service.getForScope(ORG, SCOPE)).toMatchObject({ status: 'ready', headCommit: git(remote, 'rev-parse', 'HEAD') });
  });
});
