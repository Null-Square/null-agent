import { type SessionStore } from '../core/SessionStore';
import { AppError, isAppError } from '@/domains/agent-brain/domain/errors';
import { mergeToolPolicies } from '@/domains/agent-brain/domain/policy/brainPolicyRuntimeService';
import type { SessionState } from '../../domain/types';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { AgentBrainPorts } from '../core/AgentBrainPorts';
import type { AgentEngine } from '../../application/orchestration/AgentEngine';
import { logger } from '@/shared/logger';
import type { SandboxProfileRegistryPort } from '../../ports';
import { type PolicyResolver } from '../../domain/policy';
import { SandboxSelectionService } from './SandboxSelectionService';
import { PolicyEngine } from './PolicyEngine';
import { ERROR_CODES } from '@null-ai/contracts';
import type { ModelCategory } from '@null-ai/contracts';
import type { SubscriptionPort, ModelConfigPort, SessionGateParams } from '../../ports';
import type { ModelConfig } from '../../ports';
import type { ToolAccessPolicy } from '../../domain/types';
import type { AgentType } from '../../domain/prompts/agentPrompts';
import type { PromptProfile } from '../../domain/prompts/agentPrompts';
import { ModelRuntime } from '../orchestration/ModelRuntime';
import {
  PLATFORM_API_ROUTE_ID,
  apiUnavailableReason,
  bindExecutionSelection,
  resolveExecutionSelectionDefault,
  type ExecutionSelection,
  type SessionExecutionProfileV1,
} from '../../domain/runtime/ExecutionRuntimeRegistry';

export interface CreateSessionParams {
  userId?: string;
  organizationId?: string | null;
  modelId?: string;
  modelCategory?: ModelCategory;
  profileKey?: string;
  promptProfile?: PromptProfile;
  extraContext?: string;
  flags?: SessionState['flags'];
  scopeId?: string;
  agentType?: AgentType;
  toolPolicy?: ToolAccessPolicy;
  mode?: 'interactive' | 'automated';
  executionMode?: SessionState['executionMode'];
  planSeed?: SessionState['plan'];
  /** Defer Docker/remote runner allocation until the first sandbox operation. */
  lazySandbox?: boolean;
  /** Trusted development ingress only. Never parsed by the production HTTP composition. */
  executionSelection?: ExecutionSelection;
  /** Trusted inheritance for later sessions in the same run. */
  executionProfile?: SessionExecutionProfileV1;
  /** Trusted runtime override used by fixed-configuration evaluations. */
  modelTemperature?: number;
}

export type CreateSessionResult = {
  session: SessionState;
  model: ModelConfig;
};

// Sandbox profile registry is a port to keep SessionService adapter-agnostic.

