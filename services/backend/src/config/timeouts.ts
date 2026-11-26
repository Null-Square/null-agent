/**
 * Centralized Timeout Constants
 * 
 * All timeout values used across the backend should be defined here.
 * This prevents magic numbers and ensures consistency.
 * 
 * @example
 * import { TIMEOUTS } from '@/config/timeouts';
 * 
 * await someOperation({ timeout: TIMEOUTS.HTTP_REQUEST_MS });
 */

// ============================================================================
// Graceful Shutdown
// ============================================================================

/** Time to wait for graceful shutdown before force-killing (ms) */
export const GRACEFUL_SHUTDOWN_MS = 30_000;

// ============================================================================
// Database
// ============================================================================

/** Database health check timeout (ms) */
export const DB_HEALTH_CHECK_MS = 2_000;

/** Database query timeout for long operations (ms) */
export const DB_LONG_QUERY_MS = 60_000;

/** Database migration retry delay base (ms) */
export const DB_MIGRATION_RETRY_MS = 200;

// ============================================================================
// HTTP / Network
// ============================================================================

/** HTTP request timeout for external services (ms) */
export const HTTP_REQUEST_MS = 30_000;

/** SSE connection keep-alive interval (ms) */
export const SSE_KEEPALIVE_MS = 15_000;

/** Notifications SSE keep-alive interval (ms) */
export const SSE_NOTIFICATIONS_KEEPALIVE_MS = 30_000;

/** Maintenance mode cache TTL (ms) */
export const MAINTENANCE_CACHE_MS = 5_000;

// ============================================================================
// HTTP Server
// ============================================================================

/** HTTP slow request logging threshold (ms) */
export const HTTP_LOG_SLOW_MS = 750;

// ============================================================================
// Docker / Sandbox
// ============================================================================

/** Docker container start timeout (ms) */
export const DOCKER_START_MS = 30_000;

/** Docker health check timeout (ms) */
export const DOCKER_HEALTH_CHECK_MS = 5_000;

/** Docker container stop timeout (ms) */
export const DOCKER_STOP_MS = 10_000;

/** Docker profile test init delay (ms) */
export const DOCKER_INIT_DELAY_MS = 2_000;

// ============================================================================
// PDF / Puppeteer
// ============================================================================

/** PDF generation page load timeout (ms) */
export const PDF_PAGE_LOAD_MS = 30_000;

/** PDF font/asset loading delay (ms) */
export const PDF_ASSET_DELAY_MS = 1_000;

// ============================================================================
// LLM / AI
// ============================================================================

/** LLM request timeout for model calls (ms) */
export const LLM_REQUEST_MS = 120_000;

/** LLM streaming chunk timeout (ms) */
export const LLM_STREAM_CHUNK_MS = 30_000;

// ============================================================================
// Runtime
// ============================================================================

/** Default runtime turn timeout (ms) */
export const RUNTIME_TURN_TIMEOUT_MS = 180_000;

/** Default runtime shell execution timeout (ms) */
export const RUNTIME_SHELL_TIMEOUT_MS = 120_000;

/** Default runtime web tool timeout (ms) */
export const RUNTIME_WEB_TIMEOUT_MS = 15_000;

/** Default runtime session TTL (minutes) */
export const SESSION_TTL_MINUTES = 120;

// ============================================================================
// Automation
// ============================================================================

/** Default automation turn timeout (ms) */
export const AUTOMATION_TURN_TIMEOUT_MS = 300_000;

// ============================================================================
// Circuit Breakers
// ============================================================================

/** Circuit breaker default reset timeout (ms) */
export const CIRCUIT_BREAKER_RESET_MS = 30_000;

/** Circuit breaker reset timeout for lightweight services (ms) */
export const CIRCUIT_BREAKER_SERVICE_RESET_MS = 15_000;

// ============================================================================
// Sessions
// ============================================================================

/** Session idle timeout before cleanup (ms) */
export const SESSION_IDLE_MS = 30 * 60 * 1_000; // 30 minutes

/** Session processing timeout (ms) */
export const SESSION_PROCESSING_MS = 5 * 60 * 1_000; // 5 minutes

/** Session max age for retention (days) */
export const SESSION_MAX_AGE_DAYS = 30;

/** Session reconciler interval (ms) */
export const SESSION_RECONCILER_INTERVAL_MS = 30_000;

/** Session retention reaper interval (ms) */
export const SESSION_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

/** Session retention reaper initial delay (ms) */
export const SESSION_RETENTION_INITIAL_DELAY_MS = 60_000;

