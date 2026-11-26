/**
 * Session Debug Logger
 * 
 * Enables detailed session state logging when VITE_DEBUG_SESSIONS=1
 * 
 * Usage:
 *   Set VITE_DEBUG_SESSIONS=1 in .env.local to enable
 *   
 * Logs:
 *   - Optimistic cache patches
 *   - SSE status updates
 *   - Pause barrier operations
 *   - Rollback events
 *   - Status derivation
 */

const DEBUG_ENABLED = import.meta.env.VITE_DEBUG_SESSIONS === '1' || import.meta.env.VITE_DEBUG_SESSIONS === 'true';

type LogLevel = 'info' | 'warn' | 'error';

const formatTime = (): string => {
  const now = new Date();
  return now.toISOString().slice(11, 23); // HH:MM:SS.mmm
};

const logPrefix = (level: LogLevel, category: string): string => {
  const emoji = level === 'info' ? '🔵' : level === 'warn' ? '🟡' : '🔴';
  return `${emoji} [${formatTime()}] [SESSION:${category}]`;
};

export const sessionLogger = {
  /**
   * Log optimistic cache patch
   */
  optimisticPatch: (sessionId: string, patch: Record<string, unknown>, action: string) => {
    if (!DEBUG_ENABLED) return;
    console.log(
      `${logPrefix('info', 'OPTIMISTIC')} ${action}`,
      { sessionId, patch }
    );
  },

  /**
   * Log rollback event
   */
  rollback: (sessionId: string, reason: string) => {
    if (!DEBUG_ENABLED) return;
    console.warn(
      `${logPrefix('warn', 'ROLLBACK')} Rolling back optimistic update`,
      { sessionId, reason }
    );
  },

  /**
   * Log SSE event received
   */
  sseEvent: (event: string, sessionId: string | undefined, data?: unknown) => {
    if (!DEBUG_ENABLED) return;
    console.log(
      `${logPrefix('info', 'SSE')} Received: ${event}`,
      { sessionId, data }
    );
  },

  /**
   * Log SSE cache patch
   */
  sseCachePatch: (sessionId: string, patch: Record<string, unknown>, blocked: boolean) => {
    if (!DEBUG_ENABLED) return;
    if (blocked) {
      console.log(
        `${logPrefix('info', 'SSE')} ⏸️ Skipped cache patch (blocked)`,
        { sessionId, patch }
      );
    } else {
      console.log(
        `${logPrefix('info', 'SSE')} ✅ Applied cache patch`,
        { sessionId, patch }
      );
    }
  },

  /**
   * Log status derivation
   */
  deriveStatus: (status: string | undefined, blockedReason: string | null | undefined, derived: string) => {
    if (!DEBUG_ENABLED) return;
    console.log(
      `${logPrefix('info', 'DERIVE')} ${status}/${blockedReason} → ${derived}`,
      { status, blockedReason, derived }
    );
  },

  /**
   * Log API call
   */
  apiCall: (action: string, sessionId: string, method: string) => {
    if (!DEBUG_ENABLED) return;
    console.log(
      `${logPrefix('info', 'API')} ${method} ${action}`,
      { sessionId }
    );
  },

  /**
   * Log API error
   */
  apiError: (action: string, sessionId: string, error: unknown) => {
    if (!DEBUG_ENABLED) return;
    console.error(
      `${logPrefix('error', 'API')} ${action} failed`,
      { sessionId, error: error instanceof Error ? error.message : error }
    );
  },

  /**
   * Log cache state (for debugging)
   */
  cacheState: (sessionId: string, cached: Record<string, unknown> | undefined) => {
    if (!DEBUG_ENABLED) return;
    console.log(
      `${logPrefix('info', 'CACHE')} Current state`,
      { sessionId, status: cached?.status, blocked_reason: cached?.blocked_reason }
    );
  },

  /**
   * Log general debug info
   */
  debug: (message: string, data?: Record<string, unknown>) => {
    if (!DEBUG_ENABLED) return;
    console.log(`${logPrefix('info', 'DEBUG')} ${message}`, data);
  },

  /**
   * Check if debugging is enabled
   */
  isEnabled: () => DEBUG_ENABLED,
};