export class SessionService {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly sandboxProfileRegistry: SandboxProfileRegistryPort,
    private readonly ports: AgentBrainPorts,
    private readonly agentEngine: AgentEngine,
    subscriptionPort: SubscriptionPort,
    policyResolver: PolicyResolver,
    modelConfigPort?: ModelConfigPort,
    private readonly traceRecorder?: SessionTraceRecorder,
    private readonly sessionRepository?: SessionGateParams['sessionRepository'],
    policyFacade?: PolicyEngine,
    sandboxSelection?: SandboxSelectionService,
  ) {
    const effectivePolicyFacade = policyFacade ?? new PolicyEngine(undefined, policyResolver);
    this.policyFacade = effectivePolicyFacade;
    this.sandboxSelection =
      sandboxSelection ?? new SandboxSelectionService(sandboxProfileRegistry, effectivePolicyFacade, undefined);
    this.subscriptionPort = subscriptionPort;
    this.modelConfigPort = modelConfigPort;
  }
  private readonly log = logger.child({ scope: 'SessionService' });
  private readonly policyFacade: PolicyEngine;
  private readonly sandboxSelection: SandboxSelectionService;
  private readonly subscriptionPort: SubscriptionPort;
  private readonly modelConfigPort?: ModelConfigPort;
  private readonly modelRuntime = new ModelRuntime();

  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
    const {
      userId,
      organizationId,
      profileKey,
      promptProfile,
      extraContext,
      flags,
      scopeId,
      agentType,
      toolPolicy,
      mode,
    } = params;
    let planSlug: string | undefined;
    let allowedModelCategories: ModelCategory[] | null | undefined;
    const normalizedMode = mode ?? 'automated';

    // 1. Resolve plan before default model selection so entry tiers cannot fall onto a stronger default model.
    if (userId) {
      try {
        const subscription = await this.subscriptionPort.resolveOrganizationSubscription({
          userId,
          organizationId,
        });
        planSlug = subscription.plan.slug;
        allowedModelCategories = subscription.plan.limits?.allowedModelCategories;
      } catch (error) {
        if (isAppError(error)) {
          throw error;
        }
        this.log.warn({ err: error, userId }, '[SessionService] Failed to resolve subscription before model selection');
      }
    }

    // Explicit request selection wins. Later run phases inherit their admitted profile. Only a
    // genuinely new root session may consult an optional composition-owned default (the normal
    // production composition registers none).
    const defaultExecutionSelection =
      !params.executionSelection && !params.executionProfile
        ? await resolveExecutionSelectionDefault({ userId, organizationId })
        : undefined;
    const requestedExecutionSelection = params.executionSelection ?? defaultExecutionSelection;
    const boundExecution = requestedExecutionSelection
      ? await bindExecutionSelection(requestedExecutionSelection)
      : undefined;
    const inheritedExecution = params.executionProfile;
    const selectedModel = boundExecution
      ? await this.modelConfigPort?.getByModelName(
          boundExecution.pricingModelName ?? boundExecution.profile.effectiveModel,
        )
      : inheritedExecution && inheritedExecution.routeId !== PLATFORM_API_ROUTE_ID
        ? await this.modelConfigPort?.getByModelName(inheritedExecution.effectiveModel)
        : await this.resolveSelectedModel(params, allowedModelCategories);
    const usesExternalExecution = Boolean(
      boundExecution || (inheritedExecution && inheritedExecution.routeId !== PLATFORM_API_ROUTE_ID),
    );
    if (!selectedModel?.modelName || (!usesExternalExecution && selectedModel.isActive === false)) {
      if (params.modelId) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          `Selected model ${params.modelId} is no longer available`,
          {
            httpStatus: 400,
            userMessage: 'The selected model is no longer available. Refresh models and choose another one.',
          },
        );
      }
      if (params.modelCategory) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          `No active model is available for category ${params.modelCategory}`,
          {
            httpStatus: 400,
            userMessage:
              'The selected model category is not available. Refresh model categories and choose another one.',
          },
        );
      }
      throw new AppError(
        ERROR_CODES.INTERNAL_CONFIGURATION,
        'No default model configured. Set isDefault=true on a model in the database.',
      );
    }
    // A session on a registered external route needs no API key here, because that route answers
    // it; every other session gets the API rule and message, unchanged — a refactor that alters a
    // user-visible error is a behaviour change wearing a refactor's clothes.
    const unavailable = usesExternalExecution ? null : apiUnavailableReason(selectedModel);
    if (unavailable) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, unavailable.detail, {
        httpStatus: 400,
        userMessage:
          unavailable.code === 'missing_api_key'
            ? 'The selected model is not configured with an API key. Choose another model or configure this model before starting a session.'
            : 'The selected model cannot be used right now. Choose another model or configure this model before starting a session.',
        context: {
          modelId: selectedModel.id ?? params.modelId ?? null,
          modelName: selectedModel.modelName,
          provider: selectedModel.provider,
          reason: unavailable.code,
        },
      });
    }
    const modelName = selectedModel.modelName;
    const modelContextWindow = selectedModel?.contextWindow ?? undefined;
    const modelMaxOutputTokens = selectedModel?.maxOutputTokens ?? undefined;
    const executionProfile: SessionExecutionProfileV1 =
      inheritedExecution ??
      (boundExecution
        ? {
            ...boundExecution.profile,
            pricingModelId: selectedModel.id ?? '',
          }
        : {
            version: 1,
            routeId: PLATFORM_API_ROUTE_ID,
            catalogueRevision: 'platform-api-v1',
            providerIdentity: selectedModel.provider,
            executionBackend: 'api',
            authMode: 'platform-api-key',
            accountingMode: 'platform',
            consumesPlatformCredits: true,
            requiresPlatformCreditAdmission: true,
            requestedModel: selectedModel.modelName,
            effectiveModel: selectedModel.modelName,
            pricingModelId: selectedModel.id ?? '',
            controls: {},
            faultDomain: 'api',
          });
    if (usesExternalExecution && !executionProfile.pricingModelId) {
      throw new AppError(
        ERROR_CODES.INTERNAL_CONFIGURATION,
        `Model ${selectedModel.modelName} has no deployment id and cannot be priced`,
      );
    }

    // 2. Enforce subscription gates with the resolved model category.
    if (userId) {
      try {
        const subscription = await this.subscriptionPort.enforceSessionCreation({
          userId,
          organizationId,
          mode,
          requestedModelCategory: selectedModel.selectionCategory ?? params.modelCategory ?? null,
        });
        planSlug = subscription.plan.slug;
      } catch (error) {
        if (isAppError(error)) {
          throw error;
        }
        this.log.warn({ err: error, userId }, '[SessionService] Failed to resolve subscription');
      }
    }

    // 3. Resolve Policies
    let resolvedPolicy;
    try {
      resolvedPolicy = await this.policyFacade.resolveBrainPolicy({
        planSlug,
        profile: profileKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'policy.default_missing') {
        throw new AppError(
          ERROR_CODES.INTERNAL_CONFIGURATION,
          'No default policy profile is configured. Run npm run db:seed.',
        );
      }
      throw error;
    }
    const mergedToolPolicy =
      mergeToolPolicies(resolvedPolicy?.toolPolicy, toolPolicy) ??
      resolvedPolicy?.toolPolicy ??
      toolPolicy ??
      undefined;
    const effectiveToolPolicy = mergedToolPolicy;
    // Use resolved policy sandbox profile/image only.
    const { sandboxProfile, sandboxImage } = await this.sandboxSelection.resolve({
      sandboxProfile: resolvedPolicy?.sandboxProfile,
    });
    this.log.debug(
      {
        resolvedPolicySandboxProfile: resolvedPolicy?.sandboxProfile,
        sandboxProfileRequested: sandboxProfile,
        sandboxImage,
      },
      '[SessionService] sandbox selection',
    );

    // 4. Create Session in Store
    const modelSelectionFlags = {
      requestedModelId: params.modelId ?? null,
      requestedCategory: params.modelCategory ?? null,
      resolvedModelId: selectedModel.id ?? null,
      resolvedModelName: selectedModel.modelName,
      resolvedCategory: selectedModel.selectionCategory ?? params.modelCategory ?? null,
    };

    const session = await this.sessionStore.create({
      userId,
      profileKey,
      promptProfile: promptProfile ?? agentType ?? 'chat',
      extraContext,
      flags: {
        ...(flags ?? {}),
        model_selection: modelSelectionFlags,
        execution_profile: executionProfile,
      },
      scopeId,
      agentType,
      toolPolicy: effectiveToolPolicy,
      sandboxProfile,
      mode: normalizedMode,
      sandboxImage,
      modelName,
      modelContextWindow,
      modelMaxOutputTokens,
      modelTemperature: params.modelTemperature,
      executionMode: params.executionMode,
      planSeed: params.planSeed,
    });

    // 5. Apply Flags
    session.flags = session.flags ?? {};
    session.flags.policy_base = {
      ...(session.flags.policy_base ?? {}),
      toolPolicy: resolvedPolicy?.toolPolicy ?? null,
    };
    if (planSlug) {
      session.flags.subscription = {
        ...(session.flags.subscription ?? {}),
        planSlug,
      };
    }
    if (resolvedPolicy) {
      session.flags.brain_policy = {
        profile: resolvedPolicy.profile,
        source: resolvedPolicy.source,
      };
    } else {
      delete session.flags.brain_policy;
    }
    this.sessionStore.set(session.id, session);

    // 6. Initialize Session Engine
    try {
      await this.agentEngine.initializeSession({
        session,
        sandboxImage,
        traceRecorder: this.traceRecorder,
        provisionSandbox: params.lazySandbox !== true,
      });
    } catch (error) {
      this.sessionStore.remove(session.id, 'explicit');
      const msg = (error as Error)?.message ?? '';
      if (msg.includes('not available locally')) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, msg, {
          context: { sandboxImage },
        });
      }
      throw error;
    }

    return { session, model: selectedModel };
  }

  private async resolveSelectedModel(
    params: CreateSessionParams,
    allowedModelCategories?: ModelCategory[] | null,
  ): Promise<ModelConfig | null | undefined> {
    return this.modelRuntime.resolveSessionModel({
      modelConfigPort: this.modelConfigPort,
      requestedModelId: params.modelId,
      requestedCategory: params.modelCategory,
      allowedCategories: allowedModelCategories,
    });
  }
}
