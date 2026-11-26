import { z } from 'zod';

export const MODEL_CATEGORIES = ['low', 'medium', 'high', 'extra_high'] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export const modelCategorySchema = z.enum(MODEL_CATEGORIES);

export const DEFAULT_MODEL_CATEGORY: ModelCategory = 'medium';

export const MODEL_CATEGORY_LABELS: Record<ModelCategory, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra_high: 'Extra High',
};

export const MODEL_CATEGORY_DESCRIPTIONS: Record<ModelCategory, string> = {
  low: 'Fast, lower-cost model routing for lightweight work.',
  medium: 'Balanced model routing for most sessions.',
  high: 'Stronger model routing for complex work.',
  extra_high: 'Highest-capability model routing for the most demanding work.',
};

export const isModelCategory = (value: unknown): value is ModelCategory =>
  typeof value === 'string' && (MODEL_CATEGORIES as readonly string[]).includes(value);

export const normalizeModelCategory = (value: unknown): ModelCategory | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isModelCategory(normalized) ? normalized : undefined;
};
