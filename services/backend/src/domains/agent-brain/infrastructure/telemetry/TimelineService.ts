/**
 * TimelineService - Query and filter session trace events for observability.
 *
 * Reads a session's timeline, findings and memory state from its NDJSON trace files (local or S3),
 * with filtering, pagination and stats.
 *
 * @module agent-brain/application/services/TimelineService
 */

import { promises as fsPromises } from 'fs';
import nodePath from 'path';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { logger } from '@/shared/logger';
import type {
  ActionSummaryPayload,
  DiscoveryPayload,
  MemoryUpdatePayload,
  ActionOutcome,
  DiscoveryCategory,
  TraceHydrationMode,
} from './types';
import {
  hydrateTraceEvents,
  type TraceArtifactHydration,
  type TraceArtifactLoader,
} from './TraceArtifactHydrator';
import {
  classifyTraceEvent,
  computeAdminHarnessStats,
  searchAdminHarnessEvent,
  type AdminHarnessCategory,
  type AdminHarnessOutcome,
  type AdminHarnessTimelineResponse,
} from './AdminHarnessTimeline';

// ============================================================================
// Types
// ============================================================================

/**
 * A parsed trace event with normalized timestamp
 */
export interface TimelineEvent {
  schemaVersion?: number;
  id: string;
  sessionId: string;
  runId?: string;
  agentType?: string;
  agentRole?: string;
  phaseId?: string;
  workerTaskId?: string;
  parentEventId?: string | null;
  depth?: number;
  turn: number;
  ts: string;
  tsp?: number;
  event: string;
  severity: string;
  payload?: unknown;
  note?: string;
  links?: Record<string, string>;
  acceptedOrdinal?: number;
  eventId?: string;
  requestId?: string;
  attemptId?: string;
  attemptOrdinal?: number;
  toolCallId?: string;
  name?: string;
  status?: string;
  outcome?: string;
  artifactRef?: string;
  artifactSha256?: string;
  inlinePayload?: unknown;
  hydration?: TraceArtifactHydration;
}

/**
 * Filter options for timeline queries
 */
export interface TimelineFilterOptions {
  /** Explicit artifact-detail policy for this reader. */
  hydrationMode?: TraceHydrationMode;
  /** Filter by event types (e.g., 'action.summary', 'discovery') */
  types?: string[];
  /** Filter by severity levels */
  severity?: string[];
  /** Filter by specific turns */
  turns?: number[];
  /** Time range start (ISO string) */
  from?: string;
  /** Time range end (ISO string) */
  to?: string;
  /** Filter action summaries by outcome */
  outcomes?: ActionOutcome[];
  /** Filter discoveries by category */
  categories?: DiscoveryCategory[];
  /** Text search in note/action fields */
  search?: string;
  /** Pagination offset */
  offset?: number;
  /** Pagination limit (max 500) */
  limit?: number;
}

export interface AdminHarnessTimelineOptions extends Omit<TimelineFilterOptions, 'categories' | 'outcomes'> {
  categories?: AdminHarnessCategory[];
  adminOutcomes?: AdminHarnessOutcome[];
  showNoise?: boolean;
  includeRawEvent?: boolean;
  pageBy?: 'turn' | 'event';
}

/**
 * Timeline query response
 */
export interface TimelineResponse {
  events: TimelineEvent[];
  total: number;
  stats: TimelineStats;
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

/**
 * Aggregated statistics for a timeline
 */
export interface TimelineStats {
  actionsCount: number;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  errorCount: number;
  timeoutCount: number;
  skippedCount: number;
  discoveriesCount: number;
  milestonesCount: number;
  memoryUpdatesCount: number;
}

/**
 * Findings summary from a session
 */
export interface FindingsResponse {
  discoveries: Array<{
    turn: number;
    ts: string;
    payload: DiscoveryPayload;
  }>;
  summary: {
    credentialsFound: number;
    endpointsDiscovered: number;
    vulnerabilitiesFound: number;
    flagsCaptured: number;
    dataFound: number;
    configurationsFound: number;
  };
}

/**
 * Memory state response
 */
export interface MemoryResponse {
  memory: {
    discoveredFacts: unknown[];
    attemptedTechniques: Record<string, unknown>;
    failedApproaches: unknown[];
    testedEndpoints: string[];
  };
  updates: Array<{
    turn: number;
    ts: string;
    payload: MemoryUpdatePayload;
  }>;
  stats: {
    factsCount: number;
    attemptsCount: number;
    failuresCount: number;
    endpointsCount: number;
  };
}

// ============================================================================
// Service Implementation
// ============================================================================

export interface TimelineServiceDeps {
  traceRoot?: string;
  s3Client?: S3StorageService;
  traceIndexRepository?: TraceIndexRepository;
}

export class TimelineService {
  private readonly traceRoot: string;
  private readonly s3Client?: S3StorageService;
  private readonly traceIndexRepository?: TraceIndexRepository;
  private readonly log = logger.child({ scope: 'TimelineService' });
  private readonly artifactLoader: TraceArtifactLoader;

