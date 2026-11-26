/** The providers a person connects with an API key (ProviderRegistry has a client for each). */
export const MODEL_PROVIDERS = ['ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'QWEN', 'MOONSHOT'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * The person's ChatGPT plan, reached through Sign in with ChatGPT: OpenAI's public Responses API,
 * paid by the plan, with an OAuth token instead of a key. Stored as its own provider because the
 * engine calls it differently (`ChatGptPlanChatProvider`).
 */
export const CHATGPT_PROVIDER = 'CHATGPT' as const;
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1';

/** Each provider's own public API, called when a model names no base URL of its own. */
export const MODEL_PROVIDER_CATALOG: Readonly<
  Record<ModelProvider, { label: string; defaultBaseUrl: string; keyUrl: string }>
> = {
  ANTHROPIC: {
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  OPENAI: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  DEEPSEEK: {
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  QWEN: {
    label: 'Qwen (Alibaba Cloud Model Studio)',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
  },
  MOONSHOT: {
    label: 'Moonshot (Kimi)',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
};

/** The .env variable each provider's key is read from at seed time. */
export const MODEL_API_KEY_ENV_BY_PROVIDER: Readonly<Record<ModelProvider, string>> = {
  ANTHROPIC: 'ANTHROPIC_API_KEY',
  OPENAI: 'OPENAI_API_KEY',
  DEEPSEEK: 'DEEPSEEK_API_KEY',
  QWEN: 'QWEN_API_KEY',
  MOONSHOT: 'MOONSHOT_API_KEY',
};

export const isModelProvider = (value: string): value is ModelProvider =>
  (MODEL_PROVIDERS as readonly string[]).includes(value);

const hostOf = (url: string | null | undefined): string | null => {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * A model runs on a server of its own when its base URL points anywhere but its provider's public
 * API: Ollama, vLLM, LM Studio, a proxy, a router. Such models come only from the models
 * configuration file (config/seeds/models.seed.json). The provider's own API never answers without
 * a key, so a model that carries its provider's public URL is not one.
 */
export const runsOnOwnServer = (provider: string, apiBaseUrl: string | null | undefined): boolean => {
  const host = hostOf(apiBaseUrl);
  if (!host) return false;
  const normalized = provider.trim().toUpperCase();
  if (!isModelProvider(normalized)) return false;
  return host !== hostOf(MODEL_PROVIDER_CATALOG[normalized].defaultBaseUrl);
};

/**
 * The one activation rule: a model can answer when it has a usable credential (an API key, or the
 * ChatGPT plan's tokens) or runs on a server of its own (local servers often take no key). No rate
 * card is needed; a call with none is recorded at zero cost.
 */
export const isModelUsable = (model: {
  provider: string;
  apiBaseUrl?: string | null;
  hasKey: boolean;
}): boolean => model.hasKey || runsOnOwnServer(model.provider, model.apiBaseUrl);

/** The URL the engine calls: the model's own, else its provider's public API. */
export const resolveModelBaseUrl = (provider: string, apiBaseUrl: string | null | undefined): string | undefined => {
  const own = apiBaseUrl?.trim();
  if (own) return own;
  const normalized = provider.trim().toUpperCase();
  if (normalized === CHATGPT_PROVIDER) return CHATGPT_API_BASE_URL;
  return isModelProvider(normalized) ? MODEL_PROVIDER_CATALOG[normalized].defaultBaseUrl : undefined;
};
