/**
 * Prometheus Metrics (prom-client)
 * 
 * Real histograms with buckets for p50/p95/p99 calculation.
 * Follows OpenMetrics/Prometheus best practices.
 * 
 * Labels are kept low-cardinality:
 * - ✅ tool, provider, model, status, status_class, operation
 * - ❌ sessionId, userId, requestId (use logs for these)
 * 
 * @module prometheusMetrics
 */

import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

// Create a custom registry (avoids conflicts with default registry)
export const registry = new Registry();

// Set default labels for all metrics
registry.setDefaultLabels({
  app: 'nullai-backend',
});

// Collect default Node.js metrics (memory, event loop, gc, etc.)
collectDefaultMetrics({ register: registry, prefix: 'nodejs_' });

// ============================================================================
// HISTOGRAMS - For latency percentiles (p50, p95, p99)
// ============================================================================

/**
 * Turn commit latency - time from turn start to successful commit
 */
export const turnCommitLatency = new Histogram({
  name: 'turn_commit_latency_ms',
  help: 'Turn commit duration in milliseconds',
  labelNames: ['status'] as const, // success, error
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [registry],
});

/**
 * Tool execution latency - time to execute a single tool
 */
export const toolExecLatency = new Histogram({
  name: 'tool_exec_latency_ms',
  help: 'Tool execution duration in milliseconds',
  labelNames: ['tool', 'status'] as const, // tool name, ok/error
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
  registers: [registry],
});

/**
 * LLM request latency - time for LLM API call
 */
export const llmRequestLatency = new Histogram({
  name: 'llm_request_latency_ms',
  help: 'LLM API call duration in milliseconds',
  labelNames: ['provider', 'model', 'status_class'] as const, // qwen, openai, etc + 2xx, 4xx, 5xx
  buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000],
  registers: [registry],
});

/**
 * Sandbox lifecycle latency - provision/destroy time
 */
export const sandboxLifecycleLatency = new Histogram({
  name: 'sandbox_lifecycle_latency_ms',
  help: 'Sandbox provision/destroy duration in milliseconds',
  labelNames: ['operation', 'status'] as const, // provision/destroy, ok/error
  buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [registry],
});

/**
 * Session resume latency
 */
export const sessionResumeLatency = new Histogram({
  name: 'session_resume_latency_ms',
  help: 'Session resume duration in milliseconds',
  labelNames: ['status'] as const,
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [registry],
});

/**
 * HTTP request latency (for API endpoints)
 */
