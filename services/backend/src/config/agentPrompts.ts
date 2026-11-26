import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { AgentType, PromptProfile } from '@/domains/agent-brain/domain/prompts/agentPrompts';

const PROMPTS_DIR = resolve(__dirname, '../../config/prompts');

function loadPromptFile(...segments: string[]): string {
  const filePath = resolve(PROMPTS_DIR, ...segments);
  if (!existsSync(filePath)) {
    throw new Error(`Missing required agent prompt file: ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8');
}

function loadPrompt(agentType: AgentType): string {
  return loadPromptFile(`${agentType}.md`);
}

const composePrompt = (...parts: string[]): string =>
  parts.map((part) => part.trim()).filter(Boolean).join('\n\n---\n\n');

// Loaded once at module init; no per-request file I/O.
export const AGENT_PROMPTS: Record<AgentType, string> = {
  chat: loadPrompt('chat'),
  planner: loadPrompt('planner'),
  executor: loadPrompt('executor'),
};

const COMPLIANCE_EXECUTOR_PROMPT = loadPromptFile('compliance-executor.md');
const CODE_REVIEW_EXECUTOR_PROMPT = loadPromptFile('code-review-executor.md');

export type PromptProfileDefinition = {
  profile: PromptProfile;
  baseAgentType: AgentType;
  prompt: string;
};

export const PROMPT_PROFILES: Record<PromptProfile, PromptProfileDefinition> = {
  chat: {
    profile: 'chat',
    baseAgentType: 'chat',
    prompt: AGENT_PROMPTS.chat,
  },
  planner: {
    profile: 'planner',
    baseAgentType: 'planner',
    prompt: AGENT_PROMPTS.planner,
  },
  'exposure-verification': {
    profile: 'exposure-verification',
    baseAgentType: 'planner',
    prompt: loadPromptFile('exposure-verification.md'),
  },
  'compliance-planner': {
    profile: 'compliance-planner',
    baseAgentType: 'planner',
    prompt: composePrompt(AGENT_PROMPTS.planner, loadPromptFile('compliance-planner.md')),
  },
  'code-review-planner': {
    profile: 'code-review-planner',
    baseAgentType: 'planner',
    prompt: loadPromptFile('code-review-planner.md'),
  },
  executor: {
    profile: 'executor',
    baseAgentType: 'executor',
    prompt: AGENT_PROMPTS.executor,
  },
  'phase-recon': {
    profile: 'phase-recon',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'recon.md')),
  },
  'phase-enumeration': {
    profile: 'phase-enumeration',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'enumeration.md')),
  },
  'phase-validation': {
    profile: 'phase-validation',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'validation.md')),
  },
  'phase-exploitation': {
    profile: 'phase-exploitation',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'exploitation.md')),
  },
  'phase-evidence': {
    profile: 'phase-evidence',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'evidence.md')),
  },
  'phase-control-assessment': {
    profile: 'phase-control-assessment',
    baseAgentType: 'executor',
    prompt: composePrompt(COMPLIANCE_EXECUTOR_PROMPT, loadPromptFile('phases', 'control-assessment.md')),
  },
  'compliance-reporting': {
    profile: 'compliance-reporting',
    baseAgentType: 'executor',
    prompt: composePrompt(COMPLIANCE_EXECUTOR_PROMPT, loadPromptFile('phases', 'compliance-reporting.md')),
  },
  'phase-review-mapping': {
    profile: 'phase-review-mapping',
    baseAgentType: 'executor',
    prompt: composePrompt(CODE_REVIEW_EXECUTOR_PROMPT, loadPromptFile('phases', 'review-mapping.md')),
  },
  'phase-review-analysis': {
    profile: 'phase-review-analysis',
    baseAgentType: 'executor',
    prompt: composePrompt(CODE_REVIEW_EXECUTOR_PROMPT, loadPromptFile('phases', 'review-analysis.md')),
  },
  'phase-review-validation': {
    profile: 'phase-review-validation',
    baseAgentType: 'executor',
    prompt: composePrompt(CODE_REVIEW_EXECUTOR_PROMPT, loadPromptFile('phases', 'review-validation.md')),
  },
  'phase-review-reporting': {
    profile: 'phase-review-reporting',
    baseAgentType: 'executor',
    prompt: composePrompt(CODE_REVIEW_EXECUTOR_PROMPT, loadPromptFile('phases', 'review-reporting.md')),
  },
  research: {
    profile: 'research',
    baseAgentType: 'executor',
    prompt: loadPromptFile('research.md'),
  },
  'phase-reporting': {
    profile: 'phase-reporting',
    baseAgentType: 'executor',
    prompt: composePrompt(AGENT_PROMPTS.executor, loadPromptFile('phases', 'reporting.md')),
  },
};

export const resolvePromptProfile = (
  agentType: AgentType,
  promptProfile?: PromptProfile,
): PromptProfileDefinition => {
  const profile = promptProfile ?? agentType;
  const resolved = PROMPT_PROFILES[profile];
  if (!resolved) {
    throw new Error(`Unknown prompt profile: ${profile}`);
  }
  if (resolved.baseAgentType !== agentType) {
    throw new Error(`Prompt profile ${profile} is not compatible with agent type ${agentType}`);
  }
  return resolved;
};
