import type {
  MissionEnvelopeNode,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';
import type {
  AnyWorkerType,
  MissionPhaseKey,
  ToolAccessPolicy,
} from '@/domains/agent-brain/domain/types';
import type { RunWorkflowDiscipline } from '@/db/schema';
import type { SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';

export type RunPhaseKey = MissionPhaseKey;
export type RunPhaseStatus =
  | 'pending'
  | 'active'
  | 'handoff_submitted'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'aborted';

export interface PhaseProfile {
  phaseKey: RunPhaseKey;
  phaseProfile: string;
  toolProfile: string;
  promptProfile: string;
  toolPolicy: ToolAccessPolicy;
  compatibleSkillPhases: RunPhaseKey[];
  compatibleSkillCategories: string[];
  defaultBudget: {
    maxTurns: number;
    maxToolCalls: number;
  };
  maxScannerWallSeconds: number;
  requiredExitTool: 'submit_phase_handoff';
  handoffSchema: string;
  handoffSchemaVersion: number;
  maxAttempts: number;
  workerSpawning: {
    allowed: boolean;
    allowedWorkerTypes: AnyWorkerType[];
  };
}

const QUERY_TOOLS = ['query_inventory', 'query_notes', 'query_findings'];
const COMPLIANCE_QUERY_TOOLS = ['query_compliance_readiness', 'query_compliance_evidence', 'query_compliance_proof_package'];
const FILE_TOOLS = ['file_read', 'file_write'];
const WORKER_TOOLS = ['spawn_worker', 'continue_worker', 'stop_worker', 'wait_for_worker', 'submit_worker_result'];
const SKILL_ROUTING_TOOLS = ['list_relevant_skills', 'load_skill'];
const SHELL_HTTP_BROWSER_TOOLS = [
  'shell_run',
  'wait_for_shell_job',
  'web_search',
  'http_payload',
  'http_raw_send',
  'http_differential',
  'browser_action',
  'http_list',
  'http_view',
  'http_repeat',
  'http_sitemap',
];
const PYTHON_PROOF_TOOLS = ['python_session'];
const PERSONA_TOOLS = ['persona_save', 'persona_list', 'persona_load', 'persona_forget'];
const AUTHZ_REPLAY_TOOLS = ['authz_replay'];
const OOB_TOOLS = ['oob_token_create', 'oob_check_interactions'];
const CANONICAL_WRITE_TOOLS = [
  'report_asset',
  'report_service',
  'ingest_scan_artifact',
  'report_note',
  'report_finding',
  'promote_finding',
  'submit_validation_outcome',
];
const REPOSITORY_READ_TOOLS = [
  'list_connected_repositories',
  'search_connected_repository',
  'read_connected_repository_file',
];
const PHASE_HANDOFF_TOOLS = ['submit_phase_handoff'];
const PHASE_CHECKPOINT_TOOLS = ['submit_phase_checkpoint'];
const phasePreflightTool = (phaseKey: RunPhaseKey): string => `${phaseKey}_handoff_preflight`;
const discoveryPhaseExitTools = (phaseKey: RunPhaseKey): string[] => [
  ...PHASE_HANDOFF_TOOLS,
  ...PHASE_CHECKPOINT_TOOLS,
  phasePreflightTool(phaseKey),
];
const SHARED_REPOSITORY_READ_PHASES = new Set<RunPhaseKey>([
  'planning',
  'recon',
  'enumeration',
  'validation',
  'evidence',
  'control_assessment',
]);

export interface PhaseToolPolicyContext {
  whiteboxEnabled?: boolean;
  connectedRepoCount?: number;
  complianceReporting?: boolean;
  workflowDiscipline?: RunWorkflowDiscipline;
  codeReviewMemoryWriteAllowed?: boolean;
}

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const allowPolicy = (tools: readonly string[]): ToolAccessPolicy => ({
  allow: unique(tools),
});

const hasConnectedRepositoryScope = (context?: PhaseToolPolicyContext): boolean => {
  if (!context) {
    return false;
  }
  if (typeof context.connectedRepoCount === 'number') {
    return context.connectedRepoCount > 0;
  }
  return context.whiteboxEnabled === true;
};

const phaseCanUseRepositoryReads = (
  phaseKey: RunPhaseKey,
  context?: PhaseToolPolicyContext,
): boolean => {
  if (!hasConnectedRepositoryScope(context)) {
    return false;
  }
  if (context?.workflowDiscipline === 'pentest') {
    return phaseKey === 'validation';
  }
  if (context?.workflowDiscipline === 'compliance') {
    return phaseKey === 'control_assessment' || phaseKey === 'evidence';
  }
  if (context?.workflowDiscipline === 'code_review') {
    return false;
  }
  return SHARED_REPOSITORY_READ_PHASES.has(phaseKey);
};

const planningProfile: PhaseProfile = {
  phaseKey: 'planning',
  phaseProfile: 'phase-planning',
  toolProfile: 'phase-planning',
  promptProfile: 'planner',
  toolPolicy: allowPolicy([...QUERY_TOOLS, 'submit_plan', 'file_read', 'list_relevant_skills']),
  compatibleSkillPhases: ['planning'],
  compatibleSkillCategories: ['planning'],
  defaultBudget: { maxTurns: 12, maxToolCalls: 40 },
  maxScannerWallSeconds: 60,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 1,
  workerSpawning: {
    allowed: false,
    allowedWorkerTypes: [],
  },
};

const reconProfile: PhaseProfile = {
  phaseKey: 'recon',
  phaseProfile: 'phase-recon',
  toolProfile: 'phase-recon',
  promptProfile: 'phase-recon',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    ...SHELL_HTTP_BROWSER_TOOLS,
    ...PERSONA_TOOLS,
    ...CANONICAL_WRITE_TOOLS.filter((tool) => tool !== 'submit_validation_outcome'),
    ...discoveryPhaseExitTools('recon'),
  ]),
  compatibleSkillPhases: ['recon', 'enumeration'],
  compatibleSkillCategories: ['recon', 'enumeration', 'tooling'],
  defaultBudget: { maxTurns: 30, maxToolCalls: 120 },
  maxScannerWallSeconds: 180,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 3,
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['recon_worker'],
  },
};

