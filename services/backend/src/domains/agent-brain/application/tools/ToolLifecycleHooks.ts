import type { SessionState } from '../../domain/types';
import { logger } from '@/shared/logger';
import type { ToolArgs } from './types';
import type { ToolPermissionDecision, ToolUseDescriptor } from './ToolPolicyChecker';
import {
  applyMonotonicToolPermissionDecision,
  ToolPipelineInvariantError,
  type ToolExecutionPipelineContext,
} from './ToolExecutionPipeline';

export interface ToolLifecycleBaseContext {
  sessionId: string;
  session?: SessionState;
  toolName: string;
  toolCallId?: string;
  args: ToolArgs;
  descriptor: ToolUseDescriptor;
}

export interface ToolPermissionDecisionHookContext extends ToolLifecycleBaseContext {
  decision: ToolPermissionDecision;
}

export interface ToolPermissionDecisionHookResult {
  decision?: ToolPermissionDecision;
}

export type PreToolUseHookContext = ToolLifecycleBaseContext;

export interface PostToolUseHookContext extends ToolLifecycleBaseContext {
  result: unknown;
  durationMs: number;
}

export interface PostToolUseFailureHookContext extends ToolLifecycleBaseContext {
  error: Error;
  durationMs: number;
}

export interface PreToolUseHookResult {
  continue?: boolean;
  updatedArgs?: ToolArgs;
  reason?: string;
}

export interface ToolLifecycleHook {
  /**
   * Required for any hook that implements `onPreToolUse`.
   *
   * `pre_hooks` runs after the durable claim but before `start`, so a crash inside a
   * pre-tool hook recovers as `claimed`, which E1 projects as `not_started / may_retry`.
   * That projection is only sound while pre-tool hooks cannot cause an external effect.
   * E3 states the first-effect boundary includes generic pre-tool hooks "unless they are
   * proven pure by contract" — this flag is that contract, and the registry enforces it.
   *
   * Declare `true` only for a hook that reads state and decides. A hook that mutates
   * external state must not run at this stage; move it after `start`, where an
   * interruption correctly recovers as `outcome_unknown / verify_before_retry`.
   */
  preToolUseIsEffectFree?: true;
  onPermissionDecision?(context: ToolPermissionDecisionHookContext): Promise<ToolPermissionDecisionHookResult | void> | ToolPermissionDecisionHookResult | void;
  onPreToolUse?(context: PreToolUseHookContext): Promise<PreToolUseHookResult | void> | PreToolUseHookResult | void;
  onPostToolUse?(context: PostToolUseHookContext): Promise<void> | void;
  onPostToolUseFailure?(context: PostToolUseFailureHookContext): Promise<void> | void;
  onPipelineStage?(context: ToolExecutionPipelineContext): Promise<void> | void;
}

export interface PreToolUseHookOutcome {
  continue: boolean;
  args: ToolArgs;
  blockedReason?: string;
}

export class ToolLifecycleHookRegistry {
  private readonly log = logger.child({ scope: 'ToolLifecycleHookRegistry' });
  private readonly hooks = new Set<ToolLifecycleHook>();

  register(hook: ToolLifecycleHook): () => void {
    if (hook.onPreToolUse && hook.preToolUseIsEffectFree !== true) {
      throw new Error(
        'tool_lifecycle_hook_pre_tool_use_not_effect_free: a hook implementing onPreToolUse must '
        + 'declare preToolUseIsEffectFree: true. Pre-tool hooks run after the durable claim but '
        + 'before start, so an interrupted effecting hook would recover as not_started/may_retry '
        + 'and could duplicate the effect. Move effecting work after the start boundary.',
      );
    }
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  async emitPermissionDecision(
    context: ToolPermissionDecisionHookContext,
  ): Promise<ToolPermissionDecision> {
    let currentDecision = context.decision;
    for (const hook of this.hooks) {
      if (!hook.onPermissionDecision) {
        continue;
      }
      try {
        const result = await hook.onPermissionDecision({
          ...context,
          decision: currentDecision,
        });
        if (result?.decision) {
          currentDecision = applyMonotonicToolPermissionDecision(
            currentDecision,
            result.decision,
          );
        }
      } catch (error) {
        if (error instanceof ToolPipelineInvariantError) throw error;
        this.log.warn(
          { err: error, sessionId: context.sessionId, toolName: context.toolName },
          '[ToolLifecycleHookRegistry] Permission hook failed',
        );
      }
    }
    return currentDecision;
  }

  async emitPipelineStage(context: ToolExecutionPipelineContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onPipelineStage) continue;
      try {
        await hook.onPipelineStage(context);
      } catch (error) {
        this.log.warn(
          { err: error, sessionId: context.sessionId, toolName: context.toolName, stage: context.stage },
          '[ToolLifecycleHookRegistry] Pipeline-stage observer failed',
        );
      }
    }
  }

  async emitPreToolUse(context: PreToolUseHookContext): Promise<PreToolUseHookOutcome> {
    let currentArgs = context.args;

    for (const hook of this.hooks) {
      if (!hook.onPreToolUse) {
        continue;
      }

      try {
        const result = await hook.onPreToolUse({ ...context, args: currentArgs });
        if (result?.updatedArgs) {
          currentArgs = result.updatedArgs;
        }
        if (result?.continue === false) {
          return {
            continue: false,
            args: currentArgs,
            blockedReason: result.reason ?? `Tool ${context.toolName} was blocked by a lifecycle hook.`,
          };
        }
      } catch (error) {
        this.log.warn(
          { err: error, sessionId: context.sessionId, toolName: context.toolName },
          '[ToolLifecycleHookRegistry] Pre-tool hook failed',
        );
      }
    }

    return {
      continue: true,
      args: currentArgs,
    };
  }

  async emitPostToolUse(context: PostToolUseHookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onPostToolUse) {
        continue;
      }
      try {
        await hook.onPostToolUse(context);
      } catch (error) {
        this.log.warn(
          { err: error, sessionId: context.sessionId, toolName: context.toolName },
          '[ToolLifecycleHookRegistry] Post-tool hook failed',
        );
      }
    }
  }

  async emitPostToolUseFailure(context: PostToolUseFailureHookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onPostToolUseFailure) {
        continue;
      }
      try {
        await hook.onPostToolUseFailure(context);
      } catch (error) {
        this.log.warn(
          { err: error, sessionId: context.sessionId, toolName: context.toolName },
          '[ToolLifecycleHookRegistry] Post-tool-failure hook failed',
        );
      }
    }
  }
}
