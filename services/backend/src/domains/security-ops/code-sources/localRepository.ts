import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError, ERROR_CODES } from '@/shared/errors';
import type { GitTransport } from './codeSourceLocation';
import { isPathInside } from './codeSourceLocation';

/**
 * Read-only access to a scope's code on this computer: a folder read in place,
 * or a shallow clone read through git's object store at a pinned commit.
 *
 * Every path the agent names is repository-relative, may not contain `..` or
 * a `.git` segment, and must resolve (symlinks included) inside the root.
 */

/** Same caps V3.2 applied to GitHub reads. */
export const MAX_REPO_FILE_BYTES = 300_000;
export const MAX_SEARCH_RESULTS = 10;
export const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SNIPPET_LENGTH = 160;
export const DEFAULT_MANIFEST_FILES = 5_000;
export const MAX_MANIFEST_FILES = 10_000;

/** Clone and fetch limits: two minutes, and 200 MiB on disk. */
export const CLONE_TIMEOUT_MS = 120_000;
export const CLONE_MAX_BYTES = 200 * 1024 * 1024;

export type ManifestFile = { path: string; blobSha: string; size: number | null };

export type RepositoryManifest = {
  files: ManifestFile[];
  completeness: 'complete' | 'partial';
};

const notAFile = (message: string): AppError =>
  new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, message, { userMessage: message });

// ---------------------------------------------------------------------------
// git process
// ---------------------------------------------------------------------------

export type GitRunOptions = {
  cwd?: string;
  /** Transports git may use for this command; everything else is never allowed. */
  transports?: readonly GitTransport[];
  timeoutMs?: number;
  input?: string;
  /** Kill the command when this returns true (polled while it runs). */
  abortWhen?: () => Promise<boolean>;
  maxOutputBytes?: number;
};

export type GitRunResult = { code: number; stdout: Buffer; stderr: string };

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly reason: 'failed' | 'timeout' | 'aborted' | 'missing_git',
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/**
 * Git runs isolated from the person's git configuration (no system or global
 * config, so no credential helper, no URL rewriting, no hooks path), never
 * prompts, and may use only the named transports.
 */
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_EXEC_PATH') delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: isolatedGlobalConfigPath(),
    GIT_LITERAL_PATHSPECS: '1',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=20',
  };
};

let isolatedConfigPath: string | null = null;
const isolatedGlobalConfigPath = (): string => {
  if (!isolatedConfigPath) {
    isolatedConfigPath = path.join(os.tmpdir(), 'null-ai-git-empty-config');
    writeFileSync(isolatedConfigPath, '', { flag: 'a' });
  }
  return isolatedConfigPath;
};

const transportConfig = (transports: readonly GitTransport[]): string[] => [
  '-c', 'protocol.allow=never',
  ...transports.flatMap((transport) => ['-c', `protocol.${transport}.allow=always`]),
  '-c', 'credential.helper=',
  '-c', 'core.symlinks=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'submodule.recurse=false',
  '-c', 'core.autocrlf=false',
];

const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

export const runGit = (args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...transportConfig(options.transports ?? []), ...args], {
      cwd: options.cwd,
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let stopReason: 'timeout' | 'aborted' | 'overflow' | null = null;

    const stop = (reason: 'timeout' | 'aborted' | 'overflow') => {
      if (stopReason) return;
      stopReason = reason;
      killTree(child);
    };
    const timer = options.timeoutMs ? setTimeout(() => stop('timeout'), options.timeoutMs) : null;
    let polling = false;
    const poll = options.abortWhen
      ? setInterval(() => {
          if (polling) return;
          polling = true;
          options.abortWhen?.()
            .then((abort) => { if (abort) stop('aborted'); }, () => undefined)
            .finally(() => { polling = false; });
        }, 1_000)
      : null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (options.maxOutputBytes !== undefined && stdoutBytes > options.maxOutputBytes) {
        stop('overflow');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish();
      if (settled) return;
      settled = true;
      reject(
        error.code === 'ENOENT'
          ? new GitCommandError('git is not installed or not on PATH', '', 'missing_git')
          : error,
      );
    });
    child.on('close', (code) => {
      finish();
      if (settled) return;
      settled = true;
      if (stopReason === 'timeout') {
        reject(new GitCommandError('git took too long', stderr, 'timeout'));
        return;
      }
      if (stopReason === 'aborted') {
        reject(new GitCommandError('git was stopped', stderr, 'aborted'));
        return;
      }
      if (stopReason === 'overflow') {
        reject(new GitCommandError('git output was too large', stderr, 'failed'));
        return;
      }
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });

