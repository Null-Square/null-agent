import type { SessionState } from '../../domain/types';
import { shouldRequireReportForSession } from '../../domain/workers/workerContracts';

type GuardReason = 'pending_no_tools' | 'report_missing';

/** Terminal blocked reasons that prevent automation from continuing */
export const TERMINAL_BLOCKED_REASONS = [
  'credits_exhausted',
  'token_limit_exceeded',
  'aborted',
  'deadlock',
] as const;

export type GuardContext = {
  mode?: SessionState['mode'];
  agentType?: string | (Pick<SessionState, 'agentType' | 'coordination'> & Partial<Pick<SessionState, 'flags'>>);
  isProcessing?: boolean;
  blockedReason?: string | null; // Fallback check for terminal reasons
  turnStatus?: string; // PRIMARY check - directly from TurnRunner result (no sync issues)
  pendingPlanSteps: { id: string; title?: string; status?: string }[];
  hasReport: boolean;
  toolCallCount: number;
  previousRetryCount?: number;
};

export type GuardDecision = {
  active: boolean;
  exhausted: boolean;
  nextRetryCount: number;
  pendingStepIds: string[];
  reason?: GuardReason;
  autoRetryReason?: string;
  autoRetryMessage?: string;
  /** Slow retry after the fast no-progress budget is crossed. */
  autoRetryDelayMs?: number;
  suppressDone: boolean;
};

