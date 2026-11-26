import { describe, it, expect, vi, afterEach } from 'vitest';
import { SimpleApprovalHelper } from '@/domains/agent-brain/application/services/SimpleApprovalHelper';

describe('SimpleApprovalHelper', () => {
  const makeSession = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'session-1',
      mode: 'interactive',
      pendingApproval: undefined,
      ...overrides,
    }) as any;

  const makeSessionStore = (session: any) => ({
    get: vi.fn(() => session),
    setAsync: vi.fn(async (_id: string, next: any) => {
      Object.assign(session, next);
    }),
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never awaits approval in any session mode', () => {
    const sessionStore = makeSessionStore(makeSession());
    const streamBroker = { emit: vi.fn() };
    const helper = new SimpleApprovalHelper(sessionStore as any, streamBroker as any);

    expect(helper.shouldAwaitApproval(undefined)).toBe(false);
    expect(helper.shouldAwaitApproval(makeSession({ mode: 'automated' }))).toBe(false);
    expect(helper.shouldAwaitApproval(makeSession({ mode: 'interactive' }))).toBe(false);
  });

  it('stores pending approval and emits approval_needed', async () => {
    const session = makeSession({ mode: 'interactive' });
    const sessionStore = makeSessionStore(session);
    const streamBroker = { emit: vi.fn() };
    const helper = new SimpleApprovalHelper(sessionStore as any, streamBroker as any);

    const result = await helper.requestApproval(
      session,
      session.id,
      'shell',
      { cmd: 'ls' },
      {
        toolCallId: 'call-1',
        modelRequestId: '10000000-0000-4000-8000-000000000001',
        preview: { cmd: 'ls', path: '/tmp' },
        reason: 'Approval required by policy.',
      },
    );

    expect(result).toBeNull();
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        pendingApproval: expect.objectContaining({
          actionId: 'call-1',
          toolCallId: 'call-1',
          modelRequestId: '10000000-0000-4000-8000-000000000001',
          tool: 'shell',
          args: { cmd: 'ls' },
          preview: { cmd: 'ls', path: '/tmp' },
          reason: 'Approval required by policy.',
        }),
      }),
      'approval_pending',
    );
    expect(streamBroker.emit).toHaveBeenCalledWith(
      session.id,
      {
        type: 'approval_needed',
        data: expect.objectContaining({
          actionId: 'call-1',
          toolCallId: 'call-1',
          tool: 'shell',
        }),
      },
    );
  });

  it('keeps granted approvals resumable until the orchestrator consumes them', async () => {
    const session = makeSession({
      pendingApproval: {
        actionId: 'tool-1',
        toolCallId: 'tool-1',
        modelRequestId: '10000000-0000-4000-8000-000000000002',
        tool: 'shell',
        requestedAt: Date.now(),
      },
    });
    const sessionStore = makeSessionStore(session);
    const streamBroker = { emit: vi.fn() };
    const helper = new SimpleApprovalHelper(sessionStore as any, streamBroker as any);

    const resolved = await helper.resolveDecision(session.id, 'tool-1', 'granted');
    expect(resolved).toEqual({ handled: true, needsResume: true });
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        pendingApproval: expect.objectContaining({ actionId: 'tool-1', toolCallId: 'tool-1' }),
        flags: expect.objectContaining({
          approval_resume: expect.objectContaining({
            actionId: 'tool-1',
            toolCallId: 'tool-1',
            modelRequestId: '10000000-0000-4000-8000-000000000002',
            tool: 'shell',
          }),
        }),
      }),
      'approval_granted',
    );
    expect(streamBroker.emit).not.toHaveBeenCalled();
  });

  it('clears denied approvals and can emit approval_denied', async () => {
    const session = makeSession({
      pendingApproval: {
        actionId: 'tool-2',
        toolCallId: 'tool-2',
        tool: 'shell',
        requestedAt: Date.now(),
      },
      stateMachine: {
        stopProcessing: vi.fn(() => true),
      },
    });
    const sessionStore = makeSessionStore(session);
    const streamBroker = { emit: vi.fn() };
    const helper = new SimpleApprovalHelper(sessionStore as any, streamBroker as any);

    const resolved = await helper.resolveDecision(session.id, 'tool-2', 'denied', 'nope', { emitEvent: true });

    expect(resolved).toEqual({ handled: true, needsResume: false });
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ pendingApproval: undefined }),
      'approval_denied',
    );
    expect(streamBroker.emit).toHaveBeenCalledWith(session.id, {
      type: 'approval_denied',
      data: { actionId: 'tool-2', reason: 'nope' },
    });
  });
});