const runGitOk = async (args: readonly string[], options: GitRunOptions = {}): Promise<Buffer> => {
  const result = await runGit(args, options);
  if (result.code !== 0) {
    throw new GitCommandError(`git ${args[0] ?? ''} failed`, result.stderr, 'failed');
  }
  return result.stdout;
};

// ---------------------------------------------------------------------------
// blob ids and paths
// ---------------------------------------------------------------------------

/** Git's blob object id for raw bytes (what `git hash-object --no-filters` prints). */
export const gitBlobSha = (content: Buffer): string =>
  createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

const gitBlobShaOfFile = (filePath: string, size: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha1').update(`blob ${size}\0`);
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

/**
 * Normalize a repository-relative path the agent named. Refuses absolute
 * paths, `..`, and any `.git` segment.
 */
export const normalizeRepositoryPath = (rawPath: string): string => {
  let candidate = rawPath.trim().replace(/\\/gu, '/');
  while (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/u.test(candidate) || candidate.includes('\0')) {
    throw notAFile(`Invalid repository-relative path: ${rawPath}`);
  }
  const segments = candidate.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (
    segments.length === 0
    || segments.some((segment) => segment === '..' || segment.toLowerCase() === '.git')
  ) {
    throw notAFile(`Invalid repository-relative path: ${rawPath}`);
  }
  return segments.join('/');
};

const inferSnippet = (content: string, query: string): string | null => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;
  const lower = content.toLowerCase();
  const matchIndex = lower.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    return content.slice(0, MAX_SNIPPET_LENGTH).trim() || null;
  }
  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(content.length, matchIndex + normalizedQuery.length + 80);
  return content.slice(start, end).replace(/\s+/g, ' ').trim() || null;
};

const decodeText = (content: Buffer): string => {
  if (content.length > MAX_REPO_FILE_BYTES) {
    throw notAFile('Requested file is too large to read');
  }
  if (content.includes(0)) {
    throw notAFile('Binary files cannot be read with this tool');
  }
  return content.toString('utf-8');
};

const capManifest = (files: ManifestFile[], maxFiles?: number): RepositoryManifest => {
  const cap = Math.max(1, Math.min(maxFiles ?? DEFAULT_MANIFEST_FILES, MAX_MANIFEST_FILES));
  const sorted = files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: sorted.slice(0, cap),
    completeness: sorted.length > cap ? 'partial' : 'complete',
  };
};

/** A folder's content hash: SHA-256 over its manifest, the folder's "commit". */
export const folderContentHash = (manifest: RepositoryManifest): string =>
  createHash('sha256')
    .update(manifest.files.map((file) => `${file.path}:${file.blobSha}:${file.size ?? ''}`).join('\n'))
    .digest('hex');

// ---------------------------------------------------------------------------
// folder
// ---------------------------------------------------------------------------

const statCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; blobSha: string }>();

const ignoreProbes = new Map<string, Promise<string>>();
/**
 * An empty git directory outside every folder. `ls-files --others
 * --exclude-standard` against it lists a folder's files with its .gitignore
 * rules applied and `.git` skipped, without git touching the folder.
 */
const ensureIgnoreProbe = (scratchRoot: string): Promise<string> => {
  const existing = ignoreProbes.get(scratchRoot);
  if (existing) return existing;
  const gitDir = path.join(scratchRoot, '.ignore-probe.git');
  const probe = (async () => {
    await fs.mkdir(scratchRoot, { recursive: true });
    await runGitOk(['init', '--bare', '--quiet', gitDir]);
    return gitDir;
  })().catch((error) => {
    ignoreProbes.delete(scratchRoot);
    throw error;
  });
  ignoreProbes.set(scratchRoot, probe);
  return probe;
};

const splitNul = (output: Buffer): string[] =>
  output.toString('utf8').split('\0').filter((entry) => entry.length > 0);

