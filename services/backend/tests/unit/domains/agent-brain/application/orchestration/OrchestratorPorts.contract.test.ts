import { vi, describe, it, expect } from 'vitest';
import { CacheCoordinator } from '@/domains/agent-brain/application/orchestration/services/CacheCoordinator';
import { PromptComposer } from '@/domains/agent-brain/application/orchestration/services/PromptComposer';
import { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@/domains/agent-brain/domain/prompts';
import type { ToolRegistryPort } from '@/domains/agent-brain/ports';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const makeSession = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: 'session-1',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  workspaceDir: '/workspace',
  status: 'idle',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  pendingApproval: undefined,
  checkpoints: {},
  ...overrides,
});

describe('CacheCoordinator', () => {
  it('creates then hits cache when prefix is stable and fresh', () => {
    const coordinator = new CacheCoordinator(60_000, 1);
    const session = makeSession();
    const prefix = 'stable prefix for cache';

    const first = coordinator.build({
      session,
      cacheablePrefix: prefix,
      providerSupportsCache: true,
    });
    expect(first.cacheIntent?.action).toBe('create');
    const second = coordinator.build({
      session,
      cacheablePrefix: prefix,
      providerSupportsCache: true,
    });
    expect(second.cacheIntent?.action).toBe('hit');
    expect(session.flags.cache_control?.lastAction).toBe('hit');
  });

  it('skips cache intent when provider does not support cache control', () => {
    const coordinator = new CacheCoordinator();
    const session = makeSession();
    const decision = coordinator.build({
      session,
      cacheablePrefix: 'anything',
      providerSupportsCache: false,
    });
    expect(decision.cacheIntent).toBeUndefined();
  });
});

describe('PolicyEngine.resolve', () => {
  it('merges base and resolved tool policies and sets flags', async () => {
    const facade = new PolicyEngine(undefined, { resetCache: vi.fn() } as any);
    vi.spyOn(facade, 'resolveBrainPolicy').mockResolvedValue({
      profile: 'p-1',
      sandboxProfile: 'sandbox-a',
      toolPolicy: { allow: ['fs.read'] },
      source: 'explicit',
    } as any);

    const session = makeSession({
      flags: { policy_base: { toolPolicy: { deny: ['shell.exec'] } } } as any,
    });

    const result = await facade.resolve(session, 'p-1');

    expect(result.toolPolicy?.allow).toContain('fs.read');
    expect(result.toolPolicy?.deny).toContain('shell.exec');
    expect(result.sandboxProfile).toBe('sandbox-a');
    expect(result.flags.brain_policy?.profile).toBe('p-1');
  });
});

describe('PromptComposer', () => {
  const toolsRegistry: ToolRegistryPort = {
    getToolSchemas: () => [
      { name: 'b-tool', description: 'B', parameters: {} as any },
      { name: 'a-tool', description: 'A', parameters: {} as any },
    ],
    listManifests: vi.fn(async () => []),
    getManifest: vi.fn(async () => undefined),
    execute: vi.fn(async () => undefined),
    executeWithReceipt: vi.fn(async (toolName: string) => ({
      result: undefined,
      receipt: {
        schema: 'tool-execution-receipt/v1' as const,
        toolName,
        outcome: 'succeeded' as const,
      },
    })),
    handleApprovalDecision: vi.fn(async () => ({ handled: true, needsResume: false })),
  };

  it('builds static/dynamic prompts and cacheable prefix', () => {
    const composer = new PromptComposer();
    const session = makeSession({
      plan: [{ id: '1', title: 'Step', status: 'pending' }],
      memory: { note: 'memo' },
      workspaceDir: '/workspace',
    } as any);

    const result = composer.build({
      session,
      agentType: 'chat',
      softContext: 'context-block',
      tools: toolsRegistry.getToolSchemas(),
    });

    expect(result.staticPrompt).toContain('a-tool'); // sorted
    expect(result.dynamicPrompt).toContain('Step');
    expect(result.cacheablePrefix).toContain('context-block');
    expect(result.cacheablePrefix).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(result.sections.static.map((section) => section.key)).toEqual(['role_prompt', 'tool_catalog']);
  });
});