type AutomationPolicyOptions = {
  /**
   * Master kill switch — set to false to disable all automation guards globally.
   * Useful for debugging or simplifying further. Defaults to true.
   */
  guardsEnabled?: boolean;
  maxGuardRetries?: number;
  requireReport?: boolean;
  /** Minimum report.md content length (default: 500 chars) */
  reportMinLength?: number;
  /** Per-turn timeout in ms (default: 300000 = 5 min) */
  turnTimeoutMs?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const DEGRADED_GUARD_RETRY_DELAY_MS = 30_000;
const DEFAULT_REPORT_MIN_LENGTH = 500;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/**
 * Centralizes mode-aware policies for automation:
 * - Approval bypass rules for automated sessions
 * - Turn guard evaluation (pending plan steps with no tool calls, missing report)
 * - Report content validation
 */
export class AutomationModePolicy {
  private readonly guardsEnabled: boolean;
  private readonly maxGuardRetries: number;
  private readonly requireReport: boolean;
  private readonly reportMinLength: number;
  private readonly turnTimeoutMs: number;

  constructor(options: AutomationPolicyOptions = {}) {
    this.guardsEnabled = options.guardsEnabled ?? true;
    this.maxGuardRetries = options.maxGuardRetries ?? DEFAULT_MAX_RETRIES;
    this.requireReport = options.requireReport ?? true;
    this.reportMinLength = options.reportMinLength ?? DEFAULT_REPORT_MIN_LENGTH;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /**
   * Get configured turn timeout in milliseconds
   */
  getTurnTimeoutMs(): number {
    return this.turnTimeoutMs;
  }

  /**
   * Get configured report minimum length
   */
  getReportMinLength(): number {
    return this.reportMinLength;
  }

  /**
   * Single source of truth for whether report.md is required for a session role.
   * When guards are disabled globally, report requirements are treated as disabled too.
   */
  isReportRequired(
    sessionOrAgentType?: string | (Pick<SessionState, 'agentType' | 'coordination'> & Partial<Pick<SessionState, 'flags'>>),
  ): boolean {
    if (!this.guardsEnabled || !this.requireReport) {
      return false;
    }
    if (typeof sessionOrAgentType === 'string') {
      return sessionOrAgentType !== 'planner';
    }
    return shouldRequireReportForSession(sessionOrAgentType);
  }

  /**
   * Validate report.md content meets quality requirements
   * Returns true if report is valid (has sufficient content)
   */
  validateReportContent(content: string | undefined): { valid: boolean; reason?: string } {
    if (!content) {
      return { valid: false, reason: 'Report content is empty' };
    }

    const trimmed = content.trim();
    if (trimmed.length < this.reportMinLength) {
      return {
        valid: false,
        reason: `Report content too short (${trimmed.length} chars, minimum: ${this.reportMinLength})`,
      };
    }

    return { valid: true };
  }

  /**
   * Decide whether to await approval, optionally overriding a base decision.
   * Automated sessions never await approval.
   */
  shouldAwaitApproval(session: SessionState | undefined, baseDecision: boolean): boolean {
    if (session?.mode === 'automated') {
      return false;
    }
    return baseDecision;
  }

  /**
   * Evaluate whether the automated guard should fire and if an auto-retry is warranted.
   */
  evaluateGuard(ctx: GuardContext): GuardDecision {
    const pendingStepIds = ctx.pendingPlanSteps.map((step) => step.id);

    // KILL SWITCH: guards globally disabled
    if (!this.guardsEnabled) {
      return { active: false, exhausted: false, nextRetryCount: 0, pendingStepIds, suppressDone: false };
    }

    // PRIORITY 0: Never fire guard if turn ended with a terminal status
    // Using turnStatus is cleaner than blockedReason because:
    // 1. It comes directly from TurnRunner result (no sync issues)
    // 2. Already flows through the call chain
    // 3. No reliance on session state timing
    const terminalTurnStatuses = ['credits_exhausted', 'deadlock', 'aborted', 'token_limit_exceeded'];
    if (ctx.turnStatus && terminalTurnStatuses.includes(ctx.turnStatus)) {
      return {
        active: false,
        exhausted: false,
        nextRetryCount: ctx.previousRetryCount ?? 0,
        pendingStepIds,
        suppressDone: true, // Session is in terminal state, don't emit done
      };
    }

    // FALLBACK: Also check blockedReason for cases where turnStatus isn't available
    // (e.g., guard called from different context)
    if (ctx.blockedReason && TERMINAL_BLOCKED_REASONS.includes(ctx.blockedReason as typeof TERMINAL_BLOCKED_REASONS[number])) {
      return {
        active: false,
        exhausted: false,
        nextRetryCount: ctx.previousRetryCount ?? 0,
        pendingStepIds,
        suppressDone: true,
      };
    }

    // Never fire guard if not actively processing - may be waiting for user input
    if (!ctx.isProcessing) {
      return {
        active: false,
        exhausted: false,
        nextRetryCount: ctx.previousRetryCount ?? 0,
        pendingStepIds,
        suppressDone: true, // Don't mark as done while waiting for input
      };
    }

    // Planner sessions finish via submit_plan handoff — they never produce report.md.
    const requiresReport = this.isReportRequired(ctx.agentType);

    const guardActive =
      ctx.mode === 'automated' &&
      ((ctx.pendingPlanSteps.length > 0 && ctx.toolCallCount === 0) ||
        (ctx.pendingPlanSteps.length === 0 && requiresReport && !ctx.hasReport));

    if (!guardActive) {
      return {
        active: false,
        exhausted: false,
        nextRetryCount: ctx.previousRetryCount ?? 0,
        pendingStepIds,
        suppressDone: false,
      };
    }

    const nextRetryCount = (ctx.previousRetryCount ?? 0) + 1;
    const exhausted = nextRetryCount > this.maxGuardRetries;
    const reason: GuardReason =
      ctx.pendingPlanSteps.length > 0 ? 'pending_no_tools' : 'report_missing';

    // Crossing the fast-retry budget is a degradation signal, not a new user
    // intent. Keep the session running and slow the durable continuation down
    // so a weak or temporarily confused model cannot create a hot loop.
    const autoRetryReason = `guard_retry:${reason}`;
    const autoRetryMessage = reason === 'pending_no_tools'
      ? `IMPORTANT: You did NOT call any tools in your last response. You must use proper tool calling format - do NOT write XML-like "<function=...>" syntax in your text. Use the actual tool calling mechanism to invoke tools like shell_run, file_write, etc. Pending steps: ${pendingStepIds.join(
        ', ',
      )}. Call tools now to make progress.`
      : 'Plan is complete. For SecurityOps closeout, call prepare_report_context if needed, write summary.md and report.md in the workspace root, then call finalize_run_artifacts.';

    return {
      active: true,
      exhausted,
      nextRetryCount,
      pendingStepIds,
      reason,
      autoRetryReason,
      autoRetryMessage,
      ...(exhausted ? { autoRetryDelayMs: DEGRADED_GUARD_RETRY_DELAY_MS } : {}),
      suppressDone: true,
    };
  }
}

export default AutomationModePolicy;