/** Every file in a folder, .gitignore respected, `.git` skipped, symlinks left out. */
export const listFolderManifest = async (params: {
  folder: string;
  scratchRoot: string;
  maxFiles?: number;
}): Promise<RepositoryManifest> => {
  const gitDir = await ensureIgnoreProbe(params.scratchRoot);
  const listed = splitNul(await runGitOk(
    [
      `--git-dir=${gitDir}`,
      `--work-tree=${params.folder}`,
      '-c', `core.excludesFile=${path.join(gitDir, 'no-global-excludes')}`,
      'ls-files', '-z', '--others', '--exclude-standard',
    ],
    { cwd: params.folder, timeoutMs: 60_000 },
  ));
  const cap = Math.max(1, Math.min(params.maxFiles ?? DEFAULT_MANIFEST_FILES, MAX_MANIFEST_FILES));
  const candidates = listed
    .filter((entry) => !entry.endsWith('/')) // a nested repository, not a file
    .flatMap((entry) => {
      try {
        return [normalizeRepositoryPath(entry)];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.localeCompare(right));
  const files: ManifestFile[] = [];
  for (const relativePath of candidates) {
    // One past the cap is enough to know the manifest is partial.
    if (files.length > cap) break;
    const absolutePath = path.join(params.folder, ...relativePath.split('/'));
    let stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const cached = statCache.get(absolutePath);
    let blobSha: string;
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs) {
      blobSha = cached.blobSha;
    } else {
      blobSha = await gitBlobShaOfFile(absolutePath, stats.size);
      statCache.set(absolutePath, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, blobSha });
    }
    files.push({ path: relativePath, blobSha, size: stats.size });
  }
  return capManifest(files, params.maxFiles);
};

/**
 * Read one file from a folder. The path must resolve, symlinks included,
 * inside the folder.
 */
export const readFolderFile = async (folder: string, rawPath: string): Promise<{ path: string; content: Buffer }> => {
  const relativePath = normalizeRepositoryPath(rawPath);
  const candidate = path.join(folder, ...relativePath.split('/'));
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, `File not found: ${relativePath}`);
  }
  const resolvedRelative = path.relative(folder, realCandidate);
  if (
    !isPathInside(folder, realCandidate)
    || !resolvedRelative
    || resolvedRelative.split(path.sep).some((segment) => segment.toLowerCase() === '.git')
  ) {
    throw notAFile(`Requested path resolves outside the repository: ${relativePath}`);
  }
  const stats = await fs.stat(realCandidate);
  if (!stats.isFile()) {
    throw notAFile('Requested path is not a file');
  }
  if (stats.size > MAX_REPO_FILE_BYTES) {
    throw notAFile('Requested file is too large to read');
  }
  return { path: relativePath, content: await fs.readFile(realCandidate) };
};

export const decodeRepositoryText = decodeText;

export const searchFolder = async (params: {
  folder: string;
  manifest: RepositoryManifest;
  query: string;
  limit: number;
}): Promise<Array<{ path: string; snippet: string | null }>> => {
  const needle = params.query.trim().toLowerCase();
  const results: Array<{ path: string; snippet: string | null }> = [];
  for (const file of params.manifest.files) {
    if (results.length >= params.limit) break;
    if (file.size !== null && file.size > MAX_REPO_FILE_BYTES) continue;
    let content: string;
    try {
      content = decodeText((await readFolderFile(params.folder, file.path)).content);
    } catch {
      continue;
    }
    if (content.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle)) {
      results.push({ path: file.path, snippet: inferSnippet(content, params.query) });
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// git clone
// ---------------------------------------------------------------------------

export const directorySize = async (directory: string): Promise<number> => {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        try {
          total += (await fs.lstat(entryPath)).size;
        } catch {
          // A pack file in flight can vanish between readdir and lstat.
        }
      }
    }
  }
  return total;
};

const sizeGuard = (directory: string, maxBytes: number) => async (): Promise<boolean> =>
  (await directorySize(directory)) > maxBytes;

