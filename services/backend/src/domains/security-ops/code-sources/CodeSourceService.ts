import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  codeSources,
  type CodeSourceKind,
  type CodeSourceRow,
  type CodeSourceStatus,
  type CodeReviewRepositoryVisibility,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import {
  STRICT_GIT_URL_POLICY,
  cloneDirectoryFor,
  codeSourcesRoot,
  configuredCodeRoot,
  folderRepositoryName,
  normalizeGitRef,
  resolveCodeFolder,
  type GitUrlPolicy,
} from './codeSourceLocation';
import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  decodeRepositoryText,
  fetchAndReset,
  folderContentHash,
  gitBlobSha,
  listFolderManifest,
  listGitManifest,
  readFolderFile,
  readGitFile,
  removeDirectory,
  resolveCheckedOutBranch,
  runGit,
  searchFolder,
  searchGit,
  shallowClone,
  type ManifestFile,
  type RepositoryManifest,
} from './localRepository';

/**
 * A scope's code source: the one place its code comes from.
 *
 * Owns the `code_sources` row (canonical), the clone lifecycle
 * (cloning -> ready | failed, serialized per source), and read-only access for
 * the repository tools and the Code Review start route. A folder is read in
 * place and never written; a clone is read through git's object store at a
 * pinned commit, so a refresh cannot change what a running review reads.
 */

/** Sentinel installation id: no GitHub installation or credential participates. */
export const LOCAL_CODE_SOURCE_INSTALLATION_ID = 'local-code-source';
/** A folder has no branch; its reviews pin the working tree's content hash. */
export const FOLDER_WORKING_TREE_REF = 'working-tree';
export const MAX_REVIEW_BRIEF_LENGTH = 4_000;

export type PublicCodeSource = {
  kind: CodeSourceKind;
  location: string;
  ref: string | null;
  status: CodeSourceStatus;
  /** A clone's commit, or a folder's content hash: what a review would pin. */
  headCommit: string | null;
  error: string | null;
  reviewBrief: string | null;
};

export const toPublicCodeSource = (row: CodeSourceRow | null | undefined): PublicCodeSource | null =>
  row
    ? {
        kind: row.kind,
        location: row.location,
        ref: row.ref ?? null,
        status: row.status,
        headCommit: (row.kind === 'git' ? row.headCommit : row.contentHash) ?? null,
        error: row.error ?? null,
        reviewBrief: row.reviewBrief ?? null,
      }
    : null;

export type ConnectedCodeRepository = {
  id: string;
  fullName: string;
  defaultBranch: string | null;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
};

const repositoryIdentity = (
  row: CodeSourceRow,
  policy: GitUrlPolicy = STRICT_GIT_URL_POLICY,
): Pick<ConnectedCodeRepository, 'fullName' | 'name' | 'ownerLogin'> => {
  if (row.kind === 'git') {
    try {
      const parsed = policy.parse(row.location);
      return { fullName: parsed.fullName, name: parsed.name, ownerLogin: parsed.ownerLogin };
    } catch {
      // Fall through to a name derived from the text; reads re-validate anyway.
    }
  }
  const name = row.kind === 'git'
    ? row.location.replace(/\.git$/iu, '').split(/[/:]/u).filter(Boolean).pop() ?? 'repository'
    : folderRepositoryName(row.location);
  return { fullName: name, name, ownerLogin: '' };
};

