import { recordCreditMissingOrganization } from './prometheusMetrics';

type Sample = {
  at: number;
  ms: number;
  status?: string;
  count?: number;
};

type PolicySample = Sample & { source?: string; profile?: string };
type AutomationSample = Sample & { retryCount?: number; pendingSteps?: number };

const MAX_SAMPLES = 100;

const store = {
  sandboxList: [] as Sample[],
  sandboxLifecycle: [] as Sample[],
  requests: [] as Sample[],
  s3Artifacts: [] as Sample[],
  s3Traces: [] as Sample[],
  retention: [] as Sample[],
  sessionConflicts: [] as Sample[],
  sessionLocks: [] as Sample[],
  turns: [] as Sample[],
  cache: [] as Sample[],
  sessionHydration: [] as Sample[],
  sessionCache: [] as Sample[],
  policyResolutions: [] as PolicySample[],
  automationGuards: [] as AutomationSample[],
};

const counters = {
  turns: {
    ok: 0,
    abort: 0,
    error: 0,
  },
  cache: {
    hit: 0,
    miss: 0,
  },
  // API error categorization - track why API calls fail
  apiErrors: {
    timeout: 0,           // Connection timeout, request timeout
    rate_limit: 0,        // 429 Too Many Requests
    auth: 0,              // 401/403 authentication errors
    context_too_large: 0, // Context length exceeded
    server_error: 0,      // 5xx server errors
    network: 0,           // DNS, connection refused, etc.
    unknown: 0,           // Uncategorized errors
  } as Record<string, number>,
  // Production Readiness Metrics (GPT 5.2 Milestone - Dec 2025)
  resume: {
    enqueued: 0,
    success: 0,
    fail: 0,
  },
  turnCommits: {
    success: 0,
    error: 0,
  },
  completionBlocked: {
    report_missing_in_s3: 0,
    s3_unavailable: 0,
    other: 0,
  } as Record<string, number>,
  lostOwnership: 0,
  nextAttempt: {
    scheduled: 0,
    cleared: 0,
  },
  retention: {
    runs: 0,
    deleted: 0,
    errors: 0,
  },
  creditMissingOrganizationId: {
    credit_gate: 0,
    pre_turn_checks: 0,
    usage_recorder: 0,
  } as Record<string, number>,
};


const push = <T extends Sample>(bucket: T[], sample: T) => {
  bucket.push(sample);
  if (bucket.length > MAX_SAMPLES) {
    bucket.splice(0, bucket.length - MAX_SAMPLES);
  }
};