const describeGitFailure = (error: unknown, limits: { maxBytes: number; timeoutMs: number }): string => {
  const { maxBytes, timeoutMs } = limits;
  if (error instanceof GitCommandError) {
    if (error.reason === 'missing_git') return 'git is not installed or not on PATH for the backend.';
    if (error.reason === 'timeout') return `The clone took longer than ${Math.max(1, Math.round(timeoutMs / 1000))} seconds and was stopped.`;
    if (error.reason === 'aborted') {
      return `The repository is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB, the clone limit. Clone it yourself and add it as a folder.`;
    }
    const stderr = error.stderr;
    if (
      /authentication|could not read username|permission denied|terminal prompts disabled|repository not found|403|401/iu.test(stderr)
    ) {
      return 'The repository could not be read without credentials. Null AI clones only public repositories and stores no credentials: clone a private repository yourself and add it as a folder.';
    }
    if (/remote branch .* not found|couldn't find remote ref/iu.test(stderr)) {
      return 'The ref was not found in the repository.';
    }
    if (/transport .* not allowed/iu.test(stderr)) {
      return 'That git transport is not allowed. Use an https:// or ssh git URL.';
    }
    const firstLine = stderr.split('\n').map((line) => line.trim()).find((line) => /^(fatal|error):/iu.test(line));
    return firstLine ? firstLine.replace(/^(fatal|error):\s*/iu, 'git: ') : 'git failed to clone the repository.';
  }
  return error instanceof Error ? error.message : String(error);
};

export type CloneOutcome = { ok: true; headCommit: string } | { ok: false; error: string };

/** Shallow clone: one commit, one branch, no tags, no submodules, within the limits. */
export const shallowClone = async (params: {
  url: string;
  ref: string | null;
  directory: string;
  transports: readonly GitTransport[];
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<CloneOutcome> => {
  const maxBytes = params.maxBytes ?? CLONE_MAX_BYTES;
  const timeoutMs = params.timeoutMs ?? CLONE_TIMEOUT_MS;
  await fs.mkdir(path.dirname(params.directory), { recursive: true });
  try {
    await runGitOk(
      [
        'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
        ...(params.ref ? ['--branch', params.ref] : []),
        '--', params.url, params.directory,
      ],
      {
        transports: params.transports,
        timeoutMs,
        abortWhen: sizeGuard(params.directory, maxBytes),
      },
    );
    if ((await directorySize(params.directory)) > maxBytes) {
      throw new GitCommandError('too large', '', 'aborted');
    }
    return { ok: true, headCommit: await resolveHeadCommit(params.directory) };
  } catch (error) {
    return { ok: false, error: describeGitFailure(error, { maxBytes, timeoutMs }) };
  }
};

/** Fetch the tracked ref's newest commit into an existing clone and move to it. */
export const fetchAndReset = async (params: {
  url: string;
  ref: string | null;
  directory: string;
  transports: readonly GitTransport[];
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<CloneOutcome> => {
  const maxBytes = params.maxBytes ?? CLONE_MAX_BYTES;
  const timeoutMs = params.timeoutMs ?? CLONE_TIMEOUT_MS;
  try {
    await runGitOk(
      ['fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', params.url, params.ref ?? 'HEAD'],
      {
        cwd: params.directory,
        transports: params.transports,
        timeoutMs,
        abortWhen: sizeGuard(params.directory, maxBytes),
      },
    );
    await runGitOk(['reset', '--quiet', '--hard', 'FETCH_HEAD'], { cwd: params.directory, timeoutMs: 60_000 });
    if ((await directorySize(params.directory)) > maxBytes) {
      throw new GitCommandError('too large', '', 'aborted');
    }
    return { ok: true, headCommit: await resolveHeadCommit(params.directory) };
  } catch (error) {
    return { ok: false, error: describeGitFailure(error, { maxBytes, timeoutMs }) };
  }
};

export const resolveHeadCommit = async (directory: string): Promise<string> => {
  const sha = (await runGitOk(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: directory, timeoutMs: 15_000 }))
    .toString('utf8')
    .trim()
    .toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
    throw new Error('The clone has no commit');
  }
  return sha;
};

/** The branch a clone checked out, or null when it is on a tag. */
export const resolveCheckedOutBranch = async (directory: string): Promise<string | null> => {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: directory, timeoutMs: 15_000 });
  const branch = result.stdout.toString('utf8').trim();
  return result.code === 0 && branch ? branch : null;
};

