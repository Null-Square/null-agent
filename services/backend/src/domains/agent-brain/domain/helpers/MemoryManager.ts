/**
 * MemoryManager - CRUD operations for AgentMemory
 * Provides clean interface for managing agent memory state
 *
 * @module agent-brain/domain/helpers/MemoryManager
 */

import type {
  AgentMemory,
  DiscoveredFact,
  FactCategory,
  AttemptRecord,
  AttemptResult,
  FailedApproach,
} from '../types/memory';
import {
  createAttemptKey,
  createEmptyMemory,
  getAttemptKeyVariants,
} from '../types/memory';

export interface StrategicMemorySeedNote {
  ntype?: unknown;
  data?: unknown;
  lastSeenAt?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeKeyText = (value: unknown): string =>
  normalizeText(value).toLowerCase();

const normalizeAttemptResult = (value: unknown): AttemptResult | undefined => {
  const normalized = normalizeKeyText(value);
  if (normalized === 'success' || normalized === 'succeeded' || normalized === 'ok') {
    return 'success';
  }
  if (normalized === 'failed' || normalized === 'failure' || normalized === 'error') {
    return 'failed';
  }
  if (normalized === 'blocked') {
    return 'blocked';
  }
  return undefined;
};

const parseStatusCode = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
};

const deriveAttemptResultFromNoteData = (data: Record<string, unknown>): AttemptResult => {
  const explicit = normalizeAttemptResult(data.result);
  if (explicit) {
    return explicit;
  }

  const statusCode = parseStatusCode(data.http_status);
  if (typeof statusCode === 'number') {
    if (statusCode === 401 || statusCode === 403) {
      return 'blocked';
    }
    if (statusCode >= 400 && statusCode <= 599) {
      return 'failed';
    }
    if (statusCode >= 200 && statusCode <= 399) {
      return 'success';
    }
  }

  return 'failed';
};

const toEpochMs = (value: unknown): number => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }
  return Date.now();
};

const toPositiveIntOr = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return fallback;
};

/**
 * Result of adding a fact to memory
 */
export interface AddFactResult {
  /** Whether the fact was newly added (true) or updated an existing fact (false) */
  added: boolean;
  /** Whether an existing fact was updated with higher confidence */
  updated: boolean;
  /** The previous value if updated */
  previousValue?: unknown;
  /** The previous confidence if updated */
  previousConfidence?: number;
  /** Current memory stats after the operation */
  stats: MemoryStats;
}

/**
 * Result of recording an attempt
 */
export interface RecordAttemptResult {
  /** Whether this is a new endpoint+technique combination */
  isNew: boolean;
  /** Whether a failure was recorded */
  failureRecorded: boolean;
  /** Whether a new endpoint was added to testedEndpoints */
  newEndpoint: boolean;
  /** Current memory stats after the operation */
  stats: MemoryStats;
}

/**
 * Memory statistics snapshot
 */
export interface MemoryStats {
  factsCount: number;
  attemptsCount: number;
  failuresCount: number;
  endpointsCount: number;
}

/**
 * Helper class for managing agent memory operations
 */
export class MemoryManager {
  /**
   * Add a discovered fact to memory
   * @returns Information about the change for trace event emission
   */
  static addFact(
    memory: AgentMemory,
    fact: Omit<DiscoveredFact, 'discoveredAt'>
  ): AddFactResult {
    // Check for duplicate by key
    const existing = memory.discoveredFacts.find((f) => f.key === fact.key);
    if (existing) {
      // Update existing fact with higher confidence
      if (fact.confidence > existing.confidence) {
        const previousValue = existing.value;
        const previousConfidence = existing.confidence;
        existing.value = fact.value;
        existing.confidence = fact.confidence;
        existing.source = fact.source;
        existing.discoveredAt = Date.now();
        return {
          added: false,
          updated: true,
          previousValue,
          previousConfidence,
          stats: this.getStats(memory),
        };
      }
      return {
        added: false,
        updated: false,
        stats: this.getStats(memory),
      };
    }

    memory.discoveredFacts.push({
      ...fact,
      discoveredAt: Date.now(),
    });

    return {
      added: true,
      updated: false,
      stats: this.getStats(memory),
    };
  }

  /**
   * Record an attempt of a technique on an endpoint
   * @returns Information about the change for trace event emission
   */
  static recordAttempt(
    memory: AgentMemory,
    args: {
      endpoint: string;
      technique: string;
      result: AttemptResult;
      currentTurn: number;
      reason?: string;
      toolCallId?: string;
    }
  ): RecordAttemptResult {
    const [primaryKey, ...legacyKeys] = getAttemptKeyVariants(args.endpoint, args.technique);
    const existingKey = [primaryKey, ...legacyKeys].find((candidate) => memory.attemptedTechniques[candidate]);
    const existing = existingKey ? memory.attemptedTechniques[existingKey] : undefined;
    const isNew = !existing;

    memory.attemptedTechniques[primaryKey] = {
      count: (existing?.count || 0) + 1,
      lastAttemptTurn: args.currentTurn,
      result: args.result,
      lastAttemptAt: Date.now(),
    };
    for (const legacyKey of legacyKeys) {
      delete memory.attemptedTechniques[legacyKey];
    }

    // Add to tested endpoints
    const newEndpoint = !memory.testedEndpoints.includes(args.endpoint);
    if (newEndpoint) {
      memory.testedEndpoints.push(args.endpoint);
    }

    // Record failure details
    let failureRecorded = false;
    if (args.result === 'failed' && args.reason) {
      memory.failedApproaches.push({
        endpoint: args.endpoint,
        technique: args.technique,
        reason: args.reason,
        toolCallId: args.toolCallId || '',
        failedAt: Date.now(),
      });
      failureRecorded = true;
    }

    return {
      isNew,
      failureRecorded,
      newEndpoint,
      stats: this.getStats(memory),
    };
  }