const enumerationProfile: PhaseProfile = {
  ...reconProfile,
  phaseKey: 'enumeration',
  phaseProfile: 'phase-enumeration',
  toolProfile: 'phase-enumeration',
  promptProfile: 'phase-enumeration',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    ...SHELL_HTTP_BROWSER_TOOLS,
    ...PYTHON_PROOF_TOOLS,
    ...PERSONA_TOOLS,
    ...AUTHZ_REPLAY_TOOLS,
    ...CANONICAL_WRITE_TOOLS.filter((tool) => tool !== 'submit_validation_outcome'),
    'submit_enumeration_disposition',
    ...discoveryPhaseExitTools('enumeration'),
  ]),
  compatibleSkillPhases: ['enumeration', 'recon'],
  compatibleSkillCategories: ['enumeration', 'recon', 'tooling'],
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['recon_worker', 'enumeration_worker'],
  },
};

const validationProfile: PhaseProfile = {
  phaseKey: 'validation',
  phaseProfile: 'phase-validation',
  toolProfile: 'phase-validation',
  promptProfile: 'phase-validation',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    ...SHELL_HTTP_BROWSER_TOOLS,
    ...PYTHON_PROOF_TOOLS,
    ...PERSONA_TOOLS,
    ...AUTHZ_REPLAY_TOOLS,
    ...OOB_TOOLS,
    ...CANONICAL_WRITE_TOOLS,
    'submit_finding_disposition_outcome',
    'submit_validation_lead_outcome',
    ...PHASE_HANDOFF_TOOLS,
    phasePreflightTool('validation'),
  ]),
  compatibleSkillPhases: ['validation', 'enumeration'],
  compatibleSkillCategories: ['vulnerability', 'tooling'],
  defaultBudget: { maxTurns: 48, maxToolCalls: 160 },
  maxScannerWallSeconds: 180,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 4,
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['validator_worker', 'repo_research_worker'],
  },
};

