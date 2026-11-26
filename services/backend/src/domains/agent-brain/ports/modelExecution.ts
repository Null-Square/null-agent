/**
 * The model seam, split into the two things orchestration actually needs.
 *
 * `getModelStream()` is not the only model-dependent seam. The provider is resolved **first** and
 * `BuildStage` consumes it directly, so wrapping the stream factory alone would leave prompt
 * construction, capability declaration and error mapping bound to an OpenAI-shaped provider.
 *
 * Reading it against the code, the split is clean and the whole surface is nine members:
 *
 *   - `BuildStage` needs five, all **credential-free**: `name`, `getCapabilities`,
 *     `buildSystemMessages`, `supportsCacheControl`, `mapError` — that is `ModelPromptProfilePort`.
 *   - `ModelRuntime` and `TurnToolExecutor` need the dispatch surface — that is
 *     `ModelExecutionPort`, and every OpenAI-shaped member (`getClient`, `decorateRequest`,
 *     `normalizeUsage`) stays *inside* the API adapter where it already lives.
 *
 * `ChatProviderPort` and `ModelStream` satisfy these structurally, so the API path is the same
 * objects reached through narrower types. That is the point: production must be unchanged (I13),
 * and the way to be sure of that is to move no API code at all.
 */

import type OpenAI from 'openai';
import type { CacheIdentity, ProviderCacheProjection } from '../domain/cache';
import type { AppError } from '../domain/errors';
import type {
  BuildSystemMessagesParams,
  ProviderCapabilities,
  ProviderErrorContext,
} from './ChatProviderPort';
import type { ModelConfig } from './ModelConfigPort';
import type { ModelStreamRequest, ModelStreamResult, PreparedModelRequest } from './modelStream';

/**
 * What prompt assembly needs from whatever will answer. Deliberately carries no client, no
 * credentials, and nothing OpenAI-shaped — a runtime that holds no API key can implement all of
 * it, which is exactly why the split is here and not one level down.
 */
export interface ModelPromptProfilePort {
  name: string;
  getCapabilities(): ProviderCapabilities;
  buildSystemMessages(params: BuildSystemMessagesParams): OpenAI.Chat.ChatCompletionMessageParam[];
  mapError(error: unknown, context?: ProviderErrorContext): AppError;
  supportsCacheControl(): boolean;
}

/**
 * What dispatch needs. `prepare` and `startPrepared` are separate because `ModelRuntime` prepares
 * once and dispatches per attempt, giving every retry its own frozen quote and ledger row.
 */
export interface ModelExecutionPort {
  readonly providerName: string;
  setModelName(name: string): void;
  getContextCapacity(): number;
  prepare(request: ModelStreamRequest): PreparedModelRequest;
  start(request: ModelStreamRequest): Promise<ModelStreamResult>;
  startPrepared(request: PreparedModelRequest): Promise<ModelStreamResult>;
  projectCacheSurface(
    envelope: Record<string, unknown>,
    identity: CacheIdentity,
  ): ProviderCacheProjection | undefined;
}

/**
 * Adapter-owned identifiers. The application records and routes these values but does not own a
 * closed list of external runtimes. Adding a Claude, Qwen, Kimi, or xAI route must not require a
 * core type edit.
 */
export type ExecutionBackendId = string;
export type ExecutionAuthMode = string;
export type ExecutionAccountingMode = string;

/**
 * The five axes of §4.3, kept apart on purpose.
 *
 * The failure this prevents is the tempting one: adding `CODEX` to `ProviderType`. Provider
 * identity ("which model family answered") is not the execution backend ("what process carried
 * the request"), which is not the authentication mode, which is not how it is accounted, which is
 * not which circuit breaker and which metrics it belongs to. Collapsing any two of them puts an
 * external failure onto the API circuit breaker or a subscription turn onto the credit ledger.
 */
export interface ModelExecutionDescriptor {
  /** The model family that answered. Unchanged by *how* it was reached. */
  providerIdentity: string;
  executionBackend: ExecutionBackendId;
  authMode: ExecutionAuthMode;
  accountingMode: ExecutionAccountingMode;
  /**
   * Circuit-breaker and metrics namespace (I11). An external backend must never share the API
   * fault domain, or one developer's rate limit trips the breaker for customer traffic.
   */
  faultDomain: string;
}

/** §10.2. Descriptive accounting labels; Null AI charges nothing, so no code path gates on them. */
export interface ExecutionAccountingPolicy {
  accountingMode: ExecutionAccountingMode;
  consumesPlatformCredits: boolean;
  requiresPlatformCreditAdmission: boolean;
}

export interface ResolvedModelExecution {
  promptProfile: ModelPromptProfilePort;
  execution: ModelExecutionPort;
  descriptor: ModelExecutionDescriptor;
  accounting: ExecutionAccountingPolicy;
}

/**
 * Why a model cannot be served. Returned rather than thrown so that `SessionService` can keep
 * producing the exact error text it produces today for the API case — a refactor that changes a
 * user-visible message is a behaviour change wearing a refactor's clothes.
 */
export interface ModelUnavailableReason {
  code: 'missing_api_key' | 'inactive' | 'unknown_model' | 'runtime_unavailable';
  detail: string;
}

/**
 * The single resolver `SessionService` and orchestration share (§4.1, §10.1).
 *
 * Availability is asked of the resolver rather than tested as `model.apiKey` in three places,
 * because "is there an API key in the database" answers the wrong question the moment something
 * other than an API answers. The API resolver still answers it by looking at the API key, so the
 * API path keeps its behaviour and its error text exactly.
 */
export interface ModelExecutionResolverPort {
  readonly backend: ExecutionBackendId;
  resolve(modelName: string, modelId?: string): Promise<ResolvedModelExecution>;
  /** `null` when the model can be served; a reason when it cannot. */
  unavailableReason(model: ModelConfig | null | undefined): ModelUnavailableReason | null;
  accountingPolicy(): ExecutionAccountingPolicy;
  /**
   * The model this backend will actually answer with, when that is not the one the session
   * pinned; `null` when the backend honours the selection.
   *
   * This exists so the usage ledger can price the call against the rate card of the model that
   * *ran*. A Codex process answers a `deepseek-v4-pro` session with `gpt-5.4`, and quoting the
   * former would produce a cost figure for work nothing did — which is worse than no figure,
   * because it looks like one.
   */
  effectiveModelName?(): string | null;
  /**
   * Release provider-owned conversation state for one terminal session without disposing the
   * shared route/model resolver. API resolvers need no hook; external agent runtimes use it to
   * close suspended turns and lanes when the host session becomes terminal.
   */
  releaseSession?(sessionId: string): Promise<void>;
  dispose?(): Promise<void>;
}

export const API_FAULT_DOMAIN = 'api';

export const isModelServable = (
  resolver: ModelExecutionResolverPort,
  model: ModelConfig | null | undefined,
): boolean => resolver.unavailableReason(model) === null;
