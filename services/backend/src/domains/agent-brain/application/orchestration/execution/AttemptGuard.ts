/**
 * AttemptGuard - Enforce max-attempt limits for techniques on endpoints
 * Prevents repeated failed attempts by checking agent memory
 * 
 * @module agent-brain/application/orchestration/execution/AttemptGuard
 */

import type { AgentMemory } from '../../../domain/types';
import { getAttemptKeyVariants, parseAttemptKey } from '../../../domain/types/memory';

export interface SkipDecision {
  /** Whether to skip this attempt */
  skip: boolean;
  /** Reason for skipping (if skip is true) */
  reason?: string;
}

/**
 * Runtime guard to prevent repeated failed attempts.
 * Implements Deadend-style "MAXIMUM 2 CALLS per endpoint/approach" rule.
 */
export class AttemptGuard {
  private readonly maxAttempts: number;

  constructor(maxAttempts: number = 2) {
    this.maxAttempts = maxAttempts;
  }

  /**
   * Check if an attempt should be skipped based on memory
   */
  shouldSkip(args: {
    endpoint: string;
    technique: string;
    memory: AgentMemory;
    currentTurn: number;
  }): SkipDecision {
    const attempt = getAttemptKeyVariants(args.endpoint, args.technique)
      .map((key) => args.memory.attemptedTechniques[key])
      .find(Boolean);

    if (!attempt) {
      return { skip: false };
    }

    // Hard limit: max attempts reached
    if (attempt.count >= this.maxAttempts) {
      return {
        skip: true,
        reason: `Already attempted ${attempt.count} times (max ${this.maxAttempts})`,
      };
    }

    // Per-turn guard: prevent retry in same turn
    if (attempt.lastAttemptTurn === args.currentTurn) {
      return {
        skip: true,
        reason: 'Already attempted in current turn',
      };
    }

    // Success guard: don't retry if it already succeeded
    if (attempt.result === 'success') {
      return {
        skip: true,
        reason: 'Already succeeded with this technique',
      };
    }

    return { skip: false };
  }

  /**
   * Get current attempt count for an endpoint+technique
   */
  getAttemptCount(
    memory: AgentMemory,
    endpoint: string,
    technique: string
  ): number {
    const attempt = getAttemptKeyVariants(endpoint, technique)
      .map((key) => memory.attemptedTechniques[key])
      .find(Boolean);
    return attempt?.count || 0;
  }

  /**
   * Check if any attempts have been made on an endpoint
   */
  hasTestedEndpoint(memory: AgentMemory, endpoint: string): boolean {
    return memory.testedEndpoints.includes(endpoint);
  }

  /**
   * Get all techniques attempted on an endpoint
   */
  getTechniquesForEndpoint(
    memory: AgentMemory,
    endpoint: string
  ): string[] {
    const parsedKeys = Object.keys(memory.attemptedTechniques)
      .map((key) => parseAttemptKey(key))
      .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);

    return parsedKeys
      .filter((parsed) => parsed.endpoint === endpoint)
      .map((parsed) => parsed.technique);
  }
}
