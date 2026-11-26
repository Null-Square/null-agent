/**
 * seedSteps.ts - Central definition of all available seeds
 * 
 * SINGLE SOURCE OF TRUTH for seed definitions.
 * Add new seeds here and they automatically appear in:
 * - runSeed.ts (production seeder)
 * - scripts/seed.ts (npm run db:seed)
 * 
 * NO CODE CHANGES NEEDED elsewhere when adding a new seed!
 */

import type { SeedStep } from './SeedRunner';
import {
  syncComponentAliases,
  syncModels,
  syncSettings,
} from './syncServices';

/**
 * A seed step with a description and a category.
 */
export interface SeedDefinition extends SeedStep {
  /** Human-readable description */
  description: string;
  /** Category for grouping */
  category: 'core' | 'config' | 'content';
  /** Optional seeds are excluded from bootstrap/default seeding flows. */
  optional?: boolean;
}

export interface SeedSelectionOptions {
  /** Include optional seeds (default: true) */
  includeOptional?: boolean;
}

/**
 * All available seeds in the system.
 * 
 * TO ADD A NEW SEED:
 * 1. Create sync function in syncServices.ts
 * 2. Add entry here with name, sync function, dependencies, description, category
 * 3. That's it! Auto-detected everywhere.
 */
export const SEED_DEFINITIONS: SeedDefinition[] = [
  // ============================================================================
  // CORE SEEDS - Essential for system operation
  // ============================================================================
  {
    name: 'models',
    seed: syncModels,
    seedFile: 'models.seed.json',
    alwaysRun: true,
    dependsOn: [],
    description: 'AI model configurations, pricing, and env-sourced provider keys',
    category: 'core',
  },
  {
    name: 'settings',
    seed: syncSettings,
    seedFile: 'settings',
    dependsOn: [],
    description: 'System configuration settings',
    category: 'core',
  },
  {
    name: 'component-aliases',
    seed: syncComponentAliases,
    seedFile: 'component-aliases.seed.json',
    dependsOn: [],
    description: 'Threat Watch component identity aliases (product string -> canonical component key)',
    category: 'content',
  },
  
];

const HAS_OPTIONAL_SEEDS = SEED_DEFINITIONS.some((seed) => seed.optional === true);

// ============================================================================
// Helper Functions - Used by runSeed.ts and seeds.controller.ts
// ============================================================================

/**
 * Get all seed definitions
 */
export function getAllSeedDefinitions(options: SeedSelectionOptions = {}): SeedDefinition[] {
  return [...selectSeedDefinitions(options)];
}

/**
 * Get seeds as SeedStep array (for SeedRunner)
 */
export function getSeedSteps(options: SeedSelectionOptions = {}): SeedStep[] {
  return selectSeedDefinitions(options).map(({ name, seed, dependsOn, required, seedFile, alwaysRun }) => ({
    name,
    seed,
    dependsOn,
    required,
    seedFile,
    alwaysRun,
  }));
}

/**
 * Get all seed names
 */
export function getSeedNames(options: SeedSelectionOptions = {}): string[] {
  return selectSeedDefinitions(options).map(s => s.name);
}

/**
 * Get a specific seed by name
 */
export function getSeedByName(name: string, options: SeedSelectionOptions = {}): SeedDefinition | undefined {
  return selectSeedDefinitions(options).find(s => s.name === name);
}

/**
 * Get seeds by category
 */
export function getSeedsByCategory(
  category: SeedDefinition['category'],
  options: SeedSelectionOptions = {},
): SeedDefinition[] {
  return selectSeedDefinitions(options).filter(s => s.category === category);
}

function selectSeedDefinitions(options: SeedSelectionOptions): SeedDefinition[] {
  if (!HAS_OPTIONAL_SEEDS) {
    return SEED_DEFINITIONS;
  }
  if (options.includeOptional ?? true) {
    return SEED_DEFINITIONS;
  }
  return SEED_DEFINITIONS.filter(seed => !seed.optional);
}

/**
 * Validate that all seed dependencies exist
 */
export function validateSeedDependencies(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const names = new Set(getSeedNames());
  
  for (const seed of SEED_DEFINITIONS) {
    for (const dep of seed.dependsOn ?? []) {
      if (!names.has(dep)) {
        errors.push(`Seed "${seed.name}" depends on unknown seed "${dep}"`);
      }
    }
  }
  
  // Check for circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();
  
  const hasCycle = (name: string, path: string[] = []): boolean => {
    if (inStack.has(name)) {
      errors.push(`Circular dependency: ${[...path, name].join(' -> ')}`);
      return true;
    }
    if (visited.has(name)) return false;
    
    visited.add(name);
    inStack.add(name);
    
    const seed = getSeedByName(name);
    for (const dep of seed?.dependsOn ?? []) {
      if (hasCycle(dep, [...path, name])) return true;
    }
    
    inStack.delete(name);
    return false;
  };
  
  for (const seed of SEED_DEFINITIONS) {
    hasCycle(seed.name);
  }
  
  return { valid: errors.length === 0, errors };
}
