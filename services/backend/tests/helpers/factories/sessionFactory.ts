/**
 * Session Test Factory
 * 
 * Provides typed factory functions for creating test session data.
 * Use these instead of ad-hoc object literals to ensure type safety
 * and consistent defaults across tests.
 * 
 * @example
 * ```typescript
 * import { createSession, createMessage, createArtifact } from '@/tests/helpers/factories/sessionFactory';
 * 
 * const session = createSession({ userId: 'test-user-123' });
 * const message = createMessage({ role: 'user', content: 'Hello' });
 * ```
 */

import { v4 as uuidv4 } from 'uuid';
import type { SessionState, Message, PlanItem, SessionArtifact, SessionUsage } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// =============================================================================
// Session Factory
// =============================================================================

type SessionOverrides = Partial<SessionState>;

/**
 * Create a test SessionState with sensible defaults.
 */
export function createSession(overrides: SessionOverrides = {}): SessionState {
  const id = overrides.id ?? `session-${uuidv4()}`;
  const now = Date.now();

  return {
    id,
    version: 1,
    userId: undefined,
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: `/tmp/workspaces/${id}`,
    // stateMachine provides isProcessing
    createdAt: now,
    lastActive: now,
    turn: 0,
    pendingApproval: undefined,
    checkpoints: {},
    mode: 'interactive',
    ...overrides,
  };
}

// =============================================================================
// Message Factory
// =============================================================================

type MessageOverrides = Partial<Message>;

/**
 * Create a test Message with sensible defaults.
 */
export function createMessage(overrides: MessageOverrides = {}): Message {
  return {
    id: overrides.id ?? `msg-${uuidv4()}`,
    role: 'user',
    content: 'Test message content',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a user message.
 */
export function createUserMessage(content: string, overrides: Omit<MessageOverrides, 'role' | 'content'> = {}): Message {
  return createMessage({ role: 'user', content, ...overrides });
}

/**
 * Create an assistant message.
 */
export function createAssistantMessage(content: string, overrides: Omit<MessageOverrides, 'role' | 'content'> = {}): Message {
  return createMessage({ role: 'assistant', content, ...overrides });
}

/**
 * Create a tool message.
 */
export function createToolMessage(
  content: string,
  toolName: string,
  overrides: Omit<MessageOverrides, 'role' | 'content' | 'toolName'> = {},
): Message {
  return createMessage({ role: 'tool', content, toolName, ...overrides });
}

// =============================================================================
// Plan Item Factory
// =============================================================================

type PlanItemOverrides = Partial<PlanItem>;

/**
 * Create a test PlanItem with sensible defaults.
 */
export function createPlanItem(overrides: PlanItemOverrides = {}): PlanItem {
  return {
    id: overrides.id ?? `plan-${uuidv4()}`,
    title: 'Test plan step',
    status: 'pending',
    ...overrides,
  };
}

// =============================================================================
// Artifact Factory
// =============================================================================

type ArtifactOverrides = Partial<SessionArtifact>;

/**
 * Create a test SessionArtifact with sensible defaults.
 */
export function createArtifact(overrides: ArtifactOverrides = {}): SessionArtifact {
  const id = overrides.id ?? `artifact-${uuidv4()}`;
  
  return {
    id,
    filePath: `/artifacts/${id}/output.txt`,
    originalName: 'output.txt',
    fileType: 'text/plain',
    sizeBytes: 1024,
    createdAt: Date.now(),
    storage: 'local',
    ...overrides,
  };
}

// =============================================================================
// Usage Factory
// =============================================================================

type UsageOverrides = Partial<SessionUsage>;

/**
 * Create a test SessionUsage with sensible defaults.
 */
export function createUsage(overrides: UsageOverrides = {}): SessionUsage {
  return {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cost: 0.001,
    model: 'gpt-4o',
    ...overrides,
  };
}

// =============================================================================
// Batch Factories
// =============================================================================

/**
 * Create multiple sessions for testing pagination.
 */
export function createSessions(count: number, overrides: SessionOverrides = {}): SessionState[] {
  return Array.from({ length: count }, (_, i) => 
    createSession({ title: `Session ${i + 1}`, ...overrides })
  );
}

/**
 * Create a conversation (session with messages).
 */
export function createConversation(
  messageCount: number = 4,
  sessionOverrides: SessionOverrides = {},
): SessionState {
  const messages: Message[] = [];
  
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push(createMessage({
      role,
      content: `${role === 'user' ? 'User' : 'Assistant'} message ${i + 1}`,
    }));
  }

  return createSession({ messages, turn: Math.floor(messageCount / 2), ...sessionOverrides });
}

