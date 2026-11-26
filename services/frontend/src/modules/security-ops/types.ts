/**
 * Shared types for SecurityOps module.
 * Extracted from legacy mocks and API definitions.
 */

import type { ComplianceFrameworkKey } from '@null-ai/contracts';
import type { paths } from '@shared/api';

// --- Risks ---
export type RiskState =
  | 'potential'
  | 'verifying'
  | 'confirmed'
  | 'not_reproduced'
  | 'dismissed'
  | 'resolved'
  | 'accepted';

export type RiskRecordKind = 'finding' | 'exposure';

/**
 * Where a Risk came from. The lifecycle is one; the proof behind it is not,
 * and this is what decides which source panels a detail page shows.
 */
export type RiskSourceKind = 'assessment' | 'code_review' | 'advisory_verification';

export interface RiskListItem {
  key: string;
  id: string;
  recordKind: RiskRecordKind;
  sourceKind?: RiskSourceKind;
  title: string;
  subtitle: string | null;
  severity: string;
  state: RiskState;
  assetValue: string | null;
  cvssScore: number | null;
  kevListed?: boolean;
  backportRisk?: boolean;
  versionConflict?: boolean;
}

export interface RiskSummary {
  total: number;
  open: number;
  openKev: number;
  byState: Record<RiskState, number>;
  bySeverity: Record<string, number>;
  openBySeverity: Record<string, number>;
}

/**
 * The one detail anatomy, for both a canonical Risk and an unpublished code
 * occurrence. `detailKind` says which you are looking at; everything else is
 * the same shape, which is the point — a candidate is not a lesser page, it
 * is the same page before publication.
 */
export type RiskDetailKind = 'canonical_risk' | 'code_occurrence';

export interface CanonicalRiskDetail {
  detailKind: RiskDetailKind;
  /** Null on an unpublished occurrence; set once a review publishes it. */
  canonicalRiskId: string | null;
  id: string;
  sourceKind: RiskSourceKind;
  state: RiskState;
  title: string;
  severity: string;
  summary: string;
  businessImpact: string | null;
  technicalAnalysis: string | null;
  remediation: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  cweIds: string[];
  cveIds: string[];
  scope: { id: string; name: string };
  asset: { id: string; kind: string; value: string } | null;
  repositoryId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Present only for `code_review` Risks. */
  codeOccurrence: {
    id: string;
    runId: string;
    repositoryFullName: string;
    commitSha: string;
    version: number;
    fingerprintVersion: number;
    locations: Array<{
      filePath: string;
      startLine?: number | null;
      endLine?: number | null;
      symbol?: string | null;
    }>;
    changeAttribution: string;
    attributionRationale: string | null;
    fixability: string;
    fixabilityRationale: string | null;
  } | null;
  /** Present only for a confirmed `advisory_verification` Risk. */
  exposureSource: {
    id: string;
    state: string;
    advisoryId: string;
    componentName: string;
    componentVersion: string | null;
    verifiedAt: string | null;
  } | null;
  /** The plan does not include source detail; panels render locked. */
  sourceDetailsRestricted: boolean;
}

// --- Findings ---
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'accepted_risk' | 'accepted';
export type ValidationState =
  | 'unvalidated'
  | 'under_review'
  | 'validated'
  | 'false_positive'
  | 'validation_pending'
  | 'validation_failed';

export interface FindingEndpointContext {
  id: string;
  url: string;
  method: string;
}

export interface FindingServiceContext {
  id: string;
  protocol: string;
  port: number;
  serviceName: string | null;
  product: string | null;
  version: string | null;
}

export interface CodeLocation {
  pathKind: 'repository' | 'workspace';
  repository?: string | null;
  ref?: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  label?: string | null;
  fixBefore?: string;
  fixAfter?: string;
}

export interface FindingEvidenceSummary {
  total: number;
  artifactCount: number;
  downloadableArtifactCount: number;
  structuredHttpCount: number;
  excerptCount: number;
  fileMissingCount: number;
}

export interface ReviewMeta {
  codeLocationCount: number;
  copyFixPromptReady: boolean;
  evidenceSummary: FindingEvidenceSummary;
}

export type FindingDispositionVerificationStatus =
  | 'queued'
  | 'waiting'
  | 'launching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type FindingDispositionVerificationOutcome =
  | 'fixed'
  | 'still_present'
  | 'false_positive'
  | 'validated'
  | 'inconclusive';

