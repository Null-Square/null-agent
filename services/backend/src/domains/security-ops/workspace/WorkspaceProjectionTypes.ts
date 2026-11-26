import type { SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';
import type { ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import type { WorkspaceTarget } from './WorkspaceFilePort';

export type ProjectionScope =
  | 'all'
  | 'contract'
  | 'context'
  | 'recon'
  | 'surface'
  | 'coverage'
  | 'leads'
  | 'model'
  | 'findings'
  | 'evidence'
  | 'compliance'
  | 'skills'
  | 'scanDigest';

export interface ProjectRunWorkspaceInput {
  orgId: string;
  scopeId: string;
  runId: string;
  workspace: WorkspaceTarget;
  sessionId?: string;
  phaseKey?: string;
  assignedSkillSlugs?: string[];
  activeComplianceFrameworkKey?: ComplianceFrameworkKey | null;
  reason: string;
  scopes: ProjectionScope[];
}

export interface ProjectionResult {
  success: boolean;
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
  modelSummaryPath?: string;
}

export type ProjectionEnvelope<T> = {
  schemaVersion: 1;
  runId: string;
  scopeId: string;
  generatedAt: string;
  source: {
    db: 'postgres';
    projection: string;
  };
  data: T;
};

export type LeadPriorityScore = {
  score: number;
  band: 'critical' | 'high' | 'medium' | 'low';
  reasons: string[];
};

export type ContextProjection = {
  organization: {
    id: string;
    name: string;
    slug: string;
    operationalContext: string | null;
  } | null;
  scope: {
    id: string;
    name: string;
    mission: string | null;
    executionNetwork: string;
    impactTolerance: string;
    complianceFrameworks: string[];
  } | null;
  run: {
    id: string;
    title: string | null;
    goal: string;
    status: string;
    executionTarget: string;
    runnerId: string | null;
    modelCategory: string | null;
    startedAt: string | null;
  } | null;
  targets: Array<{
    id: string;
    type: string;
    value: string;
    verified: boolean;
    verificationMethod: string | null;
  }>;
  accessMaterials: Array<{
    id: string;
    kind: string;
    label: string;
    username: string | null;
    headerName: string | null;
    appliesToHosts: string[];
    notes: string | null;
    lastUsedAt: string | null;
  }>;
  personas: Array<{
    id: string;
    label: string;
    roleLabel: string | null;
    kind: string;
    username: string | null;
    headerName: string | null;
    appliesToHosts: string[];
    refreshConfigured: boolean;
    lastUsedAt: string | null;
    refreshedAt: string | null;
  }>;
  priorRunNotes: Array<Record<string, unknown>>;
};

export type ReconProjection = {
  assets: unknown[];
  services: unknown[];
  endpoints: Array<Record<string, unknown>>;
  technologies: unknown[];
  graph: {
    nodes: unknown[];
    edges: unknown[];
  };
  endpointSummary: {
    total: number;
    byHost: Record<string, number>;
    byMethod: Record<string, number>;
    risky: Array<Record<string, unknown>>;
  };
};

export type CoverageProjection = {
  notes: unknown[];
  scannerObservations: unknown[];
  gaps: string[];
  matrix: Array<Record<string, unknown>>;
  blockers: string[];
};

export type LeadsProjection = {
  validationLeads: unknown[];
  validationQueue: unknown[];
};

export type FindingsProjection = {
  findings: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  reportable: Array<Record<string, unknown>>;
};

export type EvidenceProjection = {
  evidence: unknown[];
  scannerEvidence: unknown[];
};

export type ComplianceProjection = {
  frameworks: unknown[];
  monitoredControls: unknown[];
  readinessControls: unknown[];
  openRequests: unknown[];
  evidenceItems: unknown[];
  previousRuns: unknown[];
};

export type SkillIndexEntry = Pick<
  SkillMetadata,
  | 'slug'
  | 'name'
  | 'description'
  | 'phase'
  | 'compatiblePhases'
  | 'category'
  | 'requiredTools'
  | 'riskTier'
  | 'versionHash'
  | 'catalogVersion'
  | 'useWhen'
  | 'strongTerms'
  | 'techTriggers'
  | 'ntypeTriggers'
>;
