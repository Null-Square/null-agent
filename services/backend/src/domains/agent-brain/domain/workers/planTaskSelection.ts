import type { PlanItem } from '../types';
import type { MissionEnvelope, MissionPhaseKey } from '../types';
import {
  normalizeMissionEnvelopeNodes,
  type MissionEnvelopeNode,
} from './missionEnvelope';

export type PlanExecutionMode = 'discovery' | 'validation' | 'evidence';

export type SelectedPlanTask = {
  title: string;
  executionMode: PlanExecutionMode;
  reason: string;
  source: 'structured_plan' | 'plan_markdown' | 'skill_hint';
  stepId?: string;
  ordinal?: number;
  mission?: MissionEnvelope;
};

const TASK_LINE_PATTERNS = [
  /^\d+\.\s+(.+)$/,
  /^task\s+\d+\s*[:.-]\s*(.+)$/i,
  /^[-*+]\s+\[(?: |x|X)\]\s+(.+)$/,
];

const BULLET_TASK_PATTERN = /^[-*+]\s+(.+)$/;
const SECTION_HEADING_PATTERN = /^##+\s+(.+)$/;
const ACTIONABLE_SECTION_PATTERN =
  /^(tasks?|steps?|plan|execution plan|workflow|approach|objectives?|phases?|test plan|validation plan|next steps?)$/i;
const ACTIONABLE_TASK_PATTERN =
  /^(build|execute|run|discover|scan|enumerat|map|fingerprint|crawl|collect|inspect|analy[sz]e|identify|develop|test|check|validate|verify|confirm|reproduce|probe|attempt|package|summari[sz]e|write|review|triage|exploit|report|document|pivot|assess|prioriti[sz]e|flag)\b/i;
const PLAN_METADATA_LABEL_PATTERN =
  /^(target|execution mode|execution environment|rules?|constraint|constraints|scope|goal|goals|context|asset|assets|host|hosts|domain|domains|environment|new hypothesis|assumptions?|notes?|prerequisites?|success criteria|out of scope)\s*:/i;
const TASK_LABEL_PREFIX_PATTERN = /^(?:tasks?|steps?|plan|workflow|approach|objectives?)\s*:\s*/i;
const MISSION_ENVELOPE_HEADING_PATTERN = /^##+\s+mission envelope\s*$/im;

const DISCOVERY_TASK_PATTERN =
  /(attack surface|surface scan|broad surface|broad scan|recon|discover|enumerat|mapping|fingerprint|inventory|crawl|dirbust|content discovery|tech fingerprint|endpoint discovery)/i;
const VALIDATION_TASK_PATTERN =
  /(validat|repro|confirm|verify|exploit|proof of concept|poc|idor|auth bypass|sqli|sql injection|xss|ssrf|rce|xxe|csrf|lfi|rfi|open redirect|cve-\d{4}-\d+|finding[_ -]?id)/i;
const EVIDENCE_TASK_PATTERN =
  /(evidence|package|synthesis|summar|report|remediation|cvss|cwe|writeup|triage|digest)/i;

const stripMarkdown = (value: string): string =>
  value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/, '')
    .trim();

const normalizeTaskText = (value: string): string => stripMarkdown(value).replace(/\s+/g, ' ').trim();

const normalizeTaskCandidate = (value: string): string =>
  normalizeTaskText(value.replace(TASK_LABEL_PREFIX_PATTERN, ''));

const isPlanMetadataLine = (value: string): boolean => PLAN_METADATA_LABEL_PATTERN.test(normalizeTaskText(value));

const inferExecutionModeFromText = (value: string): PlanExecutionMode => {
  const normalized = normalizeTaskText(value);
  if (VALIDATION_TASK_PATTERN.test(normalized)) {
    return 'validation';
  }
  if (EVIDENCE_TASK_PATTERN.test(normalized)) {
    return 'evidence';
  }
  if (DISCOVERY_TASK_PATTERN.test(normalized)) {
    return 'discovery';
  }
  return 'discovery';
};

const executionModeFromMissionPhase = (phase: MissionPhaseKey | undefined): PlanExecutionMode | undefined => {
  switch (phase) {
    case 'validation':
    case 'exploitation':
    case 'review_validation':
      return 'validation';
    case 'evidence':
    case 'reporting':
    case 'review_reporting':
      return 'evidence';
    case 'planning':
    case 'recon':
    case 'enumeration':
    case 'review_mapping':
    case 'review_analysis':
      return 'discovery';
    default:
      return undefined;
  }
};

