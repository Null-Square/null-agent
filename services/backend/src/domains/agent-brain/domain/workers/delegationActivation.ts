import type {
  MissionEnvelope,
  PlanItem,
  SessionState,
  WorkerDependencyMode,
  WorkerRunMode,
  WorkerType,
} from '../types';
import { normalizeWorkerType, OPENING_WAVE_PREFERRED_CAP } from './workerContracts';
import {
  collectDiscoveryPlanTitles,
  extractPlanMarkdownFromExtraContext,
  parseApprovedPlanItems,
  selectStartingPlanTask,
} from './planTaskSelection';

const ASSIGNED_SKILLS_HEADER = '=== ASSIGNED METHODOLOGIES ===';
const ASSIGNED_SKILL_LINE = /^-\s+([a-z0-9][a-z0-9-]*):\s+\/workspace\/\.skills\/[^\s]+\/methodology\.md\s*$/;

const HOSTNAME_PATTERN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const COMPONENT_HINT_PATTERNS: Array<[string, RegExp]> = [
  ['wordpress', /\bwordpress|wp[- ]/i],
  ['phpmyadmin', /\bphpmyadmin/i],
  ['jenkins', /\bjenkins/i],
  ['grafana', /\bgrafana/i],
  ['gitlab', /\bgitlab/i],
  ['confluence', /\bconfluence/i],
  ['jira', /\bjira/i],
  ['actuator', /\bactuator/i],
  ['swagger', /\bswagger|openapi|api[_ -]?docs/i],
  ['graphql', /\bgraphql/i],
  ['admin-panel', /\badmin\s*(panel|console)|\/admin\b|\/console\b/i],
  ['auth-surface', /\boauth|sso|jwt|\btoken endpoint|\blogin endpoint/i],
];
const DISCOVERY_TITLE_PATTERN =
  /(attack surface|surface scan|broad surface|broad scan|recon|discover|enumerat|mapping|fingerprint|inventory|crawl|dirbust|content discovery|tech fingerprint|endpoint discovery)/i;

export type AssignedSkillsTraceSnapshot = {
  detected: boolean;
  slugs: string[];
  versions: Record<string, string>;
  blockLength: number;
};

export type DelegationRecommendation = {
  workerType: WorkerType;
  reason: string;
  confidence: 'suggested' | 'strong';
  executionMode: WorkerRunMode;
  dependencyMode: WorkerDependencyMode;
  suggestedTarget?: string;
  /** Stable independence key so consumers can distinguish parallel branches. */
  independenceKey?: string;
  /** Plan step id that spawned this recommendation, when it maps to one. */
  planStepId?: string;
  /** Exact structured mission to pass through to spawn_worker. */
  mission?: MissionEnvelope;
};

export type DelegationActivationHint = {
  shouldPrompt: boolean;
  confidence: 'none' | 'suggested' | 'strong';
  reasons: string[];
  recommendations: DelegationRecommendation[];
  /** @deprecated Use recommendations[] instead */
  recommendedWorkerType?: WorkerType;
  /** @deprecated Use recommendations[] instead */
  recommendedExecutionMode?: WorkerRunMode;
  /** @deprecated Use recommendations[] instead */
  recommendedDependencyMode?: WorkerDependencyMode;
  assignedSkillSlugs: string[];
  discoveryPlanTitles: string[];
  /**
   * True when the parent executor has not yet spawned any worker in this run and
   * at least two independent discovery/mapping tasks are pending. Consumers
   * use this to render the first-wave parallel-spawn guidance.
   */
  openingWave: boolean;
  /**
   * Preferred concurrency cap for the opening wave, bounded by budget when the
   * caller passed a budget hint in `evaluateDelegationActivation`.
   */
  maxConcurrency?: number;
};

const unique = (values: string[]): string[] => Array.from(new Set(values));

const splitLines = (value: string): string[] => value.split(/\r?\n/);

