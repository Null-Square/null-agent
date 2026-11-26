import type { Message } from '../../../../domain/types';

export const COMPACTION_INITIAL_THRESHOLD = 0.7;
export const COMPACTION_INCREMENTAL_THRESHOLD = 0.65;
export const COMPACTION_INITIAL_COOLDOWN_TURNS = 5;
export const COMPACTION_INCREMENTAL_COOLDOWN_TURNS = 3;

export const COMPACTION_SECTION_TITLES = {
  findings: '## Filed Findings',
  techniques: '## Attempted Techniques',
  approaches: '## Failed Approaches and Blockers',
  credentials: '## Confirmed Credentials or Tokens',
  openSteps: '## Open Plan Steps',
  discoveries: '## High-Signal Discoveries',
  constraints: '## Constraints and Safety Limits',
} as const;

export type RunCompactionProfile =
  | 'pentest'
  | 'compliance'
  | 'code_review'
  | 'exposure_verification'
  | 'finding_disposition';

type CompactionSectionKey = keyof typeof COMPACTION_SECTION_TITLES;

export type CompactionCategoryCounts = {
  findingsPreserved: number;
  techniquesPreserved: number;
  approachesPreserved: number;
  credentialsPreserved: number;
  openStepsPreserved: number;
  discoveriesPreserved: number;
  constraintsPreserved: number;
};

const SECTION_ORDER: CompactionSectionKey[] = [
  'findings',
  'techniques',
  'approaches',
  'credentials',
  'openSteps',
  'discoveries',
  'constraints',
];

const SECTION_ALIASES: Record<CompactionSectionKey, string[]> = {
  findings: ['filed findings', 'findings', 'confirmed findings'],
  techniques: ['attempted techniques', 'techniques attempted', 'techniques'],
  approaches: ['failed approaches and blockers', 'failed approaches', 'approaches', 'blockers'],
  credentials: ['confirmed credentials or tokens', 'credentials', 'tokens', 'confirmed credentials'],
  openSteps: ['open plan steps', 'open steps', 'next steps', 'remaining steps'],
  discoveries: ['high-signal discoveries', 'discoveries', 'recent discoveries'],
  constraints: [
    'constraints and safety limits',
    'constraints and next actions',
    'constraints',
    'active constraints',
  ],
};

const COUNT_KEY_BY_SECTION: Record<CompactionSectionKey, keyof CompactionCategoryCounts> = {
  findings: 'findingsPreserved',
  techniques: 'techniquesPreserved',
  approaches: 'approachesPreserved',
  credentials: 'credentialsPreserved',
  openSteps: 'openStepsPreserved',
  discoveries: 'discoveriesPreserved',
  constraints: 'constraintsPreserved',
};

const EMPTY_SECTION_PLACEHOLDER = '- none';

export const EMPTY_COMPACTION_COUNTS: CompactionCategoryCounts = {
  findingsPreserved: 0,
  techniquesPreserved: 0,
  approachesPreserved: 0,
  credentialsPreserved: 0,
  openStepsPreserved: 0,
  discoveriesPreserved: 0,
  constraintsPreserved: 0,
};

type CompactionPolicy = {
  threshold: number;
  cooldownTurns: number;
  minMessages: number;
};

type CompactionPromptInput = {
  previousSummary?: string;
  conversationText: string;
};

export function getCompactionPolicy(hasExistingSummary: boolean): CompactionPolicy {
  if (hasExistingSummary) {
    return {
      threshold: COMPACTION_INCREMENTAL_THRESHOLD,
      cooldownTurns: COMPACTION_INCREMENTAL_COOLDOWN_TURNS,
      minMessages: 2,
    };
  }

  return {
    threshold: COMPACTION_INITIAL_THRESHOLD,
    cooldownTurns: COMPACTION_INITIAL_COOLDOWN_TURNS,
    minMessages: 3,
  };
}

export function buildCompactionConversationText(messages: Message[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      const toolSuffix = message.toolName ? `:${message.toolName}` : '';
      const content = typeof message.content === 'string' ? message.content.slice(0, 2000) : '[non-text]';
      return `[${role}${toolSuffix}]: ${content}`;
    })
    .join('\n\n');
}

