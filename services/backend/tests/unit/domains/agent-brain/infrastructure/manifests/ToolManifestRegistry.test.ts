import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolManifestRegistry } from '@/domains/agent-brain/infrastructure/manifests';

const writeModule = (dir: string, name: string, content: string) => {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
};

const toolDef = (id: string) => `{
  manifest: { id: '${id}', summary: '${id}', meta: { category: 'Test' } },
  meta: { name: '${id}', description: 'desc', schema: {}, risks: [] },
  run: async () => ({ ok: true }),
}`;

describe('ToolManifestRegistry', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-manifest-registry-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('loads tool modules from multiple export shapes', async () => {
    writeModule(rootDir, 'tool-a.js', `module.exports = ${toolDef('tool-a')};`);
    writeModule(
      rootDir,
      'tool-b.js',
      `module.exports = [${toolDef('tool-b')}, ${toolDef('tool-c')}];`,
    );
    writeModule(
      rootDir,
      'tool-d.js',
      `module.exports = { default: { tools: [${toolDef('tool-d')}] } };`,
    );

    const onUpdate = vi.fn();
    const registry = new ToolManifestRegistry({ directory: rootDir, onUpdate });

    await registry.init();

    const ids = registry.list().map((m) => m.id).sort();
    expect(ids).toEqual(['tool-a', 'tool-b', 'tool-c', 'tool-d']);
    expect(registry.listModules()).toHaveLength(4);
    expect(registry.getModule('tool-b')).toBeDefined();
    expect(registry.getModule('tool-b')?.sourceFile).toContain('tool-b.js');
    expect(registry.getModule('missing')).toBeUndefined();
    expect(onUpdate).toHaveBeenCalledWith(expect.any(Array));
    expect(onUpdate.mock.calls[0][0]).toHaveLength(4);
  });
});
