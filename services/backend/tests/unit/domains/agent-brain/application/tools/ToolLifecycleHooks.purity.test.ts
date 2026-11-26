import { describe, it, expect } from 'vitest';
import { ToolLifecycleHookRegistry } from '@/domains/agent-brain/application/tools/ToolLifecycleHooks';

/**
 * E3 states the first-effect boundary includes generic pre-tool hooks "unless they are
 * proven pure by contract". `pre_hooks` runs after the durable claim but before `start`,
 * so an interrupted effecting hook would recover as `claimed` -> `not_started/may_retry`
 * and could duplicate the effect. Registration is where that contract is enforced.
 */
describe('ToolLifecycleHookRegistry pre-tool purity contract', () => {
  it('rejects a pre-tool hook that does not declare itself effect-free', () => {
    const registry = new ToolLifecycleHookRegistry();
    expect(() => registry.register({
      onPreToolUse: () => ({ continue: true }),
    })).toThrowError(/pre_tool_use_not_effect_free/u);
  });

  it('accepts a pre-tool hook that declares the contract', () => {
    const registry = new ToolLifecycleHookRegistry();
    expect(() => registry.register({
      preToolUseIsEffectFree: true,
      onPreToolUse: () => ({ continue: true }),
    })).not.toThrow();
  });

  it('leaves hooks without onPreToolUse unaffected', () => {
    const registry = new ToolLifecycleHookRegistry();
    expect(() => registry.register({ onPostToolUse: () => undefined })).not.toThrow();
    expect(() => registry.register({ onPipelineStage: () => undefined })).not.toThrow();
  });
});