export interface FindingDispositionVerification {
  id: string;
  seriesId: string;
  previousVerificationId?: string | null;
  attemptNumber: number;
  findingId: string;
  requestedByUserId: string;
  cancelledByUserId?: string | null;
  requestedState: 'resolved' | 'dismissed';
  reason?: string | null;
  status: FindingDispositionVerificationStatus;
  waitReason?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  runStatus?: string | null;
  runDisplayId?: number | null;
  outcome?: FindingDispositionVerificationOutcome | null;
  outcomeReason?: string | null;
  blockerCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FindingDispositionVerificationHistory {
  active: FindingDispositionVerification | null;
  latest: FindingDispositionVerification | null;
  attempts: FindingDispositionVerification[];
}

export type FindingDispositionVerificationProjection =
  | FindingDispositionVerification
  | {
      active: FindingDispositionVerification | null;
      latest: FindingDispositionVerification | null;
    };

export interface Finding {
  id: string;
  title: string;
  severity: Severity | string;
  state: RiskState;
  assignedTo?: string | null;
  assetId: string | null;
  assetValue: string;
  assetKind: string;
  scopeId: string | null;
  scopeName?: string;
  impactTolerance?: ImpactTolerance;
  summary: string | null;
  description?: string | null;
  businessImpact: string | null;
  technicalAnalysis?: string | null;
  pocDescription?: string | null;
  pocScriptCode?: string | null;
  remediation: string | null;
  assumptions?: string | null;
  fixEffort?: 'trivial' | 'low' | 'medium' | 'high' | null;
  confidence?: number | null;
  evidenceCount?: number | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  cweId: string | null;
  cveId: string | null;
  cweIds?: string[] | null;
  cveIds?: string[] | null;
  owaspCategory?: string | null;
  endpoint?: FindingEndpointContext | null;
  service?: FindingServiceContext | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  codeLocations?: CodeLocation[];
  reviewMeta?: ReviewMeta;
  dispositionVerification?: FindingDispositionVerificationProjection | null;
}

export interface FindingEvent {
  id: string;
  findingId: string;
  userId?: string | null;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: string;
  note?: string;
  createdAt: string;
}

export interface FindingHttpHeader {
  name: string;
  value: string;
  redacted?: boolean;
}

export interface FindingHttpBodyPreview {
  text: string;
  truncated: boolean;
}

export interface FindingHttpExchange {
  source?: 'browser' | 'request_tool' | 'manual' | 'unknown';
  durationMs?: number | null;
  request: {
    method: string;
    url: string;
    contentType?: string | null;
    headers?: FindingHttpHeader[];
    body?: FindingHttpBodyPreview | null;
  };
  response: {
    statusCode: number;
    contentType?: string | null;
    headers?: FindingHttpHeader[];
    body?: FindingHttpBodyPreview | null;
  };
}

export interface FindingEvidence {
  id?: string;
  findingId?: string;
  kind?: 'artifact' | 'http_exchange';
  displayPath?: string;
  path: string;
  label?: string;
  excerpt?: string;
  fileMissing?: boolean;
  sessionId?: string;
  artifactId?: string;
  downloadPath?: string;
  createdAt?: string;
  http?: FindingHttpExchange;
}

export interface InventoryEvidence {
  path: string;
  label?: string;
  excerpt?: string;
  fileMissing?: boolean;
}

// --- Assets ---
// `repository` is written by CodeReviewMemoryService when a review runs, and
// AssetKindBadge already renders it — the union was simply missing the value,
// which is what made it look like a repository is not an asset.
export type AssetKind = 'domain' | 'ip' | 'cloud_resource' | 'repository';
export type AssetFocusLabel = 'low' | 'medium' | 'high' | 'critical';

export interface AssetFocus {
  score: number;
  label: AssetFocusLabel;
  reasons: string[];
}

export interface Asset {
  id: string;
  kind: AssetKind | string;
  value: string;
  tags: string[];
  scopeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScannedAt?: string | null;
  findingCount?: number;
  serviceCount?: number;
  endpointCount?: number;
  observationCount?: number;
  subdomainCount?: number;
  focus?: AssetFocus | null;
}

export interface AssetEndpoint {
  id: string;
  assetId: string;
  serviceId: string | null;
  url: string;
  method: string;
  statusCode?: number | null;
  title?: string | null;
  evidence: InventoryEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetSubdomain {
  id: string;
  assetId: string;
  hostname: string;
  resolvedIps: string[];
  evidence: InventoryEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetTechFingerprint {
  id: string;
  assetId: string;
  product: string;
  version: string | null;
  category: string | null;
  confidence: number | null;
  evidence: InventoryEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryService {
  id: string;
  assetId: string;
  protocol: string;
  port: number;
  serviceName: string | null;
  product: string | null;
  version: string | null;
  evidence: InventoryEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryNote {
  id: string;
  assetId: string | null;
  scopeId: string;
  sessionId?: string | null;
  ntype: string;          // e.g. 'dns.subdomain', 'http.endpoint', 'tls.certificate'
  title: string | null;
  data: Record<string, unknown>;
  confidence: number | null;
  evidence: InventoryEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetScanCoverage {
  status: 'completed' | 'blocked' | 'unknown';
  assessedAt: string;
  endpointsDiscovered: number | null;
  findingsCreated: number | null;
  technologiesDetected: number | null;
}

export interface PentestPlan {
  recommended_next_task: string;
  rationale: string;
  priority_targets?: string[];
  confidence: number;
  chain?: string[];
}

// --- Runs ---
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type RunPauseReason = 'manual' | 'approval' | 'credits' | 'runner' | 'system';
export type RunInteractionType = 'none' | 'plan_approval';
export type RunTrigger = 'manual' | 'scheduled' | 'event';
export type ExecutionTarget = 'cloud' | 'scope_runner';
export type RunWorkflowDiscipline = 'pentest' | 'compliance' | 'code_review';
export type CodeReviewOperation = 'repository_review' | 'pull_request_review' | 'finding_fix';

export interface CodeReviewContext {
  operation: CodeReviewOperation;
  repository: {
    provider: 'github';
    installationId: string;
    repositoryId: string;
    fullName: string;
    visibility: 'private' | 'public' | 'internal' | 'unknown';
    immutableCommitSha: string;
    requestedRef?: string;
    defaultBranch: string;
  };
  reviewScope: {
    mode: 'repository' | 'paths' | 'pull_request';
    allowedPaths: string[];
    excludedPaths: string[];
    contextReadPolicy: string;
    manifestHash: string;
    completeness: 'complete' | 'partial' | 'blocked';
  };
  pullRequest?: {
    number: number;
    url: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    diffManifestHash: string;
    deliveryId?: string;
  };
  findingFix?: {
    findingId: string;
    findingVersion: number;
    vulnerableCommitSha: string;
    approvedPatchHash?: string;
    parentReviewRunId: string;
  };
  policySnapshot: {
    version: string;
    toolProfile: string;
    pathPolicy: string;
    networkPolicy: string;
    publicationPolicy: string;
  };
}

export type CodeReviewFindingState = 'candidate' | 'validated' | 'rejected';
export type CodeReviewFixability = 'fixable' | 'not_fixable' | 'uncertain';
export type CodeReviewChangeAttribution =
  | 'repository_scope'
  | 'introduced'
  | 'exposed'
  | 'worsened'
  | 'pre_existing_context';

export interface CodeReviewSourceLocation {
  repositoryId: string;
  repositoryFullName: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceExcerpt: string;
  sourceExcerptSha256: string;
  sourceOriginalSha256?: string;
}

export interface CodeReviewFinding {
  id: string;
  organizationId: string;
  scopeId: string;
  runId: string;
  repositoryId: string;
  repositoryFullName: string;
  commitSha: string;
  firstSeenCommitSha: string;
  lastSeenCommitSha: string;
  supersedesFindingId: string | null;
  /**
   * Set once a complete, finalized default-branch review publishes this
   * occurrence as a canonical Risk. Absent for candidates — a pull-request or
   * partial review produces source proof, not a customer Risk, so there is
   * nothing canonical to open yet.
   */
  riskId?: string | null;
  fingerprint: string;
  version: number;
  state: CodeReviewFindingState;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence: number;
  category: string;
  title: string;
  summary: string;
  impact: string;
  remediation: string;
  locations: CodeReviewSourceLocation[];
  changeAttribution: CodeReviewChangeAttribution;
  attributionRationale: string | null;
  validation: {
    outcome: 'validated' | 'rejected';
    rationale: string;
    validatedBySessionId: string;
    validatedAt: string;
  } | null;
  fixability: CodeReviewFixability;
  fixabilityRationale: string | null;
  expectedFiles: string[];
  validationPlan: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CodeReviewReport {
  id: string;
  runId: string;
  executiveSummary: string;
  scopeSummary: string;
  markdown: string;
  findingIds: string[];
  limitations: string[];
  completeness: 'complete' | 'partial' | 'blocked';
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodeReviewRunBundle {
  context: CodeReviewContext;
  findings: CodeReviewFinding[];
  report: CodeReviewReport | null;
  fixRequests: CodeReviewFixRequest[];
  publication: CodeReviewGithubPublication | null;
}

export interface CodeReviewGithubPublication {
  id: string;
  status:
    | 'queued'
    | 'processing'
    | 'retryable_failed'
    | 'published'
    | 'suppressed'
    | 'permanent_failed';
  remoteCheckUrl: string | null;
  annotationsEnabled: boolean;
  attemptCount: number;
  lastError: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface CodeReviewFixRequest {
  id: string;
  organizationId: string;
  findingId: string;
  requestedByUserId: string;
  findingVersion: number;
  vulnerableCommitSha: string;
  status:
    | 'requested'
    | 'generating'
    | 'preview_ready'
    | 'approved'
    | 'published'
    | 'failed'
    | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface RunUsageTotals {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  entries: number;
}

export interface RunUsagePhaseSummary extends RunUsageTotals {
  sessionId: string;
}

export interface RunUsageSummary {
  total: RunUsageTotals;
  planner: RunUsagePhaseSummary | null;
  executor: RunUsagePhaseSummary | null;
}

export interface Run {
  id: string;
  displayId?: string;
  organizationId: string;
  scopeId: string;
  scopeName?: string;
  activeSessionId?: string | null;
  sessionId?: string | null;
  plannerSessionId?: string | null;
  executorSessionId?: string | null;
  modelId?: string | null;
  modelCategory?: string | null;
  title?: string | null;
  goal: string;
  plan?: string | null;
  executionTarget?: ExecutionTarget;
  workflowDiscipline?: RunWorkflowDiscipline;
  codeReviewOperation?: CodeReviewOperation | null;
  codeReviewContext?: CodeReviewContext | null;
  runnerId?: string | null;
  status: RunStatus | string;
  pauseReason?: RunPauseReason | null;
  interactionType?: RunInteractionType;
  awaitingPlanApproval?: boolean;
  trigger: RunTrigger | string;
  impactTolerance?: ImpactTolerance;
  findingsDiscovered?: number;
  inventoryAdded?: number;
  inventoryChanges?: string;
  runnerName?: string;
  usageSummary?: RunUsageSummary;
  queuedAt?: string | null;
  capacityWaitReason?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt?: string;
}

export interface RunInventoryDiff {
  added: Asset[];
  removed: Asset[];
}

// --- Compliance Readiness ---
export type { ComplianceFrameworkKey };
export type ComplianceReadinessStatus =
  | 'missing'
  | 'partial'
  | 'passing'
  | 'failing'
  | 'stale'
  | 'accepted_risk'
  | 'not_applicable'
  | 'not_supported';

export type ComplianceControlVerdict = 'pass' | 'fail' | 'needs_evidence' | 'needs_context' | 'not_attempted' | 'accepted_risk' | 'not_applicable' | 'not_supported';
export type ComplianceControlOutcome = 'passed' | 'failed' | 'needs_action' | 'not_checked' | 'excluded';
export type ComplianceControlCheckBasis = 'agent_tested' | 'agent_reviewed_user_evidence' | 'agent_reviewed_integration';
export type ComplianceControlCheckReviewDecision = 'confirmed' | 'rejected' | 'retest_required';
export type ComplianceControlCheckReviewStatus = 'unreviewed' | ComplianceControlCheckReviewDecision;
export type ComplianceControlRequestStatus =
  | 'open'
  | 'fulfilled'
  | 'reviewed'
  | 'insufficient'
  | 'contradicted'
  | 'cancelled';
export type ComplianceControlRequestType = 'evidence' | 'access' | 'context' | 'remediation';
export type ComplianceControlRequestPriority = 'low' | 'medium' | 'high';
export type ComplianceEvidenceSupportLevel =
  | 'automated_testable'
  | 'manual_evidence_required'
  | 'integration_required'
  | 'out_of_selected_scope';

export interface ComplianceFrameworkSelection {
  key: ComplianceFrameworkKey;
  label: string;
  sources: Array<'organization_profile' | 'scope_profile' | 'organization_context' | 'scope_roe'>;
}

export interface ComplianceEvidenceQuality {
  traceable: boolean;
  fresh: boolean;
  trustedSource: boolean;
  scopeComplete: boolean;
  humanReviewed: boolean;
  score: number;
}

export interface ComplianceReadinessEvidence {
  id: string;
  kind: 'finding' | 'note' | 'scanner_observation' | 'inventory' | 'user_evidence' | 'accepted_risk' | 'agent_control_check';
  title: string;
  source: string;
  sourceRef: string;
  lastSeenAt: string | null;
  findingId?: string;
  severity?: string | null;
  validationState?: string | null;
  negative?: boolean;
  mappingSource?: 'skill' | 'cwe' | 'owasp' | 'keyword' | 'note' | 'scanner' | 'inventory' | 'user_evidence' | 'accepted_risk' | 'control_check';
  mappingConfidence?: 'high' | 'medium' | 'low';
  skillSlugs?: string[];
  controlCheckVerdict?: 'pass' | 'fail' | 'needs_context' | 'not_attempted';
  quality: ComplianceEvidenceQuality;
}

export type ComplianceControlMonitoringState = 'monitored' | 'excluded';

export interface ComplianceControlHistoryEvent {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  changes: {
    state?: ComplianceControlMonitoringState | null;
    exclusionReason?: string | null;
    assignedToUserId?: string | null;
  } | null;
  createdAt: string;
}

export interface ComplianceControlMonitoring {
  state: ComplianceControlMonitoringState;
  source: 'default' | 'explicit';
  exclusionReason: string | null;
  updatedAt: string | null;
}

export interface ComplianceControlAssignment {
  assignedToUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: string | null;
}

export interface ComplianceControlRequest {
  id: string;
  requestType: ComplianceControlRequestType;
  priority: ComplianceControlRequestPriority;
  status: ComplianceControlRequestStatus;
  title: string;
  reason: string;
  requestedEvidence: string[];
  remediationHint: string | null;
  assignedToUserId: string | null;
  dueAt: string | null;
  fulfillmentEvidenceItemId: string | null;
  fulfillmentNote: string | null;
  fulfilledByUserId: string | null;
  fulfilledAt: string | null;
  reviewControlCheckId: string | null;
  reviewNote: string | null;
  reviewedByActorType: 'agent' | 'system' | 'operator' | null;
  reviewedByActorId: string | null;
  reviewedAt: string | null;
  nextReverificationAt: string | null;
  runId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceReadinessControl {
  id: string;
  title: string;
  theme: string;
  supportLevel: ComplianceEvidenceSupportLevel;
  implementationSpec?: 'required' | 'addressable' | 'mixed' | null;
  pciDssRequirement?: string | null;
  pciDssGoal?: string | null;
  pciDssApproach?: 'defined' | 'customized_eligible' | 'compensating_possible' | null;
  pciDssSaqTypes?: string[] | null;
  pciDssCdeScope?: 'cde' | 'connected_to' | 'security_impacting' | 'payment_page' | 'program' | null;
  pciDssAccountData?: 'chd' | 'sad' | 'pan' | 'none' | null;
  status: ComplianceReadinessStatus;
  verdict: ComplianceControlVerdict;
  outcome: ComplianceControlOutcome;
  reasonCode: string;
  basis?: ComplianceControlCheckBasis | null;
  verdictReason: string;
  score: number;
  rationale: string;
  evidence: ComplianceReadinessEvidence[];
  gaps: string[];
  coverageLimitations: string[];
  catalogRef: string;
  proofObligation: { id: string; statement: string } | null;
  requiredEvidence: string[];
  nextAction: string;
  evidenceFreshness: { freshestAt: string | null; stale: boolean };
  monitoring: ComplianceControlMonitoring;
  assignment: ComplianceControlAssignment;
  actionRequests: ComplianceControlRequest[];
  controlChecks: Array<{
    id: string;
    basis?: ComplianceControlCheckBasis;
    verdict: 'pass' | 'fail' | 'needs_context' | 'not_attempted';
    reasonCode: string;
    reason: string;
    proofObligationId: string;
    method: string;
    toolName: string | null;
    skillSlug: string | null;
    targetRef: string;
    evidenceRefs: string[];
    findingIds: string[];
    artifactIds: string[];
    proof: { claim: string; evidenceIds: string[]; replayAttempted: boolean; replayArtifact?: string; replayReproduced?: boolean; notReplayedReason?: string };
    limitations: string[];
    freshUntil: string;
    runId: string;
    sessionId: string;
    createdAt: string;
    fresh: boolean;
    eligible: boolean;
    reviewStatus: ComplianceControlCheckReviewStatus;
    latestReview: {
      id: string;
      reviewerUserId: string | null;
      decision: ComplianceControlCheckReviewDecision;
      reasonCode: string;
      note: string;
      createdAt: string;
    } | null;
    reviewHistory: Array<{
      id: string;
      reviewerUserId: string | null;
      decision: ComplianceControlCheckReviewDecision;
      reasonCode: string;
      note: string;
      createdAt: string;
    }>;
  }>;
}

export interface ComplianceFrameworkReadiness {
  key: ComplianceFrameworkKey;
  label: string;
  selected: boolean;
  supported: boolean;
  score: number;
  statusCounts: Record<ComplianceReadinessStatus, number>;
  outcomeCounts: Record<ComplianceControlOutcome, number>;
  verdictCounts: Record<ComplianceControlVerdict, number>;
  controls: ComplianceReadinessControl[];
  gaps: string[];
  coverageLimitations: string[];
  frameworkProfile?: {
    kind: 'nist_csf_2_0';
    functions: Array<{
      function: string;
      total: number;
      monitored: number;
      directCheckCount: number;
      outcomeCounts: Record<ComplianceControlOutcome, number>;
    }>;
    implementationTier: {
      status: 'not_determined';
      tier: null;
      reason: string;
    };
  } | null;
}

export interface ComplianceReadinessResponse {
  generatedAt: string;
  organizationId: string;
  scopeId: string | null;
  runId: string | null;
  selectedFrameworks: ComplianceFrameworkSelection[];
  supportedFrameworks: ComplianceFrameworkKey[];
  frameworks: ComplianceFrameworkReadiness[];
  latestCompletedRunId: string | null;
  scorecards: {
    agentProvenTechnical: { total: number; passed: number; failed: number; needsContext: number; notAttempted: number; stale: number };
    customerEvidence: { total: number; approved: number; missing: number; stale: number; integrationRequired: number; acceptedRisk: number };
    outcomes: Record<ComplianceControlOutcome, number>;
  };
  reviewSummary?: {
    total: number;
    unreviewed: number;
    confirmed: number;
    rejected: number;
    retestRequired: number;
  };
  reportRequest: {
    canStart: boolean;
    scopeId: string | null;
    latestCompletedRunId: string | null;
    reason: string | null;
  };
}

export interface ComplianceReportHistoryItem {
  runId: string;
  displayId: string;
  title: string;
  framework: ComplianceFrameworkKey;
  frameworkLabel: string;
  source: string;
  sourceRunId: string | null;
  status: RunStatus | string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ComplianceEvidenceReviewStatus = 'unreviewed' | 'expired';
export type ComplianceEvidenceSourceType = 'user_upload' | 'user_attestation' | 'agent_finding' | 'integration';
export type ComplianceEvidenceType =
  | 'policy'
  | 'access_review'
  | 'risk_register'
  | 'incident_record'
  | 'continuity_exercise'
  | 'vendor_review'
  | 'change_approval'
  | 'training_record'
  | 'system_export'
  | 'other';

export interface ComplianceEvidenceMapping {
  id: string;
  evidenceItemId: string;
  organizationId: string;
  scopeId: string | null;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  mappingSource: 'user_declared' | 'system_suggested';
  confidence: 'low' | 'medium' | 'high';
  rationale: string | null;
  citationAnchors?: Array<{
    page?: number | null;
    section?: string | null;
    line?: number | null;
    chunkId?: string | null;
    excerpt?: string | null;
    excerptSha256?: string | null;
  }>;
  createdBy: string | null;
  createdAt: string;
}

export interface ComplianceEvidenceItem {
  id: string;
  organizationId: string;
  scopeId: string | null;
  title: string;
  description: string | null;
  sourceType: ComplianceEvidenceSourceType;
  evidenceType: ComplianceEvidenceType;
  owner: string | null;
  status: ComplianceEvidenceReviewStatus;
  artifact: {
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
    storageRef?: string | null;
    sourceRef?: string | null;
  };
  metadata: Record<string, unknown>;
  observationStartedAt: string | null;
  observationEndedAt: string | null;
  validUntil: string | null;
  uploadedBy: string | null;
  reviewNote: string | null;
  agentReview?: {
    status: 'reviewed' | 'needs_more_evidence';
    checkId: string;
    frameworkKey: ComplianceFrameworkKey;
    controlId: string;
    verdict: 'pass' | 'fail' | 'needs_context' | 'not_attempted';
    reviewedAt: string;
    reason: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  mappings: ComplianceEvidenceMapping[];
}

export interface ComplianceMissingEvidenceItem {
  frameworkKey: ComplianceFrameworkKey;
  frameworkLabel: string;
  controlId: string;
  title: string;
  theme: string;
  supportLevel: ComplianceEvidenceSupportLevel;
  status: ComplianceReadinessStatus;
  score: number;
  gap: string;
  mappedEvidenceCount: number;
  approvedEvidenceCount: number;
  acceptedRiskCount: number;
}

// --- Scopes ---
export type ScopeStatus = 'active' | 'archived' | 'pending';
export type ScopeExecutionNetwork = 'external' | 'internal';
export type ImpactTolerance = 'non_destructive' | 'poc' | 'full';
export type TestingPosture = 'black-box' | 'gray-box' | 'white-box';

export interface ScopeAttachedRunnerSummary {
  id: string;
  name: string;
  status: RunnerStatus | string;
  type: RunnerType;
}

export interface Scope {
  id: string;
  name: string;
  description?: string | null;
  executionNetwork?: ScopeExecutionNetwork | string;
  attachedRunner?: ScopeAttachedRunnerSummary | null;
  mission?: string | null;
  impactTolerance?: ImpactTolerance;
  complianceFrameworks?: ComplianceFrameworkKey[];
  targetCount?: number;
  verifiedTargetCount?: number;
  lastRunAt?: string | null;
  status: ScopeStatus | string;
  whiteboxEnabled: boolean;
  connectedRepoCount: number;
  /** Where Code Review reads this scope's code from: a folder or a git URL. */
  codeSource?: CodeSource | null;
  accessMaterialCount?: number;
  exclusions?: ScopeExclusion[];
  createdAt?: string;
  updatedAt?: string;
}

/** GET /api/app/scopes/:id/code-source, as the API sends it. */
export type CodeSource = NonNullable<
  paths['/api/app/scopes/{id}/code-source']['get']['responses'][200]['content']['application/json']['codeSource']
>;

export interface ScopeExclusion {
  id: string;
  type: 'domain' | 'cidr';
  value: string;
  createdAt?: string;
}

// --- Access Materials (PRD-11) ---
export type AccessMaterialKind = 'login_credential' | 'custom_header' | 'bearer_token' | 'cookie_session';

export type ScopeAccessMaterial = {
  id: string;
  scopeId: string;
  kind: AccessMaterialKind;
  label: string;
  username: string | null;
  headerName: string | null;
  notes: string | null;
  appliesToHosts: string[];
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAccessMaterialPayload =
  | {
      kind: 'login_credential';
      label?: string;
      username: string;
      password: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'custom_header';
      label?: string;
      headerName: string;
      headerValue: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'bearer_token';
      label?: string;
      token: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'cookie_session';
      label?: string;
      cookieHeader: string;
      notes?: string;
      appliesToHosts?: string[];
    };

export type UpdateAccessMaterialPayload =
  | {
      kind: 'login_credential';
      label?: string;
      username?: string;
      password?: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'custom_header';
      label?: string;
      headerName?: string;
      headerValue?: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'bearer_token';
      label?: string;
      token?: string;
      notes?: string;
      appliesToHosts?: string[];
    }
  | {
      kind: 'cookie_session';
      label?: string;
      cookieHeader?: string;
      notes?: string;
      appliesToHosts?: string[];
    };

export type ScopeTargetType = 'domain' | 'cidr';
export type ScopeTargetVerificationMethod =
  | 'dns_txt'
  | 'http_well_known'
  | 'manual_review'
  | 'none'
  | 'legacy_auto'
  | 'connected_site'
  | 'wordpress_plugin';

export interface ScopeTarget {
  id: string;
  scopeId: string;
  type: string;
  value: string;
  verified: boolean;
  verificationMethod?: ScopeTargetVerificationMethod | null;
  verificationToken?: string | null;
  verifiedAt: string | null;
}

// --- Organization ---
export interface Organization {
  id: string;
  name: string;
  slug: string;
  operationalContext: string | null;
}

export interface OrganizationMember {
  userId: string;
  email: string;
  role: string;
  fullName: string | null;
}

// --- Audit Logs ---
/** One row of GET /api/app/audit-logs (the audit_logs table, createdAt as ISO). */
export interface AuditLog {
  id: string;
  organizationId: string;
  actorId: string;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// --- Runners ---
// Keep strict private-runner UX while tolerating unexpected legacy backend values.
export type RunnerType = 'private' | (string & {});
export type RunnerStatus = 'online' | 'busy' | 'offline' | 'quarantined';

export interface Runner {
  id: string;
  organizationId: string;
  name: string;
  type: RunnerType;
  status: RunnerStatus;
  platform: string | null;
  architecture: string | null;
  ipAddress: string | null;
  version: string | null;
  lastHeartbeatAt: string | null;
  metadata: Record<string, string>;
  assignedScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RunnerScopeInfo {
  id: string;
  name: string;
  status: string;
}

/** A run row as GET /api/app/runners/:id lists it: displayId is the raw serial number. */
export type RunnerRecentRun = Omit<Run, 'displayId'> & { displayId: number };

export interface RunnerDetail extends Runner {
  scopes: RunnerScopeInfo[];
  recentRuns: RunnerRecentRun[];
}

export interface DeployRunnerResponse {
  runner: Runner;
  token?: string;
  installCommand?: string;
}

// --- Automations ---
export type AutomationTrigger = 'scheduled' | 'continuous' | 'event';
export type AutomationEventType =
  | 'finding_created'
  | 'finding_status_changed'
  | 'run_completed'
  | 'asset_discovered'
  | 'runner_offline';

export type AutomationTriggerConfig =
  | { type: 'scheduled'; cron: string; timezone: string }
  | { type: 'continuous'; intervalMinutes: number }
  | { type: 'event'; eventType: AutomationEventType; filter?: Record<string, string> };

export interface Automation {
  organizationId?: string;
  id: string;
  name: string;
  description?: string | null;
  scopeId: string;
  scopeName?: string;
  modelId?: string | null;
  modelCategory?: string | null;
  workflowDiscipline: RunWorkflowDiscipline;
  complianceFrameworkKey: ComplianceFrameworkKey | null;
  executionTarget: ExecutionTarget;
  goal: string;
  triggerType: AutomationTrigger;
  triggerConfig: AutomationTriggerConfig;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  deferredReason?: string | null;
  deferredAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AutomationHistoryEntry {
  id: string;
  runId: string;
  triggeredAt: string;
  triggerReason: string | null;
  runStatus: string | null;
  runDisplayId: number | null;
  runCreatedAt: string | null;
}

export interface AutomationDetail extends Automation {
  runs: AutomationHistoryEntry[];
}

export type DashboardSecurityGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F';
export type DashboardSecurityConfidence = 'low' | 'medium' | 'high';

export interface DashboardSecurityPosture {
  grade: DashboardSecurityGrade;
  numericScore: number;
  confidence: DashboardSecurityConfidence;
  methodology: 'academic_plus_minus';
  trend: 'improving' | 'stable' | 'regressing';
  validationCoverage: number | null;
  remediationVelocity: number | null;
  runsInWindow: number;
  rationale: string[];
  openFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

export interface DashboardSummary {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  validatedCount: number;
  openCount: number;
  resolvedCount: number;
  totalAssets: number;
  totalScopes: number;
  activeRuns: number;
  runnersOnline: number;
  runnersTotal: number;
  activeAutomations: number;
  nextScheduledRun: string | null;
  securityPosture?: DashboardSecurityPosture | null;
}

// --- Run Activity Redesign (PRD-04A) ---
export type RunPhaseSymbol =
  | 'recon'
  | 'enumeration'
  | 'validation'
  | 'exploitation'
  | 'evidence'
  | 'control_assessment'
  | 'reporting'
  | 'review_mapping'
  | 'review_analysis'
  | 'review_validation'
  | 'review_reporting';
export type RunPhaseDisplayStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface RunPhaseTimelineEntry {
  phase: RunPhaseSymbol;
  label: string;
  ordinal: number;
  status: RunPhaseDisplayStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  reason?: string | null;
  validationProgress?: { total: number; completed: number; pending: number };
}

export interface RunPhaseSessionEntry {
  id: string;
  phase: RunPhaseSymbol;
  label: string;
  ordinal: number;
  status: RunPhaseDisplayStatus;
  rawStatus: string;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  reason?: string | null;
}

// Backwards-compatible aliases (deprecated; remove after UI migration completes).
export type AttackPhaseSymbol = RunPhaseSymbol;
export type AttackPhase = RunPhaseTimelineEntry;

export interface RunActivitySummary {
  totals: {
    requests: number;
    uniqueHosts: number;
    uniqueEndpoints: number;
    failures: number;
    blockedActions: number;
    averageDurationMs: number | null;
  };
  distributions: {
    statusCodes: Array<{ key: string; label: string; count: number; percentage: number }>;
    methods: Array<{ key: string; label: string; count: number; percentage: number }>;
    responseTimes: Array<{ key: string; label: string; count: number; percentage: number }>;
    contentTypes: Array<{ key: string; label: string; count: number; percentage: number }>;
  };
  timeline: {
    buckets: Array<{ ts: string; hosts: Array<{ host: string; count: number }> }>;
    hosts: string[];
  };
  topEndpoints: Array<{
    id: string;
    host: string;
    path: string;
    requestCount: number;
    failureCount: number;
    methods: Array<{ method: string; count: number }>;
    statusBand: '2xx' | '3xx' | '4xx' | '5xx' | 'mixed' | 'none';
  }>;
  topHosts: Array<{
    host: string;
    requestCount: number;
    failureCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  }>;
  discoveries: Array<{
    category: string;
    key: string;
    summary: string;
    confidence: number;
    ts: string;
    outcome: 'success' | 'failure' | 'neutral';
  }>;
  authSurface: Array<{
    host: string;
    path: string;
    methods: string[];
    statusCodes: number[];
    requestCount: number;
  }>;
  securityHeaders: {
    totalEndpoints: number;
    missingHeaders: Array<{ header: string; missingCount: number; percentage: number }>;
  };
  coverage: {
    source: 'action.summary' | 'action.summary+http_capture';
    limitations: string[];
  };
  phases: RunPhaseTimelineEntry[];
  generatedAt: string;
}
export type DashboardOverviewV2 = {
  window: { days: number; from: string; to: string };
  posture: {
    criticalOpen: number;
    highOpen: number;
    activeBacklog: number;
    resolvedInWindow: number;
    mttrHours: number | null;
    runsInWindow: number;
    trajectory: 'improving' | 'stable' | 'regressing';
  };
  securityPosture: DashboardSecurityPosture;
  activeRuns: number;
  recentRuns: Array<{
    id: string;
    displayId: number | null;
    title: string | null;
    goal: string | null;
    status: string;
    createdAt: string | null;
  }>;
  lifecycle: {
    trend: Array<{ date: string; created: number; resolved: number; active: number }>;
    validationRate: number;
    remediationVelocity: number | null;
    backlogDelta: number;
  };
  cadence: {
    heatmap: Array<{ date: string; count: number }>;
    statusMix: Record<string, number>;
    triggerMix: Record<string, number>;
    nextScheduledRun: string | null;
  };
  assets: {
    topAffected: Array<{
      assetId: string;
      assetValue: string;
      weightedRisk: number;
      openCount: number;
      criticalCount: number;
      highCount: number;
      lastSeenAt: string | null;
    }>;
  };
  categories: {
    owasp: Array<{ category: string; count: number }>;
  };
  readiness: {
    targetState: 'missing' | 'pending' | 'verified';
    runnerState: 'not_required' | 'missing' | 'offline' | 'ready';
    accessMaterialsCount: number;
    connectedRepoCount: number;
    whiteboxEnabled: boolean;
    activeAutomations: number;
  };
  latestActivity: {
    runId: string;
    title: string;
    createdAt: string;
    totals: {
      requests: number;
      uniqueHosts: number;
      uniqueEndpoints: number;
      blockedActions: number;
    };
  } | null;
};


// ---------------------------------------------------------------------------
// Threat Watch — exposures
// ---------------------------------------------------------------------------

/**
 * An exposure is a *claim*, not a proven finding: a component version we
 * observed falls inside an advisory's affected range. Verification is what
 * turns it into a finding, so the states below are deliberately distinct from
 * finding statuses and must not be rendered as if they were the same thing.
 */
export type ExposureMatchState =
  | 'candidate'
  | 'notified'
  | 'verifying'
  | 'confirmed'
  | 'not_reproduced'
  | 'inconclusive'
  | 'dismissed'
  | 'stale'
  | 'resolved';

export type ExposureMatchConfidence = 'exact_version';

export type ComponentEvidenceTier =
  | 'observed_exact'
  | 'attested_exact'
  | 'reported_exact'
  | 'absent';

export type ExposureMatch = {
  id: string;
  /** Canonical finding created from this exposure, when one exists. */
  findingId: string | null;
  state: ExposureMatchState;
  matchConfidence: ExposureMatchConfidence | null;
  evidenceTier: ComponentEvidenceTier | null;
  evidenceSource: string | null;
  priorityScore: number | null;
  inventoryObservedAt: string | null;
  firstSeenAt: string | null;
  advisoryId: string;
  severity: string | null;
  cvssScore: number | null;
  /** Listed in CISA KEV: actively exploited in the wild. Outranks CVSS. */
  kevListed: boolean | null;
  epssPercentile: number | null;
  componentName: string;
  componentVersion: string | null;
  /** The distro may have patched without changing the version string. */
  backportRisk: boolean | null;
  /** Two sources disagreed about the installed version. */
  versionConflict: boolean | null;
  assetValue: string;
};

export type ExposureMatchListResponse = { matches: ExposureMatch[] };

export type StartExposureVerificationResponse = {
  matchId: string;
  runId: string;
  /** True when an in-flight verification was returned instead of a new one. */
  alreadyRunning: boolean;
};

export type ExposureMatchEvent = {
  id: string;
  matchId: string;
  type: string;
  fromState: ExposureMatchState | null;
  toState: ExposureMatchState | null;
  actorUserId: string | null;
  note: string | null;
  createdAt: string;
};

/**
 * The detail payload.
 *
 * Returned as the raw joined rows rather than a flattened shape, so the page
 * can show the advisory's own wording — summary, CWEs, publication dates —
 * separately from what we observed on the customer's asset. Conflating the two
 * is how a tool ends up presenting a vendor's claim as its own finding.
 */
export type ExposureMatchDetail = {
  match: {
    id: string;
    organizationId: string;
    assetId: string;
    componentId: string;
    advisoryId: string;
    matchConfidence: ExposureMatchConfidence | null;
    versionEvaluated: string | null;
    evidenceTier: ComponentEvidenceTier | null;
    evidenceSource: string | null;
    priorityScore: number | null;
    state: ExposureMatchState;
    inventoryObservedAt: string | null;
    verificationRunId: string | null;
    findingId: string | null;
    stateReason: string | null;
    notifiedAt: string | null;
    verifiedAt: string | null;
    resolvedAt: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
  advisory: {
    id: string;
    canonicalId: string;
    canonicalSource: string;
    cveId: string | null;
    title: string | null;
    summary: string | null;
    publishedAt: string | null;
    lastModifiedAt: string | null;
    severity: string | null;
    cvssV31Vector: string | null;
    cvssV31Score: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListed: boolean | null;
    kevAddedAt: string | null;
    cweIds: string[] | null;
  };
  component: {
    id: string;
    ecosystem: string;
    componentKey: string;
    displayName: string;
    resolvedVersion: string | null;
    resolvedVersionScheme: string | null;
    resolvedEvidenceTier: ComponentEvidenceTier | null;
    resolvedObservationSource: string | null;
    backportRisk: boolean | null;
    versionConflict: boolean | null;
  };
  assetValue: string;
  observations: Array<{
    id: string;
    source: string;
    port: number | null;
    versionRaw: string | null;
    versionNormalized: string | null;
    confidence: number | null;
    evidence: Array<{ label: string | null; excerpt: string | null }>;
    observedAt: string;
  }>;
  affectedRanges: Array<{
    id: string;
    versionScheme: string;
    introducedVersion: string | null;
    introducedInclusive: boolean | null;
    fixedVersion: string | null;
    fixedInclusive: boolean | null;
  }>;
  override: {
    id: string;
    action: 'not_present' | 'version_correction';
    correctedVersion: string | null;
    reason: string | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
};

export type ExposureMatchDetailResponse = ExposureMatchDetail & {
  events: ExposureMatchEvent[];
};

/**
 * The customer's authorization statement.
 *
 * Evidence, never a gate: nothing here is consulted to decide whether a run may
 * start. Target verification remains the single activation state. There is
 * deliberately no status, expiry or `current` flag to read.
 */
export type ScopeRule = { type: 'domain' | 'cidr'; value: string };

export type ScopeContract = {
  roots: ScopeRule[];
  exclusions: ScopeRule[];
  impactTolerance: 'non_destructive' | 'poc' | 'full';
  executionNetwork: string;
};
