import type OpenAI from 'openai';
import type { ResolvedConfig } from '@/config/configTypes';
import { createModelConfigPort } from '@/app/adapters/portFactories';
import { ProviderFactory } from '@/domains/agent-brain/adapters/providers/ProviderFactory';
import type { ChatProvider, ModelConfig, ModelConfigPort } from '@/domains/agent-brain/ports';
import { CHATGPT_PROVIDER, MODEL_PROVIDER_CATALOG, isModelProvider, runsOnOwnServer } from '@/domains/platform/models/modelProviders';
import { ChatGptAuthError } from '@/domains/platform/models/chatGptAuth';
import { ChatGptPlanError } from '@/domains/agent-brain/adapters/providers/chatgpt/responsesShim';
import { ERROR_CODES } from '@null-ai/contracts';
import { logger } from '@/shared/logger';

export const MODEL_TEST_TIMEOUT_MS = 20_000;

export type ModelTestResult = { ok: boolean; latencyMs: number; message: string };

/** Answers "can the agent use the connected model?" by one request through the agent's own provider path. */
export type ModelProbe = () => Promise<ModelTestResult | null>;

type ProviderSource = { create(modelName: string, modelId?: string): Promise<ChatProvider> };

/** The agent always sends tools; a model that refuses tool calls cannot do its work. */
const PROBE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'report_ready',
    description: 'Report that the model is ready.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

class ProbeTimeout extends Error {}

const causes = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
};

/** What the ChatGPT plan's documented error codes mean for the person (Errors and recovery). */
const PLAN_ERROR_MESSAGES: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded:
    'Usage limit reached: your ChatGPT plan is not taking requests from apps for now. See ChatGPT Settings → Usage.',
  subscription_sharing_user_not_eligible: 'Not eligible: this ChatGPT plan or workspace cannot be used by apps.',
  subscription_sharing_usage_unavailable: 'ChatGPT could not check your plan usage just now. Try again later.',
  subscription_sharing_user_unavailable: 'ChatGPT could not load your account just now. Try again later.',
  subscription_sharing_invalid_user: 'ChatGPT did not accept this sign-in. Connect ChatGPT again.',
  subscription_sharing_unsupported_capability: 'The ChatGPT plan refused part of the request this model needs.',
  subscription_sharing_route_not_supported: 'The ChatGPT plan does not serve this kind of request.',
  chatpass_v2_scope_not_authorized: 'This sign-in does not allow plan usage. Connect ChatGPT again and allow it.',
  chatpass_v2_invalid_authorization_context: 'This sign-in does not allow plan usage. Connect ChatGPT again and allow it.',
};

const statusOf = (error: unknown): number | undefined => {
  const record = error as { status?: unknown; context?: { status?: unknown } } | null;
  const status = record?.context?.status ?? record?.status;
  return typeof status === 'number' ? status : undefined;
};

const signalsOf = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.message === 'string') parts.push(record.message);
    if (typeof record.code === 'string') parts.push(record.code);
    current = record.cause;
  }
  return parts.join(' ').toLowerCase();
};

const hostOf = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** Who answered, in words: the provider's name, or the server the person pointed the model at. */
const whoAnswers = (model: ModelConfig): string => {
  const provider = model.provider.toUpperCase();
  if (provider === CHATGPT_PROVIDER) return 'ChatGPT';
  if (runsOnOwnServer(provider, model.apiBaseUrl)) return `The server at ${hostOf(model.apiBaseUrl) ?? model.apiBaseUrl}`;
  return isModelProvider(provider) ? MODEL_PROVIDER_CATALOG[provider].label : provider;
};

const withStatus = (text: string, status: number | undefined): string =>
  status === undefined ? `${text}.` : `${text} (HTTP ${status}).`;

/**
 * Names the kind of failure in plain words. It is built only from the status, the error class and
 * the model's own settings, never from the provider's text, which can quote part of the key.
 */
