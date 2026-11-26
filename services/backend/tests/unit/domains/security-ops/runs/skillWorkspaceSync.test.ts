import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  syncAssignedSkillsIntoWorkspace,
} from '@/domains/security-ops/runs/skillWorkspaceSync';

const tempDirs: string[] = [];

const createTempWorkspace = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-skill-sync-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('skillWorkspaceSync', () => {
  it('returns empty list when workspace path is missing', async () => {
    await expect(syncAssignedSkillsIntoWorkspace(['sql-injection'], undefined)).resolves.toEqual([]);
    await expect(syncAssignedSkillsIntoWorkspace(['sql-injection'], '')).resolves.toEqual([]);
  });

  it('returns empty list when no skills are assigned', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace([], workspace);

    expect(synced).toEqual([]);
    await expect(fs.access(path.resolve(workspace, '.skills'))).rejects.toThrow();
  });

  it('fails closed when an assigned methodology is not active', async () => {
    const workspace = await createTempWorkspace();

    await expect(
      syncAssignedSkillsIntoWorkspace(['method-that-does-not-exist'], workspace),
    ).rejects.toThrow('Assigned methodology could not be synchronized: method-that-does-not-exist');
  });

  it('copies explicitly assigned skills into workspace .skills directory', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace(['sql-injection'], workspace);

    expect(synced).toEqual(['sql-injection']);

    const copiedSkill = path.resolve(workspace, '.skills', 'sql-injection', 'SKILL.md');
    await expect(fs.access(copiedSkill)).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'sql-injection', 'methodology.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'sql-injection', 'examples.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'sql-injection', 'fixtures')),
    ).rejects.toThrow();
  });

  it('keeps compliance readiness templates out of the normal security reporting skill', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace(['security-reporting'], workspace);

    expect(synced).toEqual(['security-reporting']);
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'security-reporting', 'templates')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'compliance-reporting', 'templates')),
    ).rejects.toThrow();
  });

  it('keeps framework templates out of the compliance reporting skill workspace', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace(['compliance-reporting'], workspace);

    expect(synced).toEqual(['compliance-reporting']);
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'compliance-reporting', 'templates')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.resolve(workspace, '.skills', 'security-reporting')),
    ).rejects.toThrow();
  });

  it('syncs the normalized methodology for formerly compact skills', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace(['compliance-access-control'], workspace);

    expect(synced).toEqual(['compliance-access-control']);
    const methodology = await fs.readFile(
      path.resolve(workspace, '.skills', 'compliance-access-control', 'methodology.md'),
      'utf8',
    );
    expect(methodology).toContain('B1 Methodology Contract');
    expect(methodology).toContain('Preconditions and Fast Applicability');
  });

  it('normalizes and deduplicates assigned skill slugs', async () => {
    const workspace = await createTempWorkspace();

    const synced = await syncAssignedSkillsIntoWorkspace(
      ['SQL-INJECTION', '  sql-injection  ', '', 'xss'],
      workspace,
    );

    expect(synced).toContain('sql-injection');
    expect(synced).toContain('xss');
    expect(synced.length).toBe(2);
  });
});