  constructor(deps: TimelineServiceDeps) {
    // Default to logs/ai-agent (same as SessionTraceRecorder default)
    this.traceRoot = deps.traceRoot ?? nodePath.resolve(process.cwd(), 'logs', 'ai-agent');
    this.s3Client = deps.s3Client;
    this.traceIndexRepository = deps.traceIndexRepository;
    this.artifactLoader = {
      load: (sessionId, artifactRef) => this.loadArtifact(sessionId, artifactRef),
    };
  }

  /**
   * Get timeline events for a session with optional filtering
   */
  async getTimeline(sessionId: string, options: TimelineFilterOptions = {}): Promise<TimelineResponse> {
    const events = await this.readTraceEvents(sessionId, options.hydrationMode ?? 'inline');
    const filtered = this.filterEvents(events, options);
    const stats = this.computeStats(events); // Stats computed on full set

    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? 100, 500);
    const paginated = filtered.slice(offset, offset + limit);

    return {
      events: paginated,
      total: filtered.length,
      stats,
      pagination: {
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      },
    };
  }

  async getAllEvents(
    sessionId: string,
    hydrationMode: TraceHydrationMode = 'inline',
  ): Promise<TimelineEvent[]> {
    return this.readTraceEvents(sessionId, hydrationMode);
  }

  /**
   * Get classified admin harness timeline. This is a read-model projection over
   * raw trace events; it does not change canonical trace storage.
   */
  async getAdminHarnessTimeline(
    sessionId: string,
    options: AdminHarnessTimelineOptions = {},
  ): Promise<AdminHarnessTimelineResponse> {
    const rawEvents = this.sortEvents(await this.readTraceEvents(sessionId, 'inline'));
    const rawFilterOptions: TimelineFilterOptions = {
      ...options,
      // Admin harness categories/outcomes are applied after classification.
      // Keep them out of the legacy raw timeline filters, where category means
      // discovery.category and outcome means action.summary outcome.
      categories: undefined,
      outcomes: undefined,
    };
    const rawFiltered = this.filterEvents(rawEvents, rawFilterOptions);
    const classifiedAll = rawEvents.map((event) => classifyTraceEvent(event, {
      includeRawEvent: options.includeRawEvent,
    }));
    let classified = rawFiltered.map((event) => classifyTraceEvent(event, {
      includeRawEvent: options.includeRawEvent,
    }));

    if (options.categories?.length) {
      const categories = new Set(options.categories);
      classified = classified.filter((event) => categories.has(event.category));
    }

    if (options.adminOutcomes?.length) {
      const outcomes = new Set(options.adminOutcomes);
      classified = classified.filter((event) => outcomes.has(event.outcome));
    }

    if (options.showNoise !== true) {
      classified = classified.filter((event) => !event.flags.isNoise);
    }

    if (options.search) {
      classified = classified.filter((event) => searchAdminHarnessEvent(event, options.search ?? ''));
    }

    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? 100, 500);
    const pageBy = options.pageBy ?? 'turn';
    const paginated = pageBy === 'turn'
      ? this.paginateByTurn(classified, offset, limit)
      : classified.slice(offset, offset + limit);
    const paginationTotal = pageBy === 'turn' ? this.countTurns(classified) : classified.length;