export const httpRequestLatency = new Histogram({
  name: 'http_request_latency_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

/**
 * Session duration - total time from creation to completion
 */
export const sessionDurationSeconds = new Histogram({
  name: 'session_duration_seconds',
  help: 'Total session duration in seconds',
  labelNames: ['status', 'mode', 'tier'] as const, // completed/failed/aborted, automated/interactive, free/pro/enterprise
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

export const cloudRunAdmissionLatency = new Histogram({
  name: 'cloud_run_admission_latency_ms',
  help: 'Time spent processing a claimed shared-cloud Run admission',
  labelNames: ['scheduling_class', 'result'] as const,
  buckets: [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000],
  registers: [registry],
});

/**
 * Context window utilization - how much of the context window is used
 */
export const contextWindowUtilization = new Gauge({
  name: 'context_window_utilization',
  help: 'Context window utilization ratio (0-1)',
  labelNames: ['model'] as const,
  registers: [registry],
});

/**
 * LLM time to first token (streaming latency)
 */
export const llmTimeToFirstToken = new Histogram({
  name: 'llm_time_to_first_token_ms',
  help: 'Time from LLM request to first token in milliseconds',
  labelNames: ['provider', 'model'] as const,
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

// ============================================================================
// COUNTERS - For rates and totals
// ============================================================================

/**
 * Turn commits by status
 */
export const turnCommitTotal = new Counter({
  name: 'turn_commit_total',
  help: 'Total turn commits',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Session resume attempts
 */
export const sessionResumeTotal = new Counter({
  name: 'session_resume_total',
  help: 'Session resume attempts',
  labelNames: ['status'] as const, // enqueued, success, fail
  registers: [registry],
});

/**
 * Completion blocked events
 */
export const completionBlockedTotal = new Counter({
  name: 'completion_blocked_total',
  help: 'Completion blocked events by reason',
  labelNames: ['reason'] as const, // s3_unavailable, report_missing, other
  registers: [registry],
});

/**
 * CAS fencing / lost ownership
 */
export const lostOwnershipTotal = new Counter({
  name: 'lost_ownership_total',
  help: 'CAS fencing rejects (nonce mismatch)',
  registers: [registry],
});

/**
 * API errors by category
 */
export const apiErrorTotal = new Counter({
  name: 'api_error_total',
  help: 'API errors by category and provider',
  labelNames: ['category', 'provider'] as const, // timeout, rate_limit, auth, server_error, etc.
  registers: [registry],
});

/**
 * Credit checks that could not resolve organization scope.
 */
export const creditMissingOrganizationTotal = new Counter({
  name: 'credit_missing_organization_total',
  help: 'Credit enforcement events that were skipped because organizationId was missing',
  labelNames: ['source'] as const, // credit_gate, pre_turn_checks, usage_recorder
  registers: [registry],
});

/**
 * Next attempt scheduling
 */
export const nextAttemptTotal = new Counter({
  name: 'next_attempt_total',
  help: 'Retry scheduling events',
  labelNames: ['action'] as const, // scheduled, cleared
  registers: [registry],
});

/**
 * Retention reaper events
 */
export const retentionReaperTotal = new Counter({
  name: 'retention_reaper_total',
  help: 'Retention reaper events',
  labelNames: ['result'] as const, // run, deleted, error
  registers: [registry],
});

/**
 * Orphan container cleanup events
 */
export const orphanContainerCleanupTotal = new Counter({
  name: 'orphan_container_cleanup_total',
  help: 'Orphan container cleanup events',
  labelNames: ['result'] as const, // found, reaped, error
  registers: [registry],
});

export const cloudRunAdmissionTotal = new Counter({
  name: 'cloud_run_admission_total',
  help: 'Claimed shared-cloud Run admissions by scheduling class and bounded result',
  labelNames: ['scheduling_class', 'result'] as const,
  registers: [registry],
});

export const cloudRunRecoveryTotal = new Counter({
  name: 'cloud_run_recovery_total',
  help: 'Capacity lease reconciliation outcomes',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Orphan container cleanup duration
 */
export const orphanContainerCleanupDuration = new Histogram({
  name: 'orphan_container_cleanup_duration_ms',
  help: 'Orphan container cleanup duration in milliseconds',
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [registry],
});

/**
 * Tool executions by tool name
 */
export const toolExecTotal = new Counter({
  name: 'tool_exec_total',
  help: 'Tool executions by tool and status',
  labelNames: ['tool', 'status'] as const,
  registers: [registry],
});

/**
 * B1 skill catalog observability. Slug and content hash are bounded by the
 * versioned catalog, so these labels do not grow with sessions or users.
 */
export const skillSelectionTotal = new Counter({
  name: 'securityops_skill_selection_total',
  help: 'Skill relevance selections by catalog content version and phase',
  labelNames: ['slug', 'version_hash', 'phase'] as const,
  registers: [registry],
});

export const skillLoadTotal = new Counter({
  name: 'securityops_skill_load_total',
  help: 'Skill methodology loads by catalog content version and phase',
  labelNames: ['slug', 'version_hash', 'phase', 'result'] as const,
  registers: [registry],
});

export const skillOutcomeTotal = new Counter({
  name: 'securityops_skill_outcome_total',
  help: 'Validation, lead, blocker, and false-positive outcomes attributed to active skills',
  labelNames: ['slug', 'version_hash', 'outcome'] as const,
  registers: [registry],
});

export const skillToolCompatibilityRejectionTotal = new Counter({
  name: 'securityops_skill_tool_compatibility_rejection_total',
  help: 'Skill assignments rejected because required tools are unavailable',
  labelNames: ['slug'] as const,
  registers: [registry],
});

export const enumerationWorkerAdmissionTotal = new Counter({
  name: 'securityops_enumeration_worker_admission_total',
  help: 'Enumeration worker admission decisions by bounded capability state',
  labelNames: ['decision', 'reason', 'cohort', 'policy_version', 'catalog_version'] as const,
  registers: [registry],
});

export const enumerationWorkerTargetRequestTotal = new Counter({
  name: 'securityops_enumeration_worker_target_request_total',
  help: 'Reserved or rejected target requests for enumeration workers',
  labelNames: ['decision', 'reason'] as const,
  registers: [registry],
});

export const enumerationWorkerAttemptTotal = new Counter({
  name: 'securityops_enumeration_worker_attempt_total',
  help: 'Server-side enumeration attempt reservation and completion decisions',
  labelNames: ['decision', 'status'] as const,
  registers: [registry],
});

export const enumerationWorkerResultTotal = new Counter({
  name: 'securityops_enumeration_worker_result_total',
  help: 'Enumeration worker typed result outcomes',
  labelNames: ['decision', 'status'] as const,
  registers: [registry],
});

export const enumerationWorkerDispositionTotal = new Counter({
  name: 'securityops_enumeration_worker_disposition_total',
  help: 'Parent enumeration result dispositions',
  labelNames: ['action', 'outcome'] as const,
  registers: [registry],
});

export const skillRoutingLatency = new Histogram({
  name: 'securityops_skill_routing_latency_ms',
  help: 'Catalog relevance-ranking latency',
  labelNames: ['phase'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100],
  registers: [registry],
});

export const skillContextTokens = new Histogram({
  name: 'securityops_skill_context_tokens',
  help: 'Estimated prompt tokens introduced by a loaded skill context',
  labelNames: ['slug', 'version_hash'] as const,
  buckets: [50, 100, 250, 500, 1000, 2000, 4000, 8000],
  registers: [registry],
});

// ============================================================================
// GAUGES - For current state
// ============================================================================

/**
 * Active sessions gauge
 */
export const activeSessionsGauge = new Gauge({
  name: 'active_sessions',
  help: 'Number of currently active sessions',
  registers: [registry],
});

/**
 * Pending resume queue size
 */
export const pendingResumeGauge = new Gauge({
  name: 'pending_resume_queue',
  help: 'Number of sessions pending resume',
  registers: [registry],
});

/**
 * S3 health probe
 */
export const s3HealthGauge = new Gauge({
  name: 's3_health',
  help: 'S3 storage health (1=ok, 0=down)',
  labelNames: ['bucket'] as const,
  registers: [registry],
});

/**
 * Database health probe
 */
export const dbHealthGauge = new Gauge({
  name: 'db_health',
  help: 'Database health (1=ok, 0=down)',
  registers: [registry],
});

export const cloudRunQueueDepthGauge = new Gauge({
  name: 'cloud_run_queue_depth',
  help: 'Unadmitted shared-cloud Runs currently queued by bounded scheduling class',
  labelNames: ['scheduling_class'] as const,
  registers: [registry],
});

export const cloudRunOldestWaitSecondsGauge = new Gauge({
  name: 'cloud_run_oldest_wait_seconds',
  help: 'Age of the oldest unadmitted shared-cloud Run',
  registers: [registry],
});

export const cloudRunCapacityGauge = new Gauge({
  name: 'cloud_run_capacity',
  help: 'Effective and leased shared-cloud capacity by runner and bounded resource',
  labelNames: ['runner', 'resource', 'kind'] as const,
  registers: [registry],
});

export const cloudRunRunnerReadyGauge = new Gauge({
  name: 'cloud_run_runner_ready',
  help: 'Whether a shared-cloud runner is accepting, fresh, and automatic-capacity ready',
  labelNames: ['runner'] as const,
  registers: [registry],
});

export const cloudRunReadyRunnersGauge = new Gauge({
  name: 'cloud_run_ready_runners',
  help: 'Number of shared-cloud runners currently safe to admit work',
  registers: [registry],
});

export const cloudRunRunnerHeartbeatAgeSecondsGauge = new Gauge({
  name: 'cloud_run_runner_heartbeat_age_seconds',
  help: 'Age of the most recent shared-cloud runner heartbeat',
  labelNames: ['runner'] as const,
  registers: [registry],
});

export const cloudRunCleanupDisagreementsGauge = new Gauge({
  name: 'cloud_run_cleanup_disagreements',
  help: 'Live leases that disagree with terminal/releasing runtime state',
  labelNames: ['runner'] as const,
  registers: [registry],
});

export const cloudRunAutomaticAdmissionGauge = new Gauge({
  name: 'cloud_run_automatic_admission',
  help: 'Whether automatic shared-cloud admission is active for this deployment',
  registers: [registry],
});

export const cloudRunStarvationThresholdSecondsGauge = new Gauge({
  name: 'cloud_run_starvation_threshold_seconds',
  help: 'Configured age-promotion threshold for queued customer Runs',
  registers: [registry],
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get status class from HTTP status code (2xx, 4xx, 5xx)
 */
export function getStatusClass(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500) return '5xx';
  return 'other';
}

/**
 * Record an LLM request with proper labels
 */
export function recordLLMRequest(
  provider: string,
  model: string,
  durationMs: number,
  statusCode: number = 200,
): void {
  const statusClass = getStatusClass(statusCode);
  llmRequestLatency.observe({ provider, model, status_class: statusClass }, durationMs);
}

/**
 * Record a tool execution
 */
export function recordToolExec(
  toolName: string,
  durationMs: number,
  success: boolean,
): void {
  const status = success ? 'ok' : 'error';
  toolExecLatency.observe({ tool: toolName, status }, durationMs);
  toolExecTotal.inc({ tool: toolName, status });
}

/**
 * Record a turn commit
 */
export function recordTurnCommit(
  durationMs: number,
  success: boolean,
): void {
  const status = success ? 'success' : 'error';
  turnCommitLatency.observe({ status }, durationMs);
  turnCommitTotal.inc({ status });
}

/**
 * Record session resume
 */
export function recordSessionResume(
  outcome: 'enqueued' | 'success' | 'fail',
  durationMs?: number,
): void {
  sessionResumeTotal.inc({ status: outcome });
  if (durationMs !== undefined && outcome !== 'enqueued') {
    sessionResumeLatency.observe({ status: outcome }, durationMs);
  }
}

/**
 * Record sandbox lifecycle event
 */
export function recordSandboxLifecycle(
  operation: 'provision' | 'destroy',
  durationMs: number,
  success: boolean,
): void {
  const status = success ? 'ok' : 'error';
  sandboxLifecycleLatency.observe({ operation, status }, durationMs);
}

/**
 * Record API error
 */
export function recordAPIError(
  category: string,
  provider: string = 'unknown',
): void {
  apiErrorTotal.inc({ category, provider });
}

/**
 * Record a credit enforcement path with missing organization context.
 */
export function recordCreditMissingOrganization(source: string): void {
  creditMissingOrganizationTotal.inc({ source });
}

export function recordCloudRunAdmission(
  schedulingClass: 'free' | 'paid' | 'pro' | 'internal',
  result: 'started' | 'deferred' | 'failed',
  durationMs: number,
): void {
  const labels = { scheduling_class: schedulingClass, result };
  cloudRunAdmissionTotal.inc(labels);
  cloudRunAdmissionLatency.observe(labels, durationMs);
}

export function recordCloudRunRecovery(result: 'released' | 'requeued' | 'failed', count = 1): void {
  if (count > 0) cloudRunRecoveryTotal.inc({ result }, count);
}

export function recordCloudCapacitySnapshot(snapshot: {
  automaticAdmission: boolean;
  starvationThresholdMs: number;
  queue: { depth: number; oldestWaitMs: number; byClass: Record<'free' | 'paid' | 'pro' | 'internal', number> };
  runners: Array<{
    name: string;
    schedulingMode: string;
    heartbeatStale: boolean;
    automaticCapacityReady: boolean;
    lastHeartbeatAt: string | null;
    detectedMemoryMb: number | null;
    admissionMemoryMb: number | null;
    leasedMemoryMb: number;
    detectedContainerSlots: number | null;
    leasedContainerSlots: number;
    derivedActiveRuns: number | null;
    leasedActiveRuns: number;
    cleanupDisagreements: number;
  }>;
}): void {
  cloudRunQueueDepthGauge.reset();
  cloudRunCapacityGauge.reset();
  cloudRunRunnerReadyGauge.reset();
  cloudRunRunnerHeartbeatAgeSecondsGauge.reset();
  cloudRunCleanupDisagreementsGauge.reset();
  cloudRunAutomaticAdmissionGauge.set(snapshot.automaticAdmission ? 1 : 0);
  cloudRunStarvationThresholdSecondsGauge.set(snapshot.starvationThresholdMs / 1_000);
  for (const schedulingClass of ['free', 'paid', 'pro', 'internal'] as const) {
    cloudRunQueueDepthGauge.set({ scheduling_class: schedulingClass }, snapshot.queue.byClass[schedulingClass]);
  }
  cloudRunOldestWaitSecondsGauge.set(snapshot.queue.oldestWaitMs / 1_000);
  cloudRunReadyRunnersGauge.set(snapshot.runners.filter((runner) =>
    runner.schedulingMode === 'accepting' && !runner.heartbeatStale && runner.automaticCapacityReady).length);
  for (const runner of snapshot.runners) {
    cloudRunRunnerReadyGauge.set(
      { runner: runner.name },
      runner.schedulingMode === 'accepting' && !runner.heartbeatStale && runner.automaticCapacityReady ? 1 : 0,
    );
    const heartbeatAge = runner.lastHeartbeatAt
      ? Math.max(0, (Date.now() - Date.parse(runner.lastHeartbeatAt)) / 1_000)
      : 1_000_000_000;
    cloudRunRunnerHeartbeatAgeSecondsGauge.set({ runner: runner.name }, heartbeatAge);
    cloudRunCleanupDisagreementsGauge.set({ runner: runner.name }, runner.cleanupDisagreements);
    const resources = [
      ['memory_mb', runner.detectedMemoryMb ?? 0, runner.leasedMemoryMb],
      ['admission_memory_mb', runner.admissionMemoryMb ?? 0, runner.leasedMemoryMb],
      ['container_slots', runner.detectedContainerSlots ?? 0, runner.leasedContainerSlots],
      ['active_runs', runner.derivedActiveRuns ?? 0, runner.leasedActiveRuns],
    ] as const;
    for (const [resource, limit, leased] of resources) {
      cloudRunCapacityGauge.set({ runner: runner.name, resource, kind: 'limit' }, limit);
      cloudRunCapacityGauge.set({ runner: runner.name, resource, kind: 'leased' }, leased);
    }
  }
}

// ============================================================================
// TOKEN / COST / CACHE METRICS
// ============================================================================

/**
 * Token usage counters
 */
export const tokenUsageTotal = new Counter({
  name: 'token_usage_total',
  help: 'Total tokens used by type',
  labelNames: ['type', 'provider', 'model', 'tier'] as const, // prompt, completion, cached + subscription tier
  registers: [registry],
});

/**
 * Cost counter (in microdollars to avoid float precision issues)
 */
export const costMicroUsdTotal = new Counter({
  name: 'cost_micro_usd_total',
  help: 'Total cost in microdollars (divide by 1000000 for USD)',
  labelNames: ['provider', 'model', 'tier'] as const,
  registers: [registry],
});

/**
 * LLM cache hits and misses
 */
export const cacheTotal = new Counter({
  name: 'llm_cache_total',
  help: 'LLM cache hits and misses',
  labelNames: ['result'] as const, // hit, miss
  registers: [registry],
});

/**
 * Record token usage
 */
export function recordTokenUsage(
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  provider: string,
  model: string,
  tier: string = 'unknown',
): void {
  tokenUsageTotal.inc({ type: 'prompt', provider, model, tier }, promptTokens);
  tokenUsageTotal.inc({ type: 'completion', provider, model, tier }, completionTokens);
  if (cachedTokens > 0) {
    tokenUsageTotal.inc({ type: 'cached', provider, model, tier }, cachedTokens);
  }
}

/**
 * Record cost (in USD, will be converted to microdollars)
 */
export function recordCost(costUsd: number, provider: string, model: string, tier: string = 'unknown'): void {
  const microUsd = Math.round(costUsd * 1000000);
  costMicroUsdTotal.inc({ provider, model, tier }, microUsd);
}

/**
 * Record cache hit or miss
 */
export function recordCacheResult(hit: boolean): void {
  cacheTotal.inc({ result: hit ? 'hit' : 'miss' });
}

/**
 * Record session duration when session completes
 */
export function recordSessionDuration(
  durationSeconds: number,
  status: 'completed' | 'failed' | 'aborted',
  mode: 'automated' | 'interactive',
  tier: string = 'unknown',
): void {
  sessionDurationSeconds.observe({ status, mode, tier }, durationSeconds);
}

/**
 * Record context window utilization
 */
export function recordContextUtilization(tokensUsed: number, contextWindow: number, model: string): void {
  if (contextWindow > 0) {
    const utilization = tokensUsed / contextWindow;
    contextWindowUtilization.set({ model }, utilization);
  }
}

/**
 * Record time to first token for streaming LLM calls
 */
export function recordTimeToFirstToken(durationMs: number, provider: string, model: string): void {
  llmTimeToFirstToken.observe({ provider, model }, durationMs);
}
