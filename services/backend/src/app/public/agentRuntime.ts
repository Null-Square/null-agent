/**
 * Stable in-process agent runtime surface for trusted sidecar services.
 *
 * The production backend owns every implementation exported here. Sidecars may
 * construct and observe the real runtime through this module, but production
 * code must never import sidecar code or receive evaluation-only flags, expected
 * outcomes, or ground truth.
 */
import type { AppContext } from '../createAppContext';
import type {
  CreateSessionParams,
  CreateSessionResult,
} from '@/domains/agent-brain/application/services/SessionService';
import type { SubscriptionPort, UsageStorePort } from '@/domains/agent-brain/ports';
import type { RuntimeHostCapabilities } from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import type { Application } from 'express';

export type { AppContext };
export type { CodeReviewContext } from '@/db/schema';
export type {
  StandaloneCodeReviewRunRuntime,
  StandaloneCodeReviewStartInput,
} from './standaloneCodeReviewRunRuntime';

export const createAppContext = async (): Promise<AppContext> => {
  const runtime = await import('../createAppContext');
  return runtime.createAppContext();
};

/**
 * Create a session through the same admission service used by product HTTP and
 * run entrypoints. Trusted sidecars must not call SessionStore.create directly
 * for billable work: that low-level API does not resolve subscription policy or
 * pin the model deployment used by provider accounting.
 */
export const createAdmittedAgentSession = async (
  app: AppContext,
  input: CreateSessionParams,
): Promise<CreateSessionResult> => {
  const [{ SessionService }, { createModelConfigPort, createSubscriptionPort }] =
    await Promise.all([
      import('@/domains/agent-brain/application/services/SessionService'),
      import('@/app/adapters/portFactories'),
    ]);
  const service = new SessionService(
    app.agentServices.sessionStore,
    app.agentServices.sandboxProfileRegistry,
    app.agentServices.ports,
    app.agentServices.agentEngine,
    createSubscriptionPort(),
    app.agentServices.policyResolver,
    createModelConfigPort(),
    app.agentServices.traceRecorder,
    undefined,
    app.agentServices.policyFacade,
  );
  return service.createSession(input);
};

/**
 * Stop in-flight agent work belonging to a run.
 *
 * A sidecar that cancels only its own AbortSignal does not stop the runtime.
 * A blocking worker drives its entire mission inside a single await and never
 * observes that signal, so the sidecar stops waiting while the worker keeps
 * making paid model calls — the run reports itself finished while spend
 * continues against an orphaned session.
 *
 * This is the mechanism the product already uses to cancel live runs. The work
 * continuation guard rechecks the marker at every paid model and tool
 * boundary, so the worker stops at its next boundary rather than running to
 * natural completion. Callers pass the same run identifier they placed on the
 * session's securityops flags, which worker children inherit.
 */
export const markRunCancelled = async (runId: string): Promise<void> => {
  const guard = await import(
    '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard'
  );
  guard.workCancellationRegistry.markRunCancelled(runId);
};

export const createHostedAgentRuntimeContext = async (
  options: {
    persistSessions?: boolean;
    runtimeHostCapabilities?: RuntimeHostCapabilities;
    providerAttemptStore?: UsageStorePort;
  } = {},
): Promise<AppContext> => {
  const runtime = await import('../createAppContext');
  return runtime.createAppContext({
    productHost: 'research_lab',
    persistSessions: options.persistSessions,
    runtimeHostCapabilities: options.runtimeHostCapabilities,
    providerAttemptStore: options.providerAttemptStore,
  });
};

export const createStandaloneCodeReviewRunRuntime = async (
  app: AppContext,
  subscriptionPort: SubscriptionPort,
) => {
  const runtime = await import('./standaloneCodeReviewRunRuntime');
  return runtime.createStandaloneCodeReviewRunRuntime(app, subscriptionPort);
};

/**
 * Mount the complete production platform HTTP application around a supplied
 * runtime context. Trusted sidecars use this instead of recreating auth,
 * organization context, readiness, or product routers.
 */
export const createPlatformHttpApp = async (
  app: AppContext,
): Promise<Application> => {
  const runtime = await import('@/interfaces/http/httpServer');
  return runtime.createHttpApp(app);
};