const exploitationProfile: PhaseProfile = {
  phaseKey: 'exploitation',
  phaseProfile: 'phase-exploitation',
  toolProfile: 'phase-exploitation',
  promptProfile: 'phase-exploitation',
  toolPolicy: allowPolicy([
    'query_findings',
    'query_notes',
    ...SKILL_ROUTING_TOOLS,
    'submit_attack_disposition',
    ...PHASE_HANDOFF_TOOLS,
    phasePreflightTool('exploitation'),
  ]),
  compatibleSkillPhases: ['exploitation', 'validation'],
  compatibleSkillCategories: ['vulnerability', 'tooling'],
  defaultBudget: { maxTurns: 30, maxToolCalls: 90 },
  maxScannerWallSeconds: 900,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 3,
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['attack_worker'],
  },
};

const evidenceProfile: PhaseProfile = {
  phaseKey: 'evidence',
  phaseProfile: 'phase-evidence',
  toolProfile: 'phase-evidence',
  promptProfile: 'phase-evidence',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    ...PYTHON_PROOF_TOOLS,
    'report_note',
    ...PHASE_HANDOFF_TOOLS,
    phasePreflightTool('evidence'),
  ]),
  compatibleSkillPhases: ['evidence', 'validation', 'reporting'],
  compatibleSkillCategories: ['evidence', 'vulnerability', 'reporting'],
  defaultBudget: { maxTurns: 16, maxToolCalls: 50 },
  maxScannerWallSeconds: 120,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 1,
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['evidence_worker'],
  },
};

const controlAssessmentProfile: PhaseProfile = {
  phaseKey: 'control_assessment',
  phaseProfile: 'phase-control-assessment',
  toolProfile: 'phase-control-assessment',
  promptProfile: 'phase-control-assessment',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...COMPLIANCE_QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    ...SHELL_HTTP_BROWSER_TOOLS,
    ...PYTHON_PROOF_TOOLS,
    ...AUTHZ_REPLAY_TOOLS,
    'record_control_check',
    'record_control_request',
    'review_control_request',
    'map_compliance_evidence',
    'annotate_compliance_evidence',
    'report_note',
    ...discoveryPhaseExitTools('control_assessment'),
  ]),
  compatibleSkillPhases: ['control_assessment'],
  compatibleSkillCategories: ['compliance'],
  defaultBudget: { maxTurns: 18, maxToolCalls: 70 },
  maxScannerWallSeconds: 120,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 1,
  workerSpawning: {
    allowed: true,
    allowedWorkerTypes: ['compliance_control_worker'],
  },
};

const codeReviewSharedTools = [
  'file_read',
  'file_write',
  'list_code_review_repository_files',
  'search_code_review_repository',
  'read_connected_repository_file',
  ...PHASE_HANDOFF_TOOLS,
  ...PHASE_CHECKPOINT_TOOLS,
];

const reviewMappingProfile: PhaseProfile = {
  phaseKey: 'review_mapping',
  phaseProfile: 'phase-review-mapping',
  toolProfile: 'phase-review-mapping-read-only',
  promptProfile: 'phase-review-mapping',
  toolPolicy: allowPolicy([
    ...codeReviewSharedTools,
    'query_code_review_memory',
    'record_code_review_memory',
  ]),
  compatibleSkillPhases: ['review_mapping'],
  compatibleSkillCategories: ['code_review'],
  defaultBudget: { maxTurns: 20, maxToolCalls: 80 },
  maxScannerWallSeconds: 60,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'code-review-phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 1,
  workerSpawning: {
    allowed: false,
    allowedWorkerTypes: [],
  },
};

const reviewAnalysisProfile: PhaseProfile = {
  ...reviewMappingProfile,
  phaseKey: 'review_analysis',
  phaseProfile: 'phase-review-analysis',
  toolProfile: 'phase-review-analysis-read-only',
  promptProfile: 'phase-review-analysis',
  toolPolicy: allowPolicy([
    ...codeReviewSharedTools,
    'query_code_review_memory',
    'query_code_review_findings',
    'report_code_review_candidate',
  ]),
  compatibleSkillPhases: ['review_analysis'],
  defaultBudget: { maxTurns: 28, maxToolCalls: 120 },
};

const reviewValidationProfile: PhaseProfile = {
  ...reviewMappingProfile,
  phaseKey: 'review_validation',
  phaseProfile: 'phase-review-validation',
  toolProfile: 'phase-review-validation-read-only',
  promptProfile: 'phase-review-validation',
  toolPolicy: allowPolicy([
    ...codeReviewSharedTools,
    'query_code_review_memory',
    'record_code_review_memory',
    'query_code_review_findings',
    'validate_code_review_finding',
  ]),
  compatibleSkillPhases: ['review_validation'],
  defaultBudget: { maxTurns: 24, maxToolCalls: 100 },
};

