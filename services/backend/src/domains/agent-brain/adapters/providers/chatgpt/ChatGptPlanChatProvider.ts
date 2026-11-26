import OpenAI from 'openai';
import type { ResolvedConfig } from '@/config/configTypes';
import { LLM_REQUEST_MS } from '@/config/timeouts';
import { CHATGPT_API_BASE_URL } from '@/domains/platform/models/modelProviders';
import type { AppError } from '../../../domain/errors';
import type {
  BuildSystemMessagesParams,
  ChatCompletionRequest,
  ChatCompletionRequestInput,
  ProviderCapabilities,
  ProviderErrorContext,
} from '../ChatProvider';
import { BaseChatProvider } from '../BaseChatProvider';
import { ChatGptPlanError, ResponsesChatShim } from './responsesShim';

export type AccessTokenSource = () => Promise<string>;

/** The stored sign-in, loaded on first use so that importing the provider opens no database. */
const defaultAccessToken: AccessTokenSource = async () => {
  const { ChatGptCredentials } = await import('@/domains/platform/models/chatGptCredentials');
  return new ChatGptCredentials().accessToken();
};

/**
 * The person's ChatGPT plan (Sign in with ChatGPT). Requests go to OpenAI's public Responses API
 * with the plan's OAuth access token as the bearer and `maxRetries: 0` (ModelRuntime owns
 * retries). The token is asked for on every request, so a refresh is picked up by the same client.
 */
export class ChatGptPlanChatProvider extends BaseChatProvider {
  public readonly name = 'chatgpt';

  protected readonly capabilities: ProviderCapabilities = {
    explicitCacheControl: false,
    automaticCaching: true,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    streaming: true,
    rateLimitHeaders: false,
    reasoning: { replay: 'none' },
  };

  private readonly shim: ResponsesChatShim;

  constructor(
    config: ResolvedConfig,
    requestProfile: Record<string, unknown> = {},
    accessToken: AccessTokenSource = defaultAccessToken,
  ) {
    super(config, requestProfile);
    this.shim = new ResponsesChatShim(
      new OpenAI({ apiKey: accessToken, baseURL: CHATGPT_API_BASE_URL, maxRetries: 0, timeout: LLM_REQUEST_MS }),
    );
  }

  override getClient(): OpenAI {
    return this.shim as unknown as OpenAI;
  }

  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[] {
    const { staticPrompt, dynamicPrompt, softContext } = params;
    // The shim moves system messages into `instructions`; the plan rejects system input items.
    return [{ role: 'system', content: [staticPrompt, softContext || '', dynamicPrompt].filter(Boolean).join('\n\n') }];
  }

  override decorateRequest(body: ChatCompletionRequestInput): ChatCompletionRequest {
    const decorated = { ...body } as ChatCompletionRequestInput & { reasoning_effort?: unknown };
    if (this.requestProfile.reasoningEffort !== undefined && decorated.reasoning_effort === undefined) {
      decorated.reasoning_effort = this.requestProfile.reasoningEffort;
    }
    return decorated as ChatCompletionRequest;
  }

  override mapError(error: unknown, context: ProviderErrorContext = {}): AppError {
    if (error instanceof ChatGptPlanError) {
      return super.mapError(Object.assign(new Error(error.message), { status: error.status, code: error.code }), context);
    }
    return super.mapError(error, context);
  }
}
