import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStoreMocks = vi.hoisted(() => ({
  mergeFlagNamespaceAsync: vi.fn(),
  listByUser: vi.fn(),
  get: vi.fn(),
  getOrHydrate: vi.fn(),
  getExecutionReadModels: vi.fn(),
  removeAsync: vi.fn(),
  set: vi.fn(),
  recordInputAndStartRequestedAsync: vi.fn(),
}));

const orchestratorMocks = vi.hoisted(() => ({
  processMessage: vi.fn(),
}));

const sessionServiceMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

const scopeAwareChatContextServiceMocks = vi.hoisted(() => ({
  buildForUser: vi.fn(),
}));

const sessionRepositoryMocks = vi.hoisted(() => ({
  listByUser: vi.fn(),
  findById: vi.fn(),
  updateTitle: vi.fn(),
  delete: vi.fn(),
}));

const messageRepositoryMocks = vi.hoisted(() => ({
  listBySessionPaged: vi.fn(),
}));

const scopeVerificationGateMocks = vi.hoisted(() => ({
  check: vi.fn(),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

import { createChatRouter } from '@/interfaces/http/controllers/chat.router';

describe('chat.router integration', () => {
  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/app/chat',
      createChatRouter({
        services: {
          sessionStore: sessionStoreMocks,
          orchestrator: orchestratorMocks,
          ports: {
            events: { emit: vi.fn() },
          },
        } as any,
        sessionService: sessionServiceMocks as any,
        scopeAwareChatContextService: scopeAwareChatContextServiceMocks as any,
        scopeVerificationGate: scopeVerificationGateMocks as any,
        sessionRepository: sessionRepositoryMocks as any,
        messageRepository: messageRepositoryMocks as any,
      }),
    );
    return app;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    scopeVerificationGateMocks.check.mockResolvedValue({ verified: true });
    sessionStoreMocks.mergeFlagNamespaceAsync.mockResolvedValue(true);
    sessionStoreMocks.listByUser.mockReturnValue([]);
    sessionStoreMocks.get.mockReturnValue(undefined);
    sessionStoreMocks.getOrHydrate.mockResolvedValue(undefined);
    sessionStoreMocks.getExecutionReadModels.mockImplementation(async (ids: string[]) => new Map(
      ids.map((id) => [id, { desiredExecution: 'running', condition: 'idle' }]),
    ));
    sessionStoreMocks.removeAsync.mockResolvedValue(true);
    sessionStoreMocks.set.mockReturnValue(undefined);
    sessionStoreMocks.recordInputAndStartRequestedAsync.mockResolvedValue(true);
    orchestratorMocks.processMessage.mockResolvedValue(undefined);
    sessionServiceMocks.createSession.mockResolvedValue({
      session: { id: 'session-1', createdAt: 1_725_000_000_000 },
    });
    sessionRepositoryMocks.listByUser.mockResolvedValue([]);
    sessionRepositoryMocks.findById.mockResolvedValue(null);
    sessionRepositoryMocks.updateTitle.mockResolvedValue(true);
    sessionRepositoryMocks.delete.mockResolvedValue(undefined);
    messageRepositoryMocks.listBySessionPaged.mockResolvedValue({
      data: [],
      meta: { hasMore: false, nextCursor: undefined },
    });
    scopeAwareChatContextServiceMocks.buildForUser.mockResolvedValue({
      organizationId: 'org-1',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
      metadata: {
        organizationId: 'org-1',
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
        schema: 'nullsquare.scope-aware-chat.v3',
        sections: ['organization', 'scope', 'targets', 'roe_document'],
      },
      renderedContext: 'scope-aware-context',
    });
  });

  it('creates a locked read-only chat session and optionally boots the first prompt', async () => {
    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
        modelCategory: 'high',
        initialPrompt: 'Summarize the latest findings for me.',
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      sessionId: 'session-1',
      mode: 'interactive',
      assistant: {
        mode: 'read_only',
        profileKey: 'security-assistant',
      },
    });

    expect(scopeAwareChatContextServiceMocks.buildForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        modelCategory: 'high',
        profileKey: 'security-assistant',
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
        mode: 'interactive',
        extraContext: expect.stringContaining('scope-aware-context'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('=== NULLSQUARE MARKDOWN REPORTING ==='),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('GitHub-flavored Markdown tables'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('compliance readiness/evidence'),
      }),
    );
    const createSessionCall = sessionServiceMocks.createSession.mock.calls.at(-1)?.[0];
    const removedDslToken = ['open', 'ui'].join('');
    expect(createSessionCall?.extraContext.toLowerCase()).not.toContain(removedDslToken);
    expect(sessionStoreMocks.mergeFlagNamespaceAsync).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'securityops',
      expect.objectContaining({
        organizationId: 'org-1',
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
        assistantMode: 'read_only_chat',
      }),
    );
    expect(sessionStoreMocks.mergeFlagNamespaceAsync).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'policy_lock',
      { profileKey: 'security-assistant' },
    );
    expect(sessionStoreMocks.recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      'session-1',
      {
        id: 'chat-initial:session-1',
        role: 'user',
        content: 'Summarize the latest findings for me.',
        timestamp: 1_725_000_000_000,
        metadata: {
          visibility: 'public',
          source: 'human',
        },
      },
      'initial_chat_prompt',
      'user-1',
    );
    expect(orchestratorMocks.processMessage).not.toHaveBeenCalled();
  });

  it('refuses to create a session when the scope target is unverified', async () => {
    scopeVerificationGateMocks.check.mockResolvedValue({ verified: false, reason: 'unverified' });

    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
        initialPrompt: 'Summarize the latest findings for me.',
      });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'scope.target_unverified',
      message: 'Verify target ownership for this scope before using the assistant.',
    });
    expect(scopeVerificationGateMocks.check).toHaveBeenCalledWith('123e4567-e89b-42d3-a456-426614174000');
    // Nothing was created and no model turn started, so no credits were spent.
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
    expect(orchestratorMocks.processMessage).not.toHaveBeenCalled();
  });

  it('refuses to create a session when the scope has no target at all', async () => {
    scopeVerificationGateMocks.check.mockResolvedValue({ verified: false, reason: 'no_target' });

    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({ scopeId: '123e4567-e89b-42d3-a456-426614174000' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'scope.target_unverified',
      message: 'Add a target to this scope and verify ownership before using the assistant.',
    });
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
  });

  it('refuses to create a session when the ownership lookup fails', async () => {
    scopeVerificationGateMocks.check.mockResolvedValue({ verified: false, reason: 'lookup_failed' });

    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({ scopeId: '123e4567-e89b-42d3-a456-426614174000' });

    expect(response.status).toBe(403);
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
  });

  it('creates the session without starting a turn when no initial prompt is provided', async () => {
    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
      });

    expect(response.status).toBe(201);
    expect(orchestratorMocks.processMessage).not.toHaveBeenCalled();
  });

  it('lists only assistant chat sessions for the requested scope and derives fallback titles from user prompts', async () => {
    sessionRepositoryMocks.listByUser.mockResolvedValue([
      {
        id: 'assistant-db',
        userId: 'user-1',
        title: null,
        metadata: {
          flags: {
            securityops: {
              assistantMode: 'read_only_chat',
              scopeId: '123e4567-e89b-42d3-a456-426614174000',
            },
          },
        },
        blockedReason: null,
        completed: false,
        mode: 'interactive',
        createdAt: new Date('2026-04-03T08:00:00.000Z'),
        updatedAt: new Date('2026-04-03T08:10:00.000Z'),
        lastActiveAt: new Date('2026-04-03T08:12:00.000Z'),
        summary: 'Summarized prior findings',
      },
      {
        id: 'assistant-other-scope',
        userId: 'user-1',
        title: 'Other scope chat',
        metadata: {
          flags: {
            securityops: {
              assistantMode: 'read_only_chat',
              scopeId: '99999999-e89b-42d3-a456-426614174999',
            },
          },
        },
        blockedReason: null,
        completed: false,
        mode: 'interactive',
        createdAt: new Date('2026-04-03T09:00:00.000Z'),
        updatedAt: new Date('2026-04-03T09:10:00.000Z'),
        lastActiveAt: new Date('2026-04-03T09:12:00.000Z'),
        summary: null,
      },
      {
        id: 'run-session',
        userId: 'user-1',
        title: 'Normal run',
        metadata: {},
        blockedReason: null,
        completed: false,
        mode: 'interactive',
        createdAt: new Date('2026-04-03T10:00:00.000Z'),
        updatedAt: new Date('2026-04-03T10:10:00.000Z'),
        lastActiveAt: new Date('2026-04-03T10:12:00.000Z'),
        summary: null,
      },
    ]);
    messageRepositoryMocks.listBySessionPaged.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'assistant-db') {
        return {
          data: [
            {
              id: 'internal',
              role: 'user',
              content: 'hidden',
              metadata: { visibility: 'internal' },
              createdAt: new Date('2026-04-03T08:00:00.000Z'),
            },
            {
              id: 'user-1',
              role: 'user',
              content: 'Summarize prior findings and explain which assets are most affected.',
              metadata: {},
              createdAt: new Date('2026-04-03T08:01:00.000Z'),
            },
          ],
          meta: { hasMore: false, nextCursor: undefined },
        };
      }
      return {
        data: [],
        meta: { hasMore: false, nextCursor: undefined },
      };
    });
    sessionStoreMocks.listByUser.mockReturnValue([
      {
        id: 'assistant-live',
        userId: 'user-1',
        title: 'Technique memory follow-up',
        summary: null,
        createdAt: Date.parse('2026-04-03T11:00:00.000Z'),
        lastActive: Date.parse('2026-04-03T11:15:00.000Z'),
        mode: 'interactive',
        completed: false,
        flags: {
          securityops: {
            assistantMode: 'read_only_chat',
            scopeId: '123e4567-e89b-42d3-a456-426614174000',
          },
        },
        stateMachine: {
          isProcessing: () => true,
        },
        pendingApproval: null,
        messages: [
          {
            id: 'user-live',
            role: 'user',
            content: 'What techniques have already been tried?',
            metadata: {},
          },
        ],
      },
    ]);

    const response = await request(buildApp())
      .get('/api/app/chat/sessions')
      .query({
        scopeId: '123e4567-e89b-42d3-a456-426614174000',
      });

    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(2);
    expect(response.body.sessions[0]).toMatchObject({
      id: 'assistant-live',
      title: 'Technique memory follow-up',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
      status: 'running',
      assistantMode: 'read_only_chat',
      sessionKind: 'assistant_chat',
    });
    expect(response.body.sessions[1]).toMatchObject({
      id: 'assistant-db',
      title: 'Summarize prior findings and explain which assets are most affected.',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
      status: 'idle',
      assistantMode: 'read_only_chat',
      sessionKind: 'assistant_chat',
    });

    expect(response.body.sessions.find((session: { id: string }) => session.id === 'run-session')).toBeUndefined();
    expect(response.body.sessions.find((session: { id: string }) => session.id === 'assistant-other-scope')).toBeUndefined();
  });

  it('renames only assistant chat sessions', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174111';
    const liveSession = {
      id: sessionId,
      userId: 'user-1',
      title: 'Old assistant title',
      flags: {
        securityops: {
          assistantMode: 'read_only_chat',
          scopeId: '123e4567-e89b-42d3-a456-426614174000',
        },
      },
    };
    sessionStoreMocks.get.mockReturnValue(liveSession);
    sessionRepositoryMocks.findById.mockResolvedValue({
      id: sessionId,
      userId: 'user-1',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
      metadata: {
        flags: {
          securityops: {
            assistantMode: 'read_only_chat',
            scopeId: '123e4567-e89b-42d3-a456-426614174000',
          },
        },
      },
    });

    const response = await request(buildApp())
      .patch(`/api/app/chat/sessions/${sessionId}`)
      .send({ title: 'Renamed assistant title' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      title: 'Renamed assistant title',
    });
    expect(sessionRepositoryMocks.updateTitle).toHaveBeenCalledWith(
      sessionId,
      'Renamed assistant title',
    );
    expect(sessionStoreMocks.set).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ title: 'Renamed assistant title' }),
    );
  });

  it('deletes only assistant chat sessions', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174222';
    sessionStoreMocks.get.mockReturnValue({
      id: sessionId,
      userId: 'user-1',
      flags: {
        securityops: {
          assistantMode: 'read_only_chat',
          scopeId: '123e4567-e89b-42d3-a456-426614174000',
        },
      },
    });
    sessionRepositoryMocks.findById.mockResolvedValue({
      id: sessionId,
      userId: 'user-1',
      scopeId: '123e4567-e89b-42d3-a456-426614174000',
      metadata: {
        flags: {
          securityops: {
            assistantMode: 'read_only_chat',
            scopeId: '123e4567-e89b-42d3-a456-426614174000',
          },
        },
      },
    });

    const response = await request(buildApp())
      .delete(`/api/app/chat/sessions/${sessionId}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(sessionStoreMocks.removeAsync).toHaveBeenCalledWith(sessionId, 'explicit');
    expect(sessionRepositoryMocks.delete).not.toHaveBeenCalled();
  });

  it('enforces the 10-chat cap per scope while keeping the newly created assistant chat', async () => {
    const scopeId = '123e4567-e89b-42d3-a456-426614174000';
    const now = Date.parse('2026-04-03T12:00:00.000Z');

    sessionRepositoryMocks.listByUser.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `assistant-old-${index + 1}`,
        userId: 'user-1',
        title: `Older assistant chat ${index + 1}`,
        scopeId,
        metadata: {
          flags: {
            securityops: {
              assistantMode: 'read_only_chat',
              scopeId,
            },
          },
        },
        blockedReason: null,
        completed: false,
        mode: 'interactive',
        createdAt: new Date(now - (10 - index) * 60_000),
        updatedAt: new Date(now - (10 - index) * 60_000),
        lastActiveAt: new Date(now - (10 - index) * 60_000),
        summary: `Summary ${index + 1}`,
      })),
    );
    sessionStoreMocks.listByUser.mockReturnValue([
      {
        id: 'session-1',
        userId: 'user-1',
        title: '',
        summary: null,
        createdAt: now,
        lastActive: now,
        mode: 'interactive',
        completed: false,
        flags: {
          securityops: {
            assistantMode: 'read_only_chat',
            scopeId,
          },
        },
        stateMachine: {
          isProcessing: () => false,
        },
        pendingApproval: null,
        messages: [],
      },
    ]);
    messageRepositoryMocks.listBySessionPaged.mockResolvedValue({
      data: [
        {
          id: 'user-older',
          role: 'user',
          content: 'Explain what happened in this chat.',
          metadata: {},
          createdAt: new Date(now),
        },
      ],
      meta: { hasMore: false, nextCursor: undefined },
    });

    const response = await request(buildApp())
      .post('/api/app/chat/sessions')
      .send({
        scopeId,
      });

    expect(response.status).toBe(201);
    expect(sessionRepositoryMocks.delete).toHaveBeenCalledWith('assistant-old-1');
    expect(sessionRepositoryMocks.delete).not.toHaveBeenCalledWith('session-1');
  });
});