export const resolveDefaultModelName = async (): Promise<string> => {
  const { ModelService } = await import('@/domains/platform/models/ModelService');
  const defaultModel = await new ModelService().getDefaultMetadataOrNull();
  if (!defaultModel?.modelName) {
    throw new Error('[ResearchLab] No default model configured. Pass --model or configure a default backend model.');
  }
  return defaultModel.modelName;
};

export type RuntimeModelOption = {
  id: string;
  name: string;
  displayName: string | null;
  provider: string;
  modelName: string;
  description?: string | null;
  isDefault: boolean;
  selectionCategory: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
};

export const listActiveModelOptions = async (): Promise<RuntimeModelOption[]> => {
  const { ModelService } = await import('@/domains/platform/models/ModelService');
  const rows = await new ModelService().listActive();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    provider: row.provider,
    modelName: row.modelName,
    description: row.description,
    isDefault: row.isDefault,
    selectionCategory: row.selectionCategory,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
  }));
};

export type {
  EnumerationMissionV1,
  Message,
  MissionEnvelope,
  SessionState,
  StreamEvent,
  WorkerTaskRecord,
} from '@/domains/agent-brain/domain/types';

export {
  computeEnumerationResultHash,
  computeEnumerationMissionFingerprint,
  parseEnumerationResultV1,
  sha256Canonical,
} from '@/domains/agent-brain/domain/workers/enumerationContracts';

export type {
  AttackMissionV1,
  AttackResultV1,
} from '@/domains/agent-brain/domain/workers/attackContracts';
export {
  parseAttackMissionV1,
  parseAttackResultV1,
} from '@/domains/agent-brain/domain/workers/attackContracts';
export { assessAttackWorkerToolUse } from '@/domains/agent-brain/domain/workers/attackRuntimeGuard';
export {
  evaluateAttackWorkerAdmission,
  evaluateControlledExploitationPhaseAdmission,
} from '@/domains/security-ops/runs/controlledExploitationAdmission';
export type { ScopeContext } from '@/domains/security-ops/scopes/ScopeService';

export {
  evaluateDelegationActivation,
  parseAssignedSkillsFromExtraContext,
} from '@/domains/agent-brain/domain/workers/delegationActivation';