const resolvePlanItemExecutionMode = (step: PlanItem): PlanExecutionMode =>
  executionModeFromMissionPhase(step.mission?.phase) ??
  inferExecutionModeFromText(`${step.title} ${step.notes ?? ''}`);

const isResumableBlockedStep = (step: PlanItem): boolean =>
  step.status === 'blocked' &&
  typeof step.blockedReason === 'string' &&
  step.blockedReason.includes('for resume');

const selectFirstEligiblePlanItem = (plan: PlanItem[]): PlanItem | undefined =>
  plan.find((step) => step.status === 'running') ??
  plan.find((step) => isResumableBlockedStep(step)) ??
  plan.find((step) => step.status === 'pending');

const shouldTreatBulletAsTask = (title: string, currentSection: string | null): boolean => {
  if (!title || isPlanMetadataLine(title)) {
    return false;
  }

  if (currentSection && ACTIONABLE_SECTION_PATTERN.test(currentSection)) {
    return true;
  }

  return (
    ACTIONABLE_TASK_PATTERN.test(title) ||
    DISCOVERY_TASK_PATTERN.test(title) ||
    VALIDATION_TASK_PATTERN.test(title) ||
    EVIDENCE_TASK_PATTERN.test(title)
  );
};

const appendTask = (
  items: PlanItem[],
  ordinal: number,
  title: string,
  notes: string[],
): void => {
  const normalizedTitle = normalizeTaskText(title);
  if (!normalizedTitle) {
    return;
  }

  const normalizedNotes = notes
    .map((note) => normalizeTaskText(note))
    .filter((note) => note.length > 0)
    .join(' ');

  items.push({
    id: `task-${ordinal}`,
    title: normalizedTitle,
    status: 'pending',
    ...(normalizedNotes ? { notes: normalizedNotes } : {}),
  });
};

