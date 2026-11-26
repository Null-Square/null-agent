/**
 * AutomationGuardHandler - Handles automation guard evaluation and actions
 * 
 * The automation guard ensures that automated sessions complete their work:
 * - Detects when the model returns without making progress
 * - Schedules retries when plan steps are still pending
 * - Handles guard exhaustion (max retries reached)
 * - Manages mode switching from automated to interactive
 * 
 * Extracted from OrchestratorAdapter to improve maintainability.
 */

import { logger } from '@/shared/logger';
import type { SessionState } from '../../../domain/types';
import type { SessionStore } from '../../core/SessionStore';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { AutomationModePolicy } from '../../services/AutomationModePolicy';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { summarizeForNote } from '@/shared/utils/text';
import type { NotificationPort } from '../../../ports';
import { PLANNER_SUBMIT_REQUIRED_REASON } from './AutomationDecisionEngine';
import { isHostedRunContext } from '@/domains/security-ops/runs/HostedRunPersistencePort';

// summarizeForNote imported from @/shared/utils/text

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const shouldTrackPlannerSubmitRetry = (reason: string | undefined): boolean =>
    typeof reason === 'string' && reason.startsWith(PLANNER_SUBMIT_REQUIRED_REASON);

const getRetryCount = (value: unknown): number => {
    const state = isRecord(value) ? value : undefined;
    const count = state?.count;
    return typeof count === 'number' && Number.isFinite(count) && count > 0
        ? count
        : 0;
};

