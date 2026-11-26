import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { OobCheckInteractions, OobTokenCreate } from '@/domains/agent-brain/adapters/tools/builtins/oob';
import type { ToolContext } from '@/domains/agent-brain/application/tools';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const { createTokenMock, checkInteractionsMock } = vi.hoisted(() => ({
  createTokenMock: vi.fn(),
  checkInteractionsMock: vi.fn(),
}));

vi.mock('@/domains/agent-brain/adapters/tools/builtins/oobServiceRegistry', () => ({
  getOobService: () => ({
    createToken: createTokenMock,
    checkInteractions: checkInteractionsMock,
  }),
}));

describe('OOB builtins', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.shutdown();
  });

  const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      sessionId: 'session-1',
      workspaceDir: '/tmp/workspace',
      sandbox: {} as any,
      sessionStore: store,
      streamBroker: { emit: vi.fn() } as any,
      trace: undefined,
      approvals: { require: vi.fn().mockResolvedValue(undefined) },
      checkpoints: undefined,
      guards: {
        pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
        cmdGuard: { validate: vi.fn() } as any,
      },
      policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
      flags: {},
      planRuntime: {} as any,
      abortSignal: new AbortController().signal,
      ...overrides,
    }) as ToolContext;

  it('creates run-scoped OOB tokens through OobService', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });
    const ctx = makeContext({
      sessionId: session.id,
      flags: session.flags,
    });
    createTokenMock.mockResolvedValueOnce({
      token: 'abc',
      hostname: 'abc.oast.nullai.io',
      url: 'https://abc.oast.nullai.io/',
      dns: 'abc.oast.nullai.io',
      mode: 'interactsh',
    });

    const result = await OobTokenCreate.run({ label: 'blind ssrf', ttl_seconds: 120 }, ctx);

    expect(result.ok).toBe(true);
    expect(createTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'blind ssrf',
      ttlSeconds: 120,
      sessionId: session.id,
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      workspaceDir: session.workspaceDir,
    }));
  });

  it('checks interactions through OobService with tenant context', async () => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          organizationId: 'org-1',
          runId: 'run-1',
        },
      },
      scopeId: 'scope-1',
    });
    const ctx = makeContext({
      sessionId: session.id,
      flags: session.flags,
    });
    checkInteractionsMock.mockResolvedValueOnce({
      token: 'abc',
      interactions: [{ token: 'abc', protocol: 'dns', ts: '2026-05-01T00:00:00.000Z' }],
      count: 1,
      mode: 'interactsh',
    });

    const result = await OobCheckInteractions.run({ token: 'abc', limit: 5 }, ctx);

    expect(result.ok).toBe(true);
    expect(checkInteractionsMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'abc',
      limit: 5,
      sessionId: session.id,
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      workspaceDir: session.workspaceDir,
    }));
  });
});
