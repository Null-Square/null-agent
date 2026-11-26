import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ManifestRegistry } from '@/domains/agent-brain/infrastructure/manifests';
import { toolManifestSchema } from '@/domains/agent-brain/domain/manifests';

const writeModule = (dir: string, name: string, content: string) => {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
};

describe('ManifestRegistry', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-registry-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('loads manifests from nested directories and trims ids', async () => {
    const nested = path.join(rootDir, 'nested');
    fs.mkdirSync(nested);

    writeModule(
      rootDir,
      'tool-a.js',
      "module.exports = { manifest: { id: ' tool-a ', summary: 'A', meta: { category: 'Test' } } };",
    );
    writeModule(
      nested,
      'tool-b.js',
      "module.exports = { default: { manifest: { id: 'tool-b', summary: 'B', meta: { category: 'Test' } } } };",
    );
    writeModule(rootDir, 'bad.js', 'module.exports = { nope: true };');

    const registry = new ManifestRegistry({
      directory: rootDir,
      schema: toolManifestSchema,
    });

    await registry.init();

    const ids = registry.list().map((m) => m.id).sort();
    expect(ids).toEqual(['tool-a', 'tool-b']);
    expect(registry.get('tool-a')).toEqual(expect.objectContaining({ summary: 'A' }));
  });

  it('clears records on dispose', async () => {
    writeModule(
      rootDir,
      'tool-a.js',
      "module.exports = { manifest: { id: 'tool-a', summary: 'A', meta: { category: 'Test' } } };",
    );

    const registry = new ManifestRegistry({
      directory: rootDir,
      schema: toolManifestSchema,
    });

    await registry.init();
    expect(registry.list()).toHaveLength(1);

    registry.dispose();
    expect(registry.list()).toHaveLength(0);
  });
});