export const parseAssignedSkillsFromExtraContext = (
  extraContext: string | undefined,
): AssignedSkillsTraceSnapshot => {
  if (!extraContext || extraContext.trim().length === 0) {
    return { detected: false, slugs: [], versions: {}, blockLength: 0 };
  }

  const headerIndex = extraContext.indexOf(ASSIGNED_SKILLS_HEADER);
  if (headerIndex < 0) {
    return { detected: false, slugs: [], versions: {}, blockLength: 0 };
  }

  const afterHeader = extraContext.slice(headerIndex + ASSIGNED_SKILLS_HEADER.length);
  const nextSectionMatch = afterHeader.match(/\r?\n=== [A-Z0-9 _-]+ ===/);
  const block = (nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader).trim();
  const slugs = new Set<string>();
  const versions: Record<string, string> = {};
  for (const rawLine of splitLines(block)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    const slugMatch = rawLine.match(ASSIGNED_SKILL_LINE);
    if (slugMatch) {
      slugs.add(slugMatch[1]);
    }
  }

  return {
    detected: true,
    slugs: Array.from(slugs),
    versions,
    blockLength: block.length,
  };
};

const isDiscoveryTitle = (title: string | undefined): boolean =>
  typeof title === 'string' && DISCOVERY_TITLE_PATTERN.test(title);

const extractHostname = (title: string | undefined, notes: string | undefined): string | undefined => {
  const text = `${title ?? ''} ${notes ?? ''}`;
  const matches = text.match(HOSTNAME_PATTERN);
  if (!matches || matches.length === 0) {
    return undefined;
  }
  return matches[0].toLowerCase();
};

