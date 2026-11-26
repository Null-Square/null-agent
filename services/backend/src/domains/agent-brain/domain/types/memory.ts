/**
 * Structured memory for autonomous agents.
 * Tracks discoveries, failed attempts, and tested approaches to prevent repeated work.
 * 
 * @module agent-brain/domain/types/memory
 */

/**
 * Category of discovered information
 */
export type FactCategory = 'endpoint' | 'credential' | 'vulnerability' | 'data' | 'configuration';

/**
 * Result of an attempted technique
 */
export type AttemptResult = 'success' | 'failed' | 'blocked';

/**
 * A discovered fact with metadata
 */
export interface DiscoveredFact {
  /** Category of the discovered information */
  category: FactCategory;
  /** Unique key for deduplication */
  key: string;
  /** The actual discovered value */
  value: unknown;
  /** Confidence score 0.0-1.0 */
  confidence: number;
  /** Source tool call ID or step number */
  source: string;
  /** Timestamp when discovered */
  discoveredAt: number;
}

/**
 * Record of an attempted technique on an endpoint
 */
export interface AttemptRecord {
  /** Number of times this combination was attempted */
  count: number;
  /** Turn number of last attempt */
  lastAttemptTurn: number;
  /** Result of the attempt */
  result: AttemptResult;
  /** Timestamp of last attempt */
  lastAttemptAt: number;
}

export interface ParsedAttemptKey {
  endpoint: string;
  technique: string;
}

/**
 * Record of a failed approach with details
 */
export interface FailedApproach {
  /** Target endpoint */
  endpoint: string;
  /** Technique attempted (e.g., 'sqli', 'xss', 'idor') */
  technique: string;
  /** Reason it failed */
  reason: string;
  /** Tool call ID that generated this failure */
  toolCallId: string;
  /** Timestamp of failure */
  failedAt: number;
}

/**
 * Structured memory for autonomous agent execution.
 * Prevents repeated failed attempts and preserves successful discoveries.
 */
export interface AgentMemory {
  /**
   * Successful discoveries (preserve verbatim)
   * Array for ordered iteration, indexed by key for fast lookup
   */
  discoveredFacts: DiscoveredFact[];

  /**
   * Attempted techniques (for deduplication)
   * Key format: JSON string {"endpoint":"...","technique":"..."}.
   * Legacy sessions may still contain "endpoint:technique" entries.
   */
  attemptedTechniques: Record<string, AttemptRecord>;

  /**
   * Failed approaches (for summarization and prevention)
   * Ordered array for recency-based filtering
   */
  failedApproaches: FailedApproach[];

  /**
   * Tested endpoints (quick lookup set, stored as array for JSON)
   * Includes all endpoints that have been tested at least once
   */
  testedEndpoints: string[];
}

/**
 * Create an empty AgentMemory instance
 */
export function createEmptyMemory(): AgentMemory {
  return {
    discoveredFacts: [],
    attemptedTechniques: {},
    failedApproaches: [],
    testedEndpoints: [],
  };
}

const normalizeAttemptComponent = (value: string): string => value.trim();

export function createLegacyAttemptKey(endpoint: string, technique: string): string {
  return `${normalizeAttemptComponent(endpoint)}:${normalizeAttemptComponent(technique)}`;
}

export function createAttemptKey(endpoint: string, technique: string): string {
  return JSON.stringify({
    endpoint: normalizeAttemptComponent(endpoint),
    technique: normalizeAttemptComponent(technique),
  });
}

export function getAttemptKeyVariants(endpoint: string, technique: string): string[] {
  const normalizedEndpoint = normalizeAttemptComponent(endpoint);
  const normalizedTechnique = normalizeAttemptComponent(technique);
  const variants = [
    createAttemptKey(normalizedEndpoint, normalizedTechnique),
    createLegacyAttemptKey(normalizedEndpoint, normalizedTechnique),
  ];
  return Array.from(new Set(variants));
}

export function parseAttemptKey(key: string): ParsedAttemptKey | null {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(key) as ParsedAttemptKey | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.endpoint === 'string' &&
      parsed.endpoint.trim().length > 0 &&
      typeof parsed.technique === 'string' &&
      parsed.technique.trim().length > 0
    ) {
      return {
        endpoint: parsed.endpoint.trim(),
        technique: parsed.technique.trim(),
      };
    }
  } catch {
    // Fall through to legacy delimiter parsing.
  }

  const separatorIndex = key.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
    return null;
  }

  const endpoint = key.slice(0, separatorIndex).trim();
  const technique = key.slice(separatorIndex + 1).trim();
  if (!endpoint || !technique) {
    return null;
  }

  return { endpoint, technique };
}

/**
 * Check if memory is empty
 */
export function isMemoryEmpty(memory: AgentMemory | undefined): boolean {
  if (!memory) return true;

  const discoveredFacts = Array.isArray(memory.discoveredFacts) ? memory.discoveredFacts : [];
  const failedApproaches = Array.isArray(memory.failedApproaches) ? memory.failedApproaches : [];
  const testedEndpoints = Array.isArray(memory.testedEndpoints) ? memory.testedEndpoints : [];
  const attemptedTechniques =
    memory.attemptedTechniques && typeof memory.attemptedTechniques === 'object'
      ? memory.attemptedTechniques
      : {};

  return (
    discoveredFacts.length === 0 &&
    Object.keys(attemptedTechniques).length === 0 &&
    failedApproaches.length === 0 &&
    testedEndpoints.length === 0
  );
}
