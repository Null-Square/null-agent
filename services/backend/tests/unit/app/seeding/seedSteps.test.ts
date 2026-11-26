/**
 * seedSteps.test.ts - Tests for seed step registry and validation
 * 
 * Ensures:
 * - All seed dependencies are valid
 * - No circular dependencies
 * - Registry functions work correctly
 */

import { describe, it, expect } from 'vitest';
import {
  getAllSeedDefinitions,
  getSeedSteps,
  getSeedNames,
  getSeedByName,
  getSeedsByCategory,
  validateSeedDependencies,
  type SeedDefinition,
} from '@/app/seeding/seedSteps';

describe('seedSteps', () => {
  describe('getAllSeedDefinitions', () => {
    it('returns all registered seeds', () => {
      const seeds = getAllSeedDefinitions();
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds.every(s => typeof s.name === 'string')).toBe(true);
      expect(seeds.every(s => typeof s.seed === 'function')).toBe(true);
    });

    it('includes the required core seeds and no plan or communication seeds', () => {
      const names = getSeedNames();
      expect(names).toContain('models');
      expect(names).toContain('settings');
      expect(names).not.toContain('tiers');
      expect(names).not.toContain('communication-catalog');
    });

    it('returns a new array (immutable)', () => {
      const seeds1 = getAllSeedDefinitions();
      const seeds2 = getAllSeedDefinitions();
      expect(seeds1).not.toBe(seeds2);
    });
  });

  describe('getSeedSteps', () => {
    it('returns seed steps compatible with SeedRunner', () => {
      const steps = getSeedSteps();
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]).toHaveProperty('name');
      expect(steps[0]).toHaveProperty('seed');
      expect(steps[0]).toHaveProperty('dependsOn');
    });

    it('marks models as alwaysRun because provider keys come from env', () => {
      const models = getSeedSteps().find((step) => step.name === 'models');
      expect(models?.alwaysRun).toBe(true);
    });

    it('does not include metadata fields (description, category)', () => {
      const steps = getSeedSteps();
      const firstStep = steps[0];
      // These should NOT be present (stripped for SeedRunner)
      expect('description' in firstStep).toBe(false);
      expect('category' in firstStep).toBe(false);
    });
  });

  describe('getSeedByName', () => {
    it('returns seed definition for valid name', () => {
      const seed = getSeedByName('models');
      expect(seed).toBeDefined();
      expect(seed?.name).toBe('models');
      expect(seed?.category).toBe('core');
    });

    it('returns undefined for unknown name', () => {
      const seed = getSeedByName('nonexistent-seed');
      expect(seed).toBeUndefined();
    });
  });

  describe('getSeedsByCategory', () => {
    it('returns seeds filtered by category', () => {
      const coreSeeds = getSeedsByCategory('core');
      expect(coreSeeds.length).toBeGreaterThan(0);
      expect(coreSeeds.every(s => s.category === 'core')).toBe(true);
    });

    it('returns only seeds belonging to the requested category', () => {
      // The contract the previous test was reaching for, stated so it cannot expire.
      for (const category of ['core', 'config', 'content'] as const) {
        for (const seed of getSeedsByCategory(category)) {
          expect(seed.category).toBe(category);
        }
      }
    });

    it('groups the component alias catalog as content seed data', () => {
      const contentSeeds = getSeedsByCategory('content');
      expect(contentSeeds.map(seed => seed.name)).toEqual(['component-aliases']);
    });
  });

  describe('validateSeedDependencies', () => {
    it('validates that all dependencies exist', () => {
      const result = validateSeedDependencies();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('validates no circular dependencies', () => {
      const result = validateSeedDependencies();
      expect(result.valid).toBe(true);
      // No circular dependency errors
      const circularErrors = result.errors.filter(e => e.includes('Circular'));
      expect(circularErrors).toHaveLength(0);
    });

    it('returns all seeds are unique', () => {
      const names = getSeedNames();
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('seed metadata', () => {
    it('all seeds have descriptions', () => {
      const seeds = getAllSeedDefinitions();
      for (const seed of seeds) {
        expect(seed.description).toBeTruthy();
        expect(typeof seed.description).toBe('string');
        expect(seed.description.length).toBeGreaterThan(5);
      }
    });

    it('all seeds have valid categories', () => {
      const validCategories = ['core', 'config', 'content'];
      const seeds = getAllSeedDefinitions();
      for (const seed of seeds) {
        expect(validCategories).toContain(seed.category);
      }
    });
  });

  describe('dependency ordering', () => {
    it('core seeds have no dependencies', () => {
      const coreSeeds = getSeedsByCategory('core');
      for (const seed of coreSeeds) {
        expect(seed.dependsOn ?? []).toHaveLength(0);
      }
    });
  });
});