const getStringPayloadValue = (payload: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = payload?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

const getRecordPayloadValue = (
    payload: Record<string, unknown> | undefined,
    key: string,
): Record<string, unknown> | undefined => {
    const value = payload?.[key];
    return isRecord(value) ? value : undefined;
};

const hasUnsubmittedActivePhaseHandoff = (session: SessionState | undefined): boolean => {
    const securityops = isRecord(session?.flags?.securityops) ? session?.flags.securityops : undefined;
    const activePhaseKey = securityops?.activePhaseKey;
    return (
        typeof activePhaseKey === 'string' &&
        activePhaseKey.trim().length > 0 &&
        securityops?.phaseHandoffSubmitted !== true
    );
};

const hasDedicatedContinuationOwner = (session: SessionState | undefined): boolean => {
    // WorkerDelegationService owns the sequential turn loop for worker sessions.
    // Scheduling a second continuation here races that loop: the duplicate call is
    // rejected as `session_already_processing`, then the delegation loop retries
    // immediately without making progress.
    if (session?.coordination?.role === 'worker') {
        // Provider quota is different: the worker loop projects this as a blocked wait and exits,
        // so it no longer owns a future continuation. Let the journal recovery worker reclaim the
        // child at the provider reset instead of terminalizing it or relying on an in-memory sleep.
        if (session.blockedReason !== 'provider_quota_exhausted') return true;
    }

    const securityops = isRecord(session?.flags?.securityops)
        ? session.flags.securityops
        : undefined;
    return isHostedRunContext({
        runId: typeof securityops?.runId === 'string' ? securityops.runId : undefined,
        runHost: typeof securityops?.runHost === 'string' ? securityops.runHost : undefined,
    });
};
const LIVE_WORKER_TASK_STATUSES = new Set([
    'pending',
    'running',
    'blocked',
    'awaiting_input',
    'awaiting_approval',
]);
const getLiveSidecarTaskIds = (session: SessionState | undefined): string[] => {
    if (
        !session ||
        session.mode !== 'automated' ||
        session.agentType !== 'executor' ||
        session.coordination?.role === 'worker' ||
        !Array.isArray(session.workerTasks)
    ) {
        return [];
    }

    return session.workerTasks
        .filter((task) =>
            LIVE_WORKER_TASK_STATUSES.has(task.status) &&
            task.executionMode === 'background' &&
            (task.dependencyMode ?? 'sidecar') === 'sidecar',
        )
        .map((task) => task.taskId);
};

/** Pending plan step (matches ReconcilePlanResult.pendingSteps) */
export type PendingPlanStep = { id: string; title?: string; status?: string };

/** Stream interface for guard events */
export interface GuardStream {
    raw(type: string, data: unknown): void;
    done(): void;
}

/** Result of guard handling */
export interface GuardHandlingResult {
    /** Whether done event should be suppressed */
    suppressDone: boolean;
    /** Whether to schedule an auto-retry */
    scheduleAutoRetry: boolean;
    /** Whether the fast retry budget was crossed (diagnostic only). */
    exhausted: boolean;
    /** Message to include in retry */
    autoRetryMessage?: string;
    /** Reason for retry */
    autoRetryReason?: string;
    /** Profile to use for retry */
    autoRetryProfile?: string;
    /** Optional durable backoff for the retry. */
    autoRetryDelayMs?: number;
    /** Reason for mode switch (if applicable) */
    modeSwitchReason?: string;
    /** Payload for mode switch event */
    modeSwitchPayload?: Record<string, unknown>;
}

/** Parameters for guard handling */
export interface GuardHandlingParams {
    sessionId: string;
    turnNumber: number;
    session: SessionState;
    pendingPlanSteps: PendingPlanStep[];
    hasReport: boolean;
    toolCallCount: number;
    turnStatus: string;
    turnStream: GuardStream;
    recorder?: SessionTraceRecorder;
    blockedReason?: string | null; // Pass through from DB/session to check terminal states
}

/** Dependencies for AutomationGuardHandler */
export interface AutomationGuardHandlerDeps {
    sessionStore: SessionStore;
    automationPolicy: AutomationModePolicy;
    /** Optional persistence for user-visible terminal/prerequisite blocks. */
    sessionRepository?: {
        /** Persists terminal/user-action block state independently of session snapshots. */
        setBlockedReason?: (
            id: string,
            reason: string,
            meta?: Record<string, unknown>,
            executionClaimToken?: string,
        ) => Promise<boolean>;
    };
    notificationPort?: NotificationPort;
}

/**
 * AutomationGuardHandler processes guard evaluation results and takes appropriate action.
 */
export class AutomationGuardHandler {
    private readonly log = logger.child({ scope: 'AutomationGuardHandler' });

    constructor(private readonly deps: AutomationGuardHandlerDeps) { }

    private isReportRequired(session?: SessionState): boolean {
        const policy = this.deps.automationPolicy as unknown as {
            isReportRequired?: (sessionOrAgentType?: string | Pick<SessionState, 'agentType' | 'coordination'>) => boolean;
        };
        if (typeof policy.isReportRequired === 'function') {
            return policy.isReportRequired(session);
        }
        return session?.agentType !== 'planner';
    }

    private isGoalRunAutomationSession(session: SessionState): boolean {
        if (session.mode !== 'automated') {
            return false;
        }
        if (session.agentType !== 'planner' && session.agentType !== 'executor') {
            return false;
        }
        const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
        return typeof securityops?.runId === 'string' && securityops.runId.trim().length > 0;
    }

    /**
     * Handle guard evaluation and take appropriate actions.
     */
    async handle(params: GuardHandlingParams): Promise<GuardHandlingResult> {
        const {
            sessionId,
            turnNumber,
            session,
            pendingPlanSteps,
            hasReport,
            toolCallCount,
            turnStatus,
            turnStream,
            recorder,
        } = params;

        const result: GuardHandlingResult = {
            suppressDone: false,
            scheduleAutoRetry: false,
            exhausted: false, // P0 FIX: Track exhaustion state
        };

        // Get fresh session state for guard evaluation
        const freshSession = this.deps.sessionStore.get(sessionId);
        const isProcessing =
            freshSession?.stateMachine?.isProcessing() ??
            session.stateMachine?.isProcessing() ??
            false;

        // Get previous guard state
        const guardSnapshot = isRecord(session.flags?.guard) ? session.flags.guard : {};
        const previousRetryCount = typeof guardSnapshot.retryCount === 'number' ? guardSnapshot.retryCount : 0;

        // Evaluate guard
        const guardActive = this.deps.automationPolicy.evaluateGuard({
            mode: session.mode,
            agentType: session,
            isProcessing: isProcessing, // SIMPLIFIED: was sessionStatus
            turnStatus: params.turnStatus, // PRIMARY check for terminal states (cleanest)
            blockedReason: params.blockedReason ?? session.blockedReason, // FALLBACK
            pendingPlanSteps,
            hasReport,
            toolCallCount,
            previousRetryCount,
        });

        // Record metric even if guard is not active
        if (!guardActive.active) {
            opsMetrics.recordAutomationGuard('none', 0, pendingPlanSteps.length);
        }

        // Check for mode switch without guard (successful completion).
        // Planner sessions complete when plan is written — they never produce report.md.
        const requiresReport = this.isReportRequired(session);
        const completionReportSatisfied = !requiresReport || hasReport;
        const liveSidecarTaskIds = getLiveSidecarTaskIds(session);
        if (
            !guardActive.active &&
            session.mode === 'automated' &&
            turnStatus === 'completed' &&
            pendingPlanSteps.length === 0 &&
            completionReportSatisfied &&
            liveSidecarTaskIds.length === 0 &&
            !hasUnsubmittedActivePhaseHandoff(session)
        ) {
            result.modeSwitchReason = 'automated.completed';
            result.modeSwitchPayload = {
                pendingSteps: 0,
                pendingStepIds: [],
            };

            // NOTE: TASK_COMPLETED notification is sent by OrchestratorAdapter (lines 631-662)
            // with proper deduplication (checks isAlreadyCompleted flag).
            // Do NOT send notification here to avoid duplicates.
        } else if (
            !guardActive.active &&
            session.mode === 'automated' &&
            turnStatus === 'completed' &&
            pendingPlanSteps.length === 0 &&
            completionReportSatisfied &&
            liveSidecarTaskIds.length > 0
        ) {
            turnStream.raw('warning', {
                code: 'completion_deferred_live_workers',
                message: 'Completion deferred because background sidecar workers are still active.',
                liveWorkerTaskIds: liveSidecarTaskIds,
            });
            if (recorder) {
                await recorder.write(sessionId, turnNumber, {
                    event: 'automated.completion_deferred',
                    severity: 'warn',
                    payload: {
                        liveWorkerTaskIds: liveSidecarTaskIds,
                    },
                    note: summarizeForNote(`completion deferred; live sidecars=${liveSidecarTaskIds.length}`),
                });
            }
        }

        // If guard is not active, return early
        if (!guardActive.active) {
            return result;
        }

        // Guard is active - handle it
        result.suppressDone = guardActive.suppressDone ?? false;
        const retryCount = guardActive.nextRetryCount;

        // Update session flags with guard state (in-memory only)
        // Persistence will happen in OrchestratorAdapter's consolidated finalization
        // to prevent version conflicts during auto-retry
        const updatedSession = this.deps.sessionStore.get(sessionId) ?? session;
        updatedSession.flags = {
            ...(updatedSession.flags ?? {}),
            guard: {
                retryCount,
                lastPendingStepIds: guardActive.pendingStepIds,
                lastReason:
                    guardActive.reason === 'report_missing'
                        ? 'report_missing'
                        : 'model returned without tool calls while plan steps pending',
            },
        };

        // Record guard event
        const guardEventBase = {
            isProcessing: isProcessing, // SIMPLIFIED: was sessionStatus
            pendingStepIds: guardActive.pendingStepIds,
            pendingSteps: pendingPlanSteps,
            toolCalls: toolCallCount,
            turn: turnNumber,
            retryAttempt: retryCount,
            hasReport,
        };

        opsMetrics.recordAutomationGuard(
            guardActive.exhausted ? 'exhausted' : 'fired',
            retryCount,
            pendingPlanSteps.length,
        );

        // Emit warning to frontend
        turnStream.raw('warning', {
            code: guardActive.exhausted ? 'automated_guard_exhausted' : 'automated_guard',
            message:
                guardActive.reason === 'report_missing'
                    ? 'report.md missing; automation will not finish until it is created.'
                    : 'model returned without tool calls while plan steps remain pending',
            pendingStepIds: guardActive.pendingStepIds,
            retryAttempt: retryCount,
        });

        // Record to trace
        if (recorder) {
            await recorder.write(sessionId, turnNumber, {
                event: guardActive.exhausted ? 'automated.guard.exhausted' : 'automated.guard.fired',
                severity: guardActive.exhausted ? 'error' : 'warn',
                payload: guardEventBase,
                note: summarizeForNote(
                    guardActive.exhausted
                        ? `guard exhausted after ${retryCount} attempts; pending ${pendingPlanSteps.length} step(s)`
                        : `guard fired; pending ${pendingPlanSteps.length} step(s); retry ${retryCount}`,
                ),
            });

            await recorder.write(sessionId, turnNumber, {
                event: 'automated.guard.retry',
                severity: 'info',
                payload: {
                    ...guardEventBase,
                    degradedBackoff: guardActive.exhausted,
                    delayMs: guardActive.autoRetryDelayMs,
                },
                note: summarizeForNote(`retry ${retryCount} for pending work`),
            });
        }

        // A model-quality guard never becomes a durable user prerequisite.
        // After the fast budget is crossed it continues with a slower retry.
        result.exhausted = guardActive.exhausted;
        if (guardActive.autoRetryMessage) {
            result.scheduleAutoRetry = true;
            result.autoRetryReason = guardActive.autoRetryReason;
            result.autoRetryMessage = guardActive.autoRetryMessage;
            result.autoRetryProfile = session.profileKey;
            result.autoRetryDelayMs = guardActive.autoRetryDelayMs;

            if (recorder) {
                await recorder.write(sessionId, turnNumber, {
                    event: 'automated.guard.retry_scheduled',
                    severity: 'info',
                    payload: {
                        retryAttempt: retryCount,
                        pendingStepIds: guardActive.pendingStepIds,
                        hasReport,
                        degradedBackoff: guardActive.exhausted,
                        delayMs: guardActive.autoRetryDelayMs,
                    },
                    note: summarizeForNote(result.autoRetryReason ?? 'automated retry scheduled'),
                });
            }
        }

        return result;
    }

    /**
     * Apply mode switch from automated to interactive.
     */
    async applyModeSwitch(params: {
        sessionId: string;
        turnNumber: number;
        reason: string;
        payload?: Record<string, unknown>;
        recorder?: SessionTraceRecorder;
    }): Promise<void> {
        const { sessionId, turnNumber, reason, payload, recorder } = params;

        const session = this.deps.sessionStore.get(sessionId);
        if (!session || session.mode !== 'automated') {
            return;
        }

        // Goal-path run sessions should remain automated; run-level approval is the only gate.
        if (this.isGoalRunAutomationSession(session)) {
            return;
        }

        session.mode = 'interactive';
        await this.deps.sessionStore.setAsync(sessionId, session, 'turn.complete.modeSwitch');

        if (recorder) {
            await recorder.write(sessionId, turnNumber, {
                event: 'mode.switch',
                severity: 'info',
                payload: {
                    from: 'automated',
                    to: 'interactive',
                    reason,
                    ...(payload ?? {}),
                },
                note: 'automated task completed, switching to interactive',
            });
        }
    }

    /**
     * Schedule an auto-retry for the session. Persisted runtimes append one
     * journal fact and update the due projection atomically. In-memory timers
     * remain only for deliberately unpersisted test/embedded runtimes.
     */
    async scheduleRetry(params: {
        sessionId: string;
        message: string;
        profile?: string;
        processMessage: (sessionId: string, input: string, profile?: string) => Promise<void>;
        delayMs?: number;
        reason?: string;
        executionClaimToken?: string;
    }): Promise<void> {
        const { sessionId, message, profile, processMessage, delayMs = 50, reason, executionClaimToken } = params;
        const hostedSession = this.deps.sessionStore.get(sessionId);
        if (hasDedicatedContinuationOwner(hostedSession)) {
            this.log.debug(
                { sessionId, reason },
                'Dedicated run or worker owner controls turn continuation; core auto-retry skipped'
            );
            return;
        }

        // P0 FIX (Dec 2025): Guard nudge is EPHEMERAL, not persisted as assistant message
        // Store in session.flags.ephemeralNudge for prompt assembly to pick up
        // This prevents polluting conversation history with control-plane instructions
        const currentSession = this.deps.sessionStore.get(sessionId);
        if (currentSession) {
            const existingNudge =
                typeof currentSession.flags?.ephemeralNudge === 'string' &&
                currentSession.flags.ephemeralNudge.trim().length > 0
                    ? currentSession.flags.ephemeralNudge
                    : undefined;
            const nextNudge = existingNudge && message === 'continue' ? existingNudge : message;
            const nextFlags: Record<string, unknown> = {
                ...(currentSession.flags ?? {}),
                ephemeralNudge: nextNudge, // Will be consumed by prompt builder on next call
            };
            if (shouldTrackPlannerSubmitRetry(reason)) {
                nextFlags.plannerSubmitRetry = {
                    count: getRetryCount(currentSession.flags?.plannerSubmitRetry) + 1,
                    reason,
                    updatedAt: new Date().toISOString(),
                };
            }
            currentSession.flags = {
                ...currentSession.flags,
                ...nextFlags,
            };
            // Note: NOT calling appendMessageAsync - nudge is ephemeral only
        }

        // Persisted sessions have one continuation owner: the recovery worker.
        // The journal event and due projection commit together; blocked_reason
        // is reserved for real prerequisites and operator presentation.
        if (this.deps.sessionRepository) {
            const attemptAt = new Date(Date.now() + delayMs);
            try {
                const scheduled = await this.deps.sessionStore.recordExecutionDeferredAsync(
                    sessionId,
                    reason ?? 'continuation',
                    attemptAt,
                    `automation:${currentSession?.turn ?? 0}:${reason ?? 'continuation'}`,
                    executionClaimToken,
                );
                if (!scheduled) {
                    throw new Error('durable_automation_continuation_unavailable');
                }
            } catch (err) {
                this.log.error({ err, sessionId }, 'Failed to schedule durable session recovery');
                throw err;
            }
            this.log.info({ sessionId, attemptAt, reason }, 'Scheduled durable session continuation');
            return;
        }

        this.log.debug({ sessionId }, 'Using process-local continuation for non-persisted session');
        setTimeout(() => {
            void (async () => {
                const currentSession = this.deps.sessionStore.get(sessionId);
                // Use stateMachine as source of truth for processing state
                const stillProcessing = currentSession?.stateMachine?.isProcessing?.()
                    
                    ?? false;
                if (!currentSession || stillProcessing) {
                    this.log.info(
                        { sessionId, isProcessing: stillProcessing },
                        'Auto-retry cancelled: session processing or unavailable'
                    );
                    return;
                }

                // IMPORTANT: Do not append a synthetic "continue" user message.
                // Automated retries/continuations are control-plane, not user intent, and should not
                // pollute conversation history. Any instruction for the next turn is injected via
                // session.flags.ephemeralNudge (see above) and consumed by BuildStage.
                await processMessage(sessionId, '', profile);
            })().catch((err) => {
                this.log.error({ err, sessionId }, 'Auto-retry turn failed');
            });
        }, delayMs);
    }

    /**
     * Evaluate if automation should continue and schedule next turn if needed.
     * 
     * UNIFIED CONTINUATION POLICY (Phase 3 refactoring):
     * This method unifies two previously separate concerns:
     * 1. Guard detection ("model gave up" - no tools called)
     * 2. Continuation policy (max_tool_calls, pending steps, missing report)
     * 
     * Returns true if continuation was scheduled, false otherwise.
     */
    async evaluateContinuation(params: {
        sessionId: string;
        turnNumber: number;
        turnStatus: string;
        pendingPlanSteps: PendingPlanStep[];
        hasReport: boolean;
        guardResult: GuardHandlingResult;
        processMessage: (sessionId: string, input: string, profile?: string) => Promise<void>;
        recorder?: SessionTraceRecorder;
        executionClaimToken?: string;
    }): Promise<boolean> {
        const { 
            sessionId, 
            turnNumber, 
            turnStatus, 
            pendingPlanSteps, 
            hasReport, 
            guardResult, 
            processMessage, 
            recorder,
            executionClaimToken,
        } = params;

        const session = this.deps.sessionStore.get(sessionId);
        if (!session) {
            return false;
        }
        if (hasDedicatedContinuationOwner(session)) {
            this.log.debug(
                { sessionId },
                '[evaluateContinuation] Dedicated run or worker owner controls turn continuation'
            );
            return false;
        }

        // Use unified decision engine
        const { getDecisionEngine } = await import('./AutomationDecisionEngine');
        const decision = getDecisionEngine().decide({
            sessionId,
            session,
            turnStatus,
            pendingPlanSteps,
            hasReport,
            requiresReport: this.isReportRequired(session),
            guardResult,
        });

        // Only continue if decision is 'continue'
        if (decision.action !== 'continue') {
            if (decision.action === 'await_user') {
                const blockedReason = getStringPayloadValue(decision.payload, 'blockedReason');
                const blockedMeta = getRecordPayloadValue(decision.payload, 'blockedMeta');
                if (blockedReason) {
                    session.blockedReason = blockedReason;
                    session.blockedMeta = blockedMeta ?? { reason: decision.reason };
                    await this.deps.sessionStore.setAsync(sessionId, session, 'automation.await_user');
                    if (this.deps.sessionRepository?.setBlockedReason) {
                        try {
                            const persisted = executionClaimToken
                                ? await this.deps.sessionRepository.setBlockedReason(
                                    sessionId,
                                    blockedReason,
                                    session.blockedMeta,
                                    executionClaimToken,
                                )
                                : await this.deps.sessionRepository.setBlockedReason(
                                    sessionId,
                                    blockedReason,
                                    session.blockedMeta,
                                );
                            if (!persisted) {
                                this.log.warn(
                                    { sessionId, blockedReason },
                                    '[evaluateContinuation] Durable blocked state was not persisted',
                                );
                            }
                        } catch (error) {
                            this.log.warn(
                                { err: error, sessionId, blockedReason },
                                '[evaluateContinuation] Failed to persist durable blocked state',
                            );
                        }
                    }
                    if (recorder) {
                        await recorder.write(sessionId, turnNumber, {
                            event: 'automation.await_user',
                            severity: 'warn',
                            payload: {
                                reason: decision.reason,
                                blockedReason,
                                blockedMeta: session.blockedMeta,
                            },
                            note: summarizeForNote(`automation awaiting user: ${decision.reason}`),
                        });
                    }
                }
            }
            this.log.debug(
                { sessionId, decision: decision.reason },
                '[evaluateContinuation] Decision engine says stop/await'
            );
            return false;
        }

        this.log.info(
            { sessionId, turnStatus, reason: decision.reason, pendingSteps: pendingPlanSteps.length, hasReport },
            '[evaluateContinuation] Scheduling next turn'
        );

        // Record to trace
        if (recorder) {
            await recorder.write(sessionId, turnNumber, {
                event: 'automation.continue',
                severity: 'info',
                payload: { turnStatus, reason: decision.reason, ...(decision.payload ?? {}) },
                note: `automation continuing: ${decision.reason}`,
            });
        }

        // Schedule the continuation
        await this.scheduleRetry({
            sessionId,
            message: decision.message || 'continue',
            profile: session.profileKey,
            processMessage,
            reason: decision.reason,
            ...(decision.delayMs ? { delayMs: decision.delayMs } : {}),
            ...(executionClaimToken ? { executionClaimToken } : {}),
        });

        return true;
    }
}


