import { useQuery } from '@tanstack/react-query';
import { api } from '@shared/api';
import { parseApiError, shouldRetry } from '@shared/lib/apiError';
import {
  DEFAULT_MODEL_CATEGORY,
  isModelCategory,
  MODEL_CATEGORIES,
  MODEL_CATEGORY_DESCRIPTIONS,
  MODEL_CATEGORY_LABELS,
  type ModelCategory,
} from '@null-ai/contracts';

export interface AvailableModelCategory {
  id: ModelCategory;
  category: ModelCategory;
  displayName: string;
  description: string;
  isDefault: boolean;
  availableCount: number;
}

export type AvailableModel = AvailableModelCategory;

const MODEL_EFFORT_LABELS: Record<ModelCategory, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra_high: 'Extra High',
};

export const getModelEffortLabel = (
  model: Pick<AvailableModelCategory, 'category' | 'id' | 'displayName'> | null | undefined,
) => {
  if (!model) return MODEL_EFFORT_LABELS[DEFAULT_MODEL_CATEGORY];
  const category = resolveModelCategory(model);
  return category ? MODEL_EFFORT_LABELS[category] : MODEL_EFFORT_LABELS[DEFAULT_MODEL_CATEGORY];
};

export const getModelEffortOptionLabel = (model: Pick<AvailableModelCategory, 'category' | 'id' | 'displayName' | 'isDefault'>) =>
  getModelEffortLabel(model);

const resolveModelCategory = (model: { category?: unknown; id?: unknown } | null | undefined): ModelCategory | undefined => {
  if (!model) return undefined;
  if (isModelCategory(model.category)) return model.category;
  if (isModelCategory(model.id)) return model.id;
  return undefined;
};

export const normalizeAvailableModelCategories = (models: unknown): AvailableModelCategory[] => {
  if (!Array.isArray(models)) return [];

  const byCategory = new Map<ModelCategory, AvailableModelCategory>();

  for (const item of models) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const category = resolveModelCategory(record);
    if (!category) continue;
    const previous = byCategory.get(category);
    byCategory.set(category, {
      id: category,
      category,
      displayName: MODEL_CATEGORY_LABELS[category],
      description: typeof record.description === 'string' ? record.description : MODEL_CATEGORY_DESCRIPTIONS[category],
      isDefault: Boolean(record.isDefault) || Boolean(previous?.isDefault),
      availableCount:
        typeof record.availableCount === 'number'
          ? record.availableCount
          : (previous?.availableCount ?? 0) + 1,
    });
  }

  const normalized = MODEL_CATEGORIES
    .map((category) => byCategory.get(category))
    .filter((category): category is AvailableModelCategory => Boolean(category));

  if (normalized.length > 0 && !normalized.some((category) => category.isDefault)) {
    const defaultIndex = normalized.findIndex((category) => category.id === DEFAULT_MODEL_CATEGORY);
    const fallbackIndex = defaultIndex >= 0 ? defaultIndex : 0;
    normalized[fallbackIndex] = {
      ...normalized[fallbackIndex],
      isDefault: true,
    };
  }

  return normalized;
};

/**
 * Fetch available model categories for session creation.
 * Concrete model names stay server-side and are resolved at session start.
 */
export const useAvailableModelsQuery = () =>
  useQuery<AvailableModelCategory[]>({
    queryKey: ['agent-models'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/ai-agent/models');
      if (error) throw parseApiError(error);
      return normalizeAvailableModelCategories((data as { models?: unknown[] } | undefined)?.models);
    },
    staleTime: 60_000, // Categories don't change often
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      if (!shouldRetry(error)) return false;
      return failureCount < 2;
    },
  });
