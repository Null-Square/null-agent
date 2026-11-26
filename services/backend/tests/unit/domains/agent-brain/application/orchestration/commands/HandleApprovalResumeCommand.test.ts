import { describe, expect, it, vi } from 'vitest';

import { HandleApprovalResumeCommand } from '@/domains/agent-brain/application/orchestration/commands/HandleApprovalResumeCommand';

const buildHarness = (pendingApproval?: Record<string, unknown>) => {
  const session = {
    id: 'session-1',
    version: 1,
    mode: 'automated',
    turn: 2,
    messages: [],
    flags: {},
    ...(pendingApproval ? { pendingApproval } : {}),
  } as any;
  const sessionStore = {
    get: vi.fn(() => session),
    getJournalProjection: vi.fn(async () => ({ desiredExecution: 'running' })),
    startTurnAsync: vi.fn(async () => true),
    clearCurrentTurnAsync: vi.fn(async () => undefined),
    setAsync: vi.fn(async () => undefined),
    recordToolOutcomesAcceptedAsync: vi.fn(async () => undefined),
    appendMessageAsync: vi.fn(async () => undefined),
  };
  const toolsRegistry = {
    executeWithReceipt: vi.fn(async () => {
      expect(session.flags.approval_resume).toEqual({
        actionId: 'approval-1',
        toolCallId: 'call-1',
        tool: 'run_command',
        modelRequestId: 'request-1',
      });
      return {
        result: { ok: true },
        receipt: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'run_command',
          toolCallId: 'call-1',
          modelRequestId: 'request-1',
          outcome: 'succeeded',
        },
      };
    }),
  };
  const processClaimedMessage = vi.fn(async () => undefined);
  const ownsExecutionClaim = vi.fn(async () => true);
  const command = new HandleApprovalResumeCommand({
    sessionStore: sessionStore as never,
    events: { emit: vi.fn() } as never,
    toolsRegistry: toolsRegistry as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    processMessage: vi.fn(async () => undefined),
    processClaimedMessage,
    ownsExecutionClaim,
  });
  return {
    command,
    session,
    sessionStore,
    toolsRegistry,
    processClaimedMessage,
    ownsExecutionClaim,
  };
};

const approval = {
  actionId: 'approval-1',
  toolCallId: 'call-1',
  modelRequestId: 'request-1',
  toolName: 'run_command',
  args: { command: 'pwd' },
};

describe('HandleApprovalResumeCommand', () => {
  it('derives permission context from a durable grant before executing under the worker lease', async () => {
    const harness = buildHarness();

    await harness.command.execute({
      sessionId: 'session-1',
      approval,
      executionClaimToken: 'claim-1',
      durablyGranted: true,
    });

    expect(harness.toolsRegistry.executeWithReceipt).toHaveBeenCalledWith(
      'run_command',
      { command: 'pwd' },
      {
        sessionId: 'session-1',
        abortSignal: expect.any(AbortSignal),
        toolCallId: 'call-1',
        modelRequestId: 'request-1',
      },
    );
    expect(harness.sessionStore.recordToolOutcomesAcceptedAsync).toHaveBeenCalledOnce();
    expect(harness.sessionStore.appendMessageAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'tool-result-approval-1', role: 'tool', toolCallId: 'call-1' }),
    );
    expect(harness.processClaimedMessage).toHaveBeenCalledWith(
      'session-1',
      'claim-1',
      '',
      undefined,
    );
    expect(harness.session.flags).not.toHaveProperty('approval_resume');
    expect(harness.sessionStore.startTurnAsync).toHaveBeenCalledWith(
      'session-1',
      expect.any(AbortController),
      { reason: 'approved_tool_execution' },
    );
    expect(harness.sessionStore.clearCurrentTurnAsync).toHaveBeenCalledOnce();
  });

  it('rejects a stale mutable approval projection that conflicts with the durable grant', async () => {
    const harness = buildHarness({
      actionId: 'approval-new',
      toolCallId: 'call-new',
      tool: 'run_command',
    });

    await expect(harness.command.execute({
      sessionId: 'session-1',
      approval,
      executionClaimToken: 'claim-1',
      durablyGranted: true,
    })).rejects.toThrow('approved_tool_projection_mismatch');

    expect(harness.toolsRegistry.executeWithReceipt).not.toHaveBeenCalled();
    expect(harness.processClaimedMessage).not.toHaveBeenCalled();
  });

  it('does not dispatch when Stop revokes the lease after abort registration', async () => {
    const harness = buildHarness();
    harness.ownsExecutionClaim
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await harness.command.execute({
      sessionId: 'session-1',
      approval,
      executionClaimToken: 'claim-1',
      durablyGranted: true,
    });

    expect(harness.sessionStore.startTurnAsync).toHaveBeenCalledOnce();
    expect(harness.toolsRegistry.executeWithReceipt).not.toHaveBeenCalled();
    expect(harness.processClaimedMessage).not.toHaveBeenCalled();
    expect(harness.session.flags).not.toHaveProperty('approval_resume');
    expect(harness.sessionStore.clearCurrentTurnAsync).toHaveBeenCalledOnce();
  });

  it('records a settled tool outcome but does not continue after a racing Stop', async () => {
    const harness = buildHarness();
    harness.toolsRegistry.executeWithReceipt.mockImplementationOnce(async () => {
      harness.session.blockedReason = 'user_paused';
      harness.ownsExecutionClaim.mockResolvedValue(false);
      return {
        result: { ok: true },
        receipt: {
          schema: 'tool-execution-receipt/v1',
          toolName: 'run_command',
          toolCallId: 'call-1',
          modelRequestId: 'request-1',
          outcome: 'succeeded',
        },
      };
    });

    await harness.command.execute({
      sessionId: 'session-1',
      approval,
      executionClaimToken: 'claim-1',
      durablyGranted: true,
    });

    expect(harness.sessionStore.recordToolOutcomesAcceptedAsync).toHaveBeenCalledOnce();
    expect(harness.sessionStore.appendMessageAsync).toHaveBeenCalledOnce();
    expect(harness.session.blockedReason).toBe('user_paused');
    expect(harness.processClaimedMessage).not.toHaveBeenCalled();
    expect(harness.sessionStore.clearCurrentTurnAsync).toHaveBeenCalledOnce();
  });
});