const PROFILE_RULES: Record<RunCompactionProfile, string[]> = {
  pentest: [
    '- Preserve filed finding IDs, severity, scope, and direct evidence.',
    '- For techniques use "technique | endpoint/scope | outcome".',
    '- For discoveries capture hosts, subdomains, services, frameworks, auth/admin/docs surfaces, and data sources worth revisiting.',
  ],
  compliance: [
    '- Under Filed Findings preserve control IDs, recorded verdicts, request IDs, evidence refs, limitations, and freshness; do not turn missing evidence into a fail.',
    '- For techniques preserve the assessment method, control scope, evidence source, and recorded outcome.',
    '- For discoveries preserve framework coverage, mapped evidence, gaps, and explicit control dependencies. Do not introduce vulnerability-testing work.',
  ],
  code_review: [
    '- Under Filed Findings preserve candidate or finding IDs, severity, exact file and line anchors, commit identity, and direct evidence.',
    '- For techniques preserve the source-tracing or validation method, changed path, and outcome.',
    '- For discoveries preserve relevant changed files, call paths, trust boundaries, and unresolved code hypotheses. Do not invent live-target authority.',
  ],
  exposure_verification: [
    '- Preserve only the bound advisory, exact asset, observed component/version, fresh exchange evidence, negative control, and submitted outcome.',
    '- For techniques preserve the one advisory-specific verification method and outcome.',
    '- Do not introduce another host, advisory, vulnerability class, or general reconnaissance task.',
  ],
  finding_disposition: [
    '- Preserve the exact finding ID, requested state, historical claim, replay evidence, prerequisite/control evidence, blocker code, and submitted outcome.',
    '- For techniques preserve the independent replay method and outcome.',
    '- Do not introduce discovery work or treat failed access, target drift, or tool failure as proof of resolution or false positive.',
  ],
};

export function buildRunCompactionPrompt(
  input: CompactionPromptInput,
  profile: RunCompactionProfile,
): {
  system: string;
  user: string;
} {
  const sectionList = SECTION_ORDER.map((key) => COMPACTION_SECTION_TITLES[key]).join('\n');
  const system = [
    `You compress ${profile.replace(/_/gu, ' ')} run history for future turns.`,
    'Return Markdown with exactly these section headers in this order:',
    sectionList,
    'Rules:',
    '- Every section must contain bullet lines that start with "- ".',
    '- If a section is empty, write "- none".',
    ...PROFILE_RULES[profile],
    '- For failed approaches include the blocker or reason they failed.',
    '- For credentials or tokens include scope and confirmation status.',
    '- For open plan steps keep the exact remaining task or validation target.',
    '- For constraints preserve authority, user instructions, approval limits, safety restrictions, and budget or time pressure. Do not invent a next action.',
    '- Dense facts only. No prose paragraphs outside the required bullets.',
    '- Keep the response under 900 words.',
  ].join('\n');

  const user = input.previousSummary
    ? [
        `Update the existing structured ${profile.replace(/_/gu, ' ')} summary.`,
        'Keep still-valid bullets, remove disproven bullets, and add the new messages below.',
        '',
        'Existing structured summary:',
        input.previousSummary,
        '',
        'New messages to merge:',
        input.conversationText,
      ].join('\n')
    : [`Create the first structured ${profile.replace(/_/gu, ' ')} summary from these messages:`, '', input.conversationText].join('\n');

  return { system, user };
}

/**
 * E12 Slice C — the compaction directive as a trailing user message.
 *
 * The previous design put this in a bespoke `system` prompt in front of a flattened
 * transcript. The system slot is the first token region a provider caches on, so a distinct
 * summarizer system prompt invalidated the entire warm prefix; and the flattened transcript
 * discarded `tool_calls`, `tool_call_id`, non-text blocks, and everything past 2,000
 * characters per message.
 *
 * Moving the directive to the end makes the auxiliary request a genuine prefix extension of
 * the warm conversation, and lets the summarizer read the real structured history.
 */
