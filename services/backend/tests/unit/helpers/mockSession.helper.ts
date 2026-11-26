import type { SessionState, Message, PlanItem, SessionFlags } from '@/domains/agent-brain/domain/types';
import { MemoryManager } from '@/domains/agent-brain/domain/helpers';
import { createSessionStateMachine } from '@/domains/agent-brain/domain/state/SessionStateMachine';

type SessionOverrides = Partial<SessionState>;

const now = () => Date.now();

export function makeSession(overrides: SessionOverrides = {}): SessionState {
  const sessionId = overrides.id ?? 'session-1';
  return {
    id: sessionId,
    userId: overrides.userId,
    messages: overrides.messages ?? [],
    plan: overrides.plan ?? ([] as PlanItem[]),
    memory: overrides.memory ?? MemoryManager.initialize(),
    flags: overrides.flags ?? ({} as SessionFlags),
    workspaceDir: overrides.workspaceDir ?? '/tmp/workspaces/session-1',
    stateMachine: overrides.stateMachine ?? createSessionStateMachine(sessionId),
    profileKey: overrides.profileKey,
    extraContext: overrides.extraContext,
    createdAt: overrides.createdAt ?? now(),
    lastActive: overrides.lastActive ?? now(),
    turn: overrides.turn ?? 0,
    pendingApproval: overrides.pendingApproval,
    blockedReason: overrides.blockedReason,
    checkpoints: overrides.checkpoints ?? {},
    task: overrides.task,
    toolPolicy: overrides.toolPolicy,
    softContextBlocks: overrides.softContextBlocks,
    planVersionHash: overrides.planVersionHash,
    sandboxProfile: overrides.sandboxProfile,
    sandboxImage: overrides.sandboxImage,
    mode: overrides.mode ?? 'interactive',
    executionMode: overrides.executionMode,
    coordination: overrides.coordination,
    workerTasks: overrides.workerTasks,
    workerResult: overrides.workerResult,
    summary: overrides.summary,
    artifacts: overrides.artifacts ?? [],
    usage: overrides.usage,
    completed: overrides.completed,
    modelName: overrides.modelName,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? 'msg-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? now(),
    status: overrides.status,
    toolName: overrides.toolName,
  };
}

/**
 * Lightweight in-memory session store mock for tests.
 */
export function createInMemorySessionStore(initialSessions: SessionState[] = []) {
  const sessions = new Map<string, SessionState>(initialSessions.map((s) => [s.id, s]));

  return {
    get: (id: string) => sessions.get(id),
    set: (id: string, session: SessionState) => sessions.set(id, session),
    setAsync: async (id: string, session: SessionState) => {
      sessions.set(id, session);
    },
    recordSessionCompletedAsync: async (id: string) => {
      const session = sessions.get(id);
      if (!session) return false;
      session.completed = true;
      sessions.set(id, session);
      return true;
    },
    appendMessageAsync: async (id: string, message: Message) => {
      const session = sessions.get(id);
      if (!session) return false;
      session.messages.push(message);
      sessions.set(id, session);
      return true;
    },
    list: () => Array.from(sessions.values()),
  };
}