export { getWorkerTemplate } from '@/domains/agent-brain/domain/workers/workerContracts';
export { buildWorkerExtraContext } from '@/domains/agent-brain/application/services/worker/WorkerDelegationShared';
export { RunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
export { buildRunContext } from '@/domains/security-ops/runs/RunContextService';
export { focusScopeContextOnAsset } from '@/domains/security-ops/runs/StartRunPromptHelpers';
export { SystemPromptBuilder } from '@/domains/agent-brain/domain/prompts/SystemPromptBuilder';
export { buildRunCompactionPrompt } from '@/domains/agent-brain/application/orchestration/stages/helpers/CompactionSummary';
export { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';
export {
  findMissionToolCapabilityFailures,
  findSkillToolCapabilityFailures,
  isPhaseReplanSubmission,
} from '@/domains/security-ops/runs/MissionAdmissionPolicy';
export {
  mergeRunFindingIds,
  normalizeReportingCloseoutOutcome,
  reportingCloseoutRequiresInterim,
} from '@/domains/security-ops/tools/reporting/RunReportAuthority';
export { syncAssignedSkillsIntoWorkspace } from '@/domains/security-ops/runs/skillWorkspaceSync';
export { EnumerationWorkerSkillResolver } from '@/domains/security-ops/skills/EnumerationWorkerSkillResolver';
export {
  SkillLoader,
  type SkillMetadata,
} from '@/domains/security-ops/skills/SkillLoader';
export { rankSkillsForState } from '@/domains/security-ops/skills/SkillRanker';
export {
  getAgentRunHostCapabilities,
  type AgentRunEngineIntegration,
  type AgentRunEvent,
  type AgentRunEventSink,
  type AgentRunHandle,
  type AgentRunHost,
  type AgentRunHostCapabilities,
  type AgentRunHostContext,
  type AgentRunHostKind,
  type AgentRunProfile,
  type AgentRunProfileAvailability,
} from './agentRunHost';
export { SharedAgentRunHostService } from '@/domains/security-ops/runs/SharedAgentRunHostService';
export type {
  HostedFindingResult,
  HostedFindingSubmission,
  HostedPhaseHandoffResult,
  HostedPhaseHandoffSubmission,
  HostedRepositoryQuery,
  HostedRepositoryManifest,
  HostedRunPersistencePort,
  HostedRunPhase,
  HostedRunPlanResult,
  HostedRunPlanSubmission,
  HostedCodeReviewCandidateSubmission,
  HostedCodeReviewFinding,
  HostedCodeReviewMemoryQuery,
  HostedCodeReviewMemoryWrite,
  HostedCodeReviewReportSubmission,
  HostedCodeReviewValidation,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
export {
  assertRuntimeHostCapabilitiesCompatible,
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  createTestRuntimeHostCapabilities,
  resolveRuntimeHostCapabilities,
  RUNTIME_HOST_LIFECYCLES,
  RuntimeHostCapabilityRegistrationError,
  type PersistenceCapability,
  type PersistenceDurability,
  type RuntimeHostCapabilities,
  type RuntimeHostKind,
  type RuntimeHostLifecycle,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
export {
  TOOL_EXECUTION_LIFECYCLE_SCHEMA_VERSION,
  isToolExecutionTerminal,
  normalizeToolExecutionStatus,
  supportsDurableToolExecutionLifecycle,
  type BlockToolExecutionInput,
  type CanonicalToolExecutionStatus,
  type CompleteToolExecutionInput,
  type CreateToolExecutionInput,
  type FailToolExecutionInput,
  type OutcomeUnknownToolExecutionInput,
  type ToolExecutionIdentity,
  type ToolExecutionPort,
  type ToolExecutionRecord,
  type ToolExecutionStatus,
} from '@/domains/agent-brain/ports/ToolExecutionPort';
export {
  MODEL_REQUEST_SCHEMA_VERSION,
  reconstructLegacyModelRequest,
  supportsAtomicModelRequests,
  type AppendModelRequestInput,
  type ModelRequestPort,
  type ModelRequestProvenance,
  type ModelRequestRecord,
} from '@/domains/agent-brain/ports/ModelRequestPort';
export {
  HISTORY_TRANSFORMATION_SCHEMA_VERSION,
  HistoryTransformationImmutableConflictError,
  createHistoryTransformationId,
  reconstructLegacyHistoryTransformation,
  supportsTransactionalHistory,
  type HistoryTransformationPort,
  type HistoryTransformationProvenance,
  type HistoryTransformationRecord,
  type HistoryTransformationStatus,
  type PersistHistoryReplacementInput,
  type PrepareHistoryTransformationInput,
} from '@/domains/agent-brain/ports/HistoryTransformationPort';
export {
  PROVIDER_ATTEMPT_SCHEMA_VERSION,
  supportsDurableProviderAttemptLifecycle,
  type BeginUsageAttemptInput,
  type CompleteUsageAttemptInput,
  type FailUsageAttemptInput,
  type FinalizedUsageAttempt,
  type ModelAttemptCircuitDecision,
  type ModelAttemptCircuitState,
  type ModelAttemptReasoningSource,
  type ModelAttemptRecord,
  type ModelAttemptRetryDecision,
  type ModelAttemptState,
  type TurnUsageRecord,
  type UsageAttemptHandle,
  type UsageStorePort,
  type UsageSummary,
} from '@/domains/agent-brain/ports/UsagePort';

/**
 * Shared Code Review memory primitives.
 *
 * Hosts own their storage substrate, but the compatibility model, the write
 * contract, and the redaction rule are the product's, not the host's. A host
 * that reimplemented these would drift from the locked memory PRD.
 */
export {
  evaluateCodeReviewMemoryCompatibility,
  selectCodeReviewMemoryIdsForPruning,
  RecordCodeReviewMemoryInputSchema,
  CODE_REVIEW_MEMORY_TYPES,
  CODE_REVIEW_MEMORY_OBSERVATION_TYPES,
} from '@/domains/security-ops/code-review/CodeReviewMemoryService';
export type {
  CodeReviewMemoryAnchor,
  CodeReviewMemoryRecord,
  CodeReviewMemoryState,
  CodeReviewMemoryType,
  CodeReviewCoverageMemory,
} from '@/domains/security-ops/code-review/CodeReviewMemoryService';
export { redactCodeReviewText } from '@/domains/security-ops/code-review/CodeReviewRedaction';
export {
  buildCodeReviewManifestHash,
  filterCodeReviewManifestFiles,
} from '@/domains/security-ops/runs/codeReviewRunContext';