export function buildCompactionInstruction(
  profile: RunCompactionProfile,
  previousSummary?: string,
): string {
  const readable = profile.replace(/_/gu, ' ');
  const sectionList = SECTION_ORDER.map((key) => COMPACTION_SECTION_TITLES[key]).join('\n');
  return [
    `You are now acting as a compaction engine for this ${readable} run.`,
    'Condense THE CONVERSATION ABOVE into a structured checkpoint for future turns.',
    '',
    'Return Markdown with exactly these section headers in this order:',
    sectionList,
    '',
    'Rules:',
    '- Every section must contain bullet lines that start with "- ".',
    '- If a section is empty, write "- none".',
    ...PROFILE_RULES[profile],
    '- For failed approaches include the blocker or reason they failed.',
    '- For credentials or tokens include scope and confirmation status.',
    '- For open plan steps keep the exact remaining task or validation target.',
    '- For constraints preserve authority, user instructions, approval limits, safety restrictions, and budget or time pressure. Do not invent a next action.',
    '- Dense facts only. No prose paragraphs outside the required bullets.',
    '- Keep the response under 900 words.',
    '- Do not mention this compaction request.',
    '- Output only the checkpoint text. Do not call a tool.',
    ...(previousSummary
      ? [
        '',
        'An earlier checkpoint exists. Keep still-valid bullets, remove disproven bullets,',
        'and merge in what the conversation above adds:',
        '',
        previousSummary,
      ]
      : []),
  ].join('\n');
}

export function normalizeCompactionSummary(summary: string): string {
  const extracted = extractSections(summary);
  const hasRecognizedSection = SECTION_ORDER.some((key) => extracted[key].length > 0);

  if (!hasRecognizedSection) {
    const fallback = toBulletLines(summary);
    extracted.discoveries = fallback.length > 0 ? fallback : [EMPTY_SECTION_PLACEHOLDER];
  }

  return SECTION_ORDER.map((key) => {
    const body = extracted[key].length > 0 ? extracted[key] : [EMPTY_SECTION_PLACEHOLDER];
    return [COMPACTION_SECTION_TITLES[key], ...body].join('\n');
  }).join('\n\n');
}

export function extractCompactionCategoryCounts(summary: string): CompactionCategoryCounts {
  const normalized = normalizeCompactionSummary(summary);
  const sections = extractSections(normalized);
  const counts: CompactionCategoryCounts = { ...EMPTY_COMPACTION_COUNTS };

  for (const key of SECTION_ORDER) {
    counts[COUNT_KEY_BY_SECTION[key]] = sections[key].filter((line) => !isPlaceholderBullet(line)).length;
  }

  return counts;
}

export function summarizeCompactionCounts(counts: CompactionCategoryCounts): string {
  const labels: Array<[keyof CompactionCategoryCounts, string]> = [
    ['findingsPreserved', 'findings'],
    ['techniquesPreserved', 'techniques'],
    ['approachesPreserved', 'approaches'],
    ['credentialsPreserved', 'credentials'],
    ['openStepsPreserved', 'open_steps'],
    ['discoveriesPreserved', 'discoveries'],
    ['constraintsPreserved', 'constraints'],
  ];

  const nonZero = labels
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${label}=${counts[key]}`);

  return nonZero.length > 0 ? nonZero.join(' ') : 'no categorized signal preserved';
}

function extractSections(summary: string): Record<CompactionSectionKey, string[]> {
  const sections = createEmptySections();
  const lines = summary.replace(/\r/g, '').split('\n');
  let current: CompactionSectionKey | null = null;
  const orphaned: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const headingMatch = /^#{1,6}\s+(.+)$/.exec(line);
    if (headingMatch) {
      current = resolveSectionKey(headingMatch[1]);
      continue;
    }

    if (current) {
      sections[current].push(...toBulletLines(line));
    } else {
      orphaned.push(line);
    }
  }

  if (orphaned.length > 0) {
    sections.discoveries.push(...toBulletLines(orphaned.join('\n')));
  }

  for (const key of SECTION_ORDER) {
    if (sections[key].length === 0) {
      continue;
    }
    sections[key] = dedupePreserveOrder(sections[key]);
  }

  return sections;
}

function createEmptySections(): Record<CompactionSectionKey, string[]> {
  return {
    findings: [],
    techniques: [],
    approaches: [],
    credentials: [],
    openSteps: [],
    discoveries: [],
    constraints: [],
  };
}

function resolveSectionKey(heading: string): CompactionSectionKey | null {
  const normalized = heading.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const key of SECTION_ORDER) {
    if (SECTION_ALIASES[key].some((alias) => normalized.includes(alias))) {
      return key;
    }
  }
  return null;
}

function toBulletLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const withoutMarker = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      return withoutMarker ? `- ${withoutMarker}` : EMPTY_SECTION_PLACEHOLDER;
    });
}

function isPlaceholderBullet(line: string): boolean {
  const normalized = line
    .replace(/^-\s+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized === 'none' || normalized === 'n a' || normalized === 'unknown' || normalized === 'not recorded';
}

function dedupePreserveOrder(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(line);
  }
  return deduped;
}
