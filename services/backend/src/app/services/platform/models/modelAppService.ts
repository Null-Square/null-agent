import { ModelService } from '@/domains/platform/models/ModelService';
import { MODEL_PROVIDER_CATALOG, MODEL_PROVIDERS } from '@/domains/platform/models/modelProviders';

export type { ModelConnection } from '@/domains/platform/models/ModelService';
export type { CatalogModel } from '@/domains/platform/models/modelCatalog';
export { MODEL_PROVIDERS };

export type ModelAppService = ModelService;

export const modelAppService = new ModelService();

/** A provider the person can connect with an API key, and where to get one. */
export type ModelProviderOption = { id: string; label: string; keyUrl: string };

/**
 * The API-key providers, in the order the screen offers them. Claude is here, as Anthropic: claude.ai
 * (Pro/Max) sign-in may not be offered by third-party products, so Claude takes a Console API key.
 */
export const listModelProviderOptions = (): ModelProviderOption[] =>
  MODEL_PROVIDERS.map((provider) => ({
    id: provider,
    label: MODEL_PROVIDER_CATALOG[provider].label,
    keyUrl: MODEL_PROVIDER_CATALOG[provider].keyUrl,
  }));
