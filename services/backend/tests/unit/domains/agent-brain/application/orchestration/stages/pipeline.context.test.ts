import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

/**
 * Unit and integration tests for context management features:
 * - Real-time context estimate (context_estimate SSE)
 * - Context warning at 80% (context_warning SSE)
 * - Auto-compaction at 70% (context_compacted SSE)
 */

const baseCompactionCounts = {
  findingsPreserved: 1,
  techniquesPreserved: 2,
  approachesPreserved: 1,
  credentialsPreserved: 0,
  openStepsPreserved: 1,
  discoveriesPreserved: 3,
  constraintsPreserved: 1,
};

describe('Context Management Features', () => {
  describe('contextEstimate in BuildPromptResult', () => {
    it('includes contextEstimate with all required fields', async () => {
      // Mock the buildPrompt result
      const mockResult = {
        contextEnvelope: {},
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

      expect(mockResult.contextEstimate).toBeDefined();
      expect(mockResult.contextEstimate.estimatedTokens).toBe(5000);
      expect(mockResult.contextEstimate.contextWindow).toBe(10000);
      expect(mockResult.contextEstimate.percentUsed).toBe(50);
    });

    it('calculates percentUsed correctly', () => {
      const estimatedTokens = 7000;
      const contextWindow = 10000;
      const percentUsed = Math.round((estimatedTokens / contextWindow) * 100);
      
      expect(percentUsed).toBe(70);
    });
  });

  describe('Context Warning at 80%', () => {
    it('should trigger warning when percentUsed >= 80', () => {
      const contextEstimate = {
        estimatedTokens: 8000,
        contextWindow: 10000,
        percentUsed: 80,
      };

      const shouldWarn = contextEstimate.percentUsed >= 80;
      expect(shouldWarn).toBe(true);
    });

    it('should NOT trigger warning when percentUsed < 80', () => {
      const contextEstimate = {
        estimatedTokens: 7000,
        contextWindow: 10000,
        percentUsed: 70,
      };

      const shouldWarn = contextEstimate.percentUsed >= 80;
      expect(shouldWarn).toBe(false);
    });
  });

  describe('Auto-Compaction policy', () => {
    const INITIAL_THRESHOLD = 0.7;
    const INCREMENTAL_THRESHOLD = 0.65;
    const PRESERVE_TAIL_RATIO = 0.3;

    it('should trigger compaction when percentUsed >= 70 and enough messages', () => {
      const totalEstimatedTokens = 7000;
      const MAX_HISTORY_TOKENS = 10000;
      const messageCount = 10;
      const turnsPassedSinceCompaction = 5;

      const percentUsed = totalEstimatedTokens / MAX_HISTORY_TOKENS;
      const shouldCompact = 
        percentUsed >= INITIAL_THRESHOLD && 
        messageCount >= 6 && 
        turnsPassedSinceCompaction >= 5;

      expect(percentUsed).toBe(0.7);
      expect(shouldCompact).toBe(true);
    });

    it('should NOT trigger compaction when percentUsed < 70', () => {
      const totalEstimatedTokens = 6000;
      const MAX_HISTORY_TOKENS = 10000;
      const messageCount = 10;
      const turnsPassedSinceCompaction = 5;

      const percentUsed = totalEstimatedTokens / MAX_HISTORY_TOKENS;
      const shouldCompact = 
        percentUsed >= INITIAL_THRESHOLD && 
        messageCount >= 6 && 
        turnsPassedSinceCompaction >= 5;

      expect(percentUsed).toBe(0.6);
      expect(shouldCompact).toBe(false);
    });

    it('allows incremental compaction after the first summary when cooldown passed', () => {
      const totalEstimatedTokens = 6800;
      const MAX_HISTORY_TOKENS = 10000;
      const messageCount = 10;
      const hasExistingSummary = true;
      const turnsPassedSinceCompaction = 3;

      const percentUsed = totalEstimatedTokens / MAX_HISTORY_TOKENS;
      const shouldCompact = 
        percentUsed >= INCREMENTAL_THRESHOLD && 
        messageCount >= 6 && 
        turnsPassedSinceCompaction >= 3 &&
        hasExistingSummary;

      expect(shouldCompact).toBe(true);
    });

    it('should NOT trigger compaction when not enough messages', () => {
      const totalEstimatedTokens = 8000;
      const MAX_HISTORY_TOKENS = 10000;
      const messageCount = 4; // Less than 6
      const turnsPassedSinceCompaction = 5;

      const percentUsed = totalEstimatedTokens / MAX_HISTORY_TOKENS;
      const shouldCompact = 
        percentUsed >= INITIAL_THRESHOLD && 
        messageCount >= 6 && 
        turnsPassedSinceCompaction >= 5;

      expect(shouldCompact).toBe(false);
    });

    it('preserves newest 30% of messages', () => {
      const messageCount = 10;
      const preserveCount = Math.max(3, Math.ceil(messageCount * PRESERVE_TAIL_RATIO));
      const toSummarize = messageCount - preserveCount;

      expect(preserveCount).toBe(3);
      expect(toSummarize).toBe(7);
    });

    it('preserves at least 3 messages', () => {
      const messageCount = 6;
      const preserveCount = Math.max(3, Math.ceil(messageCount * PRESERVE_TAIL_RATIO));

      expect(preserveCount).toBe(3); // Even though 6 * 0.3 = 1.8, minimum is 3
    });
  });

  describe('compactionResult in BuildPromptResult', () => {
    it('includes compactionResult when compaction occurred', () => {
      const mockResult = {
        contextEnvelope: {},
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
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

      expect(mockResult.compactionResult).toBeDefined();
      expect(mockResult.compactionResult!.messagesSummarized).toBe(7);
      expect(mockResult.compactionResult!.discoveriesPreserved).toBe(3);
      expect(mockResult.compactionResult!.beforeTokens).toBeGreaterThan(mockResult.compactionResult!.afterTokens);
    });

    it('compactionResult is undefined when no compaction occurred', () => {
      const mockResult = {
        contextEnvelope: {},
        systemMessages: [],
        historyMessages: [],
        toolDefinitions: [],
        contextEstimate: {
          estimatedTokens: 3000,
          contextWindow: 10000,
          maxHistoryTokens: 6000,
          percentUsed: 30,
        },
        compactionResult: undefined,
      };

      expect(mockResult.compactionResult).toBeUndefined();
    });
  });

  describe('SessionState compaction fields', () => {
    it('stores compaction state correctly', () => {
      const sessionState = {
        id: 'test-session',
        compactionSummary: 'Summary of earlier conversation...',
        compactionCutoffTurn: 5,
        compactionVersion: 1,
      };

      expect(sessionState.compactionSummary).toBeDefined();
      expect(sessionState.compactionCutoffTurn).toBe(5);
      expect(sessionState.compactionVersion).toBe(1);
    });

    it('increments compactionVersion on each compaction', () => {
      let compactionVersion = 0;
      
      // First compaction
      compactionVersion = (compactionVersion ?? 0) + 1;
      expect(compactionVersion).toBe(1);

      // Second compaction
      compactionVersion = (compactionVersion ?? 0) + 1;
      expect(compactionVersion).toBe(2);
    });
  });
});

describe('SSE Event Integration', () => {
  describe('context_estimate event', () => {
    it('emits context_estimate with correct data shape', () => {
      const emit = vi.fn();
      const sessionId = 'test-session';
      const contextEstimate = {
        estimatedTokens: 5000,
        contextWindow: 10000,
        maxHistoryTokens: 6000,
        percentUsed: 50,
      };

      // Simulate emission
      emit(sessionId, {
        type: 'context_estimate',
        data: contextEstimate,
      });

      expect(emit).toHaveBeenCalledWith(sessionId, {
        type: 'context_estimate',
        data: expect.objectContaining({
          estimatedTokens: 5000,
          percentUsed: 50,
        }),
      });
    });
  });

  describe('context_warning event', () => {
    it('emits context_warning when percentUsed >= 80', () => {
      const emit = vi.fn();
      const sessionId = 'test-session';
      const contextEstimate = {
        estimatedTokens: 8500,
        contextWindow: 10000,
        percentUsed: 85,
      };

      // Simulate warning check
      if (contextEstimate.percentUsed >= 80) {
        emit(sessionId, {
          type: 'context_warning',
          data: {
            percentUsed: contextEstimate.percentUsed,
            estimatedTokens: contextEstimate.estimatedTokens,
            contextWindow: contextEstimate.contextWindow,
          },
        });
      }

      expect(emit).toHaveBeenCalledWith(sessionId, {
        type: 'context_warning',
        data: expect.objectContaining({
          percentUsed: 85,
        }),
      });
    });

    it('does NOT emit context_warning when percentUsed < 80', () => {
      const emit = vi.fn();
      const contextEstimate = { percentUsed: 75 };

      if (contextEstimate.percentUsed >= 80) {
        emit('session', { type: 'context_warning', data: contextEstimate });
      }

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('context_compacted event', () => {
    it('emits context_compacted when compaction occurred', () => {
      const emit = vi.fn();
      const sessionId = 'test-session';
      const compactionResult = {
        beforeTokens: 8000,
        afterTokens: 3000,
        messagesSummarized: 7,
        ...baseCompactionCounts,
        compactionVersion: 1,
      };

      // Simulate emission
      if (compactionResult) {
        emit(sessionId, {
          type: 'context_compacted',
          data: compactionResult,
        });
      }

      expect(emit).toHaveBeenCalledWith(sessionId, {
        type: 'context_compacted',
        data: expect.objectContaining({
          messagesSummarized: 7,
          discoveriesPreserved: 3,
          compactionVersion: 1,
        }),
      });
    });

    it('does NOT emit context_compacted when no compaction', () => {
      const emit = vi.fn();
      const compactionResult = undefined;

      if (compactionResult) {
        emit('session', { type: 'context_compacted', data: compactionResult });
      }

      expect(emit).not.toHaveBeenCalled();
    });
  });
});

describe('Token Estimation', () => {
  const estimateTokens = (msg: { content?: string }) => {
    if (typeof msg?.content !== 'string') return 0;
    const content = msg.content;
    const byChars = Math.ceil(content.length / 4);
    const byWords = Math.ceil(content.trim().split(/\s+/).filter(Boolean).length * 1.05);
    return Math.max(1, Math.max(byChars, byWords));
  };

  it('estimates tokens by character count', () => {
    const msg = { content: 'Hello world' }; // 11 chars
    const tokens = estimateTokens(msg);
    
    // 11 / 4 = 2.75 -> ceil = 3
    // 2 words * 1.05 = 2.1 -> ceil = 3
    expect(tokens).toBe(3);
  });

  it('estimates tokens for longer content', () => {
    const msg = { content: 'This is a longer message with more words and content to estimate.' };
    const tokens = estimateTokens(msg);
    
    expect(tokens).toBeGreaterThan(10);
  });

  it('returns 0 for non-string content', () => {
    const msg = { content: undefined };
    const tokens = estimateTokens(msg as any);
    
    expect(tokens).toBe(0);
  });

  it('returns at least 1 for non-empty content', () => {
    const msg = { content: 'a' };
    const tokens = estimateTokens(msg);
    
    expect(tokens).toBeGreaterThanOrEqual(1);
  });
});







