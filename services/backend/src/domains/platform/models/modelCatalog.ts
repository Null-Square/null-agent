import { ErrorFactory } from '@/shared/errors';
import {
  CHATGPT_API_BASE_URL,
  MODEL_PROVIDER_CATALOG,
  type ModelProvider,
} from './modelProviders';

export type CatalogModel = { id: string; label: string };

type Fetch = typeof fetch;

export const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Only models the agent can talk to through its chat client. Each provider's list is narrowed to
 * its chat families, then anything that is not a chat model (embeddings, speech, images, search,
 * moderation) or speaks only OpenAI's Responses API (pro, deep research, codex) is left out.
 */
const CHAT_FAMILY: Record<ModelProvider, RegExp> = {
  ANTHROPIC: /^claude/iu,
  OPENAI: /^(gpt-|o\d|chatgpt-)/iu,
  DEEPSEEK: /^deepseek/iu,
  QWEN: /^(qwen|qwq|qvq)/iu,
  MOONSHOT: /^(kimi|moonshot)/iu,
};
const NOT_CHAT =
  /(embed|rerank|moderation|whisper|tts|transcri|audio|realtime|speech|image|dall-e|sora|davinci|babbage|search|similarity|computer-use|instruct|ocr|omni|wanx|paraformer|sambert|cosyvoice|-asr|-mt-)/iu;
/** OpenAI models that answer only the Responses API, which the API-key path does not speak. */
const OPENAI_RESPONSES_ONLY = /(codex|deep-research|-pro\b)/iu;

export const isChatModel = (provider: ModelProvider, id: string): boolean =>
  CHAT_FAMILY[provider].test(id)
  && !NOT_CHAT.test(id)
  && !(provider === 'OPENAI' && OPENAI_RESPONSES_ONLY.test(id));

const refused = (message: string, httpStatus = 400): never => {
  throw ErrorFactory.validation.constraintViolated(message, { userMessage: message, httpStatus });
};

/**
 * One GET, bounded in time. The provider's own error text is never surfaced: some quote part of
 * the key back. Only the status, in plain words, leaves here.
 */
const getJson = async (
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  who: string,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return refused(
      timedOut
        ? `${who} did not answer within ${MODEL_LIST_TIMEOUT_MS / 1000} seconds; try again`
        : `Could not reach ${who}; check this computer's connection and try again`,
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return refused(`${who} refused this key (HTTP ${response.status}); check it and paste it again`);
  }
  if (response.status === 429) return refused(`${who} is rate-limiting this key for now (HTTP 429); try again shortly`, 502);
  if (response.status >= 500) return refused(`${who} failed on its side (HTTP ${response.status}); try again later`, 502);
  if (!response.ok) return refused(`${who} did not list its models (HTTP ${response.status})`, 502);
  try {
    return await response.json();
  } catch {
    return refused(`${who} answered with something that is not a model list`, 502);
  }
};

const dataArray = (body: unknown): Array<Record<string, unknown>> => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>) : [];
};

const createdAt = (entry: Record<string, unknown>): number | null => {
  if (typeof entry.created === 'number') return entry.created * 1000;
  if (typeof entry.created_at === 'string') {
    const parsed = Date.parse(entry.created_at);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** Newest first when the provider dates its models; otherwise the provider's own order. */
const newestFirst = (entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
  if (!entries.every((entry) => createdAt(entry) !== null)) return entries;
  return [...entries].sort((left, right) => createdAt(right)! - createdAt(left)!);
};

/**
 * The chat models this key can use, newest first. Listing models costs nothing, so this is also
 * how a key is validated: a provider that refuses the key refuses the list.
 */
export const listProviderModels = async (
  provider: ModelProvider,
  apiKey: string,
  options: { fetch?: Fetch; baseUrl?: string } = {},
): Promise<CatalogModel[]> => {
  const fetchImpl = options.fetch ?? fetch;
  const { label, defaultBaseUrl } = MODEL_PROVIDER_CATALOG[provider];
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/u, '');
  const body =
    provider === 'ANTHROPIC'
      ? await getJson(fetchImpl, `${baseUrl}/v1/models?limit=1000`, {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }, label)
      : await getJson(fetchImpl, `${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` }, label);
  return newestFirst(dataArray(body))
    .filter((entry) => typeof entry.id === 'string' && isChatModel(provider, entry.id))
    .map((entry) => ({
      id: entry.id as string,
      label: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name : (entry.id as string),
    }));
};

/**
 * The models the person's ChatGPT plan offers, in the server's order (Models and inference: keep
 * entries whose visibility is "list", show display_name, send slug as the model).
 */
export const listChatGptPlanModels = async (
  accessToken: string,
  options: { fetch?: Fetch; baseUrl?: string } = {},
): Promise<CatalogModel[]> => {
  const baseUrl = (options.baseUrl ?? CHATGPT_API_BASE_URL).replace(/\/+$/u, '');
  const body = await getJson(options.fetch ?? fetch, `${baseUrl}/models`, { Authorization: `Bearer ${accessToken}` }, 'ChatGPT');
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && (entry as Record<string, unknown>).visibility === 'list'
      && typeof (entry as Record<string, unknown>).slug === 'string')
    .map((entry) => ({
      id: entry.slug as string,
      label: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name : (entry.slug as string),
    }));
};
