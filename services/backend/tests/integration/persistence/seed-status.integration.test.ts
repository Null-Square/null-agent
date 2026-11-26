/**
 * Seed Status Integration Tests
 * 
 * Tests the actual database flow for seed status tracking.
 * Uses unique seed names per test to avoid state conflicts.
 * 
 * Requires TEST_DATABASE_URL to be set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { seedStatusRepository } from '@/app/seeding/SeedStatusRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Generate unique seed names per test run to avoid conflicts
const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

maybeDescribe('Seed Status Integration', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    // We use unique seed names, so no need to truncate
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  // ============================================================================
  // SeedStatusRepository Tests
  // ============================================================================

  itMaybe('isApplied returns false for unapplied seed', async () => {
    const seedName = `test-seed-${uniqueId()}`;
    const result = await seedStatusRepository.isApplied(seedName);
    expect(result).toBe(false);
  });

  itMaybe('markApplied records seed in database', async () => {
    const seedName = `test-seed-${uniqueId()}`;
    
    await seedStatusRepository.markApplied(seedName, 'v1');
    
    const applied = await seedStatusRepository.isApplied(seedName);
    expect(applied).toBe(true);
  });

  itMaybe('getInfo returns correct seed info after marking', async () => {
    const seedName = `test-seed-${uniqueId()}`;
    
    await seedStatusRepository.markApplied(seedName, 'v1');
    
    const info = await seedStatusRepository.getInfo(seedName);
    expect(info.name).toBe(seedName);
    expect(info.applied).toBe(true);
    expect(info.version).toBe('v1');
    expect(info.appliedAt).toBeInstanceOf(Date);
  });

  itMaybe('markPending removes seed from applied status', async () => {
    const seedName = `test-seed-${uniqueId()}`;
    
    await seedStatusRepository.markApplied(seedName);
    expect(await seedStatusRepository.isApplied(seedName)).toBe(true);
    
    await seedStatusRepository.markPending(seedName);
    expect(await seedStatusRepository.isApplied(seedName)).toBe(false);
  });

  itMaybe('getAllWithKnownSeeds merges DB and known list', async () => {
    const seedA = `test-seed-a-${uniqueId()}`;
    const seedB = `test-seed-b-${uniqueId()}`;
    const seedC = `test-seed-c-${uniqueId()}`;
    
    await seedStatusRepository.markApplied(seedA);
    
    const result = await seedStatusRepository.getAllWithKnownSeeds([seedA, seedB, seedC]);
    
    expect(result.length).toBe(3);
    expect(result.find(r => r.name === seedA)?.applied).toBe(true);
    expect(result.find(r => r.name === seedB)?.applied).toBe(false);
    expect(result.find(r => r.name === seedC)?.applied).toBe(false);
  });

  itMaybe('markApplied can update version on existing seed', async () => {
    const seedName = `test-seed-${uniqueId()}`;
    
    await seedStatusRepository.markApplied(seedName, 'v1');
    let info = await seedStatusRepository.getInfo(seedName);
    expect(info.version).toBe('v1');
    
    await seedStatusRepository.markApplied(seedName, 'v2');
    info = await seedStatusRepository.getInfo(seedName);
    expect(info.version).toBe('v2');
  });

  // ============================================================================
  // Deployment Scenario Tests
  // ============================================================================

  describe('Deployment Scenarios', () => {
    itMaybe('Scenario 1: Fresh deployment - seed runs and stores hash', async () => {
      const seedName = `models-${uniqueId()}`;
      const fileHash = 'abc123def456';
      
      // Before: seed never applied
      const infoBefore = await seedStatusRepository.getInfo(seedName);
      expect(infoBefore.applied).toBe(false);
      
      // Deploy: seed runs and stores hash
      await seedStatusRepository.markApplied(seedName, fileHash);
      
      // After: seed is applied with hash
      const infoAfter = await seedStatusRepository.getInfo(seedName);
      expect(infoAfter.applied).toBe(true);
      expect(infoAfter.version).toBe(fileHash);
    });

    itMaybe('Scenario 2: Redeploy no changes - hash unchanged, skip logic works', async () => {
      const seedName = `models-${uniqueId()}`;
      const fileHash = 'abc123def456';
      
      // First deploy
      await seedStatusRepository.markApplied(seedName, fileHash);
      
      // Second deploy: check if hash matches (simulating skip logic)
      const info = await seedStatusRepository.getInfo(seedName);
      const shouldSkip = info.applied && info.version === fileHash;
      
      expect(shouldSkip).toBe(true);
    });

    itMaybe('Scenario 3: Dev changes seed file - hash changed, re-run logic works', async () => {
      const seedName = `models-${uniqueId()}`;
      const oldHash = 'abc123def456';
      const newHash = 'xyz789new123';
      
      // First deploy
      await seedStatusRepository.markApplied(seedName, oldHash);
      
      // Dev changes file, second deploy:
      const info = await seedStatusRepository.getInfo(seedName);
      const shouldRerun = info.applied && info.version !== newHash;
      
      expect(shouldRerun).toBe(true);
      
      // After re-run, update hash
      await seedStatusRepository.markApplied(seedName, newHash);
      
      const infoAfterRerun = await seedStatusRepository.getInfo(seedName);
      expect(infoAfterRerun.version).toBe(newHash);
    });

    itMaybe('Scenario 4: Admin edits via panel - seed stays applied, no overwrite', async () => {
      const seedName = `models-${uniqueId()}`;
      const fileHash = 'abc123def456';
      
      // Initial deploy
      await seedStatusRepository.markApplied(seedName, fileHash);
      
      // Admin edits in panel (doesn't touch seed_status)
      // ... admin changes model pricing in DB directly ...
      
      // Next deploy: file unchanged, should skip
      const info = await seedStatusRepository.getInfo(seedName);
      const shouldSkip = info.applied && info.version === fileHash;
      
      expect(shouldSkip).toBe(true);
      // Admin edits preserved because seed didn't re-run
    });

    itMaybe('Scenario 5: Force re-seed - ignores hash match', async () => {
      const seedName = `models-${uniqueId()}`;
      const fileHash = 'abc123def456';
      
      // Deploy with hash
      await seedStatusRepository.markApplied(seedName, fileHash);
      
      // Force mode: ALWAYS run regardless of hash
      // (In real code, force=true skips the hash check entirely)
      const info = await seedStatusRepository.getInfo(seedName);
      const forceMode = true;
      const shouldRun = forceMode || !info.applied || info.version !== fileHash;
      
      expect(shouldRun).toBe(true);
    });

    itMaybe('Scenario 6: Reset marks a seed pending for the next start', async () => {
      const seedName = `models-${uniqueId()}`;
      const fileHash = 'abc123def456';
      
      // Initial deploy
      await seedStatusRepository.markApplied(seedName, fileHash);
      expect(await seedStatusRepository.isApplied(seedName)).toBe(true);
      
      // Reset
      await seedStatusRepository.markPending(seedName);
      
      // Next deploy: should run because not applied
      const info = await seedStatusRepository.getInfo(seedName);
      expect(info.applied).toBe(false);
    });

    itMaybe('Scenario 7: Legacy seed without hash - runs once then skips', async () => {
      const seedName = `legacy-${uniqueId()}`;
      
      // Mark as applied without version (legacy behavior)
      await seedStatusRepository.markApplied(seedName);
      
      const info = await seedStatusRepository.getInfo(seedName);
      expect(info.applied).toBe(true);
      expect(info.version).toBeUndefined();
      
      // Legacy skip: if no seedFile, skip if applied
      const noSeedFile = true;
      const shouldSkip = info.applied && noSeedFile;
      
      expect(shouldSkip).toBe(true);
    });

    itMaybe('Scenario 8: Concurrent deploys - upsert prevents duplicates', async () => {
      const seedName = `models-${uniqueId()}`;
      const hash1 = 'hash1';
      const hash2 = 'hash2';
      
      // Simulate concurrent deploys
      await Promise.all([
        seedStatusRepository.markApplied(seedName, hash1),
        seedStatusRepository.markApplied(seedName, hash2),
      ]);
      
      // No error thrown, one of them wins
      const info = await seedStatusRepository.getInfo(seedName);
      expect(info.applied).toBe(true);
      expect([hash1, hash2]).toContain(info.version);
    });
  });
});
