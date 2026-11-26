import { vi, describe, it, expect, Mock } from 'vitest';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: fsMocks.existsSync,
  mkdirSync: fsMocks.mkdirSync,
}));

describe('SessionPersistenceService', () => {
  const baseSession = {
    id: 's1',
    userId: 'u1',
    status: 'running',
    mode: 'interactive',
    workspaceDir: '/tmp/s1',
    plan: [],
    messages: [],
    flags: {},
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
  };

  const createService = (overrides: Partial<ReturnType<typeof buildDeps>> = {}) => {
    const deps = buildDeps();
    const merged = { ...deps, ...overrides };
    return { service: new SessionPersistenceService(merged as any), deps: merged };
  };

  const buildDeps = () => {
    return {
      sessions: {
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        listAll: vi.fn(async (): Promise<any[]> => []),
        findById: vi.fn(),
      },
      messages: {
        listBySession: vi.fn(async (_sessionId: string): Promise<any[]> => []),
        append: vi.fn(),
      },
    };
  };

  it('retries metadata persistence without expectedVersion after conflict', async () => {
    const conflict = new Error('session_version_conflict');
    (conflict as any).code = 'session.conflict';

    const { service, deps } = createService();
    (deps.sessions.update as Mock).mockImplementation(async (_id, _fields, options?: any) => {
      if (options?.expectedVersion !== undefined) {
        throw conflict;
      }
      return true;
    });

    const session = { ...baseSession, version: 5 };
    await service.persistMetadata(session as any);

    expect(deps.sessions.update).toHaveBeenCalledTimes(2);
    expect((deps.sessions.update as Mock).mock.calls[0][2]).toEqual({ expectedVersion: 4 });
    expect((deps.sessions.update as Mock).mock.calls[1][2]).toEqual({ expectedVersion: undefined });
  });

  it('does not let mutable metadata persistence write lifecycle completion', async () => {
    const { service, deps } = createService();
    (deps.sessions.update as Mock).mockResolvedValue(true);

    await service.persistMetadata({
      ...baseSession,
      version: 1,
      completed: true,
      flags: { session: { completed: true, terminalReason: 'report_ready' } },
    } as any);

    const fields = (deps.sessions.update as Mock).mock.calls[0][1];
    expect(fields).not.toHaveProperty('completed');
    expect(fields.metadata.flags.session).toEqual({ terminalReason: 'report_ready' });
  });

  it('falls back to update when create hits duplicate key', async () => {
    const duplicate = new Error('duplicate key value violates unique constraint');
    (duplicate as any).code = '23505';

    const { service, deps } = createService();
    (deps.sessions.create as Mock).mockImplementation(async () => {
      throw duplicate;
    });
    (deps.sessions.update as Mock).mockResolvedValue(true);

    await service.persistSession({ ...baseSession, version: 1 } as any, true);

    expect(deps.sessions.create).toHaveBeenCalledTimes(1);
    expect(deps.sessions.update).toHaveBeenCalledTimes(1);
    expect((deps.sessions.update as Mock).mock.calls[0][2]).toEqual({ expectedVersion: undefined });
  });

  it('sanitizes live tool stream results before persisting session metadata', async () => {
    const { service, deps } = createService();
    (deps.sessions.update as Mock).mockResolvedValue(true);
    const rawStdout = '{"url":"https://scanner-noise.example","status_code":200}\n'.repeat(300);

    await service.persistMetadata({
      ...baseSession,
      version: 1,
      liveToolStreams: {
        wait_for_shell_job: {
          name: 'wait_for_shell_job',
          chunks: ['done'],
          status: 'completed',
          lastUpdated: Date.now(),
          result: {
            status: 'completed',
            stdout: rawStdout,
            stdoutPath: '.artifacts/shell-jobs/job-1/stdout.log',
            exitCode: 0,
          },
        },
      },
    } as any);

    const metadata = (deps.sessions.update as Mock).mock.calls[0][1].metadata;
    const persisted = metadata.liveToolStreams.wait_for_shell_job.result;
    expect(persisted.stdout).toContain('stdout omitted from live session metadata');
    expect(persisted.stdoutPath).toBe('.artifacts/shell-jobs/job-1/stdout.log');
    expect(JSON.stringify(metadata)).not.toContain('https://scanner-noise.example');
  });

  it('persists canonical tool execution receipts outside model-facing result content', async () => {
    const { service, deps } = createService();

    await service.persistMessage('s1', {
      id: 'tool-message-1',
      role: 'tool',
      content: JSON.stringify({ notes: [], totalCount: 0 }),
      timestamp: Date.now(),
      toolCallId: 'tc-query-notes',
      metadata: {
        toolExecution: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'query_notes',
          toolCallId: 'tc-query-notes',
          outcome: 'succeeded',
        },
      },
    });

    expect(deps.messages.append).toHaveBeenCalledWith(expect.objectContaining({
      content: JSON.stringify({ notes: [], totalCount: 0 }),
      toolCallId: 'tc-query-notes',
      metadata: {
        toolExecution: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'query_notes',
          toolCallId: 'tc-query-notes',
          outcome: 'succeeded',
        },
      },
    }));
  });

  it('hydrates most recent sessions and limits message history', async () => {
    const now = Date.now();
    const rows = [
      {
        id: 's-old',
        userId: 'u1',
        mode: 'interactive',
        workspaceDir: '/tmp/s-old',
        metadata: {},
        plan: [],
        summary: null,
        createdAt: new Date(now - 100000),
        updatedAt: new Date(now - 100000),
        lastActiveAt: new Date(now - 100000),
      },
      {
        id: 's-new',
        userId: 'u2',
        mode: 'interactive',
        workspaceDir: '/tmp/s-new',
        metadata: {},
        plan: [],
        summary: null,
        createdAt: new Date(now - 1000),
        updatedAt: new Date(now - 1000),
        lastActiveAt: new Date(now - 1000),
      },
    ];
    const messageRows = [
      { id: 'm1', role: 'user', content: 'one', createdAt: new Date(now - 30) },
      { id: 'm2', role: 'assistant', content: 'two', createdAt: new Date(now - 20) },
      {
        id: 'm3',
        role: 'assistant',
        content: 'three',
        createdAt: new Date(now - 10),
        metadata: {
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'x', arguments: '{}' } }],
          toolExecution: {
            schema: 'tool-execution-receipt/v1',
            toolName: 'query_notes',
            toolCallId: 'call-1',
            outcome: 'succeeded',
          },
        },
      },
    ];

    fsMocks.existsSync.mockReturnValue(false);
    const { service, deps } = createService({
      sessions: {
        ...buildDeps().sessions,
        listAll: vi.fn(async () => rows),
      },
      messages: {
        ...buildDeps().messages,
        listBySession: vi.fn(async (sessionId: string) => (sessionId === 's-new' ? messageRows : [])),
      },
    });

    const hydrated = await service.hydrateAll({ maxSessions: 1, maxMessages: 2 });

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].id).toBe('s-new');
    expect(hydrated[0].messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(hydrated[0].messages[1].tool_calls?.[0]?.id).toBe('call-1');
    expect(hydrated[0].messages[1].metadata?.toolExecution?.outcome).toBe('succeeded');
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/s-new', { recursive: true });
  });

  it('does not restore completed historical sessions during initial hydration', async () => {
    const now = Date.now();
    const makeRow = (
      id: string,
      completed: boolean,
      metadata: Record<string, unknown> = {},
    ) => ({
      id,
      userId: 'u1',
      mode: 'automated',
      workspaceDir: `/tmp/${id}`,
      metadata,
      plan: [],
      summary: null,
      completed,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
      lastActiveAt: new Date(now - 1000),
    });
    const rows = [
      makeRow('s-active', false),
      makeRow('s-column-complete', true),
      makeRow('s-metadata-complete', false, {
        flags: { session: { completed: true } },
      }),
    ];

    fsMocks.existsSync.mockReturnValue(true);
    const { service, deps } = createService({
      sessions: {
        ...buildDeps().sessions,
        listAll: vi.fn(async () => rows),
      },
    });

    const hydrated = await service.hydrateAll();

    expect(hydrated.map((session) => session.id)).toEqual(['s-active']);
    expect(deps.messages.listBySession).toHaveBeenCalledTimes(1);
    expect(deps.messages.listBySession).toHaveBeenCalledWith('s-active');
  });


  it('hydrates usage totals from metadata flags', async () => {
    const now = Date.now();
    const row = {
      id: 's-usage',
      userId: 'u1',
      mode: 'interactive',
      workspaceDir: '/tmp/s-usage',
      metadata: {
        flags: {
          token_usage_totals: {
            promptTokens: 2,
            completionTokens: 3,
            totalTokens: 5,
            cost: 1.5,
            currency: 'usd',
            model: 'gpt-test',
          },
        },
      },
      plan: [],
      summary: null,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
      lastActiveAt: new Date(now - 1000),
    };

    fsMocks.existsSync.mockReturnValue(true);
    const { service } = createService({
      sessions: {
        ...buildDeps().sessions,
        findById: vi.fn().mockResolvedValue(row),
      },
    });

    const session = await service.hydrateSession('s-usage');

    expect(session?.usage).toEqual(
      expect.objectContaining({
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        cost: 1.5,
        currency: 'usd',
        model: 'gpt-test',
      }),
    );
  });

  it('hydrates persisted live tool streams from session metadata', async () => {
    const now = Date.now();
    const row = {
      id: 's-tool-streams',
      userId: 'u1',
      mode: 'interactive',
      workspaceDir: '/tmp/s-tool-streams',
      metadata: {
        liveToolStreams: {
          shell_run: {
            name: 'shell_run',
            chunks: ['npm test'],
            status: 'running',
            command: 'npm test',
            lastUpdated: now,
          },
        },
      },
      plan: [],
      summary: null,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
      lastActiveAt: new Date(now - 1000),
    };

    fsMocks.existsSync.mockReturnValue(true);
    const { service } = createService({
      sessions: {
        ...buildDeps().sessions,
        findById: vi.fn().mockResolvedValue(row),
      },
    });

    const session = await service.hydrateSession('s-tool-streams');

    expect(session?.liveToolStreams).toEqual(
      expect.objectContaining({
        shell_run: expect.objectContaining({
          command: 'npm test',
          chunks: ['npm test'],
          status: 'running',
        }),
      }),
    );
  });

  it('hydrates blockedReason from the durable session row', async () => {
    const now = Date.now();
    const row = {
      id: 's-blocked',
      userId: 'u1',
      mode: 'interactive',
      workspaceDir: '/tmp/s-blocked',
      metadata: {},
      plan: [],
      summary: null,
      blockedReason: 'runner_unavailable',
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
      lastActiveAt: new Date(now - 1000),
    };

    fsMocks.existsSync.mockReturnValue(true);
    const { service } = createService({
      sessions: {
        ...buildDeps().sessions,
        findById: vi.fn().mockResolvedValue(row),
      },
    });

    const session = await service.hydrateSession('s-blocked');

    expect(session?.blockedReason).toBe('runner_unavailable');
  });
});







