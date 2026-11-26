import { describe, expect, it } from 'vitest';

import {
  TOOL_EXECUTION_PIPELINE_STAGES,
  ToolPipelineInvariantError,
  advanceToolExecutionPipeline,
  applyMonotonicToolPermissionDecision,
  createToolExecutionPipelineContext,
  freezeToolExecutionResult,
  isCompleteToolExecutionPipeline,
} from '@/domains/agent-brain/application/tools/ToolExecutionPipeline';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';

const decision = (behavior: 'allow' | 'ask' | 'deny') => {
  const checker = new ToolPolicyChecker();
  const descriptor = checker.describeToolUse({ toolName: 'neutral_read', toolArgs: {} });
  return {
    behavior,
    reason: behavior,
    source: 'rule' as const,
    descriptor,
  };
};

describe('ToolExecutionPipeline', () => {
  it('accepts only the declared immutable stage order', () => {
    let context = createToolExecutionPipelineContext({
      invocationId: 'call-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolName: 'neutral_read',
      toolCallId: 'call-1',
      modelRequestId: 'request-1',
      args: { path: 'fixture.txt' },
    });

    for (const stage of TOOL_EXECUTION_PIPELINE_STAGES) {
      context = advanceToolExecutionPipeline(context, stage);
    }

    expect(isCompleteToolExecutionPipeline(context)).toBe(true);
    expect(context.completedStages).toEqual(TOOL_EXECUTION_PIPELINE_STAGES);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.completedStages)).toBe(true);
    expect(context.modelRequestId).toBe('request-1');
  });

  it('rejects skipped or repeated stages with a named invariant', () => {
    const context = createToolExecutionPipelineContext({
      invocationId: 'call-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolName: 'neutral_read',
      args: {},
    });

    expect(() => advanceToolExecutionPipeline(context, 'validate')).toThrow(
      ToolPipelineInvariantError,
    );
    expect(() => advanceToolExecutionPipeline(context, 'validate')).toThrow(
      /stage_order/u,
    );
  });

  it('allows policy narrowing and rejects deny-to-allow widening', () => {
    expect(applyMonotonicToolPermissionDecision(
      decision('allow'),
      decision('ask'),
    ).behavior).toBe('ask');
    expect(applyMonotonicToolPermissionDecision(
      decision('ask'),
      decision('deny'),
    ).behavior).toBe('deny');
    expect(() => applyMonotonicToolPermissionDecision(
      decision('deny'),
      decision('allow'),
    )).toThrow(/decision_monotonicity/u);
  });

  it('freezes a normalized result before post-settlement observers receive it', () => {
    const result = freezeToolExecutionResult({ nested: { value: 1 }, rows: [{ id: 1 }] });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
  });
});
