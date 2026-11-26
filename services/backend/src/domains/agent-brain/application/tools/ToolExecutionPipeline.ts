import type { ToolExecutionOutcome } from '../../domain/types';
import type { ToolArgs } from './types';
import type { ToolPermissionDecision, ToolUseDescriptor } from './ToolPolicyChecker';

export const TOOL_EXECUTION_PIPELINE_SCHEMA = 'tool-execution-pipeline/v1' as const;

export const TOOL_EXECUTION_PIPELINE_STAGES = [
  'resolve',
  'validate',
  'describe',
  'decide',
  'claim',
  'pre_hooks',
  'start',
  'dispatch',
  'normalize',
  'settle',
  'post_hooks',
  'project',
  'observe',
] as const;

export type ToolExecutionPipelineStage = typeof TOOL_EXECUTION_PIPELINE_STAGES[number];

export interface ToolExecutionPipelineContext {
  readonly schema: typeof TOOL_EXECUTION_PIPELINE_SCHEMA;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly modelRequestId?: string;
  readonly args: Readonly<ToolArgs>;
  readonly stage?: ToolExecutionPipelineStage;
  readonly completedStages: readonly ToolExecutionPipelineStage[];
  readonly descriptor?: ToolUseDescriptor;
  readonly decision?: ToolPermissionDecision;
  readonly result?: unknown;
  readonly outcome?: ToolExecutionOutcome;
  readonly errorClass?: string;
}

export class ToolPipelineInvariantError extends Error {
  readonly code = 'tool_pipeline_invariant_rejected';

  constructor(
    readonly invariant: 'stage_order' | 'decision_monotonicity',
    readonly details: Record<string, unknown>,
  ) {
    super(`Tool pipeline invariant rejected: ${invariant} ${JSON.stringify(details)}`);
    this.name = 'ToolPipelineInvariantError';
  }
}

const freezePlainValue = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezePlainValue(entry, seen);
  }
  return Object.freeze(value);
};

export const createToolExecutionPipelineContext = (input: {
  invocationId: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  toolCallId?: string;
  modelRequestId?: string;
  args: ToolArgs;
}): ToolExecutionPipelineContext => freezePlainValue({
  schema: TOOL_EXECUTION_PIPELINE_SCHEMA,
  invocationId: input.invocationId,
  sessionId: input.sessionId,
  turnId: input.turnId,
  toolName: input.toolName,
  ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  ...(input.modelRequestId ? { modelRequestId: input.modelRequestId } : {}),
  args: structuredClone(input.args),
  completedStages: [],
});

export const advanceToolExecutionPipeline = (
  context: ToolExecutionPipelineContext,
  stage: ToolExecutionPipelineStage,
  patch: Partial<Pick<
    ToolExecutionPipelineContext,
    'args' | 'descriptor' | 'decision' | 'result' | 'outcome' | 'errorClass'
  >> = {},
): ToolExecutionPipelineContext => {
  const expected = TOOL_EXECUTION_PIPELINE_STAGES[context.completedStages.length];
  if (stage !== expected) {
    throw new ToolPipelineInvariantError('stage_order', {
      invocationId: context.invocationId,
      expected,
      actual: stage,
      completedStages: context.completedStages,
    });
  }
  return freezePlainValue({
    ...context,
    ...patch,
    stage,
    completedStages: [...context.completedStages, stage],
  });
};

const decisionRank: Record<ToolPermissionDecision['behavior'], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** Guards may preserve or narrow a decision. They may never widen it. */
export const applyMonotonicToolPermissionDecision = (
  current: ToolPermissionDecision,
  proposed: ToolPermissionDecision,
): ToolPermissionDecision => {
  if (decisionRank[proposed.behavior] < decisionRank[current.behavior]) {
    throw new ToolPipelineInvariantError('decision_monotonicity', {
      toolName: current.descriptor.toolName,
      current: current.behavior,
      proposed: proposed.behavior,
      currentSource: current.source,
      proposedSource: proposed.source,
    });
  }
  return freezePlainValue({
    ...proposed,
    descriptor: freezePlainValue(structuredClone(proposed.descriptor)),
  });
};

/** Freeze the normalized terminal value before post-hooks and presentation projections. */
export const freezeToolExecutionResult = <T>(result: T): T => freezePlainValue(result);

export const isCompleteToolExecutionPipeline = (
  context: ToolExecutionPipelineContext,
): boolean => context.completedStages.length === TOOL_EXECUTION_PIPELINE_STAGES.length
  && context.completedStages.every((stage, index) => stage === TOOL_EXECUTION_PIPELINE_STAGES[index]);
