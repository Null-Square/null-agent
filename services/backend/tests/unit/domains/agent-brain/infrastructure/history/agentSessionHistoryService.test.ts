import { describe, it, expect, vi, afterEach } from 'vitest';
import AgentSessionHistoryService from '@/domains/agent-brain/infrastructure/history/agentSessionHistoryService';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const makeSession = (overrides: Partial<SessionState> & { mockProcessing?: boolean } = {}): SessionState => {
  const { mockProcessing, ...rest } = overrides;
  const mockStateMachine = {
    isProcessing: () => mockProcessing ?? false,
    startProcessing: () => true,
    stopProcessing: () => true,
    getState: () => mockProcessing ? "processing" : "idle",
  };
  return {
    id: 'session-1',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/tmp/ws',
    stateMachine: mockStateMachine as any,
    createdAt: 1000,
    lastActive: 2000,
    turn: 0,
    pendingApproval: undefined,
    checkpoints: {},
    ...rest,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSessionHistoryService', () => {
  it('upserts snapshots and clamps messages', async () => {
    const service = new AgentSessionHistoryService();
    const messages: SessionState['messages'] = Array.from(
      { length: 30 },
      (_, index): SessionState['messages'][number] => ({
        id: `m${index}`,
        role: 'user',
        content: `msg-${index}`,
        timestamp: index,
      }),
    );
    const session = makeSession({
      id: 'session-1',
      mockProcessing: true,
      pendingApproval: { actionId: 'a1', tool: 'shell', toolCallId: 'tc-1' },
      plan: [{ id: 'p1', title: 'Plan', status: 'pending' }],
      sandboxProfile: 'standard',
      task: { id: 'task-1', title: 'Task', vars: {} },
      messages,
      extraContext: 'extra',
    });

    await service.upsertSnapshots([session]);
    const record = await service.getSessionById('session-1');

    expect(record?.status).toBe('running');
    expect(record?.plan_length).toBe(1);
    expect(record?.pending_approvals).toBe(1);
    expect(record?.sandbox_profile).toBe('standard');
    expect(record?.task_title).toBe('Task');
    expect(record?.snapshot?.messages?.length).toBe(25);
    expect(record?.snapshot?.messages?.[0].id).toBe('m5');
    expect(record?.snapshot?.messages?.[24].id).toBe('m29');
  });

  it('marks sessions as ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const service = new AgentSessionHistoryService();
    const session = makeSession({ id: 'session-2' });

    await service.markSessionEnded(session, 'ttl');
    const record = await service.getSessionById('session-2');

    expect(record?.is_active).toBe(false);
    expect(record?.end_reason).toBe('ttl');
    expect(record?.ended_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('expires stale sessions and preserves active ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:10Z'));
    const service = new AgentSessionHistoryService();

    const stale = makeSession({ id: 'stale', lastActive: Date.now() - 10000 });
    const fresh = makeSession({ id: 'fresh', lastActive: Date.now() - 1000 });
    const ended = makeSession({ id: 'ended', lastActive: Date.now() - 10000 });

    await service.upsertSnapshots([stale, fresh, ended]);
    await service.markSessionEnded(ended, 'explicit');

    await service.expireStaleSessions(5000);

    const staleRecord = await service.getSessionById('stale');
    const freshRecord = await service.getSessionById('fresh');
    const endedRecord = await service.getSessionById('ended');

    expect(staleRecord?.is_active).toBe(false);
    expect(staleRecord?.end_reason).toBe('expired');
    expect(staleRecord?.ended_at).toBe('2025-01-01T00:00:05.000Z');
    expect(freshRecord?.is_active).toBe(true);
    expect(endedRecord?.end_reason).toBe('explicit');
  });

  it('lists sessions sorted by last activity and enforces limit floor', async () => {
    const service = new AgentSessionHistoryService();
    await service.upsertSnapshots([
      makeSession({ id: 'older', lastActive: 1000 }),
      makeSession({ id: 'newer', lastActive: 2000 }),
    ]);

    const result = await service.listSessions({ limit: 0 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe('newer');
    expect(result.pagination).toEqual({ nextCursor: null, prevCursor: null });
  });

  it('returns null for missing sessions', async () => {
    const service = new AgentSessionHistoryService();

    const record = await service.getSessionById('missing');

    expect(record).toBeNull();
  });
});


