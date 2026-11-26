import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary git repositories for code-source tests. Git runs isolated from the
 * machine's git configuration so signing, autocrlf or hooks never interfere.
 */
const emptyConfig = path.join(os.tmpdir(), 'null-ai-git-test-empty-config');
fs.writeFileSync(emptyConfig, '', { flag: 'a' });

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || key === 'GIT_EXEC_PATH')),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_TERMINAL_PROMPT: '0',
});

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
  }).trim();

export const makeTempDir = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `null-ai-${prefix}-`)));

export const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
};

/** A committed repository on `main`; returns its directory. */
export const makeGitRepo = (files: Record<string, string>): string => {
  const directory = makeTempDir('repo');
  git(directory, 'init', '--quiet', '-b', 'main');
  writeFiles(directory, files);
  git(directory, 'add', '-A');
  git(directory, 'commit', '--quiet', '-m', 'initial');
  return directory;
};

export const commitFiles = (directory: string, files: Record<string, string>, message = 'change'): string => {
  writeFiles(directory, files);
  git(directory, 'add', '-A');
  git(directory, 'commit', '--quiet', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
};

/** A file:// URL git accepts on every platform. */
export const fileUrlFor = (directory: string): string =>
  `file://${directory.startsWith('/') ? '' : '/'}${directory.replace(/\\/gu, '/')}`;

export const removeTempDir = (directory: string): void => {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};
