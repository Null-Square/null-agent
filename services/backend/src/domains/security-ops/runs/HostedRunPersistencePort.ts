import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import type { RunPhaseKey } from './PhaseProfileRegistry';
import type { RiskState } from '@/db/schema';
import {
  supportsAtomicModelRequests,
  supportsDurableToolExecutionLifecycle,
  supportsTransactionalHistory,
  supportsDurableProviderAttemptLifecycle,
  type HistoryTransformationPort,
  type ModelRequestPort,
  type ToolExecutionPort,
  type UsageStorePort,
} from '@/domains/agent-brain/ports';
import {
  assertRuntimeHostCapabilitiesCompatible,
  resolveRuntimeHostCapabilities,
  RuntimeHostCapabilityRegistrationError,
  type RuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

export type HostedRunKind = 'research_lab';

export type HostedRunPlanSubmission = {
  runId: string;
  sessionId: string;
  plan: string;
  skillSlugs: string[];
  missions: MissionEnvelopeNode[];
};

export type HostedRunPlanResult = {
  id: string;
  status: 'running';
  userId: null;
  title: string;
  assignedSkillSlugs: string[];
};

export type HostedRunPhase = {
  id: string;
  runId: string;
  phaseKey: RunPhaseKey;
  ordinal: number;
  status: 'pending' | 'active' | 'completed' | 'blocked' | 'failed' | 'aborted';
  sessionId?: string;
  handoffSchemaVersion: number;
  assignedSkillSlugs: string[];
  missionIds: string[];
  handoffInRef?: string;
  handoffOutRef?: string;
};

export type HostedPhaseHandoffSubmission = {
  runId: string;
  phaseId: string;
  phaseKey: RunPhaseKey;
  sessionId: string;
  payload: Record<string, unknown>;
};

export type HostedPhaseHandoffResult = {
  handoffRef: string;
  status: 'completed' | 'blocked' | 'failed';
};

export type HostedFindingSubmission = {
  runId: string;
  sessionId: string;
  workerType?: string;
  input: Record<string, unknown>;
};

export type HostedFindingResult = {
  findingId: string;
  created: boolean;
  warnings: string[];
  state: RiskState;
};

export type HostedRepositoryQuery =
  | { operation: 'list'; input: Record<string, unknown> }
  | { operation: 'search'; input: Record<string, unknown> }
  | { operation: 'read'; input: Record<string, unknown> }
  | { operation: 'manifest'; input: Record<string, unknown> };

/**
 * Immutable manifest for a hosted Code Review revision.
 *
 * `blobSha` is the canonical Git blob object id, which is exactly what the
 * GitHub tree API returns for a connected repository. Hosted and connected
 * runs therefore produce identical memory anchors for identical file content.
 */
export type HostedRepositoryManifest = {
  repositoryId: string;
  repository: string;
  ref: string;
  files: Array<{ path: string; blobSha: string; size: number | null }>;
  completeness: 'complete' | 'partial';
};

export type HostedCodeReviewCandidateSubmission = {
  runId: string;
  sessionId: string;
  fingerprint: string;
  input: Record<string, unknown>;
  verifiedLocations: Array<{
    filePath: string;
    commitSha: string;
    startLine: number;
    endLine: number;
    sourceExcerpt: string;
    sourceExcerptSha256: string;
    sourceOriginalSha256: string;
  }>;
};

export type HostedCodeReviewFinding = {
  id: string;
  version: number;
  state: 'candidate' | 'validated' | 'rejected';
  severity: string;
  confidence: number;
  category: string;
  title: string;
  summary: string;
  impact: string;
  remediation: string;
  commitSha: string;
  changeAttribution: string;
  attributionRationale?: string;
  fixability: 'fixable' | 'not_fixable' | 'uncertain';
  fixabilityRationale?: string;
  expectedFiles: string[];
  validationPlan: string[];
  locations: Array<{
    filePath: string;
    commitSha: string;
    startLine: number;
    endLine: number;
    sourceExcerpt: string;
    sourceExcerptSha256: string;
  }>;
  validation?: {
    outcome: 'validated' | 'rejected';
    rationale: string;
  };
};

export type HostedCodeReviewValidation = {
  runId: string;
  sessionId: string;
  input: Record<string, unknown>;
};

export type HostedCodeReviewReportSubmission = {
  runId: string;
  sessionId: string;
  input: Record<string, unknown>;
};

export type HostedCodeReviewMemoryQuery = {
  types?: string[];
  includeNeedsRecheck?: boolean;
  query?: string;
  limit?: number;
  manifestFiles: ReadonlyArray<{ path: string; blobSha: string; size?: number | null }>;
  immutableCommitSha: string;
  manifestCompleteness: 'complete' | 'partial' | 'blocked';
  allowedPaths: readonly string[];
  excludedPaths: readonly string[];
};

export type HostedCodeReviewMemoryWrite = HostedCodeReviewMemoryQuery & {
  runId: string;
  sessionId: string;
  phaseKey: string;
  operation: 'repository_review' | 'pull_request_review' | 'finding_fix';
  defaultBranchReview: boolean;
  input: Record<string, unknown>;
};

/**
 * Product-owned persistence behind the canonical shared run tools.
 *
 * Organizational sessions do not use this registry and continue through the
 * existing database services. Hosted sessions opt in explicitly through
 * flags.securityops.runHost and a registered run id.
 */
export interface HostedRunPersistencePort {
  readonly kind: HostedRunKind;
  readonly runId: string;
  readonly runtimeHostCapabilities: RuntimeHostCapabilities;
  readonly toolExecutionLifecycle: ToolExecutionPort;
  readonly modelRequestLifecycle: ModelRequestPort;
  readonly providerAttemptLifecycle: UsageStorePort;
  readonly historyTransformationLifecycle: HistoryTransformationPort;

  submitPlan(input: HostedRunPlanSubmission): Promise<HostedRunPlanResult>;
  getPlan(): Promise<HostedRunPlanSubmission | null>;

  createPhase(input: Omit<HostedRunPhase, 'status'>): Promise<HostedRunPhase>;
  activatePhase(phaseId: string, sessionId: string): Promise<HostedRunPhase>;
  findActivePhaseBySessionId(sessionId: string): Promise<HostedRunPhase | null>;
  submitPhaseHandoff(input: HostedPhaseHandoffSubmission): Promise<HostedPhaseHandoffResult>;
  listPhases(): Promise<HostedRunPhase[]>;

  reportFinding(input: HostedFindingSubmission): Promise<HostedFindingResult>;
  queryInventory(input: Record<string, unknown>): Promise<unknown>;
  queryFindings(input: Record<string, unknown>): Promise<unknown>;
  queryNotes(input: Record<string, unknown>): Promise<unknown>;
  queryRepository(input: HostedRepositoryQuery): Promise<unknown>;
  readRunArtifact(relativePath: string): Promise<Buffer>;
  writeRunArtifact(relativePath: string, content: Buffer | string): Promise<string>;

  /**
   * Code Review surface. Hosted runs execute the same discipline, phases,
   * prompts, skills, and proof contract as the organization product; only the
   * storage substrate differs. Hosts that cannot serve Code Review may leave
   * these undefined and the tools fail closed.
   */
  reportCodeReviewCandidate?(
    input: HostedCodeReviewCandidateSubmission,
  ): Promise<{ findingId: string; created: boolean; state: string; version: number }>;
  validateCodeReviewFinding?(
    input: HostedCodeReviewValidation,
  ): Promise<HostedCodeReviewFinding>;
  queryCodeReviewFindings?(input: {
    state?: 'candidate' | 'validated' | 'rejected';
  }): Promise<{ findings: HostedCodeReviewFinding[]; totalCount: number }>;
  finalizeCodeReviewReport?(input: HostedCodeReviewReportSubmission): Promise<{
    reportId: string;
    findingIds: string[];
    completeness: string;
    contentSha256: string;
  }>;
  queryCodeReviewMemory?(input: HostedCodeReviewMemoryQuery): Promise<unknown>;
  recordCodeReviewMemory?(input: HostedCodeReviewMemoryWrite): Promise<unknown>;
  buildCodeReviewMemorySnapshot?(input: HostedCodeReviewMemoryQuery): Promise<{
    promptText: string;
    counts: Record<string, number>;
  }>;

  markRunPaused(input: {
    reason: string;
    summary?: string;
  }): Promise<void>;
  markRunTerminal(input: {
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    summary?: string;
    failure?: string;
  }): Promise<void>;
}

const hostedRunPorts = new Map<string, HostedRunPersistencePort>();
const hostedRunCapabilities = new Map<string, RuntimeHostCapabilities>();

export const registerHostedRunPersistencePort = (
  port: HostedRunPersistencePort,
  expectedCapabilities?: RuntimeHostCapabilities,
): (() => void) => {
  if (port.kind !== 'research_lab') {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} portKind=${String(port.kind)} required=research_lab`,
    ]);
  }
  const capabilities = resolveRuntimeHostCapabilities(port.runtimeHostCapabilities);
  if (capabilities.hostKind !== port.kind) {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} portKind=${port.kind} capabilityHost=${capabilities.hostKind}`,
    ]);
  }
  if (
    capabilities.toolExecutions.schemaVersion >= 2
    && !supportsDurableToolExecutionLifecycle(port.toolExecutionLifecycle)
  ) {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} lifecycle=toolExecutions schemaVersion=${capabilities.toolExecutions.schemaVersion} adapter=missing_v2_contract`,
    ]);
  }
  if (
    capabilities.modelRequests.schemaVersion >= 2
    && !supportsAtomicModelRequests(port.modelRequestLifecycle)
  ) {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} lifecycle=modelRequests schemaVersion=${capabilities.modelRequests.schemaVersion} adapter=missing_v2_contract`,
    ]);
  }
  if (
    capabilities.modelRequests.schemaVersion >= 3
    && !supportsTransactionalHistory(port.historyTransformationLifecycle)
  ) {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} lifecycle=modelRequests schemaVersion=${capabilities.modelRequests.schemaVersion} adapter=missing_history_transaction_contract`,
    ]);
  }
  if (
    capabilities.providerAttempts.schemaVersion >= 2
    && !supportsDurableProviderAttemptLifecycle(port.providerAttemptLifecycle)
  ) {
    throw new RuntimeHostCapabilityRegistrationError([
      `hostedRun=${port.runId} lifecycle=providerAttempts schemaVersion=${capabilities.providerAttempts.schemaVersion} adapter=missing_v2_contract`,
    ]);
  }
  if (expectedCapabilities) {
    assertRuntimeHostCapabilitiesCompatible(expectedCapabilities, capabilities);
  }
  if (hostedRunPorts.has(port.runId)) {
    throw new Error(`Hosted run persistence is already registered: ${port.runId}`);
  }
  hostedRunPorts.set(port.runId, port);
  hostedRunCapabilities.set(port.runId, capabilities);
  return () => {
    if (hostedRunPorts.get(port.runId) === port) {
      hostedRunPorts.delete(port.runId);
      hostedRunCapabilities.delete(port.runId);
    }
  };
};

export const getHostedRunPersistencePort = (
  runId: string | undefined,
): HostedRunPersistencePort | null => {
  const normalized = runId?.trim();
  return normalized ? hostedRunPorts.get(normalized) ?? null : null;
};

export const getHostedRunRuntimeCapabilities = (context: {
  runId?: string;
  runHost?: string;
}): RuntimeHostCapabilities | null => {
  if (context.runHost !== 'research_lab') return null;
  const normalized = context.runId?.trim();
  return normalized ? hostedRunCapabilities.get(normalized) ?? null : null;
};

export const getHostedRunToolExecutionLifecycle = (context: {
  runId?: string;
  runHost?: string;
}): ToolExecutionPort | null => {
  if (context.runHost !== 'research_lab') return null;
  return getHostedRunPersistencePort(context.runId)?.toolExecutionLifecycle ?? null;
};

export const getHostedRunModelRequestLifecycle = (context: {
  runId?: string;
  runHost?: string;
}): ModelRequestPort | null => {
  if (context.runHost !== 'research_lab') return null;
  return getHostedRunPersistencePort(context.runId)?.modelRequestLifecycle ?? null;
};

export const getHostedRunHistoryTransformationLifecycle = (context: {
  runId?: string;
  runHost?: string;
}): HistoryTransformationPort | null => {
  if (context.runHost !== 'research_lab') return null;
  return getHostedRunPersistencePort(context.runId)?.historyTransformationLifecycle ?? null;
};

export const isHostedRunContext = (context: {
  runId?: string;
  runHost?: string;
}): boolean =>
  Boolean(getHostedRunRuntimeCapabilities(context));
