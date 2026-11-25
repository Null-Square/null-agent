import type { ComplianceFrameworkKey } from "@null-ai/contracts";
export type ComplianceReadinessStatus =
  | "missing"
  | "partial"
  | "passing"
  | "failing"
  | "stale"
  | "accepted_risk"
  | "not_applicable"
  | "not_supported";
export type ComplianceControlVerdict =
  | "pass"
  | "fail"
  | "needs_evidence"
  | "needs_context"
  | "not_attempted"
  | "accepted_risk"
  | "not_applicable"
  | "not_supported";
export type ComplianceControlOutcome =
  | "passed"
  | "failed"
  | "needs_action"
  | "not_checked"
  | "excluded";
export type ComplianceControlCheckBasis =
  | "agent_tested"
  | "agent_reviewed_user_evidence"
  | "agent_reviewed_integration";
export type ComplianceControlCheckReviewDecision =
  | "confirmed"
  | "rejected"
  | "retest_required";
export type ComplianceControlCheckReviewStatus =
  | "unreviewed"
  | ComplianceControlCheckReviewDecision;
export type ComplianceControlRequestStatus =
  | "open"
  | "fulfilled"
  | "reviewed"
  | "insufficient"
  | "contradicted"
  | "cancelled";
export type ComplianceControlRequestType =
  | "evidence"
  | "access"
  | "context"
  | "remediation";
export type ComplianceControlRequestPriority = "low" | "medium" | "high";
export type ComplianceEvidenceSupportLevel =
  | "automated_testable"
  | "manual_evidence_required"
  | "integration_required"
  | "out_of_selected_scope";
export interface ComplianceFrameworkSelection {
  key: ComplianceFrameworkKey;
  label: string;
  sources: Array<
    | "organization_profile"
    | "scope_profile"
    | "organization_context"
    | "scope_roe"
  >;
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
  kind:
    | "finding"
    | "note"
    | "scanner_observation"
    | "inventory"
    | "user_evidence"
    | "accepted_risk"
    | "agent_control_check";
  title: string;
  source: string;
  sourceRef: string;
  lastSeenAt: string | null;
  findingId?: string;
  severity?: string | null;
  validationState?: string | null;
  negative?: boolean;
  mappingSource?:
    | "skill"
    | "cwe"
    | "owasp"
    | "keyword"
    | "note"
    | "scanner"
    | "inventory"
    | "user_evidence"
    | "accepted_risk"
    | "control_check";
  mappingConfidence?: "high" | "medium" | "low";
  skillSlugs?: string[];
  controlCheckVerdict?: "pass" | "fail" | "needs_context" | "not_attempted";
  quality: ComplianceEvidenceQuality;
}
export type ComplianceControlMonitoringState = "monitored" | "excluded";
export interface ComplianceControlMonitoring {
  state: ComplianceControlMonitoringState;
  source: "default" | "explicit";
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
  reviewedByActorType: "agent" | "system" | "operator" | null;
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
  implementationSpec?: "required" | "addressable" | "mixed" | null;
  pciDssRequirement?: string | null;
  pciDssGoal?: string | null;
  pciDssApproach?:
    | "defined"
    | "customized_eligible"
    | "compensating_possible"
    | null;
  pciDssSaqTypes?: string[] | null;
  pciDssCdeScope?:
    | "cde"
    | "connected_to"
    | "security_impacting"
    | "payment_page"
    | "program"
    | null;
  pciDssAccountData?: "chd" | "sad" | "pan" | "none" | null;
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
    verdict: "pass" | "fail" | "needs_context" | "not_attempted";
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
    proof: {
      claim: string;
      evidenceIds: string[];
      replayAttempted: boolean;
      replayArtifact?: string;
      replayReproduced?: boolean;
      notReplayedReason?: string;
    };
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
    kind: "nist_csf_2_0";
    functions: Array<{
      function: string;
      total: number;
      monitored: number;
      directCheckCount: number;
      outcomeCounts: Record<ComplianceControlOutcome, number>;
    }>;
    implementationTier: {
      status: "not_determined";
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
    agentProvenTechnical: {
      total: number;
      passed: number;
      failed: number;
      needsContext: number;
      notAttempted: number;
      stale: number;
    };
    customerEvidence: {
      total: number;
      approved: number;
      missing: number;
      stale: number;
      integrationRequired: number;
      acceptedRisk: number;
    };
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
