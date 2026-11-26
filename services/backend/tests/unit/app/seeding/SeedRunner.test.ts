import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
import { SeedRunner, type SeedStep } from '@/app/seeding/SeedRunner';

// Mock the seedStatusRepository to avoid real DB calls in unit tests
vi.mock('@/app/seeding/SeedStatusRepository', () => ({
  seedStatusRepository: {
    isApplied: vi.fn().mockResolvedValue(false),
    markApplied: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    getInfo: vi.fn().mockResolvedValue({ name: 'test', applied: false }),
    getAllWithKnownSeeds: vi.fn().mockResolvedValue([]),
  },
}));

import { seedStatusRepository } from '@/app/seeding/SeedStatusRepository';

const step = (name: string, dependsOn: string[] = [], required = true): SeedStep => ({
  name,
  dependsOn,
  required,
  seed: vi.fn(async () => undefined),
});

const stepWithSeedFile = (name: string, seedFile: string, dependsOn: string[] = []): SeedStep => ({
  name,
  dependsOn,
  seedFile,
  seed: vi.fn(async () => undefined),
});

const alwaysRunStep = (name: string): SeedStep => ({
  name,
  alwaysRun: true,
  seed: vi.fn(async () => undefined),
});

describe('SeedRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock implementations after clearing
    (seedStatusRepository.getInfo as Mock).mockResolvedValue({ name: 'test', applied: false });
    (seedStatusRepository.isApplied as Mock).mockResolvedValue(false);
  });

  it('runs steps in topological order respecting dependencies', async () => {
    const a = step('a');
    const b = step('b', ['a']);
    const c = step('c', ['b']);
    const runner = new SeedRunner([c, b, a]);

    const results = await runner.runAll();

    expect(results.map((r) => r.step)).toEqual(['a', 'b', 'c']);
    expect((a.seed as Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (b.seed as Mock).mock.invocationCallOrder[0],
    );
    expect((b.seed as Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (c.seed as Mock).mock.invocationCallOrder[0],
    );
  });

  it('supports skip and only filters', async () => {
    const a = step('a');
    const b = step('b');
    const runner = new SeedRunner([a, b], { only: ['b'], skip: ['a'] });

    const results = await runner.runAll();

    expect(results.map((r) => r.step)).toEqual(['b']);
    expect(a.seed).not.toHaveBeenCalled();
    expect(b.seed).toHaveBeenCalled();
  });

  it('respects dryRun without executing seeds', async () => {
    const a = step('a');
    const runner = new SeedRunner([a], { dryRun: true });

    const results = await runner.runAll();

    expect(results[0].success).toBe(true);
    expect(a.seed).not.toHaveBeenCalled();
  });

  it('throws when a required dependency fails', async () => {
    const failing = step('a');
    (failing.seed as Mock).mockRejectedValue(new Error('boom'));
    const dependent = step('b', ['a']);
    const runner = new SeedRunner([failing, dependent]);

    await expect(runner.runAll()).rejects.toThrow(/Required seed step failed/);
    expect(dependent.seed).not.toHaveBeenCalled();
  });

  it('allows optional steps to fail without aborting', async () => {
    const optional = step('opt');
    (optional.seed as Mock).mockRejectedValue(new Error('boom'));
    optional.required = false;
    const runner = new SeedRunner([optional]);

    const results = await runner.runAll();

    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeInstanceOf(Error);
  });

  it('detects circular dependencies', () => {
    const a = step('a', ['b']);
    const b = step('b', ['a']);
    expect(() => new SeedRunner([a, b])).toThrow(/Circular dependency/);
  });

  // ============================================================================
  // Hash-Based Versioning Tests
  // ============================================================================

  describe('hash-based versioning', () => {
    // Note: In unit tests, seedFile paths don't exist so hashFile returns undefined.
    // We test the logic branches: applied + no hash change = skip, not applied = run, force = run

    it('skips seed when already applied (legacy mode, no seedFile)', async () => {
      const legacy = step('legacy-seed');
      
      // Mock: seed already applied (no version tracking)
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'legacy-seed',
        applied: true,
        version: undefined,
      });

      const runner = new SeedRunner([legacy]);
      const results = await runner.runAll();

      // Should skip because applied and no currentHash (no seedFile)
      expect(results[0].skipped).toBe(true);
      expect(legacy.seed).not.toHaveBeenCalled();
    });

    it('skips seed when applied and currentHash is undefined (file not found)', async () => {
      const models = stepWithSeedFile('models', 'nonexistent.seed.json');
      
      // Mock: seed already applied with some stored hash
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: true,
        version: 'stored-hash',
      });

      const runner = new SeedRunner([models]);
      const results = await runner.runAll();

      // hashFile returns undefined when file doesn't exist
      // Logic: if !currentHash, hash is "unchanged" so skip
      expect(results[0].skipped).toBe(true);
      expect(models.seed).not.toHaveBeenCalled();
    });

    it('runs seed when never applied before', async () => {
      const models = step('models');
      
      // Mock: seed never applied
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: false,
      });

      const runner = new SeedRunner([models]);
      const results = await runner.runAll();

      expect(results[0].success).toBe(true);
      expect(models.seed).toHaveBeenCalled();
      expect(seedStatusRepository.markApplied).toHaveBeenCalledWith('models', undefined);
    });

    it('force mode re-runs all seeds regardless of applied status', async () => {
      const models = step('models');
      
      // Mock: seed already applied
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: true,
        version: 'current-hash',
      });

      const runner = new SeedRunner([models], { force: true });
      const results = await runner.runAll();

      // Force mode skips the applied check entirely
      expect(results[0].skipped).toBeFalsy();
      expect(models.seed).toHaveBeenCalled();
    });

    it('marks seed as applied with hash after successful run', async () => {
      const models = step('models');
      
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: false,
      });

      const runner = new SeedRunner([models]);
      await runner.runAll();

      // Should mark as applied (with undefined hash since no seedFile)
      expect(seedStatusRepository.markApplied).toHaveBeenCalledWith('models', undefined);
    });

    it('checkOnlyPending=false skips status check and runs all', async () => {
      const models = step('models');
      
      // Mock: seed already applied
      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: true,
      });

      const runner = new SeedRunner([models], { checkOnlyPending: false });
      const results = await runner.runAll();

      // checkOnlyPending=false means run regardless of applied status
      expect(results[0].success).toBe(true);
      expect(models.seed).toHaveBeenCalled();
    });

    it('runs alwaysRun seeds even when already applied and hash is unchanged', async () => {
      const models = alwaysRunStep('models');

      (seedStatusRepository.getInfo as Mock).mockResolvedValue({
        name: 'models',
        applied: true,
        version: 'current-hash',
      });

      const runner = new SeedRunner([models]);
      const results = await runner.runAll();

      expect(results[0].skipped).toBeFalsy();
      expect(models.seed).toHaveBeenCalled();
      expect(seedStatusRepository.getInfo).not.toHaveBeenCalled();
      expect(seedStatusRepository.markApplied).toHaveBeenCalledWith('models', undefined);
    });
  });
});
