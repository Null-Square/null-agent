export type AgentType = 'chat' | 'planner' | 'executor';

export type PromptProfile =
  | AgentType
  | 'exposure-verification'
  | 'compliance-planner'
  | 'code-review-planner'
  | 'phase-recon'
  | 'phase-enumeration'
  | 'phase-validation'
  | 'phase-exploitation'
  | 'phase-evidence'
  | 'phase-control-assessment'
  | 'phase-review-mapping'
  | 'phase-review-analysis'
  | 'phase-review-validation'
  | 'phase-review-reporting'
  | 'compliance-reporting'
  | 'research'
  | 'phase-reporting';
