import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  folderContentHash,
  gitBlobSha,
  listFolderManifest,
  listGitManifest,
  normalizeRepositoryPath,
  readFolderFile,
  readGitFile,
  searchFolder,
  searchGit,
} from '@/domains/security-ops/code-sources/localRepository';
import { git, makeGitRepo, makeTempDir, removeTempDir, writeFiles } from '../../../../helpers/gitTestRepo';

const canSymlink = (() => {
  const probe = makeTempDir('symlink-probe');
  try {
    fs.writeFileSync(path.join(probe, 'target'), 'x');
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    removeTempDir(probe);
  }
})();

describe('local repository reads', () => {
  const temps: string[] = [];
  const temp = (prefix: string) => {
    const directory = makeTempDir(prefix);
    temps.push(directory);
    return directory;
  };
  afterEach(() => {
    while (temps.length) removeTempDir(temps.pop() as string);
  });

  it('computes the git blob id git itself computes (git hash-object)', () => {
    const folder = temp('hash');
    writeFiles(folder, { 'a.txt': 'hello\n', 'empty.txt': '', 'bin.dat': '\u0000\u0001\u0002' });
    for (const name of ['a.txt', 'empty.txt', 'bin.dat']) {
      const file = path.join(folder, name);
      expect(gitBlobSha(fs.readFileSync(file))).toBe(git(folder, 'hash-object', '--no-filters', file));
    }
  });

  it('lists a plain folder with .gitignore respected, .git and nested repositories skipped, and blob ids equal to git hash-object', async () => {
    const folder = temp('folder');
    const scratch = temp('scratch');
    writeFiles(folder, {
      '.gitignore': 'node_modules/\n*.log\n',
      'src/app.ts': 'export const secret = process.env.API_KEY;\n',
      'README.md': '# app\n',
      'debug.log': 'ignored\n',
      'node_modules/pkg/index.js': 'ignored\n',
      '.git/config': '[core]\n',
    });
    git(path.join(folder, 'src'), 'init', '--quiet', 'nested');
    writeFiles(folder, { 'src/nested/inner.txt': 'nested repository\n' });

    const manifest = await listFolderManifest({ folder, scratchRoot: scratch });

    expect(manifest.files.map((file) => file.path)).toEqual(['.gitignore', 'README.md', 'src/app.ts']);
    expect(manifest.completeness).toBe('complete');
    for (const file of manifest.files) {
      const absolute = path.join(folder, ...file.path.split('/'));
      expect(file.blobSha).toBe(git(folder, 'hash-object', '--no-filters', absolute));
      expect(file.size).toBe(fs.statSync(absolute).size);
    }
    expect(fs.readdirSync(folder).sort()).toEqual(['.git', '.gitignore', 'README.md', 'debug.log', 'node_modules', 'src']);
  });

  it('marks a folder manifest partial past the file cap and changes the content hash when a file changes', async () => {
    const folder = temp('folder');
    const scratch = temp('scratch');
    writeFiles(folder, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const capped = await listFolderManifest({ folder, scratchRoot: scratch, maxFiles: 2 });
    expect(capped.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
    expect(capped.completeness).toBe('partial');

    const before = folderContentHash(await listFolderManifest({ folder, scratchRoot: scratch }));
    writeFiles(folder, { 'b.txt': 'changed' });
    const after = folderContentHash(await listFolderManifest({ folder, scratchRoot: scratch }));
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(['../outside.txt', 'src/../../outside.txt', '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'src/.GIT/config', ''])(
    'refuses the repository path %j',
    (candidate) => {
      expect(() => normalizeRepositoryPath(candidate)).toThrow(/Invalid repository-relative path/u);
    },
  );

  it('reads only inside the folder', async () => {
    const parent = temp('parent');
    const folder = path.join(parent, 'repo');
    writeFiles(parent, { 'outside.txt': 'secret', 'repo/inside.txt': 'ok' });
    await expect(readFolderFile(folder, 'inside.txt')).resolves.toMatchObject({ path: 'inside.txt' });
    await expect(readFolderFile(folder, './inside.txt')).resolves.toMatchObject({ path: 'inside.txt' });
    await expect(readFolderFile(folder, '../outside.txt')).rejects.toThrow(/Invalid repository-relative path/u);
  });

  it.runIf(canSymlink)('refuses a symlink that escapes the folder or points into .git', async () => {
    const parent = temp('parent');
    const folder = path.join(parent, 'repo');
    writeFiles(parent, { 'outside.txt': 'secret', 'repo/.git/config': '[core]', 'repo/inside.txt': 'ok' });
    fs.symlinkSync(path.join(parent, 'outside.txt'), path.join(folder, 'escape.txt'), 'file');
    fs.symlinkSync(path.join(folder, '.git', 'config'), path.join(folder, 'gitconfig.txt'), 'file');
    fs.symlinkSync(path.join(folder, 'inside.txt'), path.join(folder, 'alias.txt'), 'file');
    await expect(readFolderFile(folder, 'escape.txt')).rejects.toThrow(/resolves outside the repository/u);
    await expect(readFolderFile(folder, 'gitconfig.txt')).rejects.toThrow(/resolves outside the repository/u);
    await expect(readFolderFile(folder, 'alias.txt')).resolves.toMatchObject({ path: 'alias.txt' });
  });

  it('refuses a directory link (junction on Windows) that escapes the folder or points into .git', async () => {
    const parent = temp('parent');
    const folder = path.join(parent, 'repo');
    writeFiles(parent, { 'outside/secret.txt': 'secret', 'repo/.git/config': '[core]', 'repo/src/inside.txt': 'ok' });
    const links = [
      [path.join(parent, 'outside'), path.join(folder, 'escape')],
      [path.join(folder, '.git'), path.join(folder, 'gitdir')],
      [path.join(folder, 'src'), path.join(folder, 'alias')],
    ];
    for (const [target, link] of links) fs.symlinkSync(target, link, 'junction');
    try {
      await expect(readFolderFile(folder, 'escape/secret.txt')).rejects.toThrow(/resolves outside the repository/u);
      await expect(readFolderFile(folder, 'gitdir/config')).rejects.toThrow(/resolves outside the repository/u);
      await expect(readFolderFile(folder, 'alias/inside.txt')).resolves.toMatchObject({ path: 'alias/inside.txt' });
    } finally {
      for (const [, link] of links) fs.unlinkSync(link); // detach links before recursive cleanup
    }
  });

  it('lists a commit with git blob ids and reads files from the object store, not the working tree', async () => {
    const repo = makeGitRepo({ 'src/app.ts': 'const token = "abc";\n', 'README.md': '# repo\n' });
    temps.push(repo);
    const commit = git(repo, 'rev-parse', 'HEAD');
    const manifest = await listGitManifest({ directory: repo, commit });

    expect(manifest.files.map((file) => file.path)).toEqual(['README.md', 'src/app.ts']);
    for (const file of manifest.files) {
      expect(file.blobSha).toBe(git(repo, 'hash-object', '--no-filters', path.join(repo, ...file.path.split('/'))));
    }

    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'tampered working tree');
    const read = await readGitFile({ directory: repo, commit, path: 'src/app.ts' });
    expect(read.content.toString('utf8')).toBe('const token = "abc";\n');
    await expect(readGitFile({ directory: repo, commit, path: '../x' })).rejects.toThrow(/Invalid repository-relative path/u);
    await expect(readGitFile({ directory: repo, commit, path: 'missing.ts' })).rejects.toThrow(/File not found/u);
    await expect(readGitFile({ directory: repo, commit: 'HEAD', path: 'README.md' })).rejects.toThrow(/full commit SHA/u);
  });

  it('searches a folder and a commit case-insensitively with snippets', async () => {
    const repo = makeGitRepo({ 'src/app.ts': 'const Token = readSecret();\n', 'docs/a.md': 'nothing here\n' });
    const scratch = temp('scratch');
    temps.push(repo);
    const commit = git(repo, 'rev-parse', 'HEAD');
    const gitManifest = await listGitManifest({ directory: repo, commit });
    const gitResults = await searchGit({ directory: repo, commit, manifest: gitManifest, query: 'token', limit: 5 });
    expect(gitResults).toEqual([{ path: 'src/app.ts', snippet: 'const Token = readSecret();' }]);

    const folderManifest = await listFolderManifest({ folder: repo, scratchRoot: scratch });
    const folderResults = await searchFolder({ folder: repo, manifest: folderManifest, query: 'TOKEN', limit: 5 });
    expect(folderResults).toEqual([{ path: 'src/app.ts', snippet: 'const Token = readSecret();' }]);
  });
});