const extractComponentHint = (title: string | undefined, notes: string | undefined): string | undefined => {
  const text = `${title ?? ''} ${notes ?? ''}`;
  for (const [label, pattern] of COMPONENT_HINT_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return undefined;
};

const independenceKeyForStep = (step: PlanItem): string => {
  const host = extractHostname(step.title, step.notes);
  const component = extractComponentHint(step.title, step.notes);
  if (host && component) {
    return `${host}::${component}`;
  }
  if (host) {
    return `host:${host}`;
  }
  if (component) {
    return `component:${component}`;
  }
  return `step:${step.id}`;
};

const summarizeStepForWorker = (step: PlanItem): string => {
  const title = typeof step.title === 'string' ? step.title.trim() : '';
  return title.length > 0 ? title : `plan step ${step.id}`;
};

const isPendingDiscoveryStep = (step: PlanItem): boolean =>
  (step.status === 'pending' || step.status === 'running') && isDiscoveryTitle(step.title);

/**
 * Build one recommendation per independent pending discovery plan item. This
 * lets the parent executor fan out into parallel background workers in the opening
 * wave instead of serializing through a single blocking recon.
 */
const buildOpeningWaveDiscoveryRecommendations = (
  pendingDiscovery: PlanItem[],
  maxConcurrency: number | undefined,
): DelegationRecommendation[] => {
  if (pendingDiscovery.length === 0) {
    return [];
  }

  const seen = new Map<string, DelegationRecommendation>();
  for (const step of pendingDiscovery) {
    const key = independenceKeyForStep(step);
    if (seen.has(key)) {
      continue;
    }
    seen.set(key, {
      workerType: 'recon_worker',
      reason: `pending discovery step "${summarizeStepForWorker(step)}" — delegate to a background recon_worker so the parent can fan out across independent branches`,
      confidence: 'strong',
      executionMode: 'background',
      dependencyMode: 'sidecar',
      independenceKey: key,
      planStepId: step.id,
      ...(extractHostname(step.title, step.notes)
        ? { suggestedTarget: extractHostname(step.title, step.notes)! }
        : {}),
    });
  }

  const recommendations = Array.from(seen.values());
  if (typeof maxConcurrency === 'number' && maxConcurrency > 0) {
    return recommendations.slice(0, maxConcurrency);
  }
  return recommendations;
};

const enumerationStepsAreParallelSafe = (left: PlanItem, right: PlanItem): boolean => {
  const leftRefs = new Set(left.mission?.enumeration?.surface.refs ?? []);
  const overlap = (right.mission?.enumeration?.surface.refs ?? []).some((ref) => leftRefs.has(ref));
  if (!overlap) {
    return true;
  }
  return (
    (left.mission?.parallelSafeWith ?? []).includes(right.id) &&
    (right.mission?.parallelSafeWith ?? []).includes(left.id)
  );
};

const buildOpeningWaveEnumerationRecommendations = (
  plan: PlanItem[],
  eligibleStepIds: ReadonlySet<string>,
  maxConcurrency: number | undefined,
): DelegationRecommendation[] => {
  const candidates = plan.filter(
    (step) =>
      (step.status === 'pending' || step.status === 'running') &&
      step.mission?.phase === 'enumeration' &&
      step.mission.enumeration?.kind === 'enumeration_hunt_v1' &&
      eligibleStepIds.has(step.id),
  );
  if (candidates.length < 2) {
    return [];
  }

  const selected: PlanItem[] = [];
  const fingerprints = new Set<string>();
  for (const candidate of candidates) {
    const fingerprint = candidate.mission?.enumeration?.missionFingerprint;
    if (
      !fingerprint ||
      fingerprints.has(fingerprint) ||
      selected.some((existing) => !enumerationStepsAreParallelSafe(existing, candidate))
    ) {
      continue;
    }
    selected.push(candidate);
    fingerprints.add(fingerprint);
    if (typeof maxConcurrency === 'number' && selected.length >= maxConcurrency) {
      break;
    }
  }
  if (selected.length < 2) {
    return [];
  }
  return selected.map((step) => ({
    workerType: 'enumeration_worker',
    reason:
      `structured enumeration_hunt_v1 plan step "${summarizeStepForWorker(step)}" is bounded, ` +
      'version-pinned, and independent from the other opening-wave surfaces',
    confidence: 'strong',
    executionMode: 'background',
    dependencyMode: 'sidecar',
    independenceKey: `enumeration:${step.mission!.enumeration!.missionFingerprint}`,
    planStepId: step.id,
    suggestedTarget: step.mission!.enumeration!.targetRef,
    mission: step.mission,
  }));
};

export interface EvaluateDelegationActivationArgs {
  session: Pick<
    SessionState,
    | 'agentType'
    | 'coordination'
    | 'extraContext'
    | 'plan'
    | 'workerTasks'
    | 'executionMode'
    | 'memory'
  >;
  /**
   * Optional budget-aware concurrency cap (computed via
   * `resolveOpeningWaveConcurrency`). When provided, the first-wave
   * recommendations are truncated to this count.
   */
  maxConcurrency?: number;
  enumerationWorkerEnabled?: boolean;
  enumerationAutoEligiblePlanStepIds?: readonly string[];
}

export function evaluateDelegationActivation(
  args: EvaluateDelegationActivationArgs,
): DelegationActivationHint;
/** @deprecated Pass `{ session }` instead. */
export function evaluateDelegationActivation(
  session: Pick<
    SessionState,
    'agentType' | 'coordination' | 'extraContext' | 'plan' | 'workerTasks' | 'executionMode' | 'memory'
  >,
): DelegationActivationHint;
export function evaluateDelegationActivation(
  arg:
    | EvaluateDelegationActivationArgs
    | Pick<
        SessionState,
        | 'agentType'
        | 'coordination'
        | 'extraContext'
        | 'plan'
        | 'workerTasks'
        | 'executionMode'
        | 'memory'
      >,
): DelegationActivationHint {
  const {
    session,
    maxConcurrency,
    enumerationWorkerEnabled,
    enumerationAutoEligiblePlanStepIds,
  } =
    arg && typeof arg === 'object' && 'session' in arg
      ? (arg as EvaluateDelegationActivationArgs)
      : {
          session: arg as EvaluateDelegationActivationArgs['session'],
          maxConcurrency: undefined,
          enumerationWorkerEnabled: false,
          enumerationAutoEligiblePlanStepIds: [],
        };

  const empty: DelegationActivationHint = {
    shouldPrompt: false,
    confidence: 'none',
    reasons: [],
    recommendations: [],
    assignedSkillSlugs: [],
    discoveryPlanTitles: [],
    openingWave: false,
  };

  if (session.agentType !== 'executor' || session.coordination?.role === 'worker') {
    return empty;
  }

  const assignedSkills = parseAssignedSkillsFromExtraContext(session.extraContext);
  const assignedSkillSlugs = assignedSkills.slugs;
  const effectivePlan = Array.isArray(session.plan) && session.plan.length > 0
    ? session.plan
    : parseApprovedPlanItems(extractPlanMarkdownFromExtraContext(session.extraContext) ?? '');
  const currentTask = selectStartingPlanTask({
    plan: effectivePlan,
    skillSlugs: assignedSkillSlugs,
  });
  const existingWorkerTasks = Array.isArray(session.workerTasks) ? session.workerTasks : [];
  const canonicalWorkerTasks = existingWorkerTasks
    .map((task) => ({
      ...task,
      canonicalWorkerType: normalizeWorkerType(task.workerType),
    }))
    .filter((task) => task.canonicalWorkerType);
  const hasReconCoverage = canonicalWorkerTasks.some(
    (task) =>
      task.canonicalWorkerType === 'recon_worker' &&
      (task.status === 'running' || task.status === 'pending' || task.status === 'completed'),
  );
  const hasEvidenceCoverage = canonicalWorkerTasks.some(
    (task) =>
      task.canonicalWorkerType === 'evidence_worker' &&
      (task.status === 'running' || task.status === 'pending' || task.status === 'completed'),
  );
  const hasValidatorCoverage = canonicalWorkerTasks.some(
    (task) =>
      task.canonicalWorkerType === 'validator_worker' &&
      (task.status === 'running' || task.status === 'pending' || task.status === 'completed'),
  );
  const hasAnySettledWorker = existingWorkerTasks.some(
    (task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled',
  );
  const hasAnyRunningWorker = existingWorkerTasks.some(
    (task) => task.status === 'running' || task.status === 'pending',
  );
  const noWorkersSpawnedYet = existingWorkerTasks.length === 0;

  const recommendations: DelegationRecommendation[] = [];
  const reasons: string[] = [];
  const currentTaskMode = currentTask?.executionMode;
  const currentTaskTitle = currentTask?.title;

  // ---------------------------------------------------------------------------
  // Opening-wave fan-out: when the run has not yet spawned any worker AND the
  // plan contains multiple independent pending discovery tasks, surface one
  // recommendation per independent branch so the parent executor spawns them in
  // parallel (background/sidecar) instead of serializing.
  // ---------------------------------------------------------------------------
  const pendingDiscoverySteps = effectivePlan.filter(isPendingDiscoveryStep);
  const explicitMaxConcurrency =
    typeof maxConcurrency === 'number' && Number.isFinite(maxConcurrency)
      ? Math.max(0, Math.floor(maxConcurrency))
      : undefined;
  const backgroundDelegationAllowed = explicitMaxConcurrency === undefined || explicitMaxConcurrency > 0;
  const effectiveMaxConcurrency = explicitMaxConcurrency ?? OPENING_WAVE_PREFERRED_CAP;
  const enumerationOpeningWaveRecommendations =
    backgroundDelegationAllowed && noWorkersSpawnedYet && enumerationWorkerEnabled === true
      ? buildOpeningWaveEnumerationRecommendations(
          effectivePlan,
          new Set(enumerationAutoEligiblePlanStepIds ?? []),
          effectiveMaxConcurrency,
        )
      : [];
  const openingWaveRecommendations = enumerationOpeningWaveRecommendations.length >= 2
    ? enumerationOpeningWaveRecommendations
    : backgroundDelegationAllowed && noWorkersSpawnedYet && pendingDiscoverySteps.length >= 2
      ? buildOpeningWaveDiscoveryRecommendations(pendingDiscoverySteps, effectiveMaxConcurrency)
      : [];
  const openingWave = openingWaveRecommendations.length >= 2;

  if (openingWave) {
    recommendations.push(...openingWaveRecommendations);
    if (enumerationOpeningWaveRecommendations.length >= 2) {
      reasons.push(
        `plan has ${enumerationOpeningWaveRecommendations.length} eligible structured enumeration missions with independent surfaces`,
      );
    } else {
    reasons.push(
      `plan has ${pendingDiscoverySteps.length} pending discovery tasks — fan out in parallel across ${openingWaveRecommendations.length} independent branches`,
    );
    }
  } else if (
    backgroundDelegationAllowed &&
    (currentTaskMode === 'discovery' || enumerationWorkerEnabled === true) &&
    !hasReconCoverage
  ) {
    // Single pending discovery step, OR we are in the enumeration phase with no
    // recon coverage yet: default to a background recon/mapping worker so the
    // parent keeps synthesizing while a bounded worker widens the surface.
    // Enumeration used to fan out into recon workers; B2 rerouted the phase
    // through the default-off enumeration_worker, which left it with no active
    // hunter whenever the structured enumeration_hunt_v1 wave finds no candidates.
    const enumerationMappingPass =
      currentTaskMode !== 'discovery' && enumerationWorkerEnabled === true;
    recommendations.push({
      workerType: 'recon_worker',
      reason: enumerationMappingPass
        ? 'enumeration phase has no recon coverage yet — delegate a bounded mapping/hunt pass to a background recon_worker and keep synthesizing while it runs'
        : typeof currentTaskTitle === 'string'
          ? `current plan step "${currentTaskTitle}" is discovery-oriented — delegate the mapping pass to a background recon_worker and keep synthesizing while it runs`
          : 'current plan step is discovery-oriented — delegate the mapping pass to a background recon_worker and keep synthesizing while it runs',
      confidence: 'strong',
      executionMode: 'background',
      dependencyMode: 'sidecar',
      ...(currentTask?.stepId ? { planStepId: currentTask.stepId } : {}),
    });
    reasons.push(
      enumerationMappingPass
        ? 'enumeration phase has no recon coverage yet'
        : typeof currentTaskTitle === 'string'
          ? `current plan step is discovery-oriented: ${currentTaskTitle}`
          : 'current plan step is discovery-oriented',
    );
  } else if (currentTaskMode === 'validation' && !hasValidatorCoverage && !hasAnyRunningWorker) {
    // Targeted validation genuinely gates the next parent decision: keep
    // blocking/dependency semantics so the parent waits for the yes/no
    // before acting on the finding path.
    recommendations.push({
      workerType: 'validator_worker',
      reason:
        typeof currentTaskTitle === 'string'
          ? `current plan step "${currentTaskTitle}" is targeted validation — use a validator_worker when you need an independent yes/no reproduction result`
          : 'current plan step is targeted validation — use a validator_worker when you need an independent yes/no reproduction result',
      confidence: 'suggested',
      executionMode: 'blocking',
      dependencyMode: 'dependency',
      ...(currentTask?.stepId ? { planStepId: currentTask.stepId } : {}),
    });
    reasons.push(
      typeof currentTaskTitle === 'string'
        ? `current plan step is targeted validation: ${currentTaskTitle}`
        : 'current plan step is targeted validation',
    );
  } else if (
    backgroundDelegationAllowed &&
    session.executionMode === 'discovery' &&
    !hasAnyRunningWorker &&
    !hasAnySettledWorker
  ) {
    recommendations.push({
      workerType: 'recon_worker',
      reason: 'session is in discovery mode with no worker coverage yet — a bounded recon worker can widen coverage without scripting the whole run',
      confidence: 'suggested',
      executionMode: 'background',
      dependencyMode: 'sidecar',
    });
    reasons.push('session execution mode is discovery and no worker coverage exists yet');
  }

  if (
    backgroundDelegationAllowed &&
    (currentTaskMode === 'evidence' || session.executionMode === 'evidence') &&
    existingWorkerTasks.some((task) => task.status === 'completed') &&
    !hasEvidenceCoverage
  ) {
    recommendations.push({
      workerType: 'evidence_worker',
      reason: 'completed worker artifacts exist and the session is in evidence mode — use an evidence worker only if bounded synthesis would materially help the parent',
      confidence: 'suggested',
      executionMode: 'background',
      dependencyMode: 'sidecar',
    });
    reasons.push('completed worker artifacts exist during evidence-mode work');
  }

  const highConfidenceVulnFacts = (session.memory?.discoveredFacts ?? []).filter(
    (fact) => fact.category === 'vulnerability' && fact.confidence >= 0.7,
  );
  if (highConfidenceVulnFacts.length > 0 && !hasValidatorCoverage) {
    recommendations.push({
      workerType: 'validator_worker',
      reason: 'high-confidence vulnerability candidate in memory with no validator coverage — spawn a validator_worker to reproduce independently before calling report_finding',
      confidence: 'strong',
      executionMode: 'blocking',
      dependencyMode: 'dependency',
    });
    reasons.push('high-confidence vulnerability finding candidate exists with no validator coverage');
  }

  const shouldPrompt = recommendations.length > 0;
  const hasStrongRec = recommendations.some((recommendation) => recommendation.confidence === 'strong');
  const confidence: DelegationActivationHint['confidence'] = hasStrongRec
    ? 'strong'
    : shouldPrompt
      ? 'suggested'
      : 'none';
  const primary = recommendations.find((recommendation) => recommendation.confidence === 'strong') ?? recommendations[0];

  return {
    shouldPrompt,
    confidence,
    reasons: unique(reasons),
    recommendations,
    recommendedWorkerType: primary?.workerType,
    recommendedExecutionMode: primary?.executionMode,
    recommendedDependencyMode: primary?.dependencyMode,
    assignedSkillSlugs,
    discoveryPlanTitles: collectDiscoveryPlanTitles(effectivePlan),
    openingWave,
    ...(typeof maxConcurrency === 'number' ? { maxConcurrency } : {}),
  };
}

export const renderDelegationActivationGuidance = (
  hint: DelegationActivationHint,
): string => {
  if (!hint.shouldPrompt || hint.recommendations.length === 0) {
    return '';
  }

  const lines = [
    `- This run matches ${hint.confidence === 'strong' ? 'high-confidence' : 'useful'} delegation patterns.`,
    ...hint.reasons.map((reason) => `- Signal: ${reason}.`),
  ];

  if (hint.openingWave) {
    const cap =
      typeof hint.maxConcurrency === 'number' && hint.maxConcurrency > 0
        ? Math.min(hint.recommendations.length, hint.maxConcurrency)
        : hint.recommendations.length;
    lines.push(
      '',
      `**Opening wave:** spawn ${cap} worker${cap === 1 ? '' : 's'} in parallel in your next response using executionMode="background" and dependencyMode="sidecar". Do not call wait_for_worker between spawns — fire them all, then let the results come back.`,
    );
  }

  lines.push('', 'Recommended delegations (strongest first):');

  for (const recommendation of hint.recommendations) {
    const target = recommendation.suggestedTarget ? ` against ${recommendation.suggestedTarget}` : '';
    const step = recommendation.planStepId ? ` [plan step ${recommendation.planStepId}]` : '';
    const mission =
      recommendation.mission
        ? ' Pass that plan step mission unchanged, including the enumeration contract and fingerprint.'
        : '';
    lines.push(
      `- [${recommendation.confidence}] spawn_worker(workerType="${recommendation.workerType}", executionMode="${recommendation.executionMode}", dependencyMode="${recommendation.dependencyMode}")${target}${step}`,
      `  Reason: ${recommendation.reason}.${mission}`,
    );
  }

  lines.push(
    '',
    '- These are nudges, not a worker script. Choose the role because its tool and context profile fit the task, then specialize the mission in the task description.',
    '- Use blocking/dependency only when the worker result truly gates the next parent decision (e.g. targeted validation). For independent discovery branches, default to background/sidecar.',
    '- Stay direct when the next action is trivially short, tightly coupled to your own synthesis, or faster than spinning up a worker.',
  );

  return lines.join('\n');
};