// ============================================================================
// Scheduler
// ============================================================================

/** Scheduler poll interval (ms) */
export const SCHEDULER_POLL_INTERVAL_MS = 5_000;

/** Scheduler heartbeat timeout (ms) */
export const SCHEDULER_HEARTBEAT_TIMEOUT_MS = 120_000;

/** Scheduler default run timeout (ms) */
export const SCHEDULER_DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** Scheduler heartbeat interval minimum (ms) */
export const SCHEDULER_HEARTBEAT_MIN_MS = 5_000;

/** Scheduler heartbeat interval maximum (ms) */
export const SCHEDULER_HEARTBEAT_MAX_MS = 30_000;

/** Scheduler retry base delay (ms) */
export const SCHEDULER_RETRY_BASE_MS = 1_000;

/** Scheduler retry max delay (ms) */
export const SCHEDULER_RETRY_MAX_MS = 600_000;

// ============================================================================
// Trace
// ============================================================================

/** Trace retention days */
export const TRACE_RETENTION_DAYS = 14;

// ============================================================================
// Rate Limiting
// ============================================================================

/** Default rate limit window (ms) */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Rate limiter cleanup interval (ms) */
export const RATE_LIMIT_CLEANUP_MS = 5 * 60 * 1_000;

/** Rate limiter stale bucket threshold (ms) */
export const RATE_LIMIT_STALE_MS = 30 * 60 * 1_000;

// ============================================================================
// Web Search
// ============================================================================

/** Web search request timeout (ms) */
export const WEB_SEARCH_TIMEOUT_MS = 15_000;

// ============================================================================
// Approvals
// ============================================================================

/** Default approval timeout (ms) */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

// ============================================================================
// Convenience Object
// ============================================================================

/**
 * All timeout constants as a single object.
 * Prefer direct imports for tree-shaking.
 */
export const TIMEOUTS = {
  // Graceful Shutdown
  GRACEFUL_SHUTDOWN_MS,
  
  // Database
  DB_HEALTH_CHECK_MS,
  DB_LONG_QUERY_MS,
  DB_MIGRATION_RETRY_MS,
  
  // HTTP
  HTTP_REQUEST_MS,
  SSE_KEEPALIVE_MS,
  SSE_NOTIFICATIONS_KEEPALIVE_MS,
  MAINTENANCE_CACHE_MS,
  
  // HTTP Server
  HTTP_LOG_SLOW_MS,
  
  // Docker
  DOCKER_START_MS,
  DOCKER_HEALTH_CHECK_MS,
  DOCKER_STOP_MS,
  DOCKER_INIT_DELAY_MS,
  
  // PDF
  PDF_PAGE_LOAD_MS,
  PDF_ASSET_DELAY_MS,
  
  // LLM
  LLM_REQUEST_MS,
  LLM_STREAM_CHUNK_MS,

  // Runtime
  RUNTIME_TURN_TIMEOUT_MS,
  RUNTIME_SHELL_TIMEOUT_MS,
  RUNTIME_WEB_TIMEOUT_MS,
  SESSION_TTL_MINUTES,

  // Automation
  AUTOMATION_TURN_TIMEOUT_MS,

  // Circuit Breakers
  CIRCUIT_BREAKER_RESET_MS,
  CIRCUIT_BREAKER_SERVICE_RESET_MS,
  
  // Sessions
  SESSION_IDLE_MS,
  SESSION_PROCESSING_MS,
  SESSION_MAX_AGE_DAYS,
  SESSION_RECONCILER_INTERVAL_MS,
  SESSION_RETENTION_INTERVAL_MS,
  SESSION_RETENTION_INITIAL_DELAY_MS,

  // Scheduler
  SCHEDULER_POLL_INTERVAL_MS,
  SCHEDULER_HEARTBEAT_TIMEOUT_MS,
  SCHEDULER_DEFAULT_RUN_TIMEOUT_MS,
  SCHEDULER_HEARTBEAT_MIN_MS,
  SCHEDULER_HEARTBEAT_MAX_MS,
  SCHEDULER_RETRY_BASE_MS,
  SCHEDULER_RETRY_MAX_MS,

  // Trace
  TRACE_RETENTION_DAYS,
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_CLEANUP_MS,
  RATE_LIMIT_STALE_MS,
  
  // Web Search
  WEB_SEARCH_TIMEOUT_MS,

  // Approvals
  APPROVAL_TIMEOUT_MS,
} as const;
