const RESUMABLE_PLAN_BLOCK_PREFIXES = ['Paused for resume:', 'Deferred for resume:'] as const;

export const isResumablePlanBlockReason = (value: unknown): value is string =>
  typeof value === 'string' &&
  RESUMABLE_PLAN_BLOCK_PREFIXES.some((prefix) => value.startsWith(prefix));