const reviewReportingProfile: PhaseProfile = {
  ...reviewMappingProfile,
  phaseKey: 'review_reporting',
  phaseProfile: 'phase-review-reporting',
  toolProfile: 'phase-review-reporting-read-only',
  promptProfile: 'phase-review-reporting',
  toolPolicy: allowPolicy([
    'file_read',
    'file_write',
    'record_code_review_memory',
    'query_code_review_findings',
    'finalize_code_review_report',
    ...PHASE_HANDOFF_TOOLS,
    ...PHASE_CHECKPOINT_TOOLS,
  ]),
  compatibleSkillPhases: ['review_reporting'],
  defaultBudget: { maxTurns: 14, maxToolCalls: 45 },
};

const reportingProfile: PhaseProfile = {
  phaseKey: 'reporting',
  phaseProfile: 'phase-reporting',
  toolProfile: 'phase-reporting',
  promptProfile: 'phase-reporting',
  toolPolicy: allowPolicy([
    ...QUERY_TOOLS,
    ...SKILL_ROUTING_TOOLS,
    ...FILE_TOOLS,
    'report_finalizer_preflight',
    'prepare_report_context',
    'finalize_run_artifacts',
    'report_finding',
    'report_note',
    ...PHASE_HANDOFF_TOOLS,
    phasePreflightTool('reporting'),
  ]),
  compatibleSkillPhases: ['reporting'],
  compatibleSkillCategories: ['reporting'],
  defaultBudget: { maxTurns: 14, maxToolCalls: 45 },
  maxScannerWallSeconds: 60,
  requiredExitTool: 'submit_phase_handoff',
  handoffSchema: 'phase-handoff/v1',
  handoffSchemaVersion: 1,
  maxAttempts: 1,
  workerSpawning: {
    allowed: false,
    allowedWorkerTypes: [],
  },
};

const PROFILES: Record<RunPhaseKey, PhaseProfile> = {
  planning: planningProfile,
  recon: reconProfile,
  enumeration: enumerationProfile,
  validation: validationProfile,
  exploitation: exploitationProfile,
  evidence: evidenceProfile,
  control_assessment: controlAssessmentProfile,
  reporting: reportingProfile,
  review_mapping: reviewMappingProfile,
  review_analysis: reviewAnalysisProfile,
  review_validation: reviewValidationProfile,
  review_reporting: reviewReportingProfile,
};

const CANONICAL_PHASES = new Set<RunPhaseKey>(Object.keys(PROFILES) as RunPhaseKey[]);

export const normalizePhaseKey = (value: unknown): RunPhaseKey | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return CANONICAL_PHASES.has(normalized as RunPhaseKey) ? normalized as RunPhaseKey : null;
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const REPORTING_SKILL_SLUG = 'security-reporting';
const COMPLIANCE_REPORTING_SKILL_SLUG = 'compliance-reporting';
const COMPLIANCE_ASSESSMENT_SKILL_SLUGS = new Set([
  'compliance-access-control',
  'compliance-technical-readiness',
  'compliance-evidence-review',
  'compliance-governance-review',
]);
const RECON_SKILL_SLUGS = new Set([
  'broad-surface-scan',
  'network-recon',
  'tooling-subfinder',
  'tooling-naabu',
  'tooling-httpx',
  'tooling-nmap',
]);
const ENUMERATION_SKILL_SLUGS = new Set([
  'api-enumeration',
  'spa-recon',
  'js-surface-analysis',
  'tooling-ffuf',
  'tooling-katana',
]);