export const opsMetrics = {
  recordSandboxList(ms: number, count: number) {
    push(store.sandboxList, { at: Date.now(), ms, count });
  },
  recordSandboxLifecycle(action: 'provision' | 'destroy', ms: number, status?: string) {
    push(store.sandboxLifecycle, { at: Date.now(), ms, status: `${action}:${status ?? 'ok'}` });
  },
  recordRequest(ms: number, status?: number) {
    push(store.requests, { at: Date.now(), ms, status: status?.toString() });
  },
  recordS3(bucket: 'artifacts' | 'traces', ms: number, status?: string) {
    const target = bucket === 'artifacts' ? store.s3Artifacts : store.s3Traces;
    push(target, { at: Date.now(), ms, status });
  },
  recordRetention(ms: number, count?: number, status?: string) {
    push(store.retention, { at: Date.now(), ms, status, count });
  },
  recordSessionConflict(sessionId: string, action: 'persist' | 'metadata', attempt: number, resolved: boolean) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: attempt,
      status: `${resolved ? 'resolved' : 'failed'}:${action}:${sessionId}`,
    });
  },
  recordSessionLock(sessionId: string, status: 'acquired' | 'failed', ms: number) {
    push(store.sessionLocks, {
      at: Date.now(),
      ms,
      status: `${status}:${sessionId}`,
    });
  },
  recordTurn(status: 'ok' | 'abort' | 'error', ms: number) {
    push(store.turns, { at: Date.now(), ms, status });
    counters.turns[status] += 1;
  },
  recordCacheIntent(intent: string) {
    push(store.cache, { at: Date.now(), ms: 0, status: `intent:${intent}` });
  },
  recordCacheResult(result: 'hit' | 'miss', cachedTokens: number = 0) {
    push(store.cache, { at: Date.now(), ms: cachedTokens, status: `result:${result}` });
    counters.cache[result] += 1;
  },
  snapshot() {
    const last = <T extends Sample>(bucket: T[]): T | undefined => bucket[bucket.length - 1];
    const avg = (bucket: Sample[]) =>
      bucket.length === 0 ? undefined : bucket.reduce((s, b) => s + b.ms, 0) / bucket.length;
    const recent = <T extends Sample>(bucket: T[], limit: number = 20): T[] =>
      bucket.length <= limit ? [...bucket] : bucket.slice(bucket.length - limit);

    const policyCounts: Record<string, number> = {};
    store.policyResolutions.forEach((sample) => {
      const key = sample.source ?? 'unknown';
      policyCounts[key] = (policyCounts[key] ?? 0) + 1;
    });

    const automationCounts = { fired: 0, exhausted: 0, none: 0 };
    store.automationGuards.forEach((sample) => {
      const statusKey = sample.status?.split(':')[0];
      const key: keyof typeof automationCounts =
        statusKey === 'fired' || statusKey === 'exhausted' ? statusKey : 'none';
      automationCounts[key] += 1;
    });

    return {
      sandboxList: {
        last: last(store.sandboxList),
        avgMs: avg(store.sandboxList),
        samples: store.sandboxList.length,
      },
      sandboxLifecycle: {
        last: last(store.sandboxLifecycle),
        avgMs: avg(store.sandboxLifecycle),
        samples: store.sandboxLifecycle.length,
        recent: recent(store.sandboxLifecycle),
      },
      requests: {
        last: last(store.requests),
        avgMs: avg(store.requests),
        samples: store.requests.length,
      },
      s3Artifacts: {
        last: last(store.s3Artifacts),
        avgMs: avg(store.s3Artifacts),
        samples: store.s3Artifacts.length,
      },
      s3Traces: {
        last: last(store.s3Traces),
        avgMs: avg(store.s3Traces),
        samples: store.s3Traces.length,
      },
      retention: {
        last: last(store.retention),
        avgMs: avg(store.retention),
        samples: store.retention.length,
      },
      sessionConflicts: {
        last: last(store.sessionConflicts),
        samples: store.sessionConflicts.length,
      },
      sessionLocks: {
        last: last(store.sessionLocks),
        samples: store.sessionLocks.length,
        avgMs: avg(store.sessionLocks),
      },
      sessionHydration: {
        last: last(store.sessionHydration),
        samples: store.sessionHydration.length,
        recent: recent(store.sessionHydration),
      },
      sessionCache: {
        last: last(store.sessionCache),
        samples: store.sessionCache.length,
        recent: recent(store.sessionCache),
      },
      turns: {
        last: last(store.turns),
        avgMs: avg(store.turns),
        samples: store.turns.length,
        counts: { ...counters.turns },
      },
      cache: {
        last: last(store.cache),
        samples: store.cache.length,
        counts: { ...counters.cache },
      },
      policyResolutions: {
        last: last(store.policyResolutions),
        samples: store.policyResolutions.length,
        recent: recent(store.policyResolutions),
        countsBySource: policyCounts,
      },
      automationGuards: {
        last: last(store.automationGuards),
        samples: store.automationGuards.length,
        recent: recent(store.automationGuards),
        counts: automationCounts,
      },
      creditMissingOrganizationId: {
        counts: { ...counters.creditMissingOrganizationId },
      },
    };
  },
  recordSessionHydration(ms: number, count: number, truncated: boolean = false, status: string = 'ok') {
    push(store.sessionHydration, { at: Date.now(), ms, status: `${status}:${truncated ? 'truncated' : 'full'}:${count}` });
  },
  recordSessionCache(event: 'miss' | 'hit' | 'error', sessionId?: string) {
    push(store.sessionCache, { at: Date.now(), ms: 0, status: `${event}:${sessionId ?? ''}` });
  },
  recordPolicyResolution(source: string, profile?: string) {
    push(store.policyResolutions, {
      at: Date.now(),
      ms: 0,
      status: `${source}:${profile ?? ''}`,
      source,
      profile,
    });
  },
  recordAutomationGuard(status: 'fired' | 'exhausted' | 'none', retryCount: number = 0, pendingSteps: number = 0) {
    push(store.automationGuards, {
      at: Date.now(),
      ms: retryCount,
      status: `${status}:pending:${pendingSteps}`,
      retryCount,
      pendingSteps,
    });
  },
  recordCreditMissingOrganizationId(source: 'credit_gate' | 'pre_turn_checks' | 'usage_recorder', sessionId?: string) {
    counters.creditMissingOrganizationId[source] = (counters.creditMissingOrganizationId[source] ?? 0) + 1;
    recordCreditMissingOrganization(source);
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `credit_missing_org:${source}${sessionId ? `:${sessionId}` : ''}`,
    });
  },

  // ============================================================================
  // Session Resilience Metrics
  // ============================================================================

  /** Record when a circuit breaker opens for a session */
  recordCircuitBreakerOpen(_sessionId: string, reason?: string) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `circuit_open:${reason ?? 'unknown'}`,
    });
  },

  /** Record version conflict events */
  recordVersionConflict(_sessionId: string, from: string, to: string) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `version_conflict:${from}->${to}`,
    });
  },

  /** Record force-recovery events */
  recordForceRecovery(_sessionId: string, reason: string) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `force_recovery:${reason}`,
    });
  },

  /** Record session quarantine events */
  recordQuarantinedSession(_sessionId: string, reason: string) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `quarantined:${reason}`,
    });
  },

  /** Record garbage collection of dead sessions */
  recordSessionGarbageCollected(_sessionId: string) {
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: 'garbage_collected',
    });
  },

  // ============================================================================
  // API Error Categorization Metrics
  // ============================================================================

  /**
   * Record an API error with automatic categorization.
   * This helps track WHY sessions fail - timeout, rate limit, auth, etc.
   * 
   * @param error - The error object from the API call
   * @param sessionId - Optional session ID for correlation
   */
  recordApiError(error: unknown, sessionId?: string) {
    const category = this.categorizeApiError(error);
    counters.apiErrors[category] = (counters.apiErrors[category] ?? 0) + 1;

    // Also record as a sample for time-series visualization
    push(store.sessionConflicts, {
      at: Date.now(),
      ms: 0,
      status: `api_error:${category}${sessionId ? `:${sessionId}` : ''}`,
    });
  },

  /**
   * Categorize an error into a known category for metrics.
   */
  categorizeApiError(error: unknown): string {
    if (!error) return 'unknown';

    const err = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    const message = (typeof err.message === 'string' ? err.message : '').toLowerCase();
    const name =
      (typeof err.name === 'string' ? err.name : typeof err.type === 'string' ? err.type : '').toLowerCase();
    const rawStatus = err.status ?? err.statusCode;
    const status = typeof rawStatus === 'number' ? rawStatus : typeof rawStatus === 'string' ? Number(rawStatus) : undefined;

    // Timeout errors
    if (name.includes('timeout') || message.includes('timeout') || message.includes('timed out')) {
      return 'timeout';
    }

    // Rate limit (429)
    if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
      return 'rate_limit';
    }

    // Authentication errors (401, 403)
    if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('forbidden')) {
      return 'auth';
    }

    // Context too large (400 with specific message)
    if (message.includes('context') && (message.includes('long') || message.includes('large') || message.includes('length') || message.includes('exceed'))) {
      return 'context_too_large';
    }

    // Server errors (5xx)
    if (typeof status === 'number' && status >= 500 && status < 600) {
      return 'server_error';
    }

    // Network errors
    if (name.includes('network') || message.includes('econnrefused') || message.includes('enotfound') || message.includes('dns')) {
      return 'network';
    }

    return 'unknown';
  },

  /**
   * Get current API error counts by category.
   */
  getApiErrorCounts() {
    return { ...counters.apiErrors };
  },

  // ============================================================================
  // Production Readiness Metrics (GPT 5.2 Milestone - Dec 2025)
  // ============================================================================

  /** Record a durable session recovery claim. */
  recordResumeEnqueued() {
    counters.resume.enqueued += 1;
  },

  /** Record session recovery success. */
  recordResumeSuccess() {
    counters.resume.success += 1;
  },

  /** Record session recovery failure. */
  recordResumeFail() {
    counters.resume.fail += 1;
  },

  /** Record turn commit success (from TurnRunner) */
  recordTurnCommitSuccess(ms: number) {
    counters.turnCommits.success += 1;
    push(store.turns, { at: Date.now(), ms, status: 'commit_ok' });
  },

  /** Record turn commit failure (from TurnRunner) */
  recordTurnCommitError(ms: number) {
    counters.turnCommits.error += 1;
    push(store.turns, { at: Date.now(), ms, status: 'commit_error' });
  },

  /** Record completion blocked (from OrchestratorAdapter catch of CompletionBlockedError) */
  recordCompletionBlocked(reason: string) {
    const key = reason in counters.completionBlocked ? reason : 'other';
    counters.completionBlocked[key] = (counters.completionBlocked[key] ?? 0) + 1;
  },

  /** Record lost ownership (CAS fencing - nonce mismatch in SessionRepository) */
  recordLostOwnership() {
    counters.lostOwnership += 1;
  },

  /** Record next_attempt_at scheduled (retry scheduling) */
  recordNextAttemptScheduled() {
    counters.nextAttempt.scheduled += 1;
  },

  /** Record next_attempt_at cleared (retry succeeded) */
  recordNextAttemptCleared() {
    counters.nextAttempt.cleared += 1;
  },

  /** Record retention reaper run */
  recordRetentionRun(ms: number, deletedCount: number, hasErrors: boolean) {
    counters.retention.runs += 1;
    counters.retention.deleted += deletedCount;
    if (hasErrors) counters.retention.errors += 1;
    push(store.retention, { at: Date.now(), ms, count: deletedCount, status: hasErrors ? 'error' : 'ok' });
  },

  /** Record reconciler run */
  recordReconcilerRun(sessionsFound: number) {
    push(store.retention, { at: Date.now(), ms: 0, count: sessionsFound, status: 'reconciler_run' });
  },

  /** Get production readiness counters for /metrics endpoint */
  getProductionReadinessCounts() {
    return {
      resume: { ...counters.resume },
      turnCommits: { ...counters.turnCommits },
      completionBlocked: { ...counters.completionBlocked },
      lostOwnership: counters.lostOwnership,
      nextAttempt: { ...counters.nextAttempt },
      retention: { ...counters.retention },
      creditMissingOrganizationId: { ...counters.creditMissingOrganizationId },
    };
  },
};
