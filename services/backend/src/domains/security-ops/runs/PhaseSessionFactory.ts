import type {
  CreateSessionParams,
  CreateSessionResult,
  SessionService,
} from '@/domains/agent-brain/application/services/SessionService';
import type { PromptProfile } from '@/domains/agent-brain/domain/prompts';
import type { SessionState, ToolAccessPolicy } from '@/domains/agent-brain/domain/types';
import type { ModelCategory } from '@null-ai/contracts';
import type { SessionExecutionProfileV1 } from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';

import type { RunPhaseKey } from './PhaseProfileRegistry';

export type CreatePhaseSessionInput = {
  phaseKey: RunPhaseKey;
  userId?: string;
  organizationId: string;
  modelId?: string;
  modelCategory?: ModelCategory;
  profileKey: string;
  promptProfile: PromptProfile;
  extraContext: string;
  executionMode: SessionState['executionMode'];
  flags: SessionState['flags'];
  scopeId: string;
  planSeed: SessionState['plan'];
  toolPolicy: ToolAccessPolicy;
  lazySandbox?: boolean;
  executionSelection?: CreateSessionParams['executionSelection'];
  executionProfile?: SessionExecutionProfileV1;
};

export type PhaseSessionCreator = Pick<SessionService, 'createSession'>;

/**
 * Canonical phase-session construction boundary shared by normal run startup
 * and the sidecar evaluator. It intentionally accepts only normalized
 * production inputs and never receives an evaluation-only mode.
 */
export const buildPhaseSessionParams = (input: CreatePhaseSessionInput): CreateSessionParams => ({
  userId: input.userId,
  organizationId: input.organizationId,
  modelId: input.modelId,
  modelCategory: input.modelCategory,
  profileKey: input.profileKey,
  promptProfile: input.promptProfile,
  extraContext: input.extraContext,
  executionMode: input.executionMode,
  flags: input.flags,
  scopeId: input.scopeId,
  mode: 'automated',
  agentType: 'executor',
  planSeed: input.planSeed,
  toolPolicy: input.toolPolicy,
  lazySandbox: input.lazySandbox,
  executionSelection: input.executionSelection,
  executionProfile: input.executionProfile,
});

export class PhaseSessionFactory {
  constructor(private readonly sessionCreator: PhaseSessionCreator) {}

  create(input: CreatePhaseSessionInput): Promise<CreateSessionResult> {
    return this.sessionCreator.createSession(buildPhaseSessionParams(input));
  }
}
