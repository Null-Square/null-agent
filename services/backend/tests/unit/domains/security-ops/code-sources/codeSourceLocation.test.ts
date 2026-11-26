import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cloneDirectoryFor,
  normalizeGitRef,
  parseStrictGitUrl,
  resolveCodeFolder,
} from '@/domains/security-ops/code-sources/codeSourceLocation';
import { makeTempDir, removeTempDir } from '../../../../helpers/gitTestRepo';

const canSymlink = (() => {
  const probe = makeTempDir('symlink-probe');
  try {
    fs.symlinkSync(probe, path.join(probe, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    removeTempDir(probe);
  }
})();

describe('git URL rules', () => {
  it.each([
    ['https://github.com/juice-shop/juice-shop.git', 'juice-shop/juice-shop', 'https'],
    ['https://gitlab.example.com/group/sub/app', 'group/sub/app', 'https'],
    ['ssh://git@github.com/owner/name.git', 'owner/name', 'ssh'],
    ['git@github.com:owner/name.git', 'owner/name', 'ssh'],
  ])('accepts %s as an https or ssh URL and names the repository from its path', (url, fullName, transport) => {
    const parsed = parseStrictGitUrl(url);
    expect(parsed.fullName).toBe(fullName);
    expect(parsed.transport).toBe(transport);
    expect(parsed.url).toBe(url);
  });

  it.each([
    ['http://github.com/owner/name.git', /http:\/\/ scheme is not allowed/u],
    ['git://github.com/owner/name.git', /git:\/\/ scheme is not allowed/u],
    ['file:///etc/passwd', /file:\/\/ scheme is not allowed/u],
    ['ext::sh -c touch% /tmp/pwned', /spaces or control characters/u],
    ['ext::ssh', /ext:\/\/ scheme is not allowed/u],
    ['/home/me/project', /https:\/\/ or ssh git URL/u],
    ['C:\\Users\\me\\project', /scheme is not allowed/u],
    ['../relative/repo', /https:\/\/ or ssh git URL/u],
    ['-uhttps://github.com/owner/name', /cannot start with "-"/u],
    ['https://user:token@github.com/owner/name.git', /Credentials cannot be part of the git URL/u],
    ['https://github.com/owner/name.git?x=1', /query or a fragment/u],
    ['https://-oProxyCommand=x/owner/name', /host is invalid/u],
    ['git@-oProxyCommand=x:owner/name', /scheme is not allowed|host is invalid|https:\/\/ or ssh git URL/u],
    ['https://github.com/', /must name a repository path/u],
  ])('refuses %s', (url, message) => {
    expect(() => parseStrictGitUrl(url)).toThrow(message);
  });

  it('accepts branch and tag refs and refuses refs that could become git options', () => {
    expect(normalizeGitRef('main')).toBe('main');
    expect(normalizeGitRef('release/v1.2.3')).toBe('release/v1.2.3');
    expect(normalizeGitRef('  ')).toBeNull();
    for (const ref of ['-n', '--upload-pack=x', 'a..b', 'a b', 'refs/heads/', 'x.lock']) {
      expect(() => normalizeGitRef(ref)).toThrow(/branch or tag name/u);
    }
  });

  it('derives a clone directory from the source id only', () => {
    const root = path.resolve('/tmp/code-sources');
    expect(cloneDirectoryFor('11111111-1111-4111-8111-111111111111', root)).toBe(
      path.join(root, '11111111-1111-4111-8111-111111111111'),
    );
    expect(() => cloneDirectoryFor('../escape', root)).toThrow();
  });
});

describe('folder rules', () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length) removeTempDir(temps.pop() as string);
  });

  it('resolves an absolute existing folder to its real path', async () => {
    const folder = makeTempDir('folder');
    temps.push(folder);
    await expect(resolveCodeFolder(folder, null)).resolves.toBe(fs.realpathSync(folder));
  });

  it('refuses a relative path, a missing path and a file', async () => {
    const folder = makeTempDir('folder');
    temps.push(folder);
    fs.writeFileSync(path.join(folder, 'file.txt'), 'x');
    await expect(resolveCodeFolder('relative/path', null)).rejects.toThrow(/must be absolute/u);
    await expect(resolveCodeFolder(path.join(folder, 'missing'), null)).rejects.toThrow(/does not exist/u);
    await expect(resolveCodeFolder(path.join(folder, 'file.txt'), null)).rejects.toThrow(/is not a folder/u);
  });

  it('requires the folder to sit inside NULL_AI_CODE_ROOT when it is set', async () => {
    const codeRoot = makeTempDir('code-root');
    const outside = makeTempDir('outside');
    temps.push(codeRoot, outside);
    fs.mkdirSync(path.join(codeRoot, 'app'));
    await expect(resolveCodeFolder(path.join(codeRoot, 'app'), codeRoot)).resolves.toBe(path.join(codeRoot, 'app'));
    await expect(resolveCodeFolder(outside, codeRoot)).rejects.toThrow(/must be inside/u);
    await expect(resolveCodeFolder(path.join(codeRoot, 'app', '..', '..'), codeRoot)).rejects.toThrow(/must be inside/u);
  });

  it.runIf(canSymlink)('resolves symlinks before the NULL_AI_CODE_ROOT check, so a link cannot escape it', async () => {
    const codeRoot = makeTempDir('code-root');
    const outside = makeTempDir('outside');
    temps.push(codeRoot, outside);
    const link = path.join(codeRoot, 'escape');
    fs.symlinkSync(outside, link, 'junction');
    try {
      await expect(resolveCodeFolder(link, codeRoot)).rejects.toThrow(/must be inside/u);
    } finally {
      fs.unlinkSync(link); // detach the link before any recursive cleanup
    }
  });
});