  /**
   * Check if an endpoint+technique combination has been attempted
   */
  static getAttempt(
    memory: AgentMemory,
    endpoint: string,
    technique: string
  ): AttemptRecord | undefined {
    const keys = getAttemptKeyVariants(endpoint, technique);
    for (const key of keys) {
      const attempt = memory.attemptedTechniques[key];
      if (attempt) {
        return attempt;
      }
    }
    return undefined;
  }

  /**
   * Get all discovered facts by category
   */
  static getFactsByCategory(
    memory: AgentMemory,
    category: FactCategory
  ): DiscoveredFact[] {
    return memory.discoveredFacts.filter((f) => f.category === category);
  }

  /**
   * Get high-confidence facts (confidence >= threshold)
   */
  static getHighConfidenceFacts(
    memory: AgentMemory,
    threshold: number = 0.7
  ): DiscoveredFact[] {
    return memory.discoveredFacts.filter((f) => f.confidence >= threshold);
  }

  /**
   * Get recent failed approaches (last N)
   */
  static getRecentFailures(
    memory: AgentMemory,
    limit: number = 10
  ): FailedApproach[] {
    return memory.failedApproaches
      .sort((a, b) => b.failedAt - a.failedAt)
      .slice(0, limit);
  }

  /**
   * Initialize memory for a new session
   */
  static initialize(): AgentMemory {
    return createEmptyMemory();
  }

  /**
   * Seed memory from persisted strategic notes written in prior runs.
   * This primarily restores attempted technique+endpoint pairs so AttemptGuard
   * can reason across sessions instead of starting from an empty state.
   */
  static seedFromNotes(notes: readonly StrategicMemorySeedNote[]): AgentMemory {
    const memory = createEmptyMemory();
    if (!Array.isArray(notes) || notes.length === 0) {
      return memory;
    }

    const endpoints = new Set<string>();
    const sortedNotes = [...notes].sort(
      (left, right) => toEpochMs(left.lastSeenAt) - toEpochMs(right.lastSeenAt),
    );

    for (const rawNote of sortedNotes) {
      const ntype = normalizeKeyText(rawNote.ntype);
      if (ntype !== 'approach.tried') {
        continue;
      }

      const data = isRecord(rawNote.data) ? rawNote.data : undefined;
      if (!data) {
        continue;
      }

      const endpoint = normalizeText(data.endpoint);
      const technique = normalizeKeyText(data.technique);
      if (!endpoint || !technique) {
        continue;
      }

      const key = createAttemptKey(endpoint, technique);
      const timestamp = toEpochMs(rawNote.lastSeenAt);
      const result = deriveAttemptResultFromNoteData(data);
      const increment = toPositiveIntOr(data.attempt_count, 1);
      const previous = memory.attemptedTechniques[key];

      memory.attemptedTechniques[key] = {
        count: (previous?.count ?? 0) + increment,
        lastAttemptTurn: 0,
        lastAttemptAt: Math.max(previous?.lastAttemptAt ?? 0, timestamp),
        result:
          !previous || timestamp >= previous.lastAttemptAt
            ? result
            : previous.result,
      };

      endpoints.add(endpoint);

      if (result === 'failed') {
        const reason = normalizeText(data.reason) || 'seeded from approach.tried';
        memory.failedApproaches.push({
          endpoint,
          technique,
          reason,
          toolCallId: 'seed:approach.tried',
          failedAt: timestamp,
        });
      }
    }

    memory.testedEndpoints = Array.from(endpoints);
    memory.failedApproaches.sort((left, right) => left.failedAt - right.failedAt);
    return memory;
  }

  /**
   * Merge memory from a generic Record (for backward compatibility)
   */
  static fromRecord(record: Record<string, unknown>): AgentMemory {
    // Check if it's already structured memory
    if (
      record &&
      Array.isArray((record as Record<string, unknown>).discoveredFacts) &&
      typeof (record as Record<string, unknown>).attemptedTechniques === 'object'
    ) {
      return record as unknown as AgentMemory;
    }

    // Legacy migration: create empty memory
    return createEmptyMemory();
  }

  /**
   * Export memory statistics for telemetry
   */
  static getStats(memory: AgentMemory): MemoryStats {
    return {
      factsCount: memory.discoveredFacts.length,
      attemptsCount: Object.keys(memory.attemptedTechniques).length,
      failuresCount: memory.failedApproaches.length,
      endpointsCount: memory.testedEndpoints.length,
    };
  }
}
