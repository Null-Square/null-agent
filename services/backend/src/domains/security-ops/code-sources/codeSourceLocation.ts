import fs from 'node:fs/promises';
import path from 'node:path';

import { localSettings, workspaceRootDir } from '@/config/configSchema';
import { AppError, ERROR_CODES } from '@/shared/errors';

/**
 * Where a scope's code may come from, and where a clone lives.
 *
 * A git URL is cloned only over https or ssh. A folder is read in place, and
 * when NULL_AI_CODE_ROOT is set (compose mounts the person's code there
 * read-only) the folder must resolve inside it.
 */

export type GitTransport = 'https' | 'ssh' | 'file';

export type ParsedGitUrl = {
  url: string;
  transport: GitTransport;
  /** `owner/name` from the URL path, the repository's name in reviews. */
  fullName: string;
  name: string;
  ownerLogin: string;
};

/**
 * The URL check and the transports git may use, kept together so the two can
 * never disagree. Production uses `STRICT_GIT_URL_POLICY`; unit tests pass a
 * policy that also admits a temporary local repository (no internet).
 */
export type GitUrlPolicy = {
  readonly transports: readonly GitTransport[];
  parse(raw: string): ParsedGitUrl;
};

const invalidUrl = (message: string): AppError =>
  new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, message, { userMessage: message });

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const SCP_LIKE_PATTERN = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/u;

const repositoryIdentity = (repositoryPath: string): Pick<ParsedGitUrl, 'fullName' | 'name' | 'ownerLogin'> => {
  const fullName = repositoryPath
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '');
  const segments = fullName.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw invalidUrl('The git URL must name a repository path, for example https://github.com/owner/name.git');
  }
  return {
    fullName: segments.join('/'),
    name: segments[segments.length - 1],
    ownerLogin: segments.length > 1 ? segments[0] : '',
  };
};

const assertNoControlCharacters = (value: string): void => {
  if (/\s/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw invalidUrl('The git URL cannot contain spaces or control characters');
  }
};

/**
 * Only https:// and ssh (`ssh://` or `user@host:path`). Everything else is
 * refused: http, git://, file://, ext::, local paths, and credentials in the
 * URL (a private repository is cloned by the person and added as a folder).
 */
export const parseStrictGitUrl = (raw: string): ParsedGitUrl => {
  const value = raw.trim();
  if (!value) {
    throw invalidUrl('A git URL is required');
  }
  assertNoControlCharacters(value);
  if (value.startsWith('-')) {
    throw invalidUrl('The git URL cannot start with "-"');
  }

  const scpLike = SCP_LIKE_PATTERN.exec(value);
  if (scpLike && !value.includes('://')) {
    const [, , host, repositoryPath] = scpLike;
    if (!HOST_PATTERN.test(host)) {
      throw invalidUrl('The git URL host is invalid');
    }
    return { url: value, transport: 'ssh', ...repositoryIdentity(repositoryPath) };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidUrl('Use an https:// or ssh git URL (https://host/owner/name.git, ssh://git@host/owner/name.git or git@host:owner/name.git)');
  }

  const scheme = parsed.protocol.replace(/:$/u, '').toLowerCase();
  if (scheme !== 'https' && scheme !== 'ssh') {
    throw invalidUrl(`The ${scheme}:// scheme is not allowed. Use an https:// or ssh git URL.`);
  }
  if (!parsed.hostname || !HOST_PATTERN.test(parsed.hostname.replace(/^\[|\]$/gu, ''))) {
    throw invalidUrl('The git URL host is invalid');
  }
  if (scheme === 'https' && (parsed.username || parsed.password)) {
    throw invalidUrl(
      'Credentials cannot be part of the git URL. Null AI stores no credentials: clone a private repository yourself and add it as a folder.',
    );
  }
  if (scheme === 'ssh' && parsed.password) {
    throw invalidUrl('A password cannot be part of an ssh git URL');
  }
  if (parsed.search || parsed.hash) {
    throw invalidUrl('The git URL cannot carry a query or a fragment');
  }
  return {
    url: value,
    transport: scheme,
    ...repositoryIdentity(decodeURIComponent(parsed.pathname)),
  };
};

export const STRICT_GIT_URL_POLICY: GitUrlPolicy = {
  transports: ['https', 'ssh'],
  parse: parseStrictGitUrl,
};

const GIT_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u;

/** A branch or tag name. It never starts with "-", so it cannot become a git option. */
export const normalizeGitRef = (raw: string | null | undefined): string | null => {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  if (
    value.length > 200
    || !GIT_REF_PATTERN.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'ref must be a branch or tag name', {
      userMessage: 'ref must be a branch or tag name',
    });
  }
  return value;
};

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const invalidFolder = (message: string): AppError =>
  new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, message, { userMessage: message });

/**
 * Resolve a folder the person named: absolute, existing, a directory, its
 * symlinks resolved, and inside `codeRoot` when one is configured. Returns the
 * real path the backend reads. Re-run before every use, because a symlink in
 * the path can change after the folder was added.
 */
export const resolveCodeFolder = async (
  rawPath: string,
  codeRoot: string | null = configuredCodeRoot(),
): Promise<string> => {
  const value = rawPath.trim();
  if (!value) {
    throw invalidFolder('A folder path is required');
  }
  if (!path.isAbsolute(value)) {
    throw invalidFolder('The folder path must be absolute');
  }
  let realFolder: string;
  try {
    realFolder = await fs.realpath(value);
  } catch {
    throw invalidFolder(`The folder ${value} does not exist`);
  }
  const stats = await fs.stat(realFolder);
  if (!stats.isDirectory()) {
    throw invalidFolder(`${value} is not a folder`);
  }
  if (codeRoot) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(codeRoot);
    } catch {
      throw invalidFolder(`NULL_AI_CODE_ROOT (${codeRoot}) does not exist`);
    }
    if (!isInside(realRoot, realFolder)) {
      throw invalidFolder(`The folder must be inside ${codeRoot}, where your code is mounted`);
    }
  }
  return realFolder;
};

/** The folder compose mounts the person's code into, when set. */
export const configuredCodeRoot = (): string | null => {
  const value = localSettings().NULL_AI_CODE_ROOT;
  return value ? path.resolve(value) : null;
};

/** `${WORKSPACE_ROOT}/code-sources`, from the same workspace root ConfigService uses. */
export const codeSourcesRoot = (): string =>
  path.resolve(workspaceRootDir(localSettings().WORKSPACE_ROOT), 'code-sources');

/** A clone's directory, derived from the source id (never stored). */
export const cloneDirectoryFor = (sourceId: string, root: string = codeSourcesRoot()): string => {
  if (!/^[0-9a-f-]{36}$/iu.test(sourceId)) {
    throw new Error('A clone directory needs a code source id');
  }
  return path.join(root, sourceId);
};

/** The repository's name in reviews: the folder's name. */
export const folderRepositoryName = (location: string): string =>
  path.basename(path.resolve(location)) || 'folder';

export const isPathInside = isInside;
