import { describe, expect, it, vi } from 'vitest';

import { ProcessMessageCommand } from '@/domains/agent-brain/application/orchestration/commands/ProcessMessageCommand';

const buildCommand = (repository: Record<string, unknown>) => {
  const abortCurrentTurnAsync = vi.fn(async () => undefined);
  const events = { emit: vi.fn() };
  const command = new ProcessMessageCommand({
    sessionRepository: repository,
    sessionStore: { abortCurrentTurnAsync },
    events,
    log: { info: vi.fn(), warn: vi.fn() },
  } as never);
  return { command, abortCurrentTurnAsync, events };
};

describe('ProcessMessageCommand durable execution claim', () => {
  it('does not enter the turn pipeline when another worker owns the session', async () => {
    const repository = {
      acquireExecutionClaim: vi.fn(async () => false),
      renewExecutionClaim: vi.fn(async () => true),
      ownsExecutionClaim: vi.fn(async () => false),
      releaseExecutionClaim: vi.fn(async () => false),
    };
    const { command, events } = buildCommand(repository);
    const executePipeline = vi.fn();
    (command as any).executePipeline = executePipeline;

    await command.execute({ sessionId: 'session-1', userInput: 'continue' });

    expect(executePipeline).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('session-1', expect.objectContaining({
      data: expect.objectContaining({ code: 'session_already_processing' }),
    }));
  });

  it('aborts the local turn when the database cannot renew its claim', async () => {
    const claimError = new Error('database unavailable');
    const repository = {
      acquireExecutionClaim: vi.fn(async () => true),
      renewExecutionClaim: vi.fn(async () => { throw claimError; }),
      ownsExecutionClaim: vi.fn(async () => true),
      releaseExecutionClaim: vi.fn(async () => true),
    };
    const { command, abortCurrentTurnAsync } = buildCommand(repository);
    (command as any).executePipeline = vi.fn(async (
      _input: unknown,
      heartbeat: () => Promise<void>,
    ) => heartbeat());

    await expect(command.execute({ sessionId: 'session-1', userInput: 'continue' }))
      .rejects.toBe(claimError);

    expect(abortCurrentTurnAsync).toHaveBeenCalledWith('session-1', 'execution_claim_lost');
    expect(repository.releaseExecutionClaim).toHaveBeenCalledOnce();
  });

  it('fails a recovery dispatch when its preclaimed lease is already gone', async () => {
    const repository = {
      acquireExecutionClaim: vi.fn(async () => true),
      renewExecutionClaim: vi.fn(async () => true),
      ownsExecutionClaim: vi.fn(async () => false),
      releaseExecutionClaim: vi.fn(async () => false),
    };
    const { command } = buildCommand(repository);
    const executePipeline = vi.fn();
    (command as any).executePipeline = executePipeline;

    await expect(command.execute({
      sessionId: 'session-1',
      userInput: '',
      executionClaimToken: 'stale-owner',
      retainExecutionClaim: true,
    })).rejects.toThrow('execution_claim_lost');

    expect(repository.acquireExecutionClaim).not.toHaveBeenCalled();
    expect(executePipeline).not.toHaveBeenCalled();
  });
});