const describeFailure = (error: unknown, model: ModelConfig, provider: ChatProvider | undefined): string => {
  const who = whoAnswers(model);
  if (error instanceof ProbeTimeout) {
    return `No answer: ${who} did not answer within ${MODEL_TEST_TIMEOUT_MS / 1000} seconds.`;
  }
  const chain = causes(error);
  const signIn = chain.find((entry): entry is ChatGptAuthError => entry instanceof ChatGptAuthError);
  if (signIn) {
    return signIn.terminal
      ? 'Signed out: the ChatGPT sign-in has ended. Connect ChatGPT again.'
      : 'Could not refresh the ChatGPT sign-in just now. Try again shortly.';
  }
  const plan = chain.find((entry): entry is ChatGptPlanError => entry instanceof ChatGptPlanError);
  if (plan) {
    return PLAN_ERROR_MESSAGES[plan.code] ?? `The ChatGPT plan refused the request (${plan.code}).`;
  }
  if (!provider) {
    const reason = signalsOf(error);
    if (reason.includes('missing apikey')) {
      return 'No key: this model has no API key. Add one, or point the model at a server of its own.';
    }
    if (reason.includes('not supported')) return `Not callable: the agent has no client for provider ${model.provider}.`;
    return 'Not callable: the agent could not set up this model. Check its provider and settings.';
  }

  const mapped = provider.mapError(error, { provider: provider.name });
  const status = statusOf(mapped) ?? statusOf(error);
  const signals = signalsOf(error);
  if (status === 401 || status === 403 || mapped.code === ERROR_CODES.AUTH_INVALID_API_KEY) {
    return withStatus(`Authentication failed: ${who} refused ${who === 'ChatGPT' ? 'the sign-in' : 'the API key'}`, status);
  }
  if (status === 402) return withStatus(`Out of credit: ${who} says the account has no balance left`, status);
  if (status === 429 || mapped.code === ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED) {
    return withStatus(`Rate limited: ${who} is refusing requests for now, or the account is out of quota`, status);
  }
  if (status === 404 || mapped.code === ERROR_CODES.LLM_INVALID_MODEL) {
    return withStatus(`Unknown model: ${who} has no model named "${model.modelName}"`, status);
  }
  if (mapped.code === ERROR_CODES.LLM_TIMEOUT) {
    return `No answer: ${who} did not answer within ${MODEL_TEST_TIMEOUT_MS / 1000} seconds.`;
  }
  if (mapped.code === ERROR_CODES.NETWORK_CONNECTION_FAILED || (status === undefined && signals.includes('connection'))) {
    return `Could not connect: nothing answered at ${hostOf(model.apiBaseUrl) ?? who}.`;
  }
  if (status !== undefined && status >= 500) return withStatus(`Provider error: ${who} failed on its side`, status);
  if (status === 400 && signals.includes('tool')) {
    return withStatus(`Tools refused: ${who} will not take tool calls for this model, and the agent needs them`, status);
  }
  if (status === 400) return withStatus(`Request refused: ${who} rejected the request`, status);
  return withStatus(`Request failed: ${who} did not answer`, status);
};

const redact = (text: string, secret: string | null | undefined): string => {
  const key = secret?.trim();
  return key && key.length >= 4 ? text.split(key).join('[redacted]') : text;
};

export const createModelProbe = (deps: {
  providers: ProviderSource;
  modelConfigPort: ModelConfigPort;
  timeoutMs?: number;
}): ModelProbe => async () => {
  const model = await deps.modelConfigPort.getDefaultModel();
  if (!model || model.isActive === false) return null;
  const modelId = model.id;
  const timeoutMs = deps.timeoutMs ?? MODEL_TEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let provider: ChatProvider | undefined;
  const started = Date.now();

  const request = async (): Promise<void> => {
    provider = await deps.providers.create(model.modelName, model.id);
    const body = provider.decorateRequest({
      model: model.modelName,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16,
      tools: [PROBE_TOOL],
    });
    const stream = await provider.getClient().chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: controller.signal },
    );
    // The first chunk proves the provider took the request; stop before it spends more.
    for await (const _chunk of stream) break;
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
  });

  const pending = request();
  // After a timeout the abort below rejects the request too; nobody is waiting for it then.
  pending.catch(() => undefined);
  try {
    await Promise.race([pending, timeout]);
    const latencyMs = Date.now() - started;
    return { ok: true, latencyMs, message: `${whoAnswers(model)} answered in ${latencyMs} ms.` };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = redact(describeFailure(error, model, provider), model.apiKey);
    logger.info(
      { modelId, provider: model.provider, latencyMs, status: statusOf(error) ?? null },
      '[ModelProbe] Model test failed',
    );
    return { ok: false, latencyMs, message };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
};

/** The probe the app uses: the agent's ProviderFactory over the agent's model store. */
export const createDefaultModelProbe = (config: ResolvedConfig): ModelProbe => {
  const modelConfigPort = createModelConfigPort();
  return createModelProbe({ providers: new ProviderFactory(config, modelConfigPort), modelConfigPort });
};