export const inferPhaseKeyFromMission = (
  mission: Pick<MissionEnvelopeNode, 'phase' | 'assignedSkills' | 'revalidatesFindingId'>,
): RunPhaseKey => {
  const explicit = normalizePhaseKey(mission.phase);
  if (explicit) {
    return explicit;
  }

  const assigned = new Set((mission.assignedSkills ?? []).map(normalizeText));
  if (Array.from(assigned).some((slug) => COMPLIANCE_ASSESSMENT_SKILL_SLUGS.has(slug))) {
    return 'control_assessment';
  }
  if (assigned.has(COMPLIANCE_REPORTING_SKILL_SLUG)) {
    return 'reporting';
  }
  if (assigned.has(REPORTING_SKILL_SLUG)) {
    return 'reporting';
  }
  if (mission.revalidatesFindingId) {
    return 'validation';
  }
  if (Array.from(assigned).some((slug) => ENUMERATION_SKILL_SLUGS.has(slug))) {
    return 'enumeration';
  }
  if (Array.from(assigned).some((slug) => RECON_SKILL_SLUGS.has(slug))) {
    return 'recon';
  }
  return 'validation';
};

export const attachMissionPhase = (mission: MissionEnvelopeNode): MissionEnvelopeNode => ({
  ...mission,
  phase: inferPhaseKeyFromMission(mission),
});

export const attachMissionPhases = (missions: readonly MissionEnvelopeNode[]): MissionEnvelopeNode[] =>
  missions.map(attachMissionPhase);

export class PhaseProfileRegistry {
  get(phaseKey: RunPhaseKey): PhaseProfile {
    return PROFILES[phaseKey];
  }

  list(): PhaseProfile[] {
    return Object.values(PROFILES);
  }

  buildToolPolicy(
    phaseKey: RunPhaseKey,
    context?: PhaseToolPolicyContext,
  ): ToolAccessPolicy {
    const profile = this.get(phaseKey);
    const repositoryTools = phaseCanUseRepositoryReads(phaseKey, context)
      ? REPOSITORY_READ_TOOLS
      : [];
    const complianceReportingTools =
      phaseKey === 'reporting' && context?.complianceReporting === true
        ? COMPLIANCE_QUERY_TOOLS
        : [];
    const baseAllow =
      phaseKey === 'reporting' && context?.complianceReporting === true
        ? (profile.toolPolicy.allow ?? []).filter((tool) => tool !== 'report_finding')
        : profile.toolPolicy.allow ?? [];
    const allow = unique([...baseAllow, ...repositoryTools, ...complianceReportingTools])
      .filter((tool) =>
        !(
          tool === 'record_code_review_memory'
          && context?.workflowDiscipline === 'code_review'
          && context.codeReviewMemoryWriteAllowed === false
        ));
    if (!profile.workerSpawning.allowed) {
      return {
        ...profile.toolPolicy,
        allow,
      };
    }
    return {
      ...profile.toolPolicy,
      allow: unique([...allow, ...WORKER_TOOLS]),
    };
  }

  listKnownToolNames(): string[] {
    return unique([
      ...this.list().flatMap((profile) => profile.toolPolicy.allow ?? []),
      ...REPOSITORY_READ_TOOLS,
      ...COMPLIANCE_QUERY_TOOLS,
    ]).sort();
  }

  missingRequiredTools(
    phaseKey: RunPhaseKey,
    requiredTools: readonly string[],
    context?: PhaseToolPolicyContext,
  ): string[] {
    const allowed = new Set(this.buildToolPolicy(phaseKey, context).allow ?? []);
    return unique(
      requiredTools
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0 && !allowed.has(tool)),
    ).sort();
  }

  validateSkillAssignment(phaseKey: RunPhaseKey, skill: SkillMetadata): string | null {
    const profile = this.get(phaseKey);
    const skillPhases = skill.compatiblePhases && skill.compatiblePhases.length > 0
      ? skill.compatiblePhases
      : skill.phase
        ? [skill.phase]
        : [];
    const normalizedSkillPhases = skillPhases
      .map((phase) => normalizePhaseKey(phase))
      .filter((phase): phase is RunPhaseKey => Boolean(phase));
    const normalizedCategory = normalizeText(skill.category);

    const phaseCompatible =
      normalizedSkillPhases.length === 0 ||
      normalizedSkillPhases.some((phase) => profile.compatibleSkillPhases.includes(phase));
    const categoryCompatible =
      normalizedCategory.length === 0 ||
      profile.compatibleSkillCategories.includes(normalizedCategory);

    if (phaseCompatible || categoryCompatible) {
      return null;
    }

    return `skill "${skill.slug}" is not compatible with phase "${phaseKey}"`;
  }
}

export const phaseProfileRegistry = new PhaseProfileRegistry();
