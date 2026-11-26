import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { SeedRegistry } from '@/app/seeding/SeedRegistry';

const schema = z.object({
  name: z.string(),
  value: z.number(),
});

const write = async (dir: string, file: string, content: string) => {
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
};

describe('SeedRegistry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-registry-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('loads JSON and YAML seeds and validates with zod', async () => {
    await write(dir, 'a.json', JSON.stringify({ name: 'one', value: 1 }));
    await write(dir, 'nested/b.yaml', 'name: two\nvalue: 2\n');

    const registry = new SeedRegistry({ directory: dir, schema });
    await registry.init();

    const names = registry.list().map((r) => r.name).sort();
    expect(names).toEqual(['a', 'b']);
    expect(registry.getData('a')).toEqual({ name: 'one', value: 1 });
    expect(registry.getData('b')).toEqual({ name: 'two', value: 2 });
  });

  it('skips unsupported extensions and keeps consistent ordering', async () => {
    await write(dir, 'a.txt', 'ignore');
    await write(dir, 'b.json', JSON.stringify({ name: 'b', value: 2 }));
    await write(dir, 'a.json', JSON.stringify({ name: 'a', value: 1 }));

    const registry = new SeedRegistry({ directory: dir, schema });
    await registry.init();

    const data = registry.listData();
    expect(data).toHaveLength(2);
    expect(data.find((d) => d.name === 'a')).toBeTruthy();
    expect(data.find((d) => d.name === 'b')).toBeTruthy();
  });

  it('warns and skips invalid seed files', async () => {
    await write(dir, 'bad.json', JSON.stringify({ name: 'bad', value: 'not-a-number' }));
    const registry = new SeedRegistry({ directory: dir, schema });
    // Should not throw; invalid file just skipped
    await registry.init();

    expect(registry.listData()).toEqual([]);
  });
});







