/**
 * Tool approval helper.
 *
 * Runtime-wide "approve every tool" mode remains disabled, but structured
 * policy-driven approval requests are durable again through session.pendingApproval.
 */

import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../../domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import type { ApprovalPreview, PendingApproval, SessionState } from '../../domain/types';
import type { SessionStore } from '../core/SessionStore';
import type { StreamBroker } from '../core/StreamBroker';
import type { ToolArgs } from '../tools/types';

export class ApprovalDeniedError extends AppError {
    constructor(public readonly reason?: string, toolName?: string) {
        super(
            ERROR_CODES.TOOL_APPROVAL_DENIED,
            reason ? `Action denied by operator: ${reason}` : 'Action denied by operator',
            { context: { reason, toolName } },
        );
        this.name = 'ApprovalDeniedError';
    }
}

export interface ApprovalDecision {
    status: 'granted' | 'denied';
    reason?: string;
}

type ApprovalRequestContext = {
    toolCallId?: string;
    modelRequestId?: string;
    preview?: ApprovalPreview | Record<string, unknown>;
    reason?: string;
};

const cloneRecord = <T extends Record<string, unknown>>(value: T | undefined): T | undefined => {
    if (!value) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value)) as T;
};

const normalizeText = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const normalized = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : undefined;
};

const normalizePreview = (preview?: ApprovalPreview | Record<string, unknown>): ApprovalPreview | undefined => {
    if (!preview) {
        return undefined;
    }

    const normalized: ApprovalPreview = {};
    const cmd = normalizeText(preview.cmd);
    const path = normalizeText(preview.path);
    const diff = normalizeText(preview.diff);
    const risk = normalizeStringArray(preview.risk);

    if (cmd) {
        normalized.cmd = cmd;
    }
    if (path) {
        normalized.path = path;
    }
    if (diff) {
        normalized.diff = diff;
    }
    if (risk) {
        normalized.risk = risk;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const matchesPendingApproval = (pendingApproval: PendingApproval, actionId: string): boolean =>
    pendingApproval.actionId === actionId || pendingApproval.toolCallId === actionId;

export class SimpleApprovalHelper {
    constructor(
        private readonly _sessionStore: SessionStore,
        private readonly _streamBroker: StreamBroker,
    ) { }

    /**
     * Keep legacy runtime-level "approve every tool" disabled.
     * Structured policy-driven approvals are triggered explicitly by ToolsRegistry.
     */
    shouldAwaitApproval(_session?: SessionState): boolean {
        return false;
    }

    /**
     * Persist a pending approval request on the session and emit approval UI.
     */
    async requestApproval(
        session: SessionState | undefined,
        sessionId: string,
        toolName: string,
        args: ToolArgs,
        context?: ApprovalRequestContext,
    ): Promise<ApprovalDecision | null> {
        const liveSession = this._sessionStore.get(sessionId) ?? session;
        if (!liveSession) {
            return null;
        }

        const actionId = normalizeText(context?.toolCallId) ?? uuidv4();
        const toolCallId = normalizeText(context?.toolCallId) ?? actionId;

        if (liveSession.pendingApproval) {
            if (matchesPendingApproval(liveSession.pendingApproval, actionId)) {
                return null;
            }
            return null;
        }

        const pendingApproval: PendingApproval = {
            actionId,
            tool: toolName,
            toolCallId,
            ...(normalizeText(context?.modelRequestId) ? { modelRequestId: normalizeText(context?.modelRequestId) } : {}),
            ...(cloneRecord(args) ? { args: cloneRecord(args) } : {}),
            ...(normalizePreview(context?.preview) ? { preview: normalizePreview(context?.preview) } : {}),
            ...(normalizeText(context?.reason) ? { reason: normalizeText(context?.reason) } : {}),
            requestedAt: Date.now(),
        };

        await this._sessionStore.recordApprovalRequestedAsync?.(
            sessionId,
            liveSession.turn ?? 0,
            pendingApproval,
        );
        liveSession.pendingApproval = pendingApproval;
        liveSession.blockedReason = undefined;

        await this._sessionStore.setAsync(sessionId, liveSession, 'approval_pending');
        this._streamBroker.emit(sessionId, {
            type: 'approval_needed',
            data: pendingApproval,
        });
        return null;
    }

    /**
     * Resolve a stored approval decision.
     *
     * Granted approvals remain on the session until the orchestrator consumes
     * them through handleApprovalResume(), preserving restart-safe resume data.
     */
    async resolveDecision(
        sessionId: string,
        actionId: string,
        status: 'granted' | 'denied',
        reason?: string,
        options?: { emitEvent?: boolean },
    ): Promise<{ handled: boolean; needsResume: boolean }> {
        const session = this._sessionStore.get(sessionId);
        if (!session?.pendingApproval) {
            return { handled: false, needsResume: false };
        }

        if (!matchesPendingApproval(session.pendingApproval, actionId)) {
            return { handled: false, needsResume: false };
        }

        const pendingApproval = session.pendingApproval;
        await this._sessionStore.recordApprovalDecidedAsync?.(
            sessionId,
            pendingApproval.actionId,
            status,
            reason,
            {
                toolCallId: pendingApproval.toolCallId,
                toolName: pendingApproval.tool,
                turnNumber: session.turn ?? 0,
                ...(pendingApproval.requestedAt !== undefined
                    ? { requestedAt: pendingApproval.requestedAt }
                    : {}),
            },
        );

        if (status === 'granted') {
            session.flags = {
                ...(session.flags ?? {}),
                approval_resume: {
                    actionId: session.pendingApproval.actionId,
                    toolCallId: session.pendingApproval.toolCallId,
                    tool: session.pendingApproval.tool,
                    ...(session.pendingApproval.modelRequestId
                        ? { modelRequestId: session.pendingApproval.modelRequestId }
                        : {}),
                    grantedAt: Date.now(),
                },
            };
            await this._sessionStore.setAsync(sessionId, session, 'approval_granted');
            if (options?.emitEvent) {
                this._streamBroker.emit(sessionId, {
                    type: 'approval_granted',
                    data: { actionId: session.pendingApproval.actionId },
                });
            }
            return { handled: true, needsResume: true };
        }

        const resolvedActionId = session.pendingApproval.actionId;
        session.pendingApproval = undefined;
        session.blockedReason = undefined;
        if (session.flags && 'approval_resume' in session.flags) {
            const nextFlags = { ...(session.flags ?? {}) };
            delete nextFlags.approval_resume;
            session.flags = nextFlags;
        }
        session.stateMachine?.stopProcessing('approval_denied', session.turn, 'SimpleApprovalHelper');
        await this._sessionStore.setAsync(sessionId, session, 'approval_denied');

        if (options?.emitEvent) {
            this._streamBroker.emit(sessionId, {
                type: 'approval_denied',
                data: { actionId: resolvedActionId, ...(reason ? { reason } : {}) },
            });
        }

        return { handled: true, needsResume: false };
    }
}
