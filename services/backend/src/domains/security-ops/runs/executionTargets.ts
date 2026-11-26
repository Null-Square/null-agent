export const EXECUTION_TARGETS = ['cloud', 'scope_runner'] as const;

export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export const DEFAULT_EXECUTION_TARGET: ExecutionTarget = 'cloud';

export const isExecutionTarget = (value: unknown): value is ExecutionTarget =>
  typeof value === 'string' && (EXECUTION_TARGETS as readonly string[]).includes(value);

export const normalizeExecutionTarget = (value: unknown): ExecutionTarget => {
  if (value === 'scope_runner') {
    return 'scope_runner';
  }
  return DEFAULT_EXECUTION_TARGET;
};