    return {
      sessionId,
      source: 'mixed',
      events: paginated,
      stats: computeAdminHarnessStats(rawEvents, classifiedAll),
      pagination: {
        pageBy,
        offset,
        limit,
        total: paginationTotal,
        hasMore: offset + limit < paginationTotal,
      },
    };
  }

  /**
   * Get high-signal timeline (action.summary, discovery, milestone events only)
   */
  async getHighSignalTimeline(sessionId: string, options: TimelineFilterOptions = {}): Promise<TimelineResponse> {
    const highSignalTypes = ['action.summary', 'discovery', 'milestone', 'session.init', 'session.done', 'error'];
    return this.getTimeline(sessionId, {
      ...options,
      hydrationMode: options.hydrationMode ?? 'hydrated',
      types: options.types?.length ? options.types : highSignalTypes,
    });
  }

  /**
   * Get findings (discoveries) from a session
   */
  async getFindings(sessionId: string): Promise<FindingsResponse> {
    const events = await this.readTraceEvents(sessionId, 'hydrated');
    const discoveries = events
      .filter((e) => e.event === 'discovery')
      .map((e) => ({
        turn: e.turn,
        ts: e.ts,
        payload: e.payload as DiscoveryPayload,
      }));

    const summary = {
      credentialsFound: 0,
      endpointsDiscovered: 0,
      vulnerabilitiesFound: 0,
      flagsCaptured: 0,
      dataFound: 0,
      configurationsFound: 0,
    };

    for (const d of discoveries) {
      switch (d.payload?.category) {
        case 'credential':
          summary.credentialsFound++;
          break;
        case 'endpoint':
          summary.endpointsDiscovered++;
          break;
        case 'vulnerability':
          summary.vulnerabilitiesFound++;
          break;
        case 'flag':
          summary.flagsCaptured++;
          break;
        case 'data':
          summary.dataFound++;
          break;
        case 'configuration':
          summary.configurationsFound++;
          break;
      }
    }

    return { discoveries, summary };
  }

  /**
   * Get memory state and updates from a session
   */
  async getMemory(sessionId: string): Promise<MemoryResponse> {
    const events = await this.readTraceEvents(sessionId, 'hydrated');

    // Collect memory.update events
    const updates = events
      .filter((e) => e.event === 'memory.update')
      .map((e) => ({
        turn: e.turn,
        ts: e.ts,
        payload: e.payload as MemoryUpdatePayload,
      }));

    // Get the last memory stats from updates, or use zeros
    const lastUpdate = updates[updates.length - 1];
    const stats = lastUpdate?.payload?.memoryStats ?? {
      factsCount: 0,
      attemptsCount: 0,
      failuresCount: 0,
      endpointsCount: 0,
    };

    // Reconstruct memory state from updates
    const memory = this.reconstructMemoryFromUpdates(updates);

    return { memory, updates, stats };
  }

  /**
   * Get action summaries only
   */
  async getActionSummaries(sessionId: string, options: TimelineFilterOptions = {}): Promise<TimelineResponse> {
    return this.getTimeline(sessionId, {
      ...options,
      hydrationMode: options.hydrationMode ?? 'hydrated',
      types: ['action.summary'],
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Read all trace events from NDJSON file
   */
  private async readTraceEvents(
    sessionId: string,
    hydrationMode: TraceHydrationMode,
  ): Promise<TimelineEvent[]> {
    // Try S3 first
    if (this.s3Client) {
      try {
        const traceIndex = await this.traceIndexRepository?.find(sessionId).catch(() => null);
        const key = traceIndex?.traceKey ?? `${sessionId}/trace.ndjson`;
        this.log.info({ sessionId, key, hasTraceIndex: !!traceIndex }, '[TimelineService] Attempting S3 read');
        const buffer = await this.s3Client.getObjectBuffer(key);
        this.log.info({ sessionId, bufferSize: buffer.length }, '[TimelineService] S3 read success');
        const events = this.parseNdjson(sessionId, buffer.toString('utf-8'));
        this.log.info({ sessionId, eventCount: events.length }, '[TimelineService] Parsed events from S3');
        return hydrateTraceEvents(events, hydrationMode, this.artifactLoader);
      } catch (err) {
        const errCode = (err as { name?: string })?.name;
        this.log.warn({ err, sessionId, errCode }, '[TimelineService] S3 read failed, trying local');
      }
    } else {
      this.log.warn({ sessionId }, '[TimelineService] No S3 client configured, reading from local');
    }

    // Fall back to local file
    const tracePath = nodePath.join(this.traceRoot, sessionId, 'trace.ndjson');
    this.log.info({ sessionId, tracePath }, '[TimelineService] Checking local file');
    const exists = await fsPromises.stat(tracePath).then(() => true).catch(() => false);
    if (!exists) {
      this.log.warn({ sessionId, tracePath }, '[TimelineService] Local file not found, returning empty');
      return [];
    }

    const content = await fsPromises.readFile(tracePath, 'utf-8');
    const events = this.parseNdjson(sessionId, content);
    this.log.info({ sessionId, eventCount: events.length }, '[TimelineService] Parsed events from local');
    return hydrateTraceEvents(events, hydrationMode, this.artifactLoader);
  }

  private async loadArtifact(sessionId: string, artifactRef: string): Promise<Buffer> {
    const normalized = artifactRef.replace(/\\/gu, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..')) {
      throw new Error('Trace artifact reference escaped its session directory');
    }
    if (this.s3Client) {
      const key = `${sessionId}/${normalized}`;
      try {
        return await this.s3Client.getObjectBuffer(key);
      } catch {
        // Local retained copies are a valid fallback for the same receipt.
      }
    }
    const sessionRoot = nodePath.resolve(this.traceRoot, sessionId);
    const candidate = nodePath.resolve(sessionRoot, normalized);
    const relative = nodePath.relative(sessionRoot, candidate);
    if (relative.startsWith('..') || nodePath.isAbsolute(relative)) {
      throw new Error('Trace artifact reference escaped its session directory');
    }
    return fsPromises.readFile(candidate);
  }

  /**
   * Parse NDJSON content into timeline events
   */
  private parseNdjson(sessionId: string, content: string): TimelineEvent[] {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const events: TimelineEvent[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        events.push({
          schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : undefined,
          id: String(parsed.id ?? ''),
          sessionId: String(parsed.sessionId ?? sessionId),
          runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
          agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
          agentRole: typeof parsed.agentRole === 'string' ? parsed.agentRole : undefined,
          phaseId: typeof parsed.phaseId === 'string' ? parsed.phaseId : undefined,
          workerTaskId: typeof parsed.workerTaskId === 'string' ? parsed.workerTaskId : undefined,
          parentEventId: typeof parsed.parentEventId === 'string' ? parsed.parentEventId : null,
          depth: typeof parsed.depth === 'number' ? parsed.depth : undefined,
          turn: Number(parsed.turn ?? 0),
          ts: String(parsed.ts ?? ''),
          tsp: typeof parsed.tsp === 'number' ? parsed.tsp : undefined,
          event: String(parsed.event ?? ''),
          severity: String(parsed.severity ?? 'info'),
          payload: parsed.payload,
          note: typeof parsed.note === 'string' ? parsed.note : undefined,
          links: typeof parsed.links === 'object' ? (parsed.links as Record<string, string>) : undefined,
          acceptedOrdinal: typeof parsed.acceptedOrdinal === 'number' ? parsed.acceptedOrdinal : undefined,
          eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
          requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
          attemptId: typeof parsed.attemptId === 'string' ? parsed.attemptId : undefined,
          attemptOrdinal: typeof parsed.attemptOrdinal === 'number' ? parsed.attemptOrdinal : undefined,
          toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          outcome: typeof parsed.outcome === 'string' ? parsed.outcome : undefined,
          artifactRef: typeof parsed.artifactRef === 'string' ? parsed.artifactRef : undefined,
          artifactSha256: typeof parsed.artifactSha256 === 'string' ? parsed.artifactSha256 : undefined,
        });
      } catch {
        // Skip malformed lines
      }
    }

    return events;
  }

  /**
   * Filter events based on options
   */
  private filterEvents(events: TimelineEvent[], options: TimelineFilterOptions): TimelineEvent[] {
    let filtered = events;

    // Filter by event types
    if (options.types?.length) {
      const types = new Set(options.types);
      filtered = filtered.filter((e) => types.has(e.event));
    }

    // Filter by severity
    if (options.severity?.length) {
      const severities = new Set(options.severity);
      filtered = filtered.filter((e) => severities.has(e.severity));
    }

    // Filter by turns
    if (options.turns?.length) {
      const turns = new Set(options.turns);
      filtered = filtered.filter((e) => turns.has(e.turn));
    }

    // Filter by time range
    if (options.from) {
      const fromTime = new Date(options.from).getTime();
      filtered = filtered.filter((e) => new Date(e.ts).getTime() >= fromTime);
    }
    if (options.to) {
      const toTime = new Date(options.to).getTime();
      filtered = filtered.filter((e) => new Date(e.ts).getTime() <= toTime);
    }

    // Filter action summaries by outcome
    if (options.outcomes?.length) {
      const outcomes = new Set(options.outcomes);
      filtered = filtered.filter((e) => {
        if (e.event !== 'action.summary') return true;
        const payload = e.payload as ActionSummaryPayload | undefined;
        return payload?.outcome ? outcomes.has(payload.outcome) : true;
      });
    }

    // Filter discoveries by category
    if (options.categories?.length) {
      const categories = new Set(options.categories);
      filtered = filtered.filter((e) => {
        if (e.event !== 'discovery') return true;
        const payload = e.payload as DiscoveryPayload | undefined;
        return payload?.category ? categories.has(payload.category) : true;
      });
    }

    // Text search
    if (options.search) {
      const query = options.search.toLowerCase();
      filtered = filtered.filter((e) => {
        const note = e.note?.toLowerCase() ?? '';
        const payload = e.payload as Record<string, unknown> | undefined;
        const action = String(payload?.action ?? '').toLowerCase();
        const summary = String(payload?.summary ?? '').toLowerCase();
        const eventName = e.event.toLowerCase();
        const toolName = String(payload?.toolName ?? payload?.name ?? payload?.tool ?? '').toLowerCase();
        const outcomeReason = String(payload?.outcomeReason ?? payload?.reason ?? payload?.message ?? payload?.errorMessage ?? '').toLowerCase();
        return (
          eventName.includes(query) ||
          note.includes(query) ||
          action.includes(query) ||
          summary.includes(query) ||
          toolName.includes(query) ||
          outcomeReason.includes(query)
        );
      });
    }

    return filtered;
  }

  private sortEvents(events: TimelineEvent[]): TimelineEvent[] {
    return [...events].sort((a, b) => {
      const aTs = new Date(a.ts || 0).getTime();
      const bTs = new Date(b.ts || 0).getTime();
      if (aTs !== bTs) return aTs - bTs;
      const aTsp = a.tsp ?? 0;
      const bTsp = b.tsp ?? 0;
      if (aTsp !== bTsp) return aTsp - bTsp;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  private countTurns(events: Array<{ turn?: number }>): number {
    return new Set(events.map((event) => event.turn ?? 0)).size;
  }

  private paginateByTurn<T extends { turn?: number }>(events: T[], offset: number, limit: number): T[] {
    const turns = Array.from(new Set(events.map((event) => event.turn ?? 0))).sort((a, b) => a - b);
    const selectedTurns = new Set(turns.slice(offset, offset + limit));
    return events.filter((event) => selectedTurns.has(event.turn ?? 0));
  }

  /**
   * Compute aggregate statistics from events
   */
  private computeStats(events: TimelineEvent[]): TimelineStats {
    const stats: TimelineStats = {
      actionsCount: 0,
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      errorCount: 0,
      timeoutCount: 0,
      skippedCount: 0,
      discoveriesCount: 0,
      milestonesCount: 0,
      memoryUpdatesCount: 0,
    };

    for (const event of events) {
      switch (event.event) {
        case 'action.summary': {
          stats.actionsCount++;
          const payload = event.payload as ActionSummaryPayload | undefined;
          switch (payload?.outcome) {
            case 'success':
              stats.successCount++;
              break;
            case 'failure':
              stats.failureCount++;
              break;
            case 'blocked':
              stats.blockedCount++;
              break;
            case 'error':
              stats.errorCount++;
              break;
            case 'timeout':
              stats.timeoutCount++;
              break;
            case 'skipped':
              stats.skippedCount++;
              break;
          }
          break;
        }
        case 'discovery':
          stats.discoveriesCount++;
          break;
        case 'milestone':
          stats.milestonesCount++;
          break;
        case 'memory.update':
          stats.memoryUpdatesCount++;
          break;
      }
    }

    return stats;
  }

  /**
   * Reconstruct memory state from update events
   */
  private reconstructMemoryFromUpdates(
    updates: Array<{ payload: MemoryUpdatePayload }>
  ): MemoryResponse['memory'] {
    const memory: MemoryResponse['memory'] = {
      discoveredFacts: [],
      attemptedTechniques: {},
      failedApproaches: [],
      testedEndpoints: [],
    };

    const factsMap = new Map<string, unknown>();
    const endpointsSet = new Set<string>();

    for (const update of updates) {
      const { operation, change } = update.payload;

      switch (operation) {
        case 'fact_added':
        case 'fact_updated':
          factsMap.set(change.key, change.value);
          break;
        case 'attempt_recorded': {
          memory.attemptedTechniques[change.key] = change.value;
          // Extract endpoint from key (format: "endpoint:technique")
          const endpoint = change.key.split(':')[0];
          if (endpoint) endpointsSet.add(endpoint);
          break;
        }
        case 'failure_recorded':
          memory.failedApproaches.push(change.value as unknown);
          break;
      }
    }

    memory.discoveredFacts = Array.from(factsMap.values());
    memory.testedEndpoints = Array.from(endpointsSet);

    return memory;
  }
}
