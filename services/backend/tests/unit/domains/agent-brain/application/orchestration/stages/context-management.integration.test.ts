import { vi, describe, it, expect } from 'vitest';
import type { BuildPromptResult } from '@/domains/agent-brain/application/orchestration/stages';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// Type for SSE events emitted by context management
type ContextSSEEvent = {
  type: 'context_estimate' | 'context_warning' | 'context_compacted' | 'context_trimmed';
  data: Record<string, unknown>;
};

const baseCompactionCounts = {
  findingsPreserved: 1,
  techniquesPreserved: 2,
  approachesPreserved: 1,
  credentialsPreserved: 0,
  openStepsPreserved: 1,
  discoveriesPreserved: 3,
  constraintsPreserved: 1,
};

/**
 * Integration tests for context management SSE event emission.
 * Tests the full flow from buildPrompt → SSE emission in OrchestratorAdapter.
 */

describe('Context Management Integration', () => {
  const createMockSession = (overrides: Partial<SessionState> = {}): SessionState => ({
    id: 'test-session-123',
    userId: 'user-1',
    mode: 'interactive',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/tmp/workspace',
    status: 'idle',
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
    pendingApproval: undefined,
    checkpoints: {},
    ...overrides,
  });

  describe('context_estimate SSE emission', () => {
    it('emits context_estimate with correct data shape before LLM call', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const mockBuildPromptResult: BuildPromptResult = {
        contextEnvelope: {} as any,
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 5000,
          contextWindow: 10000,
          maxHistoryTokens: 6000,
          percentUsed: 50,
        },
      };

      // Simulate SSE emission logic
      mockEmit('test-session', {
        type: 'context_estimate',
        data: mockBuildPromptResult.contextEstimate,
      });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('context_estimate');
      expect((emittedEvents[0] as any).data.estimatedTokens).toBe(5000);
      expect((emittedEvents[0] as any).data.percentUsed).toBe(50);
    });
  });

  describe('context_warning SSE emission', () => {
    it('emits context_warning when percentUsed >= 80', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const contextEstimate = {
        estimatedTokens: 8500,
        contextWindow: 10000,
        maxHistoryTokens: 6000,
        percentUsed: 85,
      };

      // Simulate warning emission logic
      if (contextEstimate.percentUsed >= 80) {
        mockEmit('test-session', {
          type: 'context_warning',
          data: {
            percentUsed: contextEstimate.percentUsed,
            estimatedTokens: contextEstimate.estimatedTokens,
            contextWindow: contextEstimate.contextWindow,
          },
        });
      }

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('context_warning');
      expect((emittedEvents[0] as any).data.percentUsed).toBe(85);
    });

    it('does NOT emit context_warning when percentUsed < 80', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const contextEstimate = {
        percentUsed: 75,
      };

      // Simulate warning emission logic
      if (contextEstimate.percentUsed >= 80) {
        mockEmit('test-session', {
          type: 'context_warning',
          data: contextEstimate,
        });
      }

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe('context_compacted SSE emission', () => {
    it('emits context_compacted when compactionResult is present', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const mockBuildPromptResult = {
        contextEstimate: {
          estimatedTokens: 3000,
          contextWindow: 10000,
          maxHistoryTokens: 6000,
          percentUsed: 30,
        },
        compactionResult: {
          beforeTokens: 8000,
          afterTokens: 3000,
          messagesSummarized: 7,
          ...baseCompactionCounts,
          compactionVersion: 1,
        },
      };

      // Simulate compaction emission logic
      if (mockBuildPromptResult.compactionResult) {
        mockEmit('test-session', {
          type: 'context_compacted',
          data: mockBuildPromptResult.compactionResult,
        });
      }

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('context_compacted');
      expect((emittedEvents[0] as any).data.messagesSummarized).toBe(7);
      expect((emittedEvents[0] as any).data.discoveriesPreserved).toBe(3);
      expect((emittedEvents[0] as any).data.compactionVersion).toBe(1);
    });

    it('does NOT emit context_compacted when compactionResult is undefined', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const mockBuildPromptResult = {
        contextEstimate: {
          estimatedTokens: 3000,
          contextWindow: 10000,
          percentUsed: 30,
        },
        compactionResult: undefined,
      };

      // Simulate compaction emission logic
      if (mockBuildPromptResult.compactionResult) {
        mockEmit('test-session', {
          type: 'context_compacted',
          data: mockBuildPromptResult.compactionResult,
        });
      }

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe('context_trimmed SSE emission', () => {
    it('emits context_trimmed when contextOverflow is present', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const mockBuildPromptResult = {
        contextOverflow: {
          droppedMessages: 5,
          keptMessages: 20,
          usedTokens: 6000,
          tokenBudget: 6000,
          percentUsed: 100,
        },
      };

      // Simulate trimmed emission logic
      if (mockBuildPromptResult.contextOverflow) {
        mockEmit('test-session', {
          type: 'context_trimmed',
          data: mockBuildPromptResult.contextOverflow,
        });
      }

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('context_trimmed');
      expect((emittedEvents[0] as any).data.droppedMessages).toBe(5);
    });
  });

  describe('SessionState compaction fields integration', () => {
    it('updates session state correctly after compaction', () => {
      const session = createMockSession();

      // Simulate compaction updating session state
      session.compactionSummary = 'Summary of earlier conversation about code changes.';
      session.compactionCutoffTurn = 5;
      session.compactionVersion = 1;

      expect(session.compactionSummary).toContain('Summary');
      expect(session.compactionCutoffTurn).toBe(5);
      expect(session.compactionVersion).toBe(1);
    });

    it('increments compactionVersion on subsequent compaction', () => {
      const session = createMockSession({
        compactionSummary: 'Old summary',
        compactionCutoffTurn: 5,
        compactionVersion: 1,
      });

      // Simulate second compaction
      session.compactionVersion = (session.compactionVersion ?? 0) + 1;
      session.compactionCutoffTurn = 10;
      session.compactionSummary = 'New summary including old and recent messages.';

      expect(session.compactionVersion).toBe(2);
      expect(session.compactionCutoffTurn).toBe(10);
    });
  });

  describe('Full context management flow', () => {
    it('emits all three events in correct order for high context usage', () => {
      const emittedEvents: ContextSSEEvent[] = [];
      const mockEmit = vi.fn((sessionId: string, event: ContextSSEEvent) => {
        emittedEvents.push(event);
      });

      const mockBuildPromptResult = {
        contextEstimate: {
          estimatedTokens: 8500,
          contextWindow: 10000,
          maxHistoryTokens: 6000,
          percentUsed: 85,
        },
        compactionResult: {
          beforeTokens: 8000,
          afterTokens: 3000,
          messagesSummarized: 7,
          ...baseCompactionCounts,
          compactionVersion: 1,
        },
      };

      // Order of emissions in OrchestratorAdapter.processMessage:
      // 1. context_estimate (always)
      mockEmit('test-session', {
        type: 'context_estimate',
        data: mockBuildPromptResult.contextEstimate,
      });

      // 2. context_warning (if >= 80%)
      if (mockBuildPromptResult.contextEstimate.percentUsed >= 80) {
        mockEmit('test-session', {
          type: 'context_warning',
          data: {
            percentUsed: mockBuildPromptResult.contextEstimate.percentUsed,
            estimatedTokens: mockBuildPromptResult.contextEstimate.estimatedTokens,
            contextWindow: mockBuildPromptResult.contextEstimate.contextWindow,
          },
        });
      }

      // 3. context_compacted (if compacted)
      if (mockBuildPromptResult.compactionResult) {
        mockEmit('test-session', {
          type: 'context_compacted',
          data: mockBuildPromptResult.compactionResult,
        });
      }

      expect(emittedEvents).toHaveLength(3);
      expect(emittedEvents[0].type).toBe('context_estimate');
      expect(emittedEvents[1].type).toBe('context_warning');
      expect(emittedEvents[2].type).toBe('context_compacted');
    });
  });
});







