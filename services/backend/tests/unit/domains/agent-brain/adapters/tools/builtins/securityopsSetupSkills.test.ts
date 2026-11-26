import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import {
  ListRelevantSetupSkills,
  LoadSetupSkill,
} from '@/domains/agent-brain/adapters/tools/builtins/securityops/setupSkills';

const mocks = vi.hoisted(() => ({
  buildForUser: vi.fn(),
}));

vi.mock('@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry', () => ({
  getSetupReadinessService: () => ({ buildForUser: mocks.buildForUser }),
}));

const makeCtx = (): ToolContext => ({
  sessionId: 'session-1',
  workspaceDir: '/tmp/session-1',
  sandbox: {} as never,
  sessionStore: {
    get: vi.fn(() => ({
      id: 'session-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
        },
      },
    })),
  } as never,
  streamBroker: {} as never,
  trace: undefined,
  approvals: { require: vi.fn() },
  checkpoints: undefined,
  guards: {} as never,
  policies: {
    requireApproval: false,
    maxStdoutBytes: 10_000,
    timeoutMs: 10_000,
  },
  flags: {
    securityops: {
      organizationId: 'org-1',
      scopeId: 'scope-1',
    },
  } as never,
  planRuntime: {} as never,
  abortSignal: new AbortController().signal,
});

describe('securityops setup skill tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildForUser.mockResolvedValue({
      gates: [
        {
          id: 'rules_of_engagement',
          label: 'Rules defined',
          status: 'pending',
          description: 'Define allowed activity.',
        },
      ],
      nextBestActions: [
        {
          id: 'define_rules',
          title: 'Define rules of engagement',
          description: 'Capture mission and limits.',
          prompt: 'Draft concise rules of engagement.',
        },
      ],
    });
  });

  it('suggests setup skills using setup readiness gaps', async () => {
    const result = await ListRelevantSetupSkills.run(
      { task: 'Help me get started with rules of engagement' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mocks.buildForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      scopeId: 'scope-1',
    });
    expect(result.data).toMatchObject({
      suggestions: expect.arrayContaining([
        expect.objectContaining({ slug: 'interview-roe' }),
      ]),
    });
  });

  it('loads a setup playbook into the conversation', async () => {
    const result = await LoadSetupSkill.run(
      { slug: 'interview-roe', reason: 'User wants to define rules.' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      slug: 'interview-roe',
      intent: 'change',
      content: expect.stringContaining('Interview Rules of Engagement'),
    });
  });
});
