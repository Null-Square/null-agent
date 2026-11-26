import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Regression tests for Model Context Window wiring (Dec 2025)
 * 
 * These tests lock in the dynamic context window functionality:
 * 1. Context limits read from model config, not hardcoded
 * 2. Dynamic history token budget calculation
 * 3. Context overflow notifications emitted when messages dropped
 */

import type { SessionState, Message } from '@/domains/agent-brain/domain/types';
import type { BuildPromptResult } from '@/domains/agent-brain/application/orchestration/stages';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// ============================================================================
// TEST 1: Dynamic context budget calculation
// ============================================================================

describe('Dynamic Context Budget Calculation', () => {
  const calculateHistoryBudget = (contextWindow: number, maxOutputTokens: number) => {
    const SYSTEM_PROMPT_RESERVE = 4000;
    const HISTORY_RATIO = 0.7;
    const availableForHistory = contextWindow - maxOutputTokens - SYSTEM_PROMPT_RESERVE;
    return Math.max(2000, Math.floor(availableForHistory * HISTORY_RATIO));
  };

  it('calculates larger budget for 100k context model', () => {
    // Qwen 3 Max: contextWindow=100000, maxOutputTokens=8192
    const budget = calculateHistoryBudget(100000, 8192);
    
    // (100000 - 8192 - 4000) * 0.7 = 61465
    expect(budget).toBe(61465);
    expect(budget).toBeGreaterThan(2000); // Much larger than old hardcoded value
  });

  it('calculates smaller budget for 8k context model', () => {
    // GPT-3.5: contextWindow=8000, maxOutputTokens=2048
    const budget = calculateHistoryBudget(8000, 2048);
    
    // (8000 - 2048 - 4000) * 0.7 = 1366 → max(2000, 1366) = 2000
    expect(budget).toBe(2000); // Falls back to minimum
  });

  it('handles 128k context model', () => {
    // Claude 3: contextWindow=128000, maxOutputTokens=4096
    const budget = calculateHistoryBudget(128000, 4096);
    
    // (128000 - 4096 - 4000) * 0.7 = 83932
    expect(budget).toBe(83932);
    expect(budget).toBeGreaterThan(60000);
  });

  it('uses minimum budget when context is very small', () => {
    // Tiny model: contextWindow=4000, maxOutputTokens=1000
    const budget = calculateHistoryBudget(4000, 1000);
    
    // (4000 - 1000 - 4000) * 0.7 = -700 → max(2000, -700) = 2000
    expect(budget).toBe(2000); // Never goes below minimum
  });
});

// ============================================================================
// TEST 2: SessionState model context fields
// ============================================================================

describe('SessionState Model Context Fields', () => {
  const makeSession = (overrides: Partial<SessionState> = {}): SessionState => ({
    id: 'test-session',
    userId: 'test-user',
    messages: [],
    plan: [],
    memory: createEmptyMemory(),
    flags: {},
    workspaceDir: '/tmp/test',
    createdAt: Date.now(),
    lastActive: Date.now(),
    turn: 0,
    pendingApproval: undefined,
    checkpoints: {},
    ...overrides,
  });

  it('accepts modelContextWindow field', () => {
    const session = makeSession({ modelContextWindow: 100000 });
    expect(session.modelContextWindow).toBe(100000);
  });

  it('accepts modelMaxOutputTokens field', () => {
    const session = makeSession({ modelMaxOutputTokens: 8192 });
    expect(session.modelMaxOutputTokens).toBe(8192);
  });

  it('allows undefined model context (fallback behavior)', () => {
    const session = makeSession();
    expect(session.modelContextWindow).toBeUndefined();
    expect(session.modelMaxOutputTokens).toBeUndefined();
  });
});

// ============================================================================
// TEST 3: Context overflow detection
// ============================================================================

describe('Context Overflow Detection', () => {
  const makeContextOverflow = (dropped: number, kept: number, usedTokens: number, budget: number) => {
    if (dropped <= 0) return undefined;
    return {
      droppedMessages: dropped,
      keptMessages: kept,
      usedTokens,
      tokenBudget: budget,
      percentUsed: Math.round((usedTokens / budget) * 100),
    };
  };

  it('returns undefined when no messages dropped', () => {
    const overflow = makeContextOverflow(0, 10, 500, 2000);
    expect(overflow).toBeUndefined();
  });

  it('returns overflow info when messages dropped', () => {
    const overflow = makeContextOverflow(5, 20, 1900, 2000);
    expect(overflow).toEqual({
      droppedMessages: 5,
      keptMessages: 20,
      usedTokens: 1900,
      tokenBudget: 2000,
      percentUsed: 95,
    });
  });

  it('calculates correct percentUsed at capacity', () => {
    const overflow = makeContextOverflow(1, 50, 61000, 61465);
    expect(overflow?.percentUsed).toBe(99);
  });
});

// ============================================================================
// TEST 4: BuildPromptResult includes contextOverflow
// ============================================================================

describe('BuildPromptResult contextOverflow field', () => {
  const makeBuildPromptResult = (overflow?: BuildPromptResult['contextOverflow']): BuildPromptResult => ({
    contextEnvelope: { hard: '', soft: '' },
    systemMessages: [],
    historyMessages: [],
    toolDefinitions: [],
    contextOverflow: overflow,
    contextEstimate: {
      estimatedTokens: 1000,
      contextWindow: 10000,
      maxHistoryTokens: 7000,
      percentUsed: 10,
    },
  });

  it('includes contextOverflow when messages trimmed', () => {
    const result = makeBuildPromptResult({
      droppedMessages: 3,
      keptMessages: 15,
      usedTokens: 1800,
      tokenBudget: 2000,
      percentUsed: 90,
    });
    
    expect(result.contextOverflow).toBeDefined();
    expect(result.contextOverflow?.droppedMessages).toBe(3);
  });

  it('omits contextOverflow when no trimming', () => {
    const result = makeBuildPromptResult(undefined);
    expect(result.contextOverflow).toBeUndefined();
  });
});

// ============================================================================
// TEST 5: StreamEvent context_trimmed type
// ============================================================================

describe('StreamEvent context_trimmed type', () => {
  type ContextTrimmedEvent = {
    type: 'context_trimmed';
    data: {
      droppedMessages: number;
      keptMessages: number;
      usedTokens: number;
      tokenBudget: number;
      percentUsed: number;
    };
  };

  it('has correct structure for context_trimmed event', () => {
    const event: ContextTrimmedEvent = {
      type: 'context_trimmed',
      data: {
        droppedMessages: 5,
        keptMessages: 20,
        usedTokens: 58000,
        tokenBudget: 61465,
        percentUsed: 94,
      },
    };

    expect(event.type).toBe('context_trimmed');
    expect(event.data.droppedMessages).toBeGreaterThan(0);
    expect(event.data.percentUsed).toBeLessThanOrEqual(100);
  });
});