export const parseMissionEnvelopeFromPlan = (planMarkdown: string): MissionEnvelopeNode[] => {
  const headingMatch = planMarkdown.match(MISSION_ENVELOPE_HEADING_PATTERN);
  if (!headingMatch || headingMatch.index === undefined) {
    return [];
  }

  const section = planMarkdown.slice(headingMatch.index);
  const fencedJson = section.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!fencedJson?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(fencedJson[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return normalizeMissionEnvelopeNodes((parsed as { missions?: unknown }).missions);
  } catch {
    return [];
  }
};

const attachMissionEnvelopes = (items: PlanItem[], planMarkdown: string): PlanItem[] => {
  const missions = parseMissionEnvelopeFromPlan(planMarkdown);
  if (missions.length === 0 || items.length === 0) {
    return items;
  }

  const missionsById = new Map(missions.map((mission) => [mission.id.trim().toLowerCase(), mission]));
  return items.map((item, index) => {
    const match = missionsById.get(item.id.trim().toLowerCase()) ?? missions[index];
    if (!match) {
      return item;
    }
    const { id: _id, ...mission } = match;
    return {
      ...item,
      mission,
    };
  });
};

export const planItemsFromMissionEnvelopeNodes = (missions: MissionEnvelopeNode[]): PlanItem[] =>
  missions.map((mission) => {
    const { id, ...normalizedMission } = mission;
    return {
      id,
      title: mission.question,
      status: 'pending',
      notes: mission.whyReadyNow,
      mission: normalizedMission,
    };
  });

export const parseApprovedPlanItems = (
  planMarkdown: string,
  missionEnvelopeNodes: MissionEnvelopeNode[] = [],
): PlanItem[] => {
  if (missionEnvelopeNodes.length > 0) {
    return planItemsFromMissionEnvelopeNodes(missionEnvelopeNodes);
  }

  const missions = parseMissionEnvelopeFromPlan(planMarkdown);
  if (missions.length > 0) {
    return planItemsFromMissionEnvelopeNodes(missions);
  }

  const items: PlanItem[] = [];
  const lines = planMarkdown.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  let insideCodeFence = false;
  let currentTitle: string | null = null;
  let currentNotes: string[] = [];
  let currentSection: string | null = null;
  let ordinal = 1;

  const flushCurrent = () => {
    if (!currentTitle) {
      return;
    }
    appendTask(items, ordinal, currentTitle, currentNotes);
    ordinal += 1;
    currentTitle = null;
    currentNotes = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    if (trimmed.startsWith('```')) {
      insideCodeFence = !insideCodeFence;
      continue;
    }
    if (insideCodeFence) {
      continue;
    }

    const headingMatch = trimmed.match(SECTION_HEADING_PATTERN);
    if (headingMatch) {
      flushCurrent();
      currentSection = normalizeTaskText(headingMatch[1]);
      continue;
    }

    const taskMatch = TASK_LINE_PATTERNS.find((pattern) => pattern.test(trimmed));
    if (taskMatch) {
      const match = trimmed.match(taskMatch);
      const taskTitle = match?.[1] ? normalizeTaskCandidate(match[1]) : '';
      if (!taskTitle || isPlanMetadataLine(taskTitle)) {
        continue;
      }
      flushCurrent();
      currentTitle = taskTitle;
      continue;
    }

    const bulletMatch = trimmed.match(BULLET_TASK_PATTERN);
    if (bulletMatch) {
      const taskTitle = normalizeTaskCandidate(bulletMatch[1]);
      if (!taskTitle) {
        continue;
      }
      if (shouldTreatBulletAsTask(taskTitle, currentSection)) {
        flushCurrent();
        currentTitle = taskTitle;
      }
      continue;
    }

    if (!currentTitle) {
      continue;
    }

    const normalizedLine = normalizeTaskText(trimmed);
    if (
      !normalizedLine ||
      /^#\s+/.test(trimmed) ||
      /^=== [A-Z0-9 _-]+ ===$/.test(trimmed) ||
      isPlanMetadataLine(normalizedLine)
    ) {
      continue;
    }
    currentNotes.push(normalizedLine);
  }

  flushCurrent();

  if (items.length === 0 && heading) {
    appendTask(items, 1, heading, []);
  }

  return attachMissionEnvelopes(items, planMarkdown);
};

export const extractPlanMarkdownFromExtraContext = (extraContext: string | undefined): string | undefined => {
  if (!extraContext || extraContext.trim().length === 0) {
    return undefined;
  }

  const planStart = extraContext.search(/^#\s+/m);
  if (planStart < 0) {
    return undefined;
  }

  const afterPlan = extraContext.slice(planStart);
  const nextSectionMatch = afterPlan.match(/\r?\n=== [A-Z0-9 _-]+ ===/);
  const block = nextSectionMatch ? afterPlan.slice(0, nextSectionMatch.index) : afterPlan;
  const normalized = block.trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const selectStartingPlanTask = (params: {
  plan?: PlanItem[];
  planMarkdown?: string;
  skillSlugs?: string[];
}): SelectedPlanTask | undefined => {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const structuredStep = selectFirstEligiblePlanItem(plan);
  if (structuredStep) {
    return {
      title: structuredStep.title,
      executionMode: resolvePlanItemExecutionMode(structuredStep),
      reason:
        structuredStep.status === 'running'
          ? `continue the active plan step "${structuredStep.title}"`
          : `start from the first eligible plan step "${structuredStep.title}"`,
      source: 'structured_plan',
      stepId: structuredStep.id,
      ...(structuredStep.mission ? { mission: structuredStep.mission } : {}),
    };
  }

  const parsedPlan = typeof params.planMarkdown === 'string' ? parseApprovedPlanItems(params.planMarkdown) : [];
  const parsedStep = selectFirstEligiblePlanItem(parsedPlan);
  if (parsedStep) {
    return {
      title: parsedStep.title,
      executionMode: resolvePlanItemExecutionMode(parsedStep),
      reason: `start from the first parsed plan step "${parsedStep.title}"`,
      source: 'plan_markdown',
      stepId: parsedStep.id,
      ...(parsedStep.mission ? { mission: parsedStep.mission } : {}),
    };
  }

  if (params.skillSlugs?.includes('broad-surface-scan')) {
    return {
      title: 'Broad surface scan',
      executionMode: 'discovery',
      reason: 'fall back to discovery because broad-surface-scan is available and no actionable plan step was parsed',
      source: 'skill_hint',
    };
  }

  return undefined;
};

export const deriveExecutionModeFromPlan = (params: {
  plan?: PlanItem[];
  planMarkdown?: string;
  skillSlugs?: string[];
}): PlanExecutionMode => selectStartingPlanTask(params)?.executionMode ?? 'discovery';

export const collectDiscoveryPlanTitles = (plan: PlanItem[]): string[] =>
  plan
    .filter((step) => inferExecutionModeFromText(`${step.title} ${step.notes ?? ''}`) === 'discovery')
    .map((step) => step.title);
