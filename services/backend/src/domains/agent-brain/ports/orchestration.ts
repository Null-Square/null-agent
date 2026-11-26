import type { SessionState } from '../domain/types';
import type { AgentType, PromptProfile, PromptSection } from '../domain/prompts';
import type { ToolDefinition } from '../domain/types';
import type { CacheIntent, ChatProvider } from './ChatProviderPort';
import type { TurnRunArgs, TurnRunResult } from '../application/orchestration/types';
import type { ModelExecutionPort } from './modelExecution';
import type { ModelStreamResult } from './modelStream';
import type OpenAI from 'openai';

export interface AuxiliaryModelCallInput {
  sessionId: string;
  turnNumber: number;
  routeReason: 'context_compaction' | 'finding_duplicate_judge';
  /**
   * E12: auxiliary calls declare their cache intent instead of all inheriting the parent.
   * Compaction is cache-affine and replays the ancestor prefix. A semantically isolated
   * call stays isolated — inheriting the session would add irrelevant context, alter
   * behavior, widen privacy exposure, and can cost more than it saves.
   */
  cacheMode?:
    | { kind: 'reuse_ancestor' }
    | { kind: 'isolated'; reason: string };
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface PolicyResolverPort {
  resolve(session: SessionState, profileKey?: string): Promise<SessionState>;
}

export interface PromptBuildInput {
  session: SessionState;
  agentType: AgentType;
  promptProfile?: PromptProfile;
  softContext?: string;
  tools: ToolDefinition[];
}

export interface PromptBuild {
  staticPrompt: string;
  dynamicPrompt: string;
  cacheablePrefix: string;
  dynamicBoundary: string;
  sections: {
    static: PromptSection[];
    soft: PromptSection[];
    dynamic: PromptSection[];
  };
  agentType: AgentType;
  promptProfile: PromptProfile;
  softContext?: string;
}

export interface PromptBuilderPort {
  build(input: PromptBuildInput): PromptBuild;
}

export interface CacheDecision {
  cacheIntent?: CacheIntent;
  prefixHash: string;
  approxPrefixTokens: number;
}

export interface CacheCoordinatorPort {
  build(args: {
    session: SessionState;
    cacheablePrefix: string;
    providerSupportsCache: boolean;
    /**
     * D17 — the named sections the prefix is built from. Recorded so that when a resume finds
     * the prefix has moved, it can say which section moved rather than only that the hash did.
     */
    prefixSections?: ReadonlyArray<{ key: string; content: string }>;
  }): CacheDecision;
}

export interface TurnExecutorPort {
  runTurn(args: TurnRunArgs): Promise<TurnRunResult>;
  setModelName(name: string): void;
  setModel?(model: ModelExecutionPort): void; // Optional for lazy initialization
  /** Runs an internal model call through the same quote, attempt, and charge boundary. */
  executeModelCall?(input: AuxiliaryModelCallInput): Promise<ModelStreamResult>;
}

export interface ArtifactFlushResult {
  hasSummary: boolean;
  hasReport: boolean;
}

export interface ProviderFactoryPort {
  create(modelName: string, modelId?: string): Promise<ChatProvider>;
}
