import { describe, expect, it } from 'vitest';
import { getModelEffortLabel, normalizeAvailableModelCategories } from './models';

describe('model category normalization', () => {
  it('keeps only backend-exposed intelligence categories in stable order', () => {
    const categories = normalizeAvailableModelCategories([
      {
        id: 'medium',
        category: 'medium',
        displayName: 'Medium',
        description: 'Balanced',
        isDefault: true,
        availableCount: 1,
      },
    ]);

    expect(categories.map((category) => category.id)).toEqual(['medium']);
    expect(categories.find((category) => category.id === 'medium')?.isDefault).toBe(true);
  });

  it('ignores stale model-shaped API responses instead of exposing concrete model names', () => {
    const categories = normalizeAvailableModelCategories([
      {
        id: 'model-qwen',
        displayName: 'Qwen 3.5 Plus',
        description: 'Concrete model row from an old API response',
        isDefault: true,
      },
    ]);

    expect(categories.map(getModelEffortLabel)).toEqual([]);
    expect(categories.some((category) => category.displayName.includes('Qwen'))).toBe(false);
  });
});
