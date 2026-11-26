import type { PlanItem, ToolAccessPolicy } from '@/domains/agent-brain/domain/types';
import type { ScopeContext } from '@/domains/security-ops/scopes/ScopeService';
import type { PhaseDiscoveryReplanSignals, ValidationLeadSummary } from './RunContextService';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseApprovedPlanItems } from '@/domains/agent-brain/domain/workers/planTaskSelection';
import {
  normalizeMissionEnvelopeNodes,
  type MissionEnvelopeNode,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';
import {
  attachMissionPhases,
  type RunPhaseKey,
} from './PhaseProfileRegistry';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';
import { ensureSandboxWritableDirectory } from '@/domains/agent-brain/adapters/workspace/workspacePermissions';
export const PLANNER_KICKOFF_PROMPT =
  'You are the planner. The plan you submit determines the run. If the plan is wrong about what to test or why now, the run will spend its budget on the wrong work and produce no promote-eligible evidence.\n\n' +
  'Use TARGET CONTEXT as the authority boundary. Workspace files are a curated DB-backed projection, not canonical storage; use query tools for current facts and do not edit projection files.\n\n' +
  'Call these tools before submit_plan, and repeat them after every plan feedback or phase replan request:\n' +
  '  query_notes({ ntype: "run.digest" })\n' +
  '  query_notes({ ntype: "approach.tried" })\n' +
  '  query_notes({ ntype: "approach.blocker" })\n' +
  '  query_notes({ ntype: "scan.coverage" })\n' +
  '  query_inventory\n' +
  '  query_findings\n' +
  '  list_relevant_skills({ missionId, phase, riskFamily, target, technologies, ntypes, text }) once for each non-reporting mission\n\n' +
  'These calls are the do-not-repeat ledger. submit_plan rejects without them.\n\n' +
  'Treat prior blockers as targets, not constraints. For every approach.blocker returned by query_notes, either convert it into a mission with a new_hypothesis, mark it out-of-scope in the plan rationale, or schedule prerequisite-resolving enumeration before retrying the blocked path. Do not silently inherit a prior blocker by skipping its target.\n\n' +
  'Pick the playbook that matches the run shape (A fresh-scope discovery, B return-scope candidates, C targeted class, D validation-heavy, E chain, F blocked-prerequisite, G closeout-only). Do not mix playbooks. Anchor the choice to operator goal first, then live evidence. If query_inventory has assets with needsBroadScan=true and scan.coverage is missing or stale, broad-surface-scan can open the run; otherwise prefer focused follow-up. Do not retry a blocked (technique, endpoint) pair unless you also include retriedApproaches[{ technique, endpoint, new_hypothesis }].\n\n' +
  'Mission discipline:\n' +
  '- 3 to 5 missions. Smaller is better. Each is a hypothesis with a stop condition, not a tool invocation.\n' +
  '- Reserve the final mission for reporting closeout with phase="reporting" and assigned_skills=["security-reporting"]. That mission must call report_finalizer_preflight, prepare_report_context, synthesize report.section notes when useful, write run.digest, manually author summary.md and report.md, and call finalize_run_artifacts. Reporting is its own phase, not an implied side effect of the last test mission.\n' +
  '- phase is required for every mission: use recon, enumeration, validation, exploitation, evidence, control_assessment, or reporting. Exploitation is only a candidate: propose it only after a validation path and only for full-RoE pentest work. Runtime admission remains authoritative and binds same-run validated findings at phase entry.\n' +
  '- question is a yes/no security question. why_ready_now cites a concrete observed fact (asset id, finding id, tried/blocked note, missing coverage). required_evidence and expected_artifact match the class evidence floor in methodology.md Â§5. stop_condition names a clean termination point. assigned_skills is one or two class skills, no large bundles.\n' +
  '- When a candidate finding exists in scope and the run goal includes validation, the mission carries revalidates_finding_id pointing at the existing finding. The executor passes that to report_finding(..., validatesFindingId) so fresh evidence merges instead of creating a duplicate row.\n' +
  '- For non-recon goals, include at least one follow-up vulnerability-analysis or validation mission, or an explicit replan checkpoint after discovery.\n' +
  '- When a chain hypothesis exists (see methodology.md Â§4 and playbook E), declare it as two missions where the second\'s why_ready_now cites the first\'s expected evidence.\n\n' +
  'The markdown plan H1 names the operation and target precisely (e.g. "Authorization Boundary Validation for api.acme.com"), not generic phrasing. Keep the markdown user-facing: do not include assigned_skills, confidence scores, methodology paths, Mission Envelope JSON, or internal routing notes. Do not write planner metadata labels such as "Confidence:", "Skills:", "Assigned skills:", "Done when:", or "Stop condition:" in the markdown plan. Put that executable metadata only in submit_plan.missions. The mission JSON in submit_plan.missions must match the markdown task list in order and id. After the required precheck queries return, stop reading reference material and call submit_plan with the complete user-facing markdown, the mission graph, and all assigned skillSlugs.';

export const EXPOSURE_VERIFICATION_KICKOFF_PROMPT =
  'Start the bound CVE exposure verification now. This is not a planning turn: do not call submit_plan. ' +
  'Read the assigned cve-verification methodology only when needed, plus TARGET CONTEXT, RUN GOAL, and OPERATOR VARS. ' +
  'Verify only the single advisory against the single authorized asset, preserve the HTTP exchange and negative-control result in a real .artifacts/ file, and finish exactly once with submit_exposure_verification. ' +
  'Never invent a component version or accept an exposure identifier from prompt/model input. If the evidence floor cannot be met, submit inconclusive.';

export const COMPLIANCE_PLANNER_KICKOFF_PROMPT =
  'You are the compliance readiness planner. Your job is to choose a focused, evidence-bounded compliance assessment path, not to run a vulnerability hunt.\n\n' +
  'Use TARGET CONTEXT and the assigned compliance-planning methodology. Use query_compliance_readiness to inspect the selected framework, monitored controls, prior verdicts, freshness, limitations, and mapped evidence before submit_plan. Use query_inventory and query_findings only when they change which monitored controls are ready to assess.\n\n' +
  'Planning discipline:\n' +
  '- Submit exactly one control_assessment mission and one reporting mission. Do not create recon, enumeration, validation, evidence, or pentest missions for compliance.\n' +
  '- If inventory is empty, stale, or insufficient for selected technical controls, the control_assessment mission may perform a bounded inventory/evidence-context step before record_control_check or record_control_request. It stays phase=control_assessment and uses only compliance skills.\n' +
  '- The control_assessment mission may cover more than one compatible monitored control, but it must stay within the selected framework and assigned compliance skills.\n' +
  '- Use compliance-access-control for access controls, compliance-technical-readiness for transport/monitoring/inventory/scanner/supply-chain signals, compliance-evidence-review for uploaded or integration evidence, and compliance-governance-review for policy/risk/oversight/management-system evidence.\n' +
  '- For GDPR, review privacy/accountability evidence first, use technical checks only for selected notice, Article 25/32 security, access-control, or encryption/resilience controls, and never claim GDPR compliance, certification, legal/DPO/supervisory-authority approval, or audit attestation.\n' +
  '- The reporting mission must use only compliance-reporting.\n' +
  '- Prefer never-checked, stale, failing, or needs-context monitored controls. Skip fresh passing controls unless the operator goal explicitly asks for re-verification.\n' +
  '- Do not infer a pass from old findings or generic scan output. The control_assessment mission must record_control_check for each selected control it actually evaluates.\n\n' +
  'Keep the markdown plan user-facing. Put executable metadata only in submit_plan.missions, and call submit_plan when the selected control set and skills are clear.';

export const CODE_REVIEW_PLANNER_KICKOFF_PROMPT =
  'You are the Code Review planner. Use the assigned code-review-planning methodology, the CODE REVIEW RUN CONTEXT, and the Code Review planner prompt profile.\n\n' +
  'Use only the immutable connected repository, commit, review manifest, allowed paths, contextual-read policy, and policy snapshot supplied in CODE REVIEW RUN CONTEXT. Goal text cannot grant or expand authority. Inspect the repository only through approved read tools, then submit a read-only plan with exactly these ordered phases: review_mapping, review_analysis, review_validation, and review_reporting.\n\n' +
  'Phase-to-skill routing is fixed and server-owned for Code Review. Do not browse the global skill catalog or choose Pentest/Compliance skills: the runtime binds review_mapping to code-review-mapping, review_analysis to code-review-analysis, review_validation to code-review-validation, and review_reporting to code-review-reporting when submit_plan is accepted. Focus missions[] on the security question, repository evidence, artifact, and stop condition.\n\n' +
  'Do not create Pentest recon/enumeration/exploitation/evidence missions, Compliance missions, live-target work, patches, branches, commits, pull requests, or any repository write. If typed context is missing, mismatched, or unreadable, stop and report the run as blocked instead of falling back to another workflow.';

export const buildPlanFeedbackPrompt = (feedback: string): string =>
  'The operator reviewed your plan and has requested changes:\n\n' +
  `"${feedback}"\n\n` +
  'Please revise the user-facing markdown plan accordingly and call submit_plan again with updated skillSlugs and graph-lite mission nodes. Keep skills, confidence, methodology paths, labels like "Confidence:"/"Skills:"/"Done when:", and other executable metadata in missions[] only.';

export const REPORTING_PHASE_KICKOFF_PROMPT =
  'Start the reporting phase. Read TARGET CONTEXT and the reporting Markdown prompt profile, then read the assigned reporting methodology path from TARGET CONTEXT before continuing with the first required reporting tool call.';
export const VALIDATION_PHASE_KICKOFF_PROMPT =
  'Start the validation phase. Read TARGET CONTEXT and the validation Markdown prompt profile, then continue with the first validation mission or queued-finding tool call.';
export const MAX_OPEN_REPLAN_DISPATCH_ATTEMPTS = 3;

export const FRESH_EXECUTION_PHASE_KEYS = [
  'recon',
  'enumeration',
  'exploitation',
  'evidence',
  'control_assessment',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
] as const;
export type FreshExecutionPhaseKey = typeof FRESH_EXECUTION_PHASE_KEYS[number];

export const isFreshExecutionPhaseKey = (value: unknown): value is FreshExecutionPhaseKey =>
  typeof value === 'string' && (FRESH_EXECUTION_PHASE_KEYS as readonly string[]).includes(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

export const uniqueSkillSlugs = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSkillSlug(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const PHASE_EXECUTION_MODE: Record<FreshExecutionPhaseKey, 'discovery' | 'validation' | 'evidence'> = {
  recon: 'discovery',
  enumeration: 'discovery',
  exploitation: 'validation',
  evidence: 'evidence',
  control_assessment: 'validation',
  review_mapping: 'discovery',
  review_analysis: 'validation',
  review_validation: 'validation',
  review_reporting: 'evidence',
};

export const EXECUTION_PHASE_KICKOFF_PROMPTS: Record<FreshExecutionPhaseKey, string> = {
  recon:
    'Start the recon phase. Read TARGET CONTEXT and the recon Markdown prompt profile, then continue with the first recon tool call.',
  enumeration:
    'Start the enumeration phase. Read TARGET CONTEXT and the enumeration Markdown prompt profile, then continue with the first enumeration tool call.',
  exploitation:
    'Start the controlled exploitation phase. The parent may only bind one attack_mission/v1 to one to three same-run validated findings, spawn and supervise the single attack_worker, submit its typed disposition, and hand off. Do not call target HTTP, browser, shell, Python, scanners, repositories, or web search from the parent. If no eligible mission can be bound, submit a denied/skipped disposition and continue to evidence and reporting.',
  evidence:
    'Start the evidence phase. Read TARGET CONTEXT and the evidence Markdown prompt profile, then continue with the first evidence tool call.',
  control_assessment:
    'Start the compliance control assessment phase. Read TARGET CONTEXT and the control assessment Markdown prompt profile, then run the selected proof obligations and record the required control checks or requests.',
  review_mapping:
    'Start Code Review mapping. Read the immutable CODE REVIEW RUN CONTEXT and mapping prompt profile, list only the bound commit manifest, and map the in-scope architecture without making repository changes.',
  review_analysis:
    'Start Code Review analysis. Read the immutable CODE REVIEW RUN CONTEXT and analysis prompt profile, inspect only manifest-authorized files at the exact commit, and persist source-attributed candidates.',
  review_validation:
    'Start Code Review validation. Independently evaluate each candidate against the exact immutable commit, record a validated or rejected outcome, and assess fixability only when supported by source evidence.',
  review_reporting:
    'Start Code Review reporting. Query the canonical validated Code Review findings, finalize the standalone Code Review report, and submit the phase handoff. Do not use Pentest report tools.',
};

export const resolveStoredMissionEnvelopeNodes = (value: unknown): MissionEnvelopeNode[] => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'missions' in value) {
    return normalizeMissionEnvelopeNodes((value as { missions?: unknown }).missions);
  }
  return normalizeMissionEnvelopeNodes(value);
};

export const ensureRunArtifactRoot = async (
  workspaceDir: string,
  missions: readonly MissionEnvelopeNode[],
): Promise<void> => {
  const phases = new Set(
    attachMissionPhases(missions)
      .map((mission) => mission.phase)
      .filter((phase): phase is RunPhaseKey => Boolean(phase)),
  );
  const artifactRoot = path.resolve(workspaceDir, '.artifacts');
  await ensureSandboxWritableDirectory(path.resolve(artifactRoot, 'scans'));
  await ensureSandboxWritableDirectory(path.resolve(artifactRoot, 'report'));
  await ensureSandboxWritableDirectory(path.resolve(workspaceDir, '.artifacts', 'phase-handoffs'));
  await ensureSandboxWritableDirectory(path.resolve(workspaceDir, '.artifacts', 'phase-checkpoints'));
  for (const phase of phases) {
    await ensureSandboxWritableDirectory(path.resolve(workspaceDir, '.artifacts', 'phases', phase));
  }
  await fs.writeFile(
    path.resolve(artifactRoot, 'README.md'),
    [
      '# Run Workspace Layout',
      '',
      'All agents in this run share this workspace.',
      '',
      '- .artifacts/scans/: scanner output for ingest_scan_artifact auto-discovery.',
      '- .artifacts/phases/<phase>/: phase-owned working artifacts.',
      '- .artifacts/phase-handoffs/: structured phase handoff JSON.',
      '- .artifacts/report/: final report outputs.',
      '',
      'Workers may write only inside their delegated write scope. Use /workspace/... paths in evidenceRefs.',
      '',
    ].join('\n'),
    'utf8',
  );
};

export type PhaseHandoffPayload = {
  status?: string;
  summary?: string;
  artifacts?: unknown;
  canonicalWrites?: unknown;
  evidenceRefs?: unknown;
  unresolvedQuestions?: unknown;
  validationQueue?: unknown;
  validationTargets?: unknown;
  recommendedNextPhase?: string;
  recommendedNextSkills?: unknown;
  closeoutOutcome?: string;
  replanRequest?: {
    needed?: boolean;
    reason?: string;
  };
  operatorActionRequired?: {
    needed?: boolean;
    request?: string;
  };
};

export type PhaseCheckpointPayload = {
  summary?: string;
  completedObjectives?: unknown;
  pendingObjectives?: unknown;
  canonicalWrites?: unknown;
  evidenceRefs?: unknown;
  nextSuggestedAction?: string;
};

export const phaseHandoffTerminalStatus = (
  payload: PhaseHandoffPayload | null,
): 'completed' | 'blocked' | 'failed' => {
  if (payload?.status === 'blocked' || payload?.status === 'failed') {
    return payload.status;
  }
  return 'completed';
};

export const buildPhasePlanSeed = (
  missions: readonly MissionEnvelopeNode[],
  stepIds: readonly string[],
  planDocument?: string | null,
): PlanItem[] => {
  const idSet = new Set(stepIds);
  const missionPlan = missions
    .filter((mission) => idSet.has(mission.id))
    .map((mission) => ({
      id: mission.id,
      title: mission.question || mission.id,
      status: 'pending' as const,
      notes: mission.whyReadyNow,
      mission,
    }));
  if (missionPlan.length > 0) {
    return missionPlan;
  }

  const parsedPlan = parseApprovedPlanItems(planDocument ?? '');
  if (parsedPlan.length === 0) {
    return [];
  }
  if (idSet.size === 0) {
    return parsedPlan;
  }

  const selectedPlan = parsedPlan.filter((item) => idSet.has(item.id));
  return selectedPlan.length > 0 ? selectedPlan : parsedPlan;
};

const uniqueStrings = (values: readonly string[]): string[] => Array.from(new Set(values));

const formatPhaseMissionLines = (
  missions: readonly MissionEnvelopeNode[],
  fallback: string,
): string => {
  if (missions.length === 0) {
    return fallback;
  }

  return missions.map((mission) => [
    `- ${mission.id}: ${mission.question}`,
    mission.whyReadyNow ? `  why_ready_now: ${mission.whyReadyNow}` : '',
    mission.requiredEvidence.length > 0 ? `  required_evidence: ${mission.requiredEvidence.join('; ')}` : '',
    mission.expectedArtifact ? `  expected_artifact: ${mission.expectedArtifact}` : '',
    mission.stopCondition ? `  stop_condition: ${mission.stopCondition}` : '',
  ].filter(Boolean).join('\n')).join('\n');
};

export const summarizeHandoffPayload = (payload: PhaseHandoffPayload | null): string =>
  payload
    ? JSON.stringify({
        status: payload.status,
        summary: payload.summary,
        artifacts: payload.artifacts,
        canonicalWrites: payload.canonicalWrites,
        evidenceRefs: payload.evidenceRefs,
        unresolvedQuestions: payload.unresolvedQuestions,
        validationQueue: payload.validationQueue,
        validationTargets: payload.validationTargets,
        recommendedNextPhase: payload.recommendedNextPhase,
        recommendedNextSkills: payload.recommendedNextSkills,
        closeoutOutcome: payload.closeoutOutcome,
        replanRequest: payload.replanRequest,
        operatorActionRequired: payload.operatorActionRequired,
      }, null, 2)
    : 'No prior phase handoff artifact was available. Use canonical query tools to reconstruct required context.';

const summarizeValidationTargets = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) {
    return 'No prior-phase validation targets were provided.';
  }
  return value
    .slice(0, 25)
    .map((target, index) => {
      if (!isRecord(target)) {
        return `${index + 1}. ${String(target)}`;
      }
      const method = typeof target.method === 'string' ? target.method.toUpperCase() : undefined;
      const pathValue =
        typeof target.path === 'string'
          ? target.path
          : typeof target.url === 'string'
            ? target.url
            : typeof target.target === 'string'
              ? target.target
              : 'target unspecified';
      const riskFamily =
        typeof target.riskFamily === 'string'
          ? target.riskFamily
          : typeof target.risk_family === 'string'
            ? target.risk_family
            : undefined;
      const hypothesis = typeof target.hypothesis === 'string' ? target.hypothesis : undefined;
      return [
        `${index + 1}. ${riskFamily ? `riskFamily=${riskFamily} ` : ''}${method ? `${method} ` : ''}${pathValue}`,
        hypothesis ? `   hypothesis: ${hypothesis}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n');
};

const formatValidationLeadSummaries = (leads: readonly ValidationLeadSummary[]): string => {
  if (leads.length === 0) {
    return 'No open canonical validation leads were found.';
  }
  return leads
    .slice(0, 25)
    .map((lead, index) => {
      const target = [
        lead.method,
        lead.path ?? lead.target,
        lead.parameter ? `parameter=${lead.parameter}` : '',
      ].filter(Boolean).join(' ');
      return [
        `${index + 1}. leadId=${lead.id} riskFamily=${lead.riskFamily} priority=${lead.priority ?? 'unspecified'} status=${lead.status}`,
        target ? `   target: ${target}` : '',
        `   hypothesis: ${lead.hypothesis}`,
        lead.promptPath ? `   prompt: ${lead.promptPath}` : '',
        lead.promptSha256 ? `   promptSha256: ${lead.promptSha256}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n');
};

const riskFamilyTokens = (riskFamily: string): string[] => {
  const normalized = riskFamily.trim().toLowerCase();
  const tokens = normalized.split(/[-_.\s]+/u).filter(Boolean);
  const aliases: Record<string, string[]> = {
    idor: ['idor', 'authorization', 'object', 'tenant', 'ownership', 'access-control'],
    'access-control': ['access-control', 'authorization', 'role', 'permission'],
    'admin-boundary': ['admin-boundary', 'admin', 'authorization', 'privilege'],
    'broken-auth': ['broken-auth', 'auth', 'authentication', 'unauthenticated'],
    'mass-assignment': ['mass-assignment', 'assignment', 'body', 'parameter'],
    'sensitive-public-endpoint': ['sensitive-public-endpoint', 'sensitive', 'public', 'unauthenticated'],
    'unauthenticated-state-change': ['unauthenticated-state-change', 'unauthenticated', 'state-change', 'auth'],
  };
  return uniqueStrings([normalized, ...tokens, ...(aliases[normalized] ?? [])]);
};

const missionCoversRiskFamily = (mission: MissionEnvelopeNode, riskFamily: string): boolean => {
  const haystack = [
    mission.question,
    mission.whyReadyNow,
    mission.expectedArtifact,
    mission.stopCondition,
    ...mission.requiredEvidence,
    ...(mission.assignedSkills ?? []),
  ].join(' ').toLowerCase();
  return riskFamilyTokens(riskFamily).some((token) => token.length > 2 && haystack.includes(token));
};

export const remainingPlanCoversHighPriorityLeads = (
  plannedNextPhaseKey: RunPhaseKey,
  missions: readonly MissionEnvelopeNode[],
  signals: PhaseDiscoveryReplanSignals,
): boolean => {
  if (signals.openHighPriorityLeadFamilies.length === 0) {
    return true;
  }
  const validationMissions = missions.filter((mission) => mission.phase === 'validation');
  if (validationMissions.length === 0) {
    return false;
  }
  if (plannedNextPhaseKey !== 'validation' && plannedNextPhaseKey !== 'evidence') {
    return false;
  }
  return signals.openHighPriorityLeadFamilies.every((riskFamily) =>
    validationMissions.some((mission) => missionCoversRiskFamily(mission, riskFamily)),
  );
};

const formatPriorArtifactManifest = (lines: readonly string[]): string =>
  lines.length > 0
    ? lines.join('\n')
    : 'No prior-phase artifact manifest was available.';

export const runtimeSkillLoader = new SkillLoader();

export const buildPhaseReplanPrompt = (params: {
  phaseId: string;
  phaseKey: string;
  phaseStatus: string;
  handoffRef: string | null;
  replanReason: string;
  handoffSummary: string;
  currentPlan: string;
}): string =>
  [
    'A phase executor requested controlled replanning after submitting its phase handoff.',
    '',
    'You remain the canonical owner of the plan. The phase executor cannot mutate the phase graph. Review the accepted handoff, query current canonical state as needed, then call submit_plan with the revised user-facing plan, skillSlugs, and graph-lite missions for the remaining work. Keep completed phase history out of missions[] unless it must be repeated with a new hypothesis.',
    '',
    '=== REPLAN REQUEST ===',
    `phaseId: ${params.phaseId}`,
    `phase: ${params.phaseKey}`,
    `phaseStatus: ${params.phaseStatus}`,
    params.handoffRef ? `handoffRef: ${params.handoffRef}` : '',
    `reason: ${params.replanReason}`,
    '',
    '=== ACCEPTED PHASE HANDOFF ===',
    params.handoffSummary,
    '',
    '=== CURRENT APPROVED PLAN ===',
    params.currentPlan.trim() || 'No approved plan document is available.',
  ].filter((line) => line !== '').join('\n');

const summarizeCheckpointPayload = (payload: PhaseCheckpointPayload | null): string =>
  payload
    ? JSON.stringify({
        summary: payload.summary,
        completedObjectives: payload.completedObjectives,
        pendingObjectives: payload.pendingObjectives,
        canonicalWrites: payload.canonicalWrites,
        evidenceRefs: payload.evidenceRefs,
        nextSuggestedAction: payload.nextSuggestedAction,
      }, null, 2)
    : 'No checkpoint artifact is attached to this phase.';

export const buildFreshExecutionPhaseContext = (params: {
  phaseMissions: readonly MissionEnvelopeNode[];
  includeFactualLiveModel: boolean;
  phase: {
    id: string;
    ordinal: number;
    phaseKey: FreshExecutionPhaseKey;
    handoffInRef?: string | null;
    checkpointRef?: string | null;
  };
  handoffPayload: PhaseHandoffPayload | null;
  checkpointPayload: PhaseCheckpointPayload | null;
}): string => {
  const missionLines = formatPhaseMissionLines(
    params.phaseMissions,
    `- No ${params.phase.phaseKey} mission metadata was stored; use canonical state and the active phase contract.`,
  );

  return [
    '=== ACTIVE RUN PHASE ===',
    `phase: ${params.phase.phaseKey}`,
    `phaseId: ${params.phase.id}`,
    `ordinal: ${params.phase.ordinal}`,
    params.phase.handoffInRef ? `handoffInRef: ${params.phase.handoffInRef}` : '',
    params.phase.checkpointRef ? `checkpointRef: ${params.phase.checkpointRef}` : '',
    '',
    '=== PHASE PROMPT PROFILE ===',
    `The ${params.phase.phaseKey} Markdown prompt profile is the authoritative phase contract. Future phase instructions are intentionally omitted. Continue only from that profile, canonical state, artifacts, and handoff/checkpoint payloads.`,
    '',
    `=== ${params.phase.phaseKey.toUpperCase()} MISSIONS ===`,
    missionLines,
    '',
    '=== PRIOR PHASE HANDOFF ===',
    summarizeHandoffPayload(params.handoffPayload),
    '',
    '=== LATEST PHASE CHECKPOINT ===',
    summarizeCheckpointPayload(params.checkpointPayload),
    ...(params.includeFactualLiveModel
      ? [
          '',
          '=== WORKSPACE PROJECTION STATE ===',
          'The factual live model is recited in the system prompt. Use recon/surface.md, journal/coverage.md, journal/leads.md, findings/index.md, and canonical query tools only when the active mission needs more detail.',
          'Projection files are read-only. If a projection looks stale, use query_inventory, query_notes, or query_findings and mention the stale projection in submit_phase_handoff.',
        ]
      : []),
    '',
    '=== ARTIFACT VISIBILITY ===',
    'Shared durable artifacts are available under /workspace/.artifacts. Write new phase artifacts under /workspace/.artifacts/phases/' + params.phase.phaseKey + '/ and include durable refs in submit_phase_handoff.',
  ].filter((line) => line !== '').join('\n');
};

export const buildReportingPhaseContext = (params: {
  reportingMissions: readonly MissionEnvelopeNode[];
  phase: {
    id: string;
    ordinal: number;
    phaseKey: string;
    handoffInRef?: string | null;
  };
  handoffPayload: PhaseHandoffPayload | null;
}): string => {
  const missionLines = params.reportingMissions.length > 0
    ? params.reportingMissions.map((mission) => [
        `- ${mission.id}: ${mission.question}`,
        mission.whyReadyNow ? `  why_ready_now: ${mission.whyReadyNow}` : '',
        mission.requiredEvidence.length > 0 ? `  required_evidence: ${mission.requiredEvidence.join('; ')}` : '',
        mission.expectedArtifact ? `  expected_artifact: ${mission.expectedArtifact}` : '',
        mission.stopCondition ? `  stop_condition: ${mission.stopCondition}` : '',
      ].filter(Boolean).join('\n')).join('\n')
    : '- No reporting mission metadata was stored; use the approved plan and canonical report context.';

  const handoffSummary = params.handoffPayload
    ? JSON.stringify({
        status: params.handoffPayload.status,
        summary: params.handoffPayload.summary,
        artifacts: params.handoffPayload.artifacts,
        canonicalWrites: params.handoffPayload.canonicalWrites,
        evidenceRefs: params.handoffPayload.evidenceRefs,
        unresolvedQuestions: params.handoffPayload.unresolvedQuestions,
      }, null, 2)
    : 'No prior phase handoff artifact was available. Reconstruct closeout state from canonical query tools and prepare_report_context.';

  return [
    '=== ACTIVE RUN PHASE ===',
    `phase: ${params.phase.phaseKey}`,
    `phaseId: ${params.phase.id}`,
    `ordinal: ${params.phase.ordinal}`,
    params.phase.handoffInRef ? `handoffInRef: ${params.phase.handoffInRef}` : '',
    '',
    '=== REPORTING PHASE CONTRACT ===',
    'You are in a fresh reporting-only session. Use only reporting tools. Do not probe, scan, browse, exploit, or spawn workers.',
    'Use report_finalizer_preflight and prepare_report_context for canonical findings, evidence, limitations, and coverage. Do not read execution projections or credentials.',
    'Required order: report_finalizer_preflight -> if missingReportFieldBlockers are present, repair existing rows with report_finding(validatesFindingId=...) and rerun preflight -> prepare_report_context -> report_note(run.digest/report.section as needed) -> file_write summary.md/report.md -> submit_phase_handoff -> finalize_run_artifacts.',
    '',
    '=== REPORTING MISSIONS ===',
    missionLines,
    '',
    '=== PRIOR PHASE HANDOFF ===',
    handoffSummary,
  ].filter((line) => line !== '').join('\n');
};

export const buildValidationPhaseContext = (params: {
  validationMissions: readonly MissionEnvelopeNode[];
  queuedFindings: readonly { findingId: string; rationale: string | null }[];
  openValidationLeads: readonly ValidationLeadSummary[];
  priorArtifactManifestLines: readonly string[];
  phase: {
    id: string;
    ordinal: number;
    phaseKey: string;
    handoffInRef?: string | null;
  };
  handoffPayload: PhaseHandoffPayload | null;
}): string => {
  const missionLines = params.validationMissions.length > 0
    ? params.validationMissions.map((mission) => [
        `- ${mission.id}: ${mission.question}`,
        mission.whyReadyNow ? `  why_ready_now: ${mission.whyReadyNow}` : '',
        mission.requiredEvidence.length > 0 ? `  required_evidence: ${mission.requiredEvidence.join('; ')}` : '',
        mission.expectedArtifact ? `  expected_artifact: ${mission.expectedArtifact}` : '',
        mission.stopCondition ? `  stop_condition: ${mission.stopCondition}` : '',
      ].filter(Boolean).join('\n')).join('\n')
    : '- No validation mission metadata was stored; process the durable validation queue from canonical finding state.';

  const queueLines = params.queuedFindings.length > 0
    ? params.queuedFindings.map((item, index) =>
        `${index + 1}. findingId=${item.findingId}${item.rationale ? ` rationale=${item.rationale}` : ''}`,
      ).join('\n')
    : 'No queued findings are currently open.';

  const handoffSummary = params.handoffPayload
    ? JSON.stringify({
        status: params.handoffPayload.status,
        summary: params.handoffPayload.summary,
        artifacts: params.handoffPayload.artifacts,
        canonicalWrites: params.handoffPayload.canonicalWrites,
        evidenceRefs: params.handoffPayload.evidenceRefs,
        unresolvedQuestions: params.handoffPayload.unresolvedQuestions,
      }, null, 2)
    : 'No prior phase handoff artifact was available. Use canonical query tools to reconstruct validation context.';

  return [
    '=== ACTIVE RUN PHASE ===',
    `phase: ${params.phase.phaseKey}`,
    `phaseId: ${params.phase.id}`,
    `ordinal: ${params.phase.ordinal}`,
    params.phase.handoffInRef ? `handoffInRef: ${params.phase.handoffInRef}` : '',
    '',
    '=== VALIDATION PHASE CONTRACT ===',
    'You are in a fresh validation session. Execute the validation missions below. If queued findings are listed, validate them one at a time from canonical state and fresh evidence.',
    'The factual live model is recited in the system prompt. Use journal/leads.md, findings/index.md, query_findings, evidence refs, and artifacts for mission-specific detail; projections are not proof.',
    'For each queued finding: query_findings, reproduce independently, attach durable evidence, and call submit_validation_outcome. For each open validation lead: read its rendered prompt artifact, run the required probes, and call submit_validation_lead_outcome with the promptSha256. Free exploration without queued findings, rendered leads, or a blocker is not permitted.',
    'Read or explicitly waive high-signal prior artifacts before declaring no testable targets.',
    'When the queue is processed or materially blocked, call submit_phase_handoff with validationQueue containing unresolved finding ids if any remain.',
    '',
    '=== VALIDATION QUEUE ===',
    queueLines,
    '',
    '=== PRIOR PHASE ARTIFACTS ===',
    formatPriorArtifactManifest(params.priorArtifactManifestLines),
    '',
    '=== PRIORITY VALIDATION TARGETS FROM HANDOFF ===',
    summarizeValidationTargets(params.handoffPayload?.validationTargets),
    '',
    '=== OPEN CANONICAL VALIDATION LEADS ===',
    formatValidationLeadSummaries(params.openValidationLeads),
    '',
    '=== VALIDATION MISSIONS ===',
    missionLines,
    '',
    '=== PRIOR PHASE HANDOFF ===',
    handoffSummary,
  ].filter((line) => line !== '').join('\n');
};

export const DEFAULT_PLANNER_TOOL_POLICY: ToolAccessPolicy = {
  allow: [
    'submit_plan',
    'query_inventory',
    'query_findings',
    'query_notes',
    'list_relevant_skills',
    'file_read',
  ],
};

export const COMPLIANCE_PLANNER_TOOL_POLICY: ToolAccessPolicy = {
  allow: [
    'submit_plan',
    'query_compliance_readiness',
    'query_compliance_proof_package',
    'query_inventory',
    'query_findings',
    'file_read',
  ],
};

export const CODE_REVIEW_PLANNER_TOOL_POLICY: ToolAccessPolicy = {
  allow: [
    'submit_plan',
    'file_read',
    'list_code_review_repository_files',
    'search_code_review_repository',
    'read_connected_repository_file',
  ],
};

/**
 * Verification runs answer one question about one asset.
 *
 * Narrower than the planner policy on purpose. The dashboard-tier customer is
 * explicitly not buying a pentest, so a Verify click must not be able to start
 * one: without a restricted policy the run can reach the full planner surface,
 * and the cost argument that makes one-click verification affordable disappears.
 *
 * `submit_exposure_verification` is the terminal action — the run exists to
 * reach it.
 */
export const CVE_VERIFICATION_TOOL_POLICY: ToolAccessPolicy = {
  allow: [
    'http_payload',
    'file_read',
    'file_write',
    'submit_exposure_verification',
  ],
  deny: [
    // No planning, no delegation, no shell. A verification that can spawn
    // workers or open a shell is a pentest wearing a different name.
    'submit_plan',
    'spawn_worker',
    'continue_worker',
    'stop_worker',
    'wait_for_worker',
    'submit_worker_result',
    'shell_run',
    'wait_for_shell_job',
    'ingest_scan_artifact',
  ],
};

export const buildPlannerToolPolicy = (
  _scopeContext: Pick<ScopeContext, 'whiteboxEnabled' | 'connectedRepoCount'>,
  basePolicy: ToolAccessPolicy | undefined = DEFAULT_PLANNER_TOOL_POLICY,
): ToolAccessPolicy => {
  return {
    ...(basePolicy ?? {}),
    allow: uniqueStrings(basePolicy?.allow ?? []),
  };
};

const inferFocusedAssetType = (value: string): string => {
  const normalized = value.trim();
  if (/^https?:\/\//iu.test(normalized)) return 'url';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(normalized)) return 'ip';
  return 'domain';
};

/**
 * Keep the scope's enforceable restrictions while projecting only the asset a
 * focused verification may test. Durable scope and backend authorization are
 * unchanged; this only prevents a wider campaign from entering the prompt.
 */
export const focusScopeContextOnAsset = (
  scope: ScopeContext,
  asset: { value: string; type?: string | null } | null | undefined,
): ScopeContext => {
  const value = asset?.value.trim() ?? '';
  return {
    ...scope,
    targets: value
      ? [{ type: asset?.type?.trim() || inferFocusedAssetType(value), value, verified: true }]
      : [],
    mission: null,
  };
};

export const SOLO_EXECUTOR_TOOL_POLICY: ToolAccessPolicy = {
  deny: [
    'submit_plan',
    'spawn_worker',
    'continue_worker',
    'stop_worker',
    'wait_for_worker',
    'submit_worker_result',
  ],
};