const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

type GitTreeEntry = ManifestFile & { mode: string };
const gitTreeCache = new Map<string, GitTreeEntry[]>();

/**
 * Every regular file at a commit, with its blob id and size
 * (`git ls-tree -r -l`, the committed tree, so it cannot drift).
 * Immutable per commit, so it is cached.
 */
const listGitTree = async (directory: string, commit: string): Promise<GitTreeEntry[]> => {
  if (!COMMIT_PATTERN.test(commit)) {
    throw notAFile('ref must be a full commit SHA');
  }
  const key = `${directory}\0${commit.toLowerCase()}`;
  const cached = gitTreeCache.get(key);
  if (cached) return cached;
  const result = await runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', commit.toLowerCase()], {
    cwd: directory,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    throw new AppError(
      ERROR_CODES.RESOURCE_NOT_FOUND,
      `Commit ${commit} is not available in the local clone. Refresh the code source and start a new review.`,
    );
  }
  const entries: GitTreeEntry[] = [];
  for (const record of splitNul(result.stdout)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blobSha, size] = record.slice(0, tab).trim().split(/\s+/u);
    const entryPath = record.slice(tab + 1);
    // Regular files only: no symlinks (120000) and no submodules (160000).
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    entries.push({ mode, path: entryPath, blobSha: blobSha.toLowerCase(), size: Number.isFinite(Number(size)) ? Number(size) : null });
  }
  if (gitTreeCache.size > 32) gitTreeCache.clear();
  gitTreeCache.set(key, entries);
  return entries;
};

export const listGitManifest = async (params: {
  directory: string;
  commit: string;
  maxFiles?: number;
}): Promise<RepositoryManifest> =>
  capManifest(
    (await listGitTree(params.directory, params.commit)).map(({ path: filePath, blobSha, size }) => ({ path: filePath, blobSha, size })),
    params.maxFiles,
  );

/** Read one file at a commit from git's object store (no working-tree path is followed). */
export const readGitFile = async (params: {
  directory: string;
  commit: string;
  path: string;
}): Promise<{ path: string; content: Buffer }> => {
  const relativePath = normalizeRepositoryPath(params.path);
  const entry = (await listGitTree(params.directory, params.commit)).find((file) => file.path === relativePath);
  if (!entry) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, `File not found at ${params.commit.slice(0, 12)}: ${relativePath}`);
  }
  if (entry.size !== null && entry.size > MAX_REPO_FILE_BYTES) {
    throw notAFile('Requested file is too large to read');
  }
  const content = await runGitOk(['cat-file', 'blob', entry.blobSha], {
    cwd: params.directory,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_REPO_FILE_BYTES + 1,
  });
  return { path: relativePath, content };
};

export const searchGit = async (params: {
  directory: string;
  commit: string;
  manifest: RepositoryManifest;
  query: string;
  limit: number;
}): Promise<Array<{ path: string; snippet: string | null }>> => {
  const result = await runGit(
    ['grep', '-I', '-i', '-F', '-l', '-z', '--no-color', '-e', params.query.trim(), params.commit.toLowerCase(), '--'],
    { cwd: params.directory, timeoutMs: 60_000 },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new GitCommandError('git grep failed', result.stderr, 'failed');
  }
  const prefix = `${params.commit.toLowerCase()}:`;
  const matched = new Set(
    splitNul(result.stdout).map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)),
  );
  const needle = params.query.trim().toLowerCase();
  const results: Array<{ path: string; snippet: string | null }> = [];
  for (const file of params.manifest.files) {
    if (results.length >= params.limit) break;
    if (!matched.has(file.path) && !file.path.toLowerCase().includes(needle)) continue;
    if (file.size !== null && file.size > MAX_REPO_FILE_BYTES) continue;
    let content: string;
    try {
      content = decodeText((await readGitFile({ directory: params.directory, commit: params.commit, path: file.path })).content);
    } catch {
      continue;
    }
    results.push({ path: file.path, snippet: inferSnippet(content, params.query) });
  }
  return results;
};

export const removeDirectory = async (directory: string): Promise<void> => {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
};
