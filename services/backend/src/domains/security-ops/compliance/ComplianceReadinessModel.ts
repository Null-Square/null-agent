import {
  FRAMEWORK_LABELS,
  FRAMEWORK_REGISTRY,
  SUPPORTED_FRAMEWORKS,
  type ComplianceFrameworkKey,
  type ControlDefinition,
  type EvidenceSupportLevel,
  type FrameworkDefinition,
} from '@/domains/security-ops/compliance/frameworks';
import {
  COMPLIANCE_FRAMEWORK_ORDER,
  normalizeComplianceFrameworkKeys,
} from '@/domains/security-ops/compliance/profile';
import {
  defaultMonitoringStateForControl,
  SYSTEM_EXCLUSION_REASON,
  type ComplianceControlAssignmentView,
  type ComplianceControlMonitoringSource,
  type ComplianceControlMonitoringState,
  type ComplianceControlMonitoringView,
} from './ComplianceControlMonitoring';
import type { RiskState } from '@/db/schema';
import { isReportableRiskState } from '@/domains/security-ops/risks/riskLifecycle';
export type { ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
export type ComplianceReadinessStatus =
  | 'missing'
  | 'partial'
  | 'passing'
  | 'failing'
  | 'stale'
  | 'accepted_risk'
  | 'not_applicable'
  | 'not_supported';

export type ComplianceControlVerdict =
  | 'pass'
  | 'fail'
  | 'needs_evidence'
  | 'needs_context'
  | 'not_attempted'
  | 'accepted_risk'
  | 'not_applicable'
  | 'not_supported';

export type ComplianceControlOutcome = 'passed' | 'failed' | 'needs_action' | 'not_checked' | 'excluded';

export type ComplianceControlCheckVerdict = 'pass' | 'fail' | 'needs_context' | 'not_attempted';
export type ComplianceControlCheckBasis = 'agent_tested' | 'agent_reviewed_user_evidence' | 'agent_reviewed_integration';
export type ComplianceControlCheckReviewDecision = 'confirmed' | 'rejected' | 'retest_required';
export type ComplianceControlCheckReviewStatus = 'unreviewed' | ComplianceControlCheckReviewDecision;

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

export type ComplianceEvidenceMappingSource =
  | 'skill'
  | 'cwe'
  | 'owasp'
  | 'keyword'
  | 'note'
  | 'scanner'
  | 'inventory'
  | 'user_evidence'
  | 'accepted_risk'
  | 'control_check';

export type ComplianceEvidenceMappingConfidence = 'high' | 'medium' | 'low';

export interface ComplianceReadinessEvidence {
  id: string;
  kind: 'finding' | 'note' | 'scanner_observation' | 'inventory' | 'user_evidence' | 'accepted_risk' | 'agent_control_check';
  title: string;
  source: string;
  sourceRef: string;
  lastSeenAt: string | null;
  findingId?: string;
  severity?: string | null;
  state?: RiskState | null;
  negative?: boolean;
  mappingSource?: ComplianceEvidenceMappingSource;
  mappingConfidence?: ComplianceEvidenceMappingConfidence;
  skillSlugs?: string[];
  controlCheckVerdict?: ComplianceControlCheckVerdict;
  quality: ComplianceEvidenceQuality;
}

export interface ComplianceControlCheckReviewView {
  id: string;
  reviewerUserId: string | null;
  decision: ComplianceControlCheckReviewDecision;
  reasonCode: string;
  note: string;
  createdAt: string;
}

export interface ComplianceControlCheckView {
  id: string;
  basis: ComplianceControlCheckBasis;
  verdict: ComplianceControlCheckVerdict;
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
  latestReview: ComplianceControlCheckReviewView | null;
  reviewHistory: ComplianceControlCheckReviewView[];
}

export interface ComplianceControlRequestView {
  id: string;
  requestType: 'evidence' | 'access' | 'context' | 'remediation';
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'fulfilled' | 'reviewed' | 'insufficient' | 'contradicted' | 'cancelled';
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
  supportLevel: EvidenceSupportLevel;
  implementationSpec?: ControlDefinition['implementationSpec'] | null;
  pciDssRequirement?: ControlDefinition['pciDssRequirement'] | null;
  pciDssGoal?: ControlDefinition['pciDssGoal'] | null;
  pciDssApproach?: ControlDefinition['pciDssApproach'] | null;
  pciDssSaqTypes?: ControlDefinition['pciDssSaqTypes'] | null;
  pciDssCdeScope?: ControlDefinition['pciDssCdeScope'] | null;
  pciDssAccountData?: ControlDefinition['pciDssAccountData'] | null;
  status: ComplianceReadinessStatus;
  verdict: ComplianceControlVerdict;
  outcome: ComplianceControlOutcome;
  reasonCode: string;
  basis: ComplianceControlCheckBasis | null;
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
  monitoring: ComplianceControlMonitoringView;
  assignment: ComplianceControlAssignmentView;
  actionRequests: ComplianceControlRequestView[];
  controlChecks: ComplianceControlCheckView[];
}

export interface NistCsfFunctionReadiness {
  function: string;
  total: number;
  monitored: number;
  directCheckCount: number;
  outcomeCounts: Record<ComplianceControlOutcome, number>;
}

export interface NistCsfReadinessProfile {
  kind: 'nist_csf_2_0';
  functions: NistCsfFunctionReadiness[];
  implementationTier: {
    status: 'not_determined';
    tier: null;
    reason: string;
  };
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
  frameworkProfile?: NistCsfReadinessProfile | null;
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
  reviewSummary: {
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
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export interface ComplianceFindingFact {
  id: string;
  title: string;
  severity: string;
  state: RiskState;
  summary: string | null;
  businessImpact: string | null;
  technicalAnalysis: string | null;
  remediation: string | null;
  cweId: string | null;
  cweIds: string[] | null;
  owaspCategory: string | null;
  assetValue: string | null;
  lastSeenAt: Date | string | null;
  evidence: Array<{
    kind: string;
    path: string;
    displayPath: string | null;
    label: string | null;
    fileMissing: boolean;
    createdAt: Date | string | null;
    sessionId?: string | null;
  }>;
  skillSlugs?: string[];
}

export interface ComplianceNoteFact {
  ntype: string;
  title: string | null;
  data: Record<string, unknown>;
  evidence: Array<{ path: string; label?: string; excerpt?: string; fileMissing?: boolean }>;
  lastSeenAt: Date | string | null;
}

export interface ComplianceScannerObservationFact {
  id: string;
  parser: string;
  observationType: string;
  title: string;
  severity: string;
  artifactPath: string;
  findingId: string | null;
  lastSeenAt: Date | string | null;
}

export interface ComplianceAssetFact {
  id: string;
  kind: string;
  value: string;
  lastSeenAt: Date | string | null;
}

export interface ComplianceServiceFact {
  id: string;
  protocol: string;
  port: number;
  serviceName: string | null;
  product: string | null;
  version: string | null;
  lastSeenAt: Date | string | null;
}

export interface ComplianceAcceptedRiskFact {
  id: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  evidenceItemId: string | null;
  owner: string;
  rationale: string;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | string | null;
  expiresAt: Date | string | null;
}

export interface ComplianceControlCheckFact {
  id: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  basis?: ComplianceControlCheckBasis;
  verdict: ComplianceControlCheckVerdict;
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
  proof: ComplianceControlCheckView['proof'];
  limitations: string[];
  freshUntil: Date | string;
  runId: string;
  sessionId: string;
  createdAt: Date | string;
  reviews?: Array<{
    id: string;
    reviewerUserId: string | null;
    decision: ComplianceControlCheckReviewDecision;
    reasonCode: string;
    note: string;
    createdAt: Date | string;
  }>;
}

export interface ComplianceControlStateFact {
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  state: ComplianceControlMonitoringState;
  exclusionReason: string | null;
  assignedToUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface ComplianceControlRequestFact {
  id: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  requestType: ComplianceControlRequestView['requestType'];
  priority: ComplianceControlRequestView['priority'];
  status: ComplianceControlRequestView['status'];
  title: string;
  reason: string;
  requestedEvidence: string[];
  remediationHint: string | null;
  assignedToUserId: string | null;
  dueAt: Date | string | null;
  fulfillmentEvidenceItemId: string | null;
  fulfillmentNote: string | null;
  fulfilledByUserId: string | null;
  fulfilledAt: Date | string | null;
  reviewControlCheckId: string | null;
  reviewNote: string | null;
  reviewedByActorType: 'agent' | 'system' | 'operator' | null;
  reviewedByActorId: string | null;
  reviewedAt: Date | string | null;
  nextReverificationAt: Date | string | null;
  runId: string;
  sessionId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ComplianceFacts {
  findings: ComplianceFindingFact[];
  notes: ComplianceNoteFact[];
  scannerObservations: ComplianceScannerObservationFact[];
  assets: ComplianceAssetFact[];
  services: ComplianceServiceFact[];
  acceptedRisks: ComplianceAcceptedRiskFact[];
  controlChecks?: ComplianceControlCheckFact[];
  controlStates?: ComplianceControlStateFact[];
  controlRequests?: ComplianceControlRequestFact[];
  completedRunCount: number;
  latestCompletedRunId: string | null;
}

export interface ComplianceReadinessBuildInput {
  generatedAt: Date;
  organizationId: string;
  scopeId: string | null;
  runId: string | null;
  selectedFrameworks: ComplianceFrameworkSelection[];
  facts: ComplianceFacts;
}

interface ComplianceEvidenceMapping {
  source: ComplianceEvidenceMappingSource;
  confidence: ComplianceEvidenceMappingConfidence;
  skillSlugs?: string[];
}

export const READINESS_NOTE_TYPES = [
  'run.digest',
  'report.section',
  'approach.tried',
  'approach.blocker',
  'scan.coverage',
  'http.endpoint',
  'tech.fingerprint',
];
const FRESHNESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const emptyComplianceFacts = (): ComplianceFacts => ({
  findings: [],
  notes: [],
  scannerObservations: [],
  assets: [],
  services: [],
  acceptedRisks: [],
  controlChecks: [],
  controlStates: [],
  controlRequests: [],
  completedRunCount: 0,
  latestCompletedRunId: null,
});

const statusWeight = (status: ComplianceReadinessStatus): number | null => {
  switch (status) {
    case 'passing':
      return 100;
    case 'partial':
      return 0;
    case 'stale':
      return 0;
    case 'accepted_risk':
      return 0;
    case 'failing':
      return 0;
    case 'missing':
      return 0;
    case 'not_applicable':
    case 'not_supported':
      return null;
    default:
      return null;
  }
};

const emptyStatusCounts = (): Record<ComplianceReadinessStatus, number> => ({
  missing: 0,
  partial: 0,
  passing: 0,
  failing: 0,
  stale: 0,
  accepted_risk: 0,
  not_applicable: 0,
  not_supported: 0,
});

const emptyOutcomeCounts = (): Record<ComplianceControlOutcome, number> => ({
  passed: 0,
  failed: 0,
  needs_action: 0,
  not_checked: 0,
  excluded: 0,
});

const emptyVerdictCounts = (): Record<ComplianceControlVerdict, number> => ({
  pass: 0,
  fail: 0,
  needs_evidence: 0,
  needs_context: 0,
  not_attempted: 0,
  accepted_risk: 0,
  not_applicable: 0,
  not_supported: 0,
});

const toIsoString = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const normalizeText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const dateMs = (value: Date | string | null | undefined): number | null => {
  const iso = toIsoString(value);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
};

const isFresh = (value: Date | string | null | undefined, generatedAt: Date): boolean => {
  const seenMs = dateMs(value);
  if (seenMs === null) return false;
  return generatedAt.getTime() - seenMs <= FRESHNESS_WINDOW_MS;
};

const computeQuality = (flags: Omit<ComplianceEvidenceQuality, 'score'>): ComplianceEvidenceQuality => {
  const values = [
    flags.traceable,
    flags.fresh,
    flags.trustedSource,
    flags.scopeComplete,
    flags.humanReviewed,
  ];
  return {
    ...flags,
    score: Math.round((values.filter(Boolean).length / values.length) * 100),
  };
};

export const extractSelectedComplianceFrameworks = (input: {
  scopeComplianceFrameworks?: unknown;
}): ComplianceFrameworkSelection[] => {
  const selected = new Set(normalizeComplianceFrameworkKeys(input.scopeComplianceFrameworks));
  return COMPLIANCE_FRAMEWORK_ORDER
    .filter((key) => selected.has(key))
    .map((key) => ({
      key,
      label: FRAMEWORK_LABELS[key],
      sources: ['scope_profile' as const],
    }));
};

const findingText = (finding: ComplianceFindingFact): string =>
  [
    finding.title,
    finding.summary,
    finding.businessImpact,
    finding.technicalAnalysis,
    finding.remediation,
    finding.cweId,
    ...(finding.cweIds ?? []),
    finding.owaspCategory,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');

const noteText = (note: ComplianceNoteFact): string =>
  [
    note.ntype,
    note.title,
    ...Object.values(note.data ?? {}).map((value) =>
      typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '',
    ),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');

const uniqueNormalized = (values: readonly (string | null | undefined)[]): string[] =>
  Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter(Boolean),
    ),
  );

const controlSkillSlugs = (definition: ControlDefinition): string[] =>
  uniqueNormalized(definition.skillSlugs ?? []);

const findingMatchesDefinition = (
  definition: ControlDefinition,
  finding: ComplianceFindingFact,
): ComplianceEvidenceMapping | null => {
  const definitionSkillSlugs = controlSkillSlugs(definition);
  const findingSkillSlugs = uniqueNormalized(finding.skillSlugs ?? []);
  const matchedSkillSlugs = definitionSkillSlugs.filter((slug) => findingSkillSlugs.includes(slug));
  if (matchedSkillSlugs.length > 0) {
    return {
      source: 'skill',
      confidence: 'high',
      skillSlugs: matchedSkillSlugs,
    };
  }

  const findingCweIds = uniqueNormalized([finding.cweId, ...(finding.cweIds ?? [])]).map((value) =>
    value.toUpperCase(),
  );
  const matchedCwe = definition.cweIds?.some((cwe) => findingCweIds.includes(cwe.toUpperCase())) ?? false;
  if (matchedCwe) {
    return { source: 'cwe', confidence: 'high' };
  }

  const owaspCategory = normalizeText(finding.owaspCategory);
  if (owaspCategory && definition.owaspKeywords?.some((keyword) => owaspCategory.includes(normalizeText(keyword)))) {
    return { source: 'owasp', confidence: 'medium' };
  }

  const text = findingText(finding);
  if (definition.findingKeywords?.some((keyword) => text.includes(normalizeText(keyword)))) {
    return { source: 'keyword', confidence: 'low' };
  }

  return null;
};

const ACCESS_CONTROL_SURFACE_CONTROLS = new Set(['CC6.1', 'CC6.2', 'CC6.3', 'CC6.6']);

const LIMITATION_ONLY_ACCESS_PATTERNS = [
  /\bno[\s\S]{0,140}\b(?:authentication|authorization|auth|login|credential|registration|password reset|session|user management|admin|api|data[-\s]?handling)[\s\S]{0,60}\b(?:surfaces?|mechanisms?|endpoints?|routes?|features?|flows?|handling|responses?|forms?|configuration)\b/iu,
  /\bno (?:testable |functional |direct )?(?:authentication|authorization|auth|login|credential|registration|password reset|session|user management|admin|api|data[-\s]?handling) (?:surfaces?|mechanisms?|endpoints?|routes?|features?|flows?|handling|responses?|forms?)\b/iu,
  /\bno (?:login forms?|api responses?|oauth configuration|session management|token handling|user management endpoints?)\b/iu,
  /\boutside (?:direct )?scope\b/iu,
  /\boperator[-\s]?provided credentials?\b/iu,
  /\bscope expansion\b/iu,
  /\bblocked prerequisite\b/iu,
  /\bwithout credentials\b/iu,
];

const isLimitationOnlyNote = (definition: ControlDefinition, text: string): boolean => {
  if (!ACCESS_CONTROL_SURFACE_CONTROLS.has(definition.id)) return false;
  return LIMITATION_ONLY_ACCESS_PATTERNS.some((pattern) => pattern.test(text));
};

const noteMatchesDefinition = (
  definition: ControlDefinition,
  note: ComplianceNoteFact,
): ComplianceEvidenceMapping | null => {
  const text = noteText(note);
  if (/auto-generated run digest/iu.test(text)) {
    return null;
  }

  if (note.ntype === 'http.endpoint' && ACCESS_CONTROL_SURFACE_CONTROLS.has(definition.id)) {
    return null;
  }

  const typeMatches = definition.noteTypes?.includes(note.ntype) ?? false;
  const keywordMatches = definition.noteKeywords?.some((keyword) => text.includes(normalizeText(keyword))) ?? false;

  if (typeMatches && definition.noteKeywords && !keywordMatches) {
    return null;
  }

  if (isLimitationOnlyNote(definition, text)) {
    return null;
  }

  if (typeMatches) {
    return { source: 'note', confidence: keywordMatches ? 'high' : 'medium' };
  }
  if (keywordMatches) {
    return { source: 'note', confidence: 'medium' };
  }
  return null;
};

const scannerMatchesDefinition = (
  definition: ControlDefinition,
  observation: ComplianceScannerObservationFact,
): ComplianceEvidenceMapping | null => {
  const parser = observation.parser.toLowerCase();
  if (definition.scannerParsers?.some((entry) => entry.toLowerCase() === parser)) {
    return { source: 'scanner', confidence: 'high' };
  }
  const text = `${observation.observationType} ${observation.title}`.toLowerCase();
  if (definition.noteKeywords?.some((keyword) => text.includes(normalizeText(keyword)))) {
    return { source: 'scanner', confidence: 'medium' };
  }
  return null;
};

const isNegativeFinding = (finding: ComplianceFindingFact): boolean =>
  finding.state === 'confirmed' &&
  ['critical', 'high', 'medium'].includes(finding.severity);

const hasDurableFindingEvidence = (finding: ComplianceFindingFact): boolean =>
  finding.evidence.some((entry) => entry.kind === 'http_exchange' || entry.fileMissing !== true);

const isPositiveFindingEvidence = (finding: ComplianceFindingFact): boolean =>
  finding.state === 'resolved' &&
  hasDurableFindingEvidence(finding);

const shouldUseFindingEvidence = (finding: ComplianceFindingFact): boolean =>
  isNegativeFinding(finding) || isPositiveFindingEvidence(finding);

const evidenceId = (prefix: string, value: string): string => `${prefix}:${value}`;

const findingEvidenceSourceRef = (finding: ComplianceFindingFact): string => {
  const durable = finding.evidence.find((entry) => entry.kind === 'http_exchange' || entry.fileMissing !== true);
  return durable?.displayPath ?? durable?.path ?? `finding:${finding.id}`;
};

const buildFindingEvidence = (
  finding: ComplianceFindingFact,
  generatedAt: Date,
  scopeComplete: boolean,
  mapping: ComplianceEvidenceMapping,
): ComplianceReadinessEvidence => {
  const hasDurableEvidence = hasDurableFindingEvidence(finding);
  const negative = isNegativeFinding(finding);
  return {
    id: evidenceId('finding', finding.id),
    kind: 'finding',
    title: finding.title,
    source: negative ? 'confirmed Risk' : 'resolved Risk',
    sourceRef: findingEvidenceSourceRef(finding),
    lastSeenAt: toIsoString(finding.lastSeenAt),
    findingId: finding.id,
    severity: finding.severity,
    state: finding.state,
    negative,
    mappingSource: mapping.source,
    mappingConfidence: mapping.confidence,
    ...(mapping.skillSlugs && mapping.skillSlugs.length > 0 ? { skillSlugs: mapping.skillSlugs } : {}),
    quality: computeQuality({
      traceable: hasDurableEvidence,
      fresh: isFresh(finding.lastSeenAt, generatedAt),
      trustedSource: isReportableRiskState(finding.state),
      scopeComplete,
      humanReviewed: isReportableRiskState(finding.state),
    }),
  };
};

const buildNoteEvidence = (
  note: ComplianceNoteFact,
  generatedAt: Date,
  scopeComplete: boolean,
  mapping: ComplianceEvidenceMapping,
): ComplianceReadinessEvidence => ({
  id: evidenceId('note', `${note.ntype}:${note.title ?? toIsoString(note.lastSeenAt) ?? 'untitled'}`),
  kind: 'note',
  title: note.title ?? note.ntype,
  source: note.ntype,
  sourceRef: note.evidence.find((entry) => !entry.fileMissing)?.path ?? `note:${note.ntype}`,
  lastSeenAt: toIsoString(note.lastSeenAt),
  mappingSource: mapping.source,
  mappingConfidence: mapping.confidence,
  quality: computeQuality({
    traceable: note.evidence.length > 0 || ['run.digest', 'scan.coverage', 'approach.tried'].includes(note.ntype),
    fresh: isFresh(note.lastSeenAt, generatedAt),
    trustedSource: true,
    scopeComplete,
    // Notes are agent-authored narrative. They are not human-reviewed by definition;
    // human review enters through finding validation or operator-managed inventory state.
    humanReviewed: false,
  }),
});

const buildScannerEvidence = (
  observation: ComplianceScannerObservationFact,
  generatedAt: Date,
  scopeComplete: boolean,
  mapping: ComplianceEvidenceMapping,
): ComplianceReadinessEvidence => ({
  id: evidenceId('scanner', observation.id),
  kind: 'scanner_observation',
  title: observation.title,
  source: observation.parser,
  sourceRef: observation.artifactPath,
  lastSeenAt: toIsoString(observation.lastSeenAt),
  findingId: observation.findingId ?? undefined,
  severity: observation.severity,
  state: null,
  mappingSource: mapping.source,
  mappingConfidence: mapping.confidence,
  quality: computeQuality({
    traceable: Boolean(observation.artifactPath),
    fresh: isFresh(observation.lastSeenAt, generatedAt),
    trustedSource: true,
    scopeComplete,
    humanReviewed: false,
  }),
});

const buildInventoryEvidence = (
  facts: ComplianceFacts,
  generatedAt: Date,
  scopeComplete: boolean,
): ComplianceReadinessEvidence[] => {
  const latestAssetSeen = facts.assets
    .map((asset) => dateMs(asset.lastSeenAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0];
  const latestServiceSeen = facts.services
    .map((service) => dateMs(service.lastSeenAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0];
  const latestSeen = latestAssetSeen ?? latestServiceSeen ?? null;
  const title = `${facts.assets.length} asset(s), ${facts.services.length} service(s) tracked`;

  if (facts.assets.length === 0 && facts.services.length === 0) {
    return [];
  }

  return [
    {
      id: 'inventory:asset-service-summary',
      kind: 'inventory',
      title,
      source: 'asset inventory',
      sourceRef: 'inventory:assets-services',
      lastSeenAt: latestSeen ? new Date(latestSeen).toISOString() : null,
      mappingSource: 'inventory',
      mappingConfidence: 'high',
      quality: computeQuality({
        traceable: true,
        fresh: latestSeen !== null && generatedAt.getTime() - latestSeen <= FRESHNESS_WINDOW_MS,
        trustedSource: true,
        scopeComplete,
        humanReviewed: false,
      }),
    },
  ];
};

const activeAcceptedRiskForControl = (
  facts: ComplianceFacts,
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
  generatedAt: Date,
): ComplianceAcceptedRiskFact | null => {
  const now = generatedAt.getTime();
  return facts.acceptedRisks.find((risk) => {
    const expiresAt = dateMs(risk.expiresAt);
    return (
      risk.frameworkKey === frameworkKey &&
      risk.controlId === controlId &&
      risk.status === 'active' &&
      expiresAt !== null &&
      expiresAt >= now
    );
  }) ?? null;
};

const buildAcceptedRiskEvidence = (
  risk: ComplianceAcceptedRiskFact,
  generatedAt: Date,
  scopeComplete: boolean,
): ComplianceReadinessEvidence => ({
  id: evidenceId('accepted-risk', risk.id),
  kind: 'accepted_risk',
  title: `Accepted risk for ${risk.controlId}`,
  source: 'reviewer-approved accepted risk',
  sourceRef: risk.evidenceItemId ? `compliance-evidence:${risk.evidenceItemId}` : `accepted-risk:${risk.id}`,
  lastSeenAt: toIsoString(risk.approvedAt),
  mappingSource: 'accepted_risk',
  mappingConfidence: 'high',
  quality: computeQuality({
    traceable: Boolean(risk.evidenceItemId || risk.rationale),
    fresh: (dateMs(risk.expiresAt) ?? 0) >= generatedAt.getTime(),
    trustedSource: Boolean(risk.approvedBy),
    scopeComplete,
    humanReviewed: Boolean(risk.approvedBy && risk.approvedAt),
  }),
});

const controlCheckIsFresh = (check: ComplianceControlCheckFact, generatedAt: Date): boolean =>
  (dateMs(check.freshUntil) ?? 0) >= generatedAt.getTime();

const buildControlCheckReviewView = (
  review: NonNullable<ComplianceControlCheckFact['reviews']>[number],
  generatedAt: Date,
): ComplianceControlCheckReviewView => ({
  id: review.id,
  reviewerUserId: review.reviewerUserId,
  decision: review.decision,
  reasonCode: review.reasonCode,
  note: review.note,
  createdAt: toIsoString(review.createdAt) ?? generatedAt.toISOString(),
});

const controlCheckIsEligible = (check: ComplianceControlCheckFact): boolean => {
  const latestReview = [...(check.reviews ?? [])]
    .sort((left, right) => (dateMs(right.createdAt) ?? 0) - (dateMs(left.createdAt) ?? 0))[0];
  return latestReview?.decision !== 'rejected' && latestReview?.decision !== 'retest_required';
};

const buildControlCheckView = (
  check: ComplianceControlCheckFact,
  generatedAt: Date,
): ComplianceControlCheckView => {
  const reviewHistory = [...(check.reviews ?? [])]
    .sort((left, right) => (dateMs(right.createdAt) ?? 0) - (dateMs(left.createdAt) ?? 0))
    .map((review) => buildControlCheckReviewView(review, generatedAt));
  const latestReview = reviewHistory[0] ?? null;
  return {
    id: check.id,
    basis: check.basis ?? 'agent_tested',
    verdict: check.verdict,
    reasonCode: check.reasonCode,
    reason: check.reason,
    proofObligationId: check.proofObligationId,
    method: check.method,
    toolName: check.toolName,
    skillSlug: check.skillSlug,
    targetRef: check.targetRef,
    evidenceRefs: check.evidenceRefs,
    findingIds: check.findingIds,
    artifactIds: check.artifactIds,
    proof: check.proof,
    limitations: check.limitations,
    freshUntil: toIsoString(check.freshUntil) ?? generatedAt.toISOString(),
    runId: check.runId,
    sessionId: check.sessionId,
    createdAt: toIsoString(check.createdAt) ?? generatedAt.toISOString(),
    fresh: controlCheckIsFresh(check, generatedAt),
    eligible: controlCheckIsEligible(check),
    reviewStatus: latestReview?.decision ?? 'unreviewed',
    latestReview,
    reviewHistory,
  };
};

const buildControlCheckEvidence = (
  check: ComplianceControlCheckFact,
  generatedAt: Date,
  scopeComplete: boolean,
): ComplianceReadinessEvidence => ({
  id: evidenceId('control-check', check.id),
  kind: 'agent_control_check',
  title: check.reason,
  source: check.method,
  sourceRef: `control-check:${check.id}`,
  lastSeenAt: toIsoString(check.createdAt),
  negative: check.verdict === 'fail',
  controlCheckVerdict: check.verdict,
  mappingSource: 'control_check',
  mappingConfidence: 'high',
  ...(check.skillSlug ? { skillSlugs: [check.skillSlug] } : {}),
  quality: computeQuality({
    traceable: check.evidenceRefs.length > 0,
    fresh: controlCheckIsFresh(check, generatedAt),
    trustedSource: true,
    scopeComplete,
    humanReviewed: false,
  }),
});

const dedupeEvidence = (evidence: ComplianceReadinessEvidence[]): ComplianceReadinessEvidence[] => {
  const seen = new Set<string>();
  const rows: ComplianceReadinessEvidence[] = [];
  for (const item of evidence) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
  }
  return rows
    .sort((left, right) => {
      const leftMs = dateMs(left.lastSeenAt) ?? 0;
      const rightMs = dateMs(right.lastSeenAt) ?? 0;
      return rightMs - leftMs || left.id.localeCompare(right.id);
    })
    .slice(0, 12);
};

const deriveControlStatus = (
  definition: ControlDefinition,
  evidence: ComplianceReadinessEvidence[],
): ComplianceReadinessStatus => {
  if (definition.supportLevel === 'out_of_selected_scope') return 'not_supported';
  const freshControlChecks = evidence.filter(
    (item) => item.kind === 'agent_control_check' && item.quality.fresh,
  );
  if (freshControlChecks.some((item) => item.negative === true)) return 'failing';
  if (evidence.some((item) => item.kind === 'accepted_risk')) return 'accepted_risk';
  if (freshControlChecks.some((item) => item.controlCheckVerdict === 'pass')) return 'passing';
  if (evidence.length === 0) return 'missing';
  const passingEligibleEvidence = evidence.filter((item) => item.mappingConfidence !== 'low');
  const freshCount = evidence.filter((item) => item.quality.fresh).length;
  const approvedUserEvidenceCount = passingEligibleEvidence.filter(
    (item) =>
      item.kind === 'user_evidence' &&
      item.quality.fresh &&
      item.quality.traceable &&
      item.quality.trustedSource &&
      item.quality.humanReviewed,
  ).length;
  if (definition.supportLevel === 'manual_evidence_required' || definition.supportLevel === 'integration_required') {
    if (approvedUserEvidenceCount > 0) return 'passing';
    if (
      passingEligibleEvidence.some(
        (item) => item.kind === 'user_evidence' && item.quality.humanReviewed && item.quality.traceable,
      ) &&
      freshCount === 0
    ) {
      return 'stale';
    }
    return 'partial';
  }
  // Automated controls pass only through a fresh direct control check. Other evidence
  // can expose a failure or provide context, but it cannot prove operation by inference.
  const hasAnyControlCheck = evidence.some((item) => item.kind === 'agent_control_check');
  if (hasAnyControlCheck && freshControlChecks.length === 0) return 'stale';
  if (freshCount === 0) return 'stale';
  return 'partial';
};

const supportLevelLimitation = (definition: ControlDefinition): string => {
  switch (definition.supportLevel) {
    case 'manual_evidence_required':
      return 'This control requires file-backed organization evidence and an agent-authored control check. Raw uploads and reference-only records are tracked as context but cannot pass the control on their own.';
    case 'integration_required':
      return 'This control requires file-backed integration evidence and an agent-authored control check. Raw exports and reference-only records are tracked as context but cannot pass the control on their own.';
    case 'out_of_selected_scope':
      return 'This control is outside the selected agent-proven readiness slice; it is tracked but excluded from scoring.';
    case 'automated_testable':
    default:
      return '';
  }
};

const controlRationale = (
  definition: ControlDefinition,
  status: ComplianceReadinessStatus,
  evidence: ComplianceReadinessEvidence[],
): string => {
  if (status === 'accepted_risk') {
    return 'Risk has been explicitly accepted with owner, rationale, approval, and expiry; this is not evidence that the control is operating effectively.';
  }
  if (definition.supportLevel === 'out_of_selected_scope') return supportLevelLimitation(definition);
  if (status === 'missing') return definition.missingGap;
  if (status === 'stale') return `Evidence exists for ${definition.id}, but it is older than 90 days.`;
  const latestControlCheck = evidence.find((item) => item.kind === 'agent_control_check');
  if (latestControlCheck && (status === 'passing' || status === 'failing' || status === 'partial')) {
    return latestControlCheck.title;
  }
  const negative = evidence.filter((item) => item.negative);
  if (negative.length > 0) {
    return `${negative.length} related negative finding(s) require review, but direct control verdict still needs a fresh control check.`;
  }
  if (status === 'passing') return definition.positiveEvidenceLabel;
  if (definition.supportLevel !== 'automated_testable') {
    return `${definition.positiveEvidenceLabel} Evidence is present but still needs an agent-authored control check, traceability, and a valid expiration date.`;
  }
  return `${definition.positiveEvidenceLabel} Evidence is partial or not yet fully reviewed.`;
};

const deriveControlVerdict = (
  status: ComplianceReadinessStatus,
  checks: ComplianceControlCheckView[],
): ComplianceControlVerdict => {
  if (status === 'passing') return 'pass';
  if (status === 'failing') return 'fail';
  if (status === 'accepted_risk') return 'accepted_risk';
  if (status === 'not_applicable') return 'not_applicable';
  if (status === 'not_supported') return 'not_supported';
  if (checks.some((check) => check.eligible && check.fresh && check.verdict === 'needs_context')) return 'needs_context';
  // A prior check that has gone stale is an observation that now needs re-verification.
  if (status === 'stale') return 'needs_evidence';
  // No observation yet: stay neutral. supportLevel only shapes the next-action hint and the
  // evidence scorecard — it must never manufacture a verdict for a control nobody has assessed.
  return 'not_attempted';
};

const outcomeForControl = (
  verdict: ComplianceControlVerdict,
  actionRequests: ComplianceControlRequestView[],
): ComplianceControlOutcome => {
  if (actionRequests.some((request) => ['open', 'fulfilled', 'insufficient', 'contradicted'].includes(request.status))) {
    return 'needs_action';
  }
  if (verdict === 'pass') return 'passed';
  if (verdict === 'fail') return 'failed';
  if (verdict === 'not_applicable' || verdict === 'not_supported') return 'excluded';
  // needs_context/needs_evidence now only arise from a real observation (an agent check or a stale
  // prior check), so they are genuine action items. An unobserved control is 'not_attempted' and
  // falls through to 'not_checked'.
  if (verdict === 'needs_context' || verdict === 'needs_evidence') return 'needs_action';
  return 'not_checked';
};

const nextActionForControl = (
  definition: ControlDefinition,
  verdict: ComplianceControlVerdict,
  actionRequests: ComplianceControlRequestView[],
): string => {
  const actionableRequest = actionRequests.find((request) =>
    ['open', 'fulfilled', 'insufficient', 'contradicted'].includes(request.status),
  );
  if (actionableRequest) {
    if (actionableRequest.status === 'fulfilled') {
      return `${actionableRequest.title}: fulfilled evidence is waiting for agent review.`;
    }
    if (actionableRequest.status === 'insufficient') {
      return `${actionableRequest.title}: the last review found the evidence insufficient. ${actionableRequest.reviewNote ?? actionableRequest.reason}`;
    }
    if (actionableRequest.status === 'contradicted') {
      return `${actionableRequest.title}: the last review contradicted the expected control state. ${actionableRequest.reviewNote ?? actionableRequest.reason}`;
    }
    if (actionableRequest.requestType === 'remediation' && actionableRequest.remediationHint) {
      return `${actionableRequest.title}: ${actionableRequest.remediationHint}`;
    }
    return `${actionableRequest.title}: ${actionableRequest.reason}`;
  }
  if (verdict === 'pass') return 'Review the evidence before freshness expires.';
  if (verdict === 'fail') return 'Remediate the failed behavior, then run the control check again.';
  if (verdict === 'accepted_risk') return 'Review the accepted risk before its expiry date.';
  if (verdict === 'needs_context') return 'Re-run the control after the agent opens or receives the missing context.';
  if (verdict === 'not_supported') return 'Assess this control outside Null-AI.';
  if (verdict === 'not_applicable') return 'No action is required for the selected scope.';
  // Unobserved or stale: the expected verification method (supportLevel) shapes the guidance, but
  // this is a hint only — it never sets the verdict/outcome.
  if (definition.supportLevel === 'manual_evidence_required') {
    return 'The agent will review supporting documents on the next compliance run, or request what is missing.';
  }
  if (definition.supportLevel === 'integration_required') {
    return 'The agent will review connected integration exports on the next compliance run, or request access.';
  }
  return definition.proofObligation
    ? 'The agent will run a targeted check for what must be true on the next compliance run.'
    : 'No agent request is open for this control yet.';
};

const explicitControlStateFor = (
  facts: ComplianceFacts,
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): ComplianceControlStateFact | null =>
  (facts.controlStates ?? []).find(
    (state) =>
      state.frameworkKey === frameworkKey &&
      state.controlId.trim().toUpperCase() === controlId.trim().toUpperCase(),
  ) ?? null;

const buildMonitoringView = (
  frameworkKey: ComplianceFrameworkKey,
  definition: ControlDefinition,
  stateFact: ComplianceControlStateFact | null,
): ComplianceControlMonitoringView => {
  const source: ComplianceControlMonitoringSource = stateFact ? 'explicit' : 'default';
  const state = stateFact?.state ?? defaultMonitoringStateForControl(definition, frameworkKey);
  return {
    state,
    source,
    exclusionReason:
      stateFact?.exclusionReason ??
      (state === 'excluded' ? SYSTEM_EXCLUSION_REASON : null),
    updatedAt: stateFact ? toIsoString(stateFact.updatedAt) : null,
  };
};

const buildAssignmentView = (
  stateFact: ComplianceControlStateFact | null,
): ComplianceControlAssignmentView => ({
  assignedToUserId: stateFact?.assignedToUserId ?? null,
  assignedByUserId: stateFact?.assignedByUserId ?? null,
  assignedAt: stateFact ? toIsoString(stateFact.assignedAt) : null,
});

const activeControlRequestStatuses = new Set(['open', 'fulfilled', 'insufficient', 'contradicted']);

const dedupeActionRequestsForDisplay = (
  requests: ComplianceControlRequestFact[],
): ComplianceControlRequestFact[] => {
  const seenActiveKeys = new Set<string>();
  return requests.filter((request) => {
    if (!activeControlRequestStatuses.has(request.status)) {
      return true;
    }
    const key = request.requestType;
    if (seenActiveKeys.has(key)) {
      return false;
    }
    seenActiveKeys.add(key);
    return true;
  });
};

const actionRequestsForControl = (
  facts: ComplianceFacts,
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): ComplianceControlRequestView[] =>
  dedupeActionRequestsForDisplay(
    (facts.controlRequests ?? [])
      .filter(
      (request) =>
        request.frameworkKey === frameworkKey &&
        request.controlId.trim().toUpperCase() === controlId.trim().toUpperCase(),
      )
      .sort((left, right) => (dateMs(right.updatedAt) ?? dateMs(right.createdAt) ?? 0) - (dateMs(left.updatedAt) ?? dateMs(left.createdAt) ?? 0)),
  )
    .map((request) => ({
      id: request.id,
      requestType: request.requestType,
      priority: request.priority,
      status: request.status,
      title: request.title,
      reason: request.reason,
      requestedEvidence: request.requestedEvidence,
      remediationHint: request.remediationHint,
      assignedToUserId: request.assignedToUserId,
      dueAt: toIsoString(request.dueAt),
      fulfillmentEvidenceItemId: request.fulfillmentEvidenceItemId,
      fulfillmentNote: request.fulfillmentNote,
      fulfilledByUserId: request.fulfilledByUserId,
      fulfilledAt: toIsoString(request.fulfilledAt),
      reviewControlCheckId: request.reviewControlCheckId,
      reviewNote: request.reviewNote,
      reviewedByActorType: request.reviewedByActorType,
      reviewedByActorId: request.reviewedByActorId,
      reviewedAt: toIsoString(request.reviewedAt),
      nextReverificationAt: toIsoString(request.nextReverificationAt),
      runId: request.runId,
      sessionId: request.sessionId,
      createdAt: toIsoString(request.createdAt) ?? new Date(0).toISOString(),
      updatedAt: toIsoString(request.updatedAt) ?? new Date(0).toISOString(),
    }));

const inactiveControlReason = (
  monitoring: ComplianceControlMonitoringView,
): string => {
  if (monitoring.state === 'excluded') {
    return monitoring.exclusionReason
      ? `Excluded from readiness: ${monitoring.exclusionReason}`
      : 'Excluded from readiness for this scope.';
  }
  return 'Excluded from readiness for this scope.';
};

const buildFrameworkReadiness = (
  input: ComplianceReadinessBuildInput,
  framework: FrameworkDefinition,
): ComplianceFrameworkReadiness => {
  const scanCoverageComplete = input.facts.notes.some(
    (note) =>
      note.ntype === 'scan.coverage' &&
      normalizeText(note.data?.status) === 'completed',
  );
  const scopeComplete =
    scanCoverageComplete ||
    input.facts.completedRunCount > 0;

  const controls = framework.controls.map((definition): ComplianceReadinessControl => {
    const evidence: ComplianceReadinessEvidence[] = [];
    const stateFact = explicitControlStateFor(input.facts, framework.key, definition.id);
    const monitoring = buildMonitoringView(framework.key, definition, stateFact);
    const assignment = buildAssignmentView(stateFact);
    const actionRequests = actionRequestsForControl(input.facts, framework.key, definition.id);
    const controlChecks = (input.facts.controlChecks ?? [])
      .filter((check) => check.frameworkKey === framework.key && check.controlId === definition.id)
      .sort((left, right) => (dateMs(right.createdAt) ?? 0) - (dateMs(left.createdAt) ?? 0))
      .map((check) => buildControlCheckView(check, input.generatedAt));
    for (const check of input.facts.controlChecks ?? []) {
      if (check.frameworkKey === framework.key && check.controlId === definition.id) {
        if (controlCheckIsEligible(check)) {
          evidence.push(buildControlCheckEvidence(check, input.generatedAt, scopeComplete));
        }
      }
    }
    const acceptedRisk = activeAcceptedRiskForControl(input.facts, framework.key, definition.id, input.generatedAt);
    if (acceptedRisk) {
      evidence.push(buildAcceptedRiskEvidence(acceptedRisk, input.generatedAt, scopeComplete));
    }

    if (definition.supportLevel === 'automated_testable') {
      for (const finding of input.facts.findings) {
        const mapping = findingMatchesDefinition(definition, finding);
        if (mapping && shouldUseFindingEvidence(finding)) {
          evidence.push(buildFindingEvidence(finding, input.generatedAt, scopeComplete, mapping));
        }
      }

      for (const note of input.facts.notes) {
        const mapping = noteMatchesDefinition(definition, note);
        if (mapping) {
          evidence.push(buildNoteEvidence(note, input.generatedAt, scopeComplete, mapping));
        }
      }

      for (const observation of input.facts.scannerObservations) {
        const mapping = scannerMatchesDefinition(definition, observation);
        if (mapping) {
          evidence.push(buildScannerEvidence(observation, input.generatedAt, scopeComplete, mapping));
        }
      }

      if (definition.includeInventory) {
        evidence.push(...buildInventoryEvidence(input.facts, input.generatedAt, scopeComplete));
      }
    }

    const deduped = dedupeEvidence(evidence);
    const derivedStatus = deriveControlStatus(definition, deduped);
    const status = monitoring.state === 'monitored' ? derivedStatus : 'not_applicable';
    const verdict = monitoring.state === 'monitored'
      ? deriveControlVerdict(status, controlChecks)
      : 'not_applicable';
    const verdictReason = monitoring.state === 'monitored'
      ? controlRationale(definition, status, deduped)
      : inactiveControlReason(monitoring);
    const score = statusWeight(status) ?? 0;
    const gaps = monitoring.state === 'monitored' && status === 'missing' ? [definition.missingGap] : [];
    if (status === 'partial') {
      gaps.push(
        definition.supportLevel === 'automated_testable'
          ? 'Evidence exists but needs more complete coverage or an agent-authored control check.'
          : 'Mapped evidence exists but requires an agent-authored control check, traceability, and a future expiration date.',
      );
    }
    if (status === 'failing') {
      gaps.push('A fresh direct control check failed and must be remediated or accepted as risk.');
    }
    if (status === 'accepted_risk') {
      gaps.push('Accepted risk is not a passing control state and must be reviewed before expiry.');
    }
    const coverageLimitations = [
      ...(definition.supportLevel === 'automated_testable' || !supportLevelLimitation(definition)
        ? []
        : [supportLevelLimitation(definition)]),
      ...(status === 'accepted_risk'
        ? ['Accepted risk documents a business decision; it does not prove control operating effectiveness.']
        : []),
      ...(monitoring.state === 'monitored'
        ? []
        : [inactiveControlReason(monitoring)]),
      ...(
        scopeComplete
          ? []
          : ['No completed scan.coverage note or managed asset baseline was found; readiness may understate gaps.']
      ),
    ];

    return {
      id: definition.id,
      title: definition.title,
      theme: definition.theme,
      supportLevel: definition.supportLevel,
      implementationSpec: definition.implementationSpec ?? null,
      pciDssRequirement: definition.pciDssRequirement ?? null,
      pciDssGoal: definition.pciDssGoal ?? null,
      pciDssApproach: definition.pciDssApproach ?? null,
      pciDssSaqTypes: definition.pciDssSaqTypes ?? null,
      pciDssCdeScope: definition.pciDssCdeScope ?? null,
      pciDssAccountData: definition.pciDssAccountData ?? null,
      status,
      verdict,
      outcome: outcomeForControl(verdict, actionRequests),
      reasonCode: monitoring.state === 'excluded'
        ? 'control_excluded'
        : controlChecks.find((check) => check.eligible)?.reasonCode ?? (status === 'stale' ? 'evidence_stale' : verdict),
      basis: controlChecks.find((check) => check.eligible && check.fresh)?.basis ?? null,
      verdictReason,
      score,
      rationale: verdictReason,
      evidence: deduped,
      gaps,
      coverageLimitations,
      catalogRef: definition.catalogRef ?? `${framework.key}:${definition.id}`,
      proofObligation: definition.proofObligation
        ? { id: definition.proofObligation.id, statement: definition.proofObligation.statement }
        : null,
      requiredEvidence: definition.proofObligation?.requiredEvidence ?? definition.evidenceExamples ?? [],
      nextAction: monitoring.state === 'excluded'
        ? 'Review the exclusion reason, or include this control to start monitoring it.'
        : nextActionForControl(definition, verdict, actionRequests),
      evidenceFreshness: {
        freshestAt: deduped[0]?.lastSeenAt ?? null,
        stale: status === 'stale',
      },
      monitoring,
      assignment,
      actionRequests,
      controlChecks,
    };
  });

  const summary = buildFrameworkSummary({
    key: framework.key,
    label: framework.label,
    selected: true,
    supported: true,
    controls,
  });
  return framework.key === 'nist_csf'
    ? { ...summary, frameworkProfile: buildNistCsfReadinessProfile(controls) }
    : summary;
};

const NIST_CSF_FUNCTIONS = ['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover'] as const;

const buildNistCsfReadinessProfile = (
  controls: ComplianceReadinessControl[],
): NistCsfReadinessProfile => ({
  kind: 'nist_csf_2_0',
  functions: NIST_CSF_FUNCTIONS.map((functionName) => {
    const functionControls = controls.filter((control) => control.theme === functionName);
    const outcomeCounts = emptyOutcomeCounts();
    for (const control of functionControls) {
      outcomeCounts[control.outcome] += 1;
    }
    return {
      function: functionName,
      total: functionControls.length,
      monitored: functionControls.filter((control) => control.monitoring.state === 'monitored').length,
      directCheckCount: functionControls.filter((control) => control.controlChecks.length > 0).length,
      outcomeCounts,
    };
  }),
  implementationTier: {
    status: 'not_determined',
    tier: null,
    reason: 'Implementation Tier is not derived from readiness counts. It requires organization-owned Current Profile and governance evidence.',
  },
});

const buildUnsupportedFramework = (key: ComplianceFrameworkKey): ComplianceFrameworkReadiness =>
  buildFrameworkSummary({
    key,
    label: FRAMEWORK_LABELS[key],
    selected: true,
    supported: false,
    controls: [
      {
        id: key.toUpperCase(),
        title: `${FRAMEWORK_LABELS[key]} mapping`,
        theme: 'Framework Mapping',
        supportLevel: 'out_of_selected_scope',
        implementationSpec: null,
        pciDssRequirement: null,
        pciDssGoal: null,
        pciDssApproach: null,
        pciDssSaqTypes: null,
        pciDssCdeScope: null,
        pciDssAccountData: null,
        status: 'not_supported',
        verdict: 'not_supported',
        outcome: 'excluded',
        reasonCode: 'not_supported',
        basis: null,
        verdictReason: `${FRAMEWORK_LABELS[key]} does not have a deterministic control registry.`,
        score: 0,
        rationale: `${FRAMEWORK_LABELS[key]} was selected in context, but no deterministic control registry is implemented for that framework key.`,
        evidence: [],
        gaps: [`Add ${FRAMEWORK_LABELS[key]} control mappings before generating readiness output for this framework.`],
        coverageLimitations: ['Framework selected but deterministic control map is not implemented yet.'],
        catalogRef: `${key}:unsupported`,
        proofObligation: null,
        requiredEvidence: [],
        nextAction: 'Assess this framework outside Null-AI until a deterministic control registry is available.',
        evidenceFreshness: { freshestAt: null, stale: false },
        monitoring: {
          state: 'excluded',
          source: 'default',
          exclusionReason: `${FRAMEWORK_LABELS[key]} does not have a deterministic control registry yet.`,
          updatedAt: null,
        },
        assignment: {
          assignedToUserId: null,
          assignedByUserId: null,
          assignedAt: null,
        },
        actionRequests: [],
        controlChecks: [],
      },
    ],
  });

const buildFrameworkSummary = (input: {
  key: ComplianceFrameworkKey;
  label: string;
  selected: boolean;
  supported: boolean;
  controls: ComplianceReadinessControl[];
}): ComplianceFrameworkReadiness => {
  const statusCounts = emptyStatusCounts();
  const outcomeCounts = emptyOutcomeCounts();
  const verdictCounts = emptyVerdictCounts();
  const scoreValues: number[] = [];
  for (const control of input.controls) {
    statusCounts[control.status] += 1;
    outcomeCounts[control.outcome] += 1;
    verdictCounts[control.verdict] += 1;
    const weight = statusWeight(control.status);
    if (weight !== null) scoreValues.push(weight);
  }
  const score =
    input.supported && scoreValues.length > 0
      ? Math.round(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length)
      : 0;

  return {
    key: input.key,
    label: input.label,
    selected: input.selected,
    supported: input.supported,
    score,
    statusCounts,
    outcomeCounts,
    verdictCounts,
    controls: input.controls,
    gaps: input.controls.flatMap((control) => control.gaps).slice(0, 12),
    coverageLimitations: Array.from(
      new Set(input.controls.flatMap((control) => control.coverageLimitations)),
    ).slice(0, 8),
  };
};

export const buildComplianceReadinessSnapshot = (input: ComplianceReadinessBuildInput): ComplianceReadinessResponse => {
  const frameworks = input.selectedFrameworks.map((selection) => {
    const framework = FRAMEWORK_REGISTRY[selection.key];
    return framework ? buildFrameworkReadiness(input, framework) : buildUnsupportedFramework(selection.key);
  });
  const controls = frameworks.flatMap((framework) => framework.controls);
  const monitoredControls = controls.filter((control) => control.monitoring.state === 'monitored');
  const technicalControls = monitoredControls.filter((control) => control.supportLevel === 'automated_testable');
  const customerControls = monitoredControls.filter(
    (control) => control.supportLevel === 'manual_evidence_required' || control.supportLevel === 'integration_required',
  );
  const outcomes = emptyOutcomeCounts();
  for (const control of controls) outcomes[control.outcome] += 1;
  const controlChecks = controls.flatMap((control) => control.controlChecks);

  return {
    generatedAt: input.generatedAt.toISOString(),
    organizationId: input.organizationId,
    scopeId: input.scopeId,
    runId: input.runId,
    selectedFrameworks: input.selectedFrameworks,
    supportedFrameworks: SUPPORTED_FRAMEWORKS,
    frameworks,
    latestCompletedRunId: input.facts.latestCompletedRunId,
    scorecards: {
      agentProvenTechnical: {
        total: technicalControls.length,
        passed: technicalControls.filter((control) => control.verdict === 'pass').length,
        failed: technicalControls.filter((control) => control.verdict === 'fail').length,
        needsContext: technicalControls.filter((control) => control.verdict === 'needs_context').length,
        notAttempted: technicalControls.filter((control) => control.verdict === 'not_attempted').length,
        stale: technicalControls.filter((control) => control.status === 'stale').length,
      },
      customerEvidence: {
        total: customerControls.length,
        approved: customerControls.filter((control) => control.verdict === 'pass').length,
        missing: customerControls.filter(
          (control) => control.verdict === 'needs_evidence' || control.verdict === 'not_attempted',
        ).length,
        stale: customerControls.filter((control) => control.status === 'stale').length,
        integrationRequired: customerControls.filter(
          (control) => control.supportLevel === 'integration_required' && control.verdict !== 'pass',
        ).length,
        acceptedRisk: customerControls.filter((control) => control.verdict === 'accepted_risk').length,
      },
      outcomes,
    },
    reviewSummary: {
      total: controlChecks.length,
      unreviewed: controlChecks.filter((check) => check.reviewStatus === 'unreviewed').length,
      confirmed: controlChecks.filter((check) => check.reviewStatus === 'confirmed').length,
      rejected: controlChecks.filter((check) => check.reviewStatus === 'rejected').length,
      retestRequired: controlChecks.filter((check) => check.reviewStatus === 'retest_required').length,
    },
    reportRequest: {
      canStart: Boolean(input.scopeId && input.selectedFrameworks.length > 0 && input.facts.latestCompletedRunId),
      scopeId: input.scopeId,
      latestCompletedRunId: input.facts.latestCompletedRunId,
      reason:
        input.selectedFrameworks.length === 0
          ? 'No compliance framework is selected for this scope.'
          : !input.scopeId
            ? 'Select a scope before starting a compliance readiness report session.'
            : input.facts.latestCompletedRunId
              ? null
              : 'Run a technical control assessment before starting a compliance readiness report session.',
    },
  };
};
