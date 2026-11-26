import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface WebSearchSettings {
  provider: 'duck' | 'tavily';
  duckBaseUrl: string;
  duckLiteBaseUrl: string;
  tavilyBaseUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxBytes: number;
  tavilyApiKey?: string;
}

const webSearchRowSchema = z
  .object({
    provider: z.unknown().optional(),
    duckBaseUrl: z.unknown().optional(),
    duckLiteBaseUrl: z.unknown().optional(),
    tavilyBaseUrl: z.unknown().optional(),
    maxResults: z.unknown().optional(),
    timeoutMs: z.unknown().optional(),
    maxBytes: z.unknown().optional(),
    tavilyApiKey: z.unknown().optional(),
  })
  .passthrough();

const providerSchema = z.enum(['duck', 'tavily']);
const urlSchema = z.string().url();
const numberSchema = z.coerce.number().int().positive();
const stringSchema = z.string().trim().min(1);

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[WebSearchSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveWebSearchSettings = (value: unknown): WebSearchSettings => {
  const parsed = webSearchRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[WebSearchSettings] Invalid settings row');
  }
  const data = parsed.data;
  const provider = requireParsed(providerSchema.safeParse(data.provider), 'provider');
  const duckBaseUrl = requireParsed(urlSchema.safeParse(data.duckBaseUrl), 'duckBaseUrl');
  const duckLiteBaseUrl = requireParsed(urlSchema.safeParse(data.duckLiteBaseUrl), 'duckLiteBaseUrl');
  const tavilyBaseUrl = requireParsed(urlSchema.safeParse(data.tavilyBaseUrl), 'tavilyBaseUrl');
  const maxResults = requireParsed(numberSchema.safeParse(data.maxResults), 'maxResults');
  const timeoutMs = requireParsed(numberSchema.safeParse(data.timeoutMs), 'timeoutMs');
  const maxBytes = requireParsed(numberSchema.safeParse(data.maxBytes), 'maxBytes');
  const apiKey = stringSchema.safeParse(data.tavilyApiKey);

  return {
    provider,
    duckBaseUrl,
    duckLiteBaseUrl,
    tavilyBaseUrl,
    maxResults,
    timeoutMs,
    maxBytes,
    tavilyApiKey: apiKey.success ? apiKey.data : undefined,
  };
};

const webSearchAccessors = createSettingsAccessors<WebSearchSettings>({
  key: 'web_search',
  scope: 'WebSearchSettings',
  resolve: resolveWebSearchSettings,
  missingMessage:
    '[WebSearchSettings] Missing web search settings. Seed settings in database.',
  serialize: (value) => ({
    provider: value.provider,
    duckBaseUrl: value.duckBaseUrl,
    duckLiteBaseUrl: value.duckLiteBaseUrl,
    tavilyBaseUrl: value.tavilyBaseUrl,
    maxResults: value.maxResults,
    timeoutMs: value.timeoutMs,
    maxBytes: value.maxBytes,
    tavilyApiKey: value.tavilyApiKey ?? null,
  }),
});

export const getWebSearchSettings = webSearchAccessors.getSettings;
export const setWebSearchSettings = webSearchAccessors.setSettings;

export const clearWebSearchSettingsCache = (): void => {
  webSearchAccessors.clearSettings();
};
