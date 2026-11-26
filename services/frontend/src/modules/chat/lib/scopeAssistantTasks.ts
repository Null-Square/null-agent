import type { CellIconName } from '@null-ai/design-tokens/ui';

export type ScopeAssistantTaskId =
  | 'scope_overview'
  | 'explain_findings'
  | 'prioritize_fixes'
  | 'latest_run'
  | 'exposure_triage'
  | 'compliance_gaps'
  | 'asset_coverage'
  | 'next_assessment'
  | 'report_summary';

export type ScopeAssistantTask = {
  id: ScopeAssistantTaskId;
  title: string;
  description: string;
  prompt: string;
};

/** The brand glyph for each ask — it names the place the question is about. */
export const SCOPE_TASK_GLYPHS: Record<ScopeAssistantTaskId, CellIconName> = {
  scope_overview: 'scope',
  explain_findings: 'findings',
  prioritize_fixes: 'threat',
  latest_run: 'runs',
  exposure_triage: 'threat',
  compliance_gaps: 'compliance',
  asset_coverage: 'assets',
  next_assessment: 'pentest',
  report_summary: 'reports',
};

export const SCOPE_ASSISTANT_TASKS: ScopeAssistantTask[] = [
  {
    id: 'scope_overview',
    title: 'Scope overview',
    description: 'Targets, rules, recent activity, and gaps.',
    prompt: 'Give me a concise overview of this scope: targets, verification status, rules of engagement, recent activity, and the biggest gaps.',
  },
  {
    id: 'explain_findings',
    title: 'Explain risks',
    description: 'Plain-language risk and priority.',
    prompt: 'Explain the current open risks for this scope in plain language and tell me which ones matter most.',
  },
  {
    id: 'prioritize_fixes',
    title: 'Prioritize fixes',
    description: 'Urgency, impact, and next remediation.',
    prompt: 'Prioritize the remediation work for this scope and group it by urgency, expected impact, and owner-friendly next steps.',
  },
  {
    id: 'latest_run',
    title: 'Latest run',
    description: 'What changed and what needs follow-up.',
    prompt: 'Summarize the latest assessment run for this scope, including what changed and what needs follow-up.',
  },
  {
    id: 'exposure_triage',
    title: 'Worth verifying',
    description: 'Which advisory matches are worth a run.',
    prompt: 'Which of the current advisory matches on this scope are worth spending a verification run on, and why?',
  },
  {
    id: 'compliance_gaps',
    title: 'Compliance gaps',
    description: 'Controls still missing evidence.',
    prompt: 'Which compliance controls for this scope still need evidence, and what would satisfy each one?',
  },
  {
    id: 'asset_coverage',
    title: 'Coverage gaps',
    description: 'What has not been tested yet.',
    prompt: 'Which assets in this scope have not been tested recently, and where are the biggest coverage gaps?',
  },
  {
    id: 'next_assessment',
    title: 'What to test next',
    description: 'A goal for the next assessment.',
    prompt: 'Based on what is known about this scope, propose a focused goal for the next assessment and say why it is the highest-value thing to test.',
  },
  {
    id: 'report_summary',
    title: 'Write a summary',
    description: 'An exec-ready read of where things stand.',
    prompt: 'Write a concise executive summary of this scope: posture, the most serious open risks, and what we are doing about them.',
  },
];