/** The repository a ready code source contributes to the scope (V3.2's connected repository shape). */
export const connectedRepositoryOf = (
  row: CodeSourceRow,
  policy: GitUrlPolicy = STRICT_GIT_URL_POLICY,
): ConnectedCodeRepository => ({
  id: row.id,
  ...repositoryIdentity(row, policy),
  defaultBranch: row.kind === 'git' ? row.ref ?? null : null,
  htmlUrl: row.location,
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

type CodeSourceFields = Pick<
  CodeSourceRow,
  'kind' | 'location' | 'ref' | 'reviewBrief' | 'status' | 'error' | 'headCommit' | 'contentHash'
>;

/** Persistence for code source rows; the Drizzle store is the only production one. */
export type CodeSourceStore = {
  findByScope(organizationId: string, scopeId: string): Promise<CodeSourceRow | null>;
  findById(id: string): Promise<CodeSourceRow | null>;
  listByScopes(scopeIds: readonly string[]): Promise<CodeSourceRow[]>;
  upsertForScope(organizationId: string, scopeId: string, fields: CodeSourceFields): Promise<CodeSourceRow>;
  /** Update only while the row still describes `expected` (the source a job worked on). */
  update(
    id: string,
    patch: Partial<CodeSourceFields>,
    expected?: Pick<CodeSourceRow, 'kind' | 'location' | 'ref' | 'status'>,
  ): Promise<CodeSourceRow | null>;
  deleteForScope(organizationId: string, scopeId: string): Promise<CodeSourceRow | null>;
};

export const createDrizzleCodeSourceStore = (db: DatabaseClient): CodeSourceStore => ({
  async findByScope(organizationId, scopeId) {
    const [row] = await db
      .select()
      .from(codeSources)
      .where(and(eq(codeSources.organizationId, organizationId), eq(codeSources.scopeId, scopeId)))
      .limit(1);
    return row ?? null;
  },
  async findById(id) {
    const [row] = await db.select().from(codeSources).where(eq(codeSources.id, id)).limit(1);
    return row ?? null;
  },
  async listByScopes(scopeIds) {
    if (scopeIds.length === 0) return [];
    return db.select().from(codeSources).where(inArray(codeSources.scopeId, [...scopeIds]));
  },
  async upsertForScope(organizationId, scopeId, fields) {
    const now = new Date();
    const [row] = await db
      .insert(codeSources)
      .values({ organizationId, scopeId, ...fields, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: codeSources.scopeId,
        set: { ...fields, updatedAt: now },
      })
      .returning();
    return row;
  },
  async update(id, patch, expected) {
    const conditions = [eq(codeSources.id, id)];
    if (expected) {
      conditions.push(
        eq(codeSources.kind, expected.kind),
        eq(codeSources.location, expected.location),
        eq(codeSources.status, expected.status),
        expected.ref === null ? isNull(codeSources.ref) : eq(codeSources.ref, expected.ref),
      );
    }
    const [row] = await db
      .update(codeSources)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },
  async deleteForScope(organizationId, scopeId) {
    const [row] = await db
      .delete(codeSources)
      .where(and(eq(codeSources.organizationId, organizationId), eq(codeSources.scopeId, scopeId)))
      .returning();
    return row ?? null;
  },
});

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export type CodeSourceInput = {
  kind: CodeSourceKind;
  location: string;
  ref?: string | null;
  reviewBrief?: string | null;
};

export type CodeReviewRepositorySnapshot = {
  installationId: string;
  repositoryId: string;
  fullName: string;
  visibility: CodeReviewRepositoryVisibility;
  defaultBranch: string;
  requestedRef: string;
  immutableCommitSha: string;
  files: ManifestFile[];
  completeness: 'complete' | 'partial';
  reviewBrief: string | null;
};

export type CodeSourceServiceOptions = {
  store?: CodeSourceStore;
  /** Test-only seam: production always uses STRICT_GIT_URL_POLICY (https and ssh). */
  gitUrlPolicy?: GitUrlPolicy;
  /** Where clones live; defaults to `${WORKSPACE_ROOT}/code-sources`. */
  clonesRoot?: string;
  /** Folder confinement; defaults to NULL_AI_CODE_ROOT. */
  codeRoot?: string | null;
  cloneTimeoutMs?: number;
  cloneMaxBytes?: number;
};

const constraint = (message: string): AppError =>
  new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, message, { userMessage: message });

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

/**
 * One job chain per source for the whole process: clones, refreshes and clone
 * removals never overlap, whichever service instance queued them.
 */
const sourceJobs = new Map<string, Promise<void>>();

const normalizeReviewBrief = (value: string | null | undefined): string | null => {
  const brief = value?.trim() || null;
  if (brief && brief.length > MAX_REVIEW_BRIEF_LENGTH) {
    throw constraint('The review brief cannot exceed 4,000 characters');
  }
  return brief;
};

export class CodeSourceService {
  private readonly store: CodeSourceStore;
  private readonly policy: GitUrlPolicy;
  private readonly explicitClonesRoot?: string;
  private readonly explicitCodeRoot?: string | null;
  private readonly jobs = sourceJobs;

  constructor(db: DatabaseClient | null, private readonly options: CodeSourceServiceOptions = {}) {
    if (!options.store && !db) {
      throw new Error('CodeSourceService needs a database or a store');
    }
    this.store = options.store ?? createDrizzleCodeSourceStore(db as DatabaseClient);
    this.policy = options.gitUrlPolicy ?? STRICT_GIT_URL_POLICY;
    this.explicitClonesRoot = options.clonesRoot;
    this.explicitCodeRoot = options.codeRoot;
  }

  private get clonesRoot(): string {
    return this.explicitClonesRoot ?? codeSourcesRoot();
  }

  private get codeRoot(): string | null {
    return this.explicitCodeRoot !== undefined ? this.explicitCodeRoot : configuredCodeRoot();
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * The scope's source. A row left `cloning` by a restart has no job in this
   * process; reading it resumes the clone (the row is the durable obligation).
   */
  async getForScope(organizationId: string, scopeId: string): Promise<CodeSourceRow | null> {
    const row = await this.store.findByScope(organizationId, scopeId);
    if (row && row.kind === 'git' && row.status === 'cloning' && !this.jobs.has(row.id)) {
      this.enqueue(row.id, () => this.syncClone(row.id));
    }
    return row;
  }

  async listByScopes(scopeIds: readonly string[]): Promise<CodeSourceRow[]> {
    return this.store.listByScopes(scopeIds);
  }

  /**
   * Point the scope at a folder or a git URL. A folder is validated and
   * scanned now; a git URL starts a background clone. Repeating the same git
   * source does not start a second clone.
   */
  async put(organizationId: string, scopeId: string, input: CodeSourceInput): Promise<CodeSourceRow> {
    const reviewBrief = normalizeReviewBrief(input.reviewBrief);
    const existing = await this.store.findByScope(organizationId, scopeId);

    if (input.kind === 'folder') {
      if (input.ref) {
        throw constraint('A folder source has no ref');
      }
      // Validate what the person typed (it must already be absolute), then store it normalized.
      const folder = await resolveCodeFolder(input.location, this.codeRoot);
      const location = path.resolve(input.location.trim());
      const manifest = await listFolderManifest({ folder, scratchRoot: this.clonesRoot });
      const row = await this.store.upsertForScope(organizationId, scopeId, {
        kind: 'folder',
        location,
        ref: null,
        reviewBrief: input.reviewBrief === undefined ? existing?.reviewBrief ?? null : reviewBrief,
        status: 'ready',
        error: null,
        headCommit: null,
        contentHash: folderContentHash(manifest),
      });
      if (existing?.kind === 'git') {
        this.enqueue(row.id, () => this.removeClone(row.id));
      }
      return row;
    }

    if (input.kind !== 'git') {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'kind must be folder or git');
    }
    const parsed = this.policy.parse(input.location);
    const ref = normalizeGitRef(input.ref);
    const brief = input.reviewBrief === undefined ? existing?.reviewBrief ?? null : reviewBrief;
    if (
      existing
      && existing.kind === 'git'
      && existing.location === parsed.url
      && (existing.ref ?? null) === ref
      && existing.status !== 'failed'
    ) {
      const row = brief === (existing.reviewBrief ?? null)
        ? existing
        : (await this.store.update(existing.id, { reviewBrief: brief })) ?? existing;
      if (row.status === 'cloning' && !this.jobs.has(row.id)) {
        this.enqueue(row.id, () => this.syncClone(row.id));
      }
      return row;
    }

    const row = await this.store.upsertForScope(organizationId, scopeId, {
      kind: 'git',
      location: parsed.url,
      ref,
      reviewBrief: brief,
      status: 'cloning',
      error: null,
      headCommit: null,
      contentHash: null,
    });
    this.enqueue(row.id, () => this.syncClone(row.id));
    return row;
  }

  /** Re-scan a folder now, or fetch and reset a clone in the background. */
  async refresh(organizationId: string, scopeId: string): Promise<CodeSourceRow> {
    const existing = await this.store.findByScope(organizationId, scopeId);
    if (!existing) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'This scope has no code source');
    }
    if (existing.kind === 'folder') {
      return this.scanFolder(existing);
    }
    if (existing.status === 'cloning') {
      if (!this.jobs.has(existing.id)) {
        this.enqueue(existing.id, () => this.syncClone(existing.id));
      }
      return existing;
    }
    const row = (await this.store.update(
      existing.id,
      { status: 'cloning', error: null },
      { kind: existing.kind, location: existing.location, ref: existing.ref, status: existing.status },
    )) ?? existing;
    this.enqueue(row.id, () => this.syncClone(row.id));
    return row;
  }

  async remove(organizationId: string, scopeId: string): Promise<CodeSourceRow | null> {
    const removed = await this.store.deleteForScope(organizationId, scopeId);
    if (removed) {
      this.enqueue(removed.id, () => this.removeClone(removed.id));
    }
    return removed;
  }

  /** Resolves once every queued job for the source has finished. */
  async settled(sourceId: string): Promise<void> {
    while (this.jobs.has(sourceId)) {
      await this.jobs.get(sourceId);
    }
  }

  private enqueue(sourceId: string, job: () => Promise<void>): void {
    const previous = this.jobs.get(sourceId) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(job)
      .catch((error) => {
        logger.error({ err: error, codeSourceId: sourceId }, '[code-sources] Job failed');
      })
      .finally(() => {
        if (this.jobs.get(sourceId) === next) this.jobs.delete(sourceId);
      });
    this.jobs.set(sourceId, next);
  }

  private async scanFolder(row: CodeSourceRow): Promise<CodeSourceRow> {
    const expected = { kind: row.kind, location: row.location, ref: row.ref, status: row.status };
    try {
      const folder = await resolveCodeFolder(row.location, this.codeRoot);
      const manifest = await listFolderManifest({ folder, scratchRoot: this.clonesRoot });
      return (await this.store.update(
        row.id,
        { status: 'ready', error: null, contentHash: folderContentHash(manifest) },
        expected,
      )) ?? row;
    } catch (error) {
      const message = error instanceof AppError ? error.userMessage : error instanceof Error ? error.message : String(error);
      return (await this.store.update(row.id, { status: 'failed', error: message }, expected)) ?? row;
    }
  }

  private async isCloneOf(directory: string, url: string): Promise<boolean> {
    try {
      await fs.access(path.join(directory, '.git'));
    } catch {
      return false;
    }
    const result = await runGit(['config', '--get', 'remote.origin.url'], { cwd: directory, timeoutMs: 15_000 });
    return result.code === 0 && result.stdout.toString('utf8').trim() === url;
  }

  /**
   * Bring a clone to the row's URL and ref. An existing clone of the same URL
   * is fetched and reset in place, keeping older commits a running review may
   * still read. A new URL is cloned beside the old directory and swapped in.
   */
  private async syncClone(sourceId: string): Promise<void> {
    const row = await this.store.findById(sourceId);
    if (!row || row.kind !== 'git' || row.status !== 'cloning') return;
    const expected = { kind: row.kind, location: row.location, ref: row.ref, status: row.status };
    const fail = async (error: string) => {
      await this.store.update(sourceId, { status: 'failed', error }, expected);
    };

    let parsed;
    try {
      parsed = this.policy.parse(row.location);
    } catch (error) {
      await fail(error instanceof AppError ? error.userMessage : String(error));
      return;
    }
    const directory = cloneDirectoryFor(sourceId, this.clonesRoot);
    const limits = {
      timeoutMs: this.options.cloneTimeoutMs,
      maxBytes: this.options.cloneMaxBytes,
    };

    if (await this.isCloneOf(directory, parsed.url)) {
      const outcome = await fetchAndReset({
        url: parsed.url,
        ref: row.ref,
        directory,
        transports: this.policy.transports,
        ...limits,
      });
      if (!outcome.ok) {
        await fail(outcome.error);
        return;
      }
      await this.store.update(sourceId, { status: 'ready', error: null, headCommit: outcome.headCommit }, expected);
      return;
    }

    const staging = `${directory}.cloning-${randomBytes(4).toString('hex')}`;
    await removeDirectory(staging);
    const outcome = await shallowClone({
      url: parsed.url,
      ref: row.ref,
      directory: staging,
      transports: this.policy.transports,
      ...limits,
    });
    if (!outcome.ok) {
      await removeDirectory(staging);
      await fail(outcome.error);
      return;
    }
    const current = await this.store.findById(sourceId);
    if (
      !current
      || current.kind !== expected.kind
      || current.location !== expected.location
      || (current.ref ?? null) !== (expected.ref ?? null)
      || current.status !== 'cloning'
    ) {
      await removeDirectory(staging);
      return;
    }
    await removeDirectory(directory);
    await renameWithRetry(staging, directory);
    await this.store.update(sourceId, { status: 'ready', error: null, headCommit: outcome.headCommit }, expected);
  }

  private async removeClone(sourceId: string): Promise<void> {
    const row = await this.store.findById(sourceId);
    if (row?.kind === 'git') return; // the source became a git source again
    await removeDirectory(cloneDirectoryFor(sourceId, this.clonesRoot));
  }

  // ---- reads (repository tools and Code Review) ----------------------------

  /** V3.2 `listScopeRepositories`: the scope's ready source, as a connected repository. */
  async listScopeRepositories(organizationId: string, scopeId: string): Promise<ConnectedCodeRepository[]> {
    const row = await this.store.findByScope(organizationId, scopeId);
    return row && row.status === 'ready' ? [connectedRepositoryOf(row, this.policy)] : [];
  }

  private async resolveSource(organizationId: string, scopeId: string, selector: string) {
    const wanted = selector.trim();
    if (!wanted) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'Repository selector is required');
    }
    const row = await this.store.findByScope(organizationId, scopeId);
    const repository = row ? connectedRepositoryOf(row, this.policy) : null;
    if (
      !row
      || !repository
      || (wanted !== row.id && wanted.toLowerCase() !== repository.fullName.toLowerCase())
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        'Requested repository is not connected to this scope',
      );
    }
    return { row, repository };
  }

  private async folderRoot(row: CodeSourceRow): Promise<string> {
    return resolveCodeFolder(row.location, this.codeRoot);
  }

  private cloneDirectory(row: CodeSourceRow): string {
    if (!row.headCommit) {
      throw constraint(
        row.status === 'cloning'
          ? 'The repository is still being cloned. Try again when the code source is ready.'
          : `The repository is not available: ${row.error ?? 'it has not been cloned'}`,
      );
    }
    return cloneDirectoryFor(row.id, this.clonesRoot);
  }

  /** A clone read takes a full commit SHA or the source's tracked ref (its current commit). */
  private resolveCloneCommit(row: CodeSourceRow, ref: string | undefined): string {
    const requested = ref?.trim();
    if (!requested || requested === row.ref) {
      this.cloneDirectory(row);
      return (row.headCommit as string).toLowerCase();
    }
    if (!COMMIT_PATTERN.test(requested)) {
      throw constraint('ref must be a full commit SHA or the code source ref');
    }
    return requested.toLowerCase();
  }

  private async folderManifest(row: CodeSourceRow, maxFiles?: number): Promise<{ folder: string; manifest: RepositoryManifest; contentHash: string }> {
    const folder = await this.folderRoot(row);
    const manifest = await listFolderManifest({ folder, scratchRoot: this.clonesRoot, maxFiles });
    return { folder, manifest, contentHash: folderContentHash(manifest) };
  }

  async readRepositoryFile(params: {
    orgId: string;
    scopeId: string;
    repository: string;
    path: string;
    ref?: string;
  }): Promise<{ repository: string; path: string; ref: string | null; content: string }> {
    const { row, repository } = await this.resolveSource(params.orgId, params.scopeId, params.repository);
    if (row.kind === 'git') {
      const commit = this.resolveCloneCommit(row, params.ref);
      const file = await readGitFile({ directory: this.cloneDirectory(row), commit, path: params.path });
      return { repository: repository.fullName, path: params.path, ref: commit, content: decodeRepositoryText(file.content) };
    }

    const folder = await this.folderRoot(row);
    const requested = params.ref?.trim();
    if (requested && !/^[a-f0-9]{64}$/iu.test(requested)) {
      throw constraint('A folder has no branches or tags: omit ref, or pass the content hash a review pinned');
    }
    const file = await readFolderFile(folder, params.path);
    if (requested) {
      // A pinned read: the file must still be exactly what the pinned manifest holds.
      const { manifest, contentHash } = await this.folderManifest(row);
      const entry = manifest.files.find((candidate) => candidate.path === file.path);
      if (contentHash === requested.toLowerCase() && !entry) {
        throw constraint(`${file.path} is not part of the pinned code (it is ignored by .gitignore or is not a regular file)`);
      }
      if (contentHash !== requested.toLowerCase() || !entry || entry.blobSha !== gitBlobSha(file.content)) {
        throw constraint(
          'This folder changed after the review pinned it. Refresh the code source and start a new review.',
        );
      }
    }
    return {
      repository: repository.fullName,
      path: params.path,
      ref: requested ? requested.toLowerCase() : null,
      content: decodeRepositoryText(file.content),
    };
  }

  async searchConnectedRepository(params: {
    orgId: string;
    scopeId: string;
    repository: string;
    query: string;
    limit?: number;
  }): Promise<{
    repository: string;
    results: Array<{ repository: string; path: string; htmlUrl: string | null; snippet: string | null }>;
  }> {
    const { row, repository } = await this.resolveSource(params.orgId, params.scopeId, params.repository);
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
    const query = params.query.trim();
    if (query.length < 2) {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Search query must be at least 2 characters');
    }
    let matches: Array<{ path: string; snippet: string | null }>;
    if (row.kind === 'git') {
      const directory = this.cloneDirectory(row);
      const commit = this.resolveCloneCommit(row, undefined);
      const manifest = await listGitManifest({ directory, commit });
      matches = await searchGit({ directory, commit, manifest, query, limit });
    } else {
      const { folder, manifest } = await this.folderManifest(row);
      matches = await searchFolder({ folder, manifest, query, limit });
    }
    return {
      repository: repository.fullName,
      results: matches.map((match) => ({
        repository: repository.fullName,
        path: match.path,
        htmlUrl: null,
        snippet: match.snippet,
      })),
    };
  }

  /**
   * The immutable identity a Code Review pins: a clone's commit and its tree,
   * or a folder's content hash and its files, with git blob ids either way.
   */
  async resolveCodeReviewRepositorySnapshot(params: {
    orgId: string;
    scopeId: string;
    repository: string;
    ref?: string;
    maxFiles?: number;
  }): Promise<CodeReviewRepositorySnapshot> {
    const { row, repository } = await this.resolveSource(params.orgId, params.scopeId, params.repository);
    const base = {
      installationId: LOCAL_CODE_SOURCE_INSTALLATION_ID,
      repositoryId: row.id,
      fullName: repository.fullName,
      reviewBrief: row.reviewBrief?.trim() || null,
    };

    if (row.kind === 'git') {
      const directory = this.cloneDirectory(row);
      const commit = this.resolveCloneCommit(row, params.ref);
      const manifest = await listGitManifest({ directory, commit, maxFiles: params.maxFiles });
      const branch = row.ref ?? (await resolveCheckedOutBranch(directory)) ?? 'HEAD';
      return {
        ...base,
        visibility: this.policy.parse(row.location).transport === 'https' ? 'public' : 'unknown',
        defaultBranch: branch,
        requestedRef: branch,
        immutableCommitSha: commit,
        files: manifest.files,
        completeness: manifest.completeness,
      };
    }

    const { manifest, contentHash } = await this.folderManifest(row, params.maxFiles);
    const requested = params.ref?.trim().toLowerCase();
    if (requested && requested !== contentHash) {
      throw constraint(
        'This folder changed after the review pinned it. Refresh the code source and start a new review.',
      );
    }
    if (!requested && row.contentHash !== contentHash) {
      // Starting a review re-scans the folder; keep the row's projection current.
      await this.store.update(row.id, { contentHash, status: 'ready', error: null });
    }
    return {
      ...base,
      visibility: 'private',
      defaultBranch: FOLDER_WORKING_TREE_REF,
      requestedRef: FOLDER_WORKING_TREE_REF,
      immutableCommitSha: contentHash,
      files: manifest.files,
      completeness: manifest.completeness,
    };
  }
}

const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      // Windows can hold a just-written pack file open for a moment.
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
};
