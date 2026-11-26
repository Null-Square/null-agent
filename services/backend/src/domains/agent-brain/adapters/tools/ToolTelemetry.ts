import { createHash } from 'crypto';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import SessionToolInvocationRecorder, {
    type ToolInvocationRecordInput,
} from '@/domains/agent-brain/infrastructure/history/sessionToolInvocationRecorder';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import type { ToolArgs } from '@/domains/agent-brain/application/tools/types';

// summarizeForNote imported from @/shared/utils/text

const PASSWORD_SELECTOR_RE = /\b(password|passwd|pwd)\b/i;

/**
 * Redact sensitive argument values from the trace preview.
 * Currently handles browser_action type-into-password-field.
 */
const redactSensitiveArgs = (toolName: string, args: ToolArgs): string => {
  if (toolName !== 'browser_action') {
    return JSON.stringify(args ?? {});
  }
  const a = args as Record<string, unknown>;
  if (
    a.action !== 'type' ||
    typeof a.selector !== 'string' ||
    typeof a.text !== 'string' ||
    !PASSWORD_SELECTOR_RE.test(a.selector)
  ) {
    return JSON.stringify(args ?? {});
  }
  return JSON.stringify({ ...a, text: '[REDACTED]' });
};

type ToolPermissionTrace = {
    behavior?: string;
    source?: string;
    reason?: string;
    category?: string;
    actions?: string[];
    paths?: string[];
    hosts?: string[];
    command?: string;
};

type ToolTelemetryStartOptions = {
    toolCallId?: string;
    modelRequestId?: string;
    permission?: ToolPermissionTrace;
    /**
     * What the tool declares it produces. A reader counting what a run actually wrote needs
     * this on the event: a name list maintained somewhere else goes stale silently the first
     * time a canonical tool is added or renamed.
     */
    progressKind?: string;
};

type ToolTelemetryMeta = {
    invocationId: string | null;
    argsHash: string;
    startedAt: number;
    toolCallId?: string;
    modelRequestId?: string;
    planStepId?: string | null;
    progressKind?: string;
};

export class ToolTelemetry {
    private readonly fallbackRecorder?: ToolInvocationRecorder;

    constructor(
        private readonly config?: ResolvedConfig,
        private readonly invocationRecorder?: ToolInvocationRecorder
    ) {
        this.fallbackRecorder = invocationRecorder
            ? undefined
            : new SessionToolInvocationRecorder(this.config);
    }
    private readonly log = logger.child({ scope: 'ToolTelemetry' });

    async recordStart(
        sessionId: string,
        toolName: string,
        args: ToolArgs,
        turn: number,
        stepId: string | null,
        recorder?: SessionTraceRecorder,
        options: ToolTelemetryStartOptions = {}
    ): Promise<ToolTelemetryMeta> {
        let invocationId: string | null = null;
        try {
            const recorderImpl = this.invocationRecorder ?? this.fallbackRecorder;
            if (recorderImpl?.recordStart) {
                invocationId = await recorderImpl.recordStart({
                    sessionId,
                    toolId: toolName,
                    stepId,
                    input: args,
                });
            }
        } catch (recorderError) {
            this.log.warn({ err: recorderError, sessionId, toolName }, 'Failed to log tool invocation start');
        }

        const argsJson = JSON.stringify(args ?? {});
        const argsHash = createHash('sha256').update(argsJson).digest('hex');
        const argsPreview = redactSensitiveArgs(toolName, args).slice(0, 256);
        const startedAt = Date.now();

        if (recorder) {
            await recorder.write(sessionId, turn, {
                event: 'tool.start',
                severity: 'info',
                payload: {
                    toolName,
                    name: toolName,
                    toolCallId: options.toolCallId,
                    requestId: options.modelRequestId,
                    planStepId: stepId,
                    permission: options.permission,
                    progressKind: options.progressKind,
                    argsHash: `sha256:${argsHash}`,
                    argsPreview,
                },
                note: summarizeForNote(`${toolName} ${argsPreview}`),
            });
        }

        return {
            invocationId,
            argsHash,
            startedAt,
            toolCallId: options.toolCallId,
            modelRequestId: options.modelRequestId,
            planStepId: stepId,
            progressKind: options.progressKind,
        };
    }

    async recordFinish(
        sessionId: string,
        toolName: string,
        result: unknown,
        turn: number,
        meta: ToolTelemetryMeta,
        recorder?: SessionTraceRecorder
    ): Promise<void> {
        const { invocationId, argsHash, startedAt } = meta;
        const outcome = this.resolveOutcome(result);

        if (recorder) {
            const finishPreview =
                typeof result === 'string'
                    ? summarizeForNote(result)
                    : summarizeForNote(JSON.stringify(result));
            await recorder.write(sessionId, turn, {
                event: 'tool.finish',
                severity: outcome.outcome === 'success' ? 'info' : 'warn',
                payload: {
                    toolName,
                    name: toolName,
                    toolCallId: meta.toolCallId,
                    requestId: meta.modelRequestId,
                    planStepId: meta.planStepId,
                    progressKind: meta.progressKind,
                    durationMs: Date.now() - startedAt,
                    success: outcome.outcome === 'success',
                    outcome: outcome.outcome,
                    outcomeReason: outcome.outcomeReason,
                    result: this.summarizeResult(result),
                    argsHash: `sha256:${argsHash}`,
                },
                note: finishPreview ? `${toolName} => ${finishPreview}` : `tool ${toolName} finished`,
            });
        }

        if (invocationId) {
            try {
                const recorderImpl = this.invocationRecorder ?? this.fallbackRecorder;
                if (recorderImpl?.recordSuccess) {
                    await recorderImpl.recordSuccess(invocationId, result);
                }
            } catch (recorderError) {
                this.log.warn({ err: recorderError, sessionId, toolName, invocationId }, 'Failed to log tool invocation success');
            }
        }
    }

    async recordFailure(
        sessionId: string,
        toolName: string,
        error: unknown,
        turn: number,
        meta: ToolTelemetryMeta,
        recorder?: SessionTraceRecorder,
        isDenied = false,
        reason?: string
    ): Promise<void> {
        const { invocationId, argsHash, startedAt } = meta;

        if (isDenied && recorder) {
            await recorder.write(sessionId, turn, {
                event: 'tool.finish',
                severity: 'warn',
                payload: {
                    toolName,
                    name: toolName,
                    toolCallId: meta.toolCallId,
                    requestId: meta.modelRequestId,
                    planStepId: meta.planStepId,
                    progressKind: meta.progressKind,
                    durationMs: Date.now() - startedAt,
                    success: false,
                    denied: true,
                    outcome: 'blocked',
                    outcomeReason: reason,
                    reason,
                    argsHash: `sha256:${argsHash}`,
                },
                note: summarizeForNote(`${toolName} denied`),
            });
        } else if (recorder) {
            await recorder.write(sessionId, turn, {
                event: 'tool.finish',
                severity: 'error',
                payload: {
                    toolName,
                    name: toolName,
                    toolCallId: meta.toolCallId,
                    requestId: meta.modelRequestId,
                    planStepId: meta.planStepId,
                    progressKind: meta.progressKind,
                    durationMs: Date.now() - startedAt,
                    success: false,
                    outcome: 'error',
                    outcomeReason: (error as Error).message,
                    argsHash: `sha256:${argsHash}`,
                },
                note: summarizeForNote(`${toolName} error: ${(error as Error).message}`),
            });
            await recorder.write(sessionId, turn, {
                event: 'error',
                severity: 'error',
                payload: {
                    class: 'tool',
                    toolName,
                    name: toolName,
                    toolCallId: meta.toolCallId,
                    requestId: meta.modelRequestId,
                    planStepId: meta.planStepId,
                    message: (error as Error).message,
                    stack: (error as Error).stack,
                    argsHash: `sha256:${argsHash}`,
                },
                note: summarizeForNote(`${toolName} error: ${(error as Error).message}`),
            });
        }

        if (invocationId) {
            try {
                const recorderImpl = this.invocationRecorder ?? this.fallbackRecorder;
                if (recorderImpl?.recordFailure) {
                    await recorderImpl.recordFailure(invocationId, error);
                }
            } catch (recorderError) {
                this.log.warn({ err: recorderError, sessionId, toolName, invocationId }, 'Failed to log tool invocation failure');
            }
        }
    }

    async recordForbidden(
        sessionId: string,
        toolName: string,
        turn: number,
        recorder?: SessionTraceRecorder
    ): Promise<void> {
        if (recorder) {
            await recorder.write(sessionId, turn, {
                event: 'tool.forbidden',
                severity: 'warn',
                payload: {
                    name: toolName,
                },
                note: summarizeForNote(`forbidden tool ${toolName}`),
            });
        }
    }

    async recordAbort(
        sessionId: string,
        toolName: string,
        turn: number,
        startedAt: number,
        recorder?: SessionTraceRecorder
    ): Promise<void> {
        if (recorder) {
            await recorder.write(sessionId, turn, {
                event: 'tool.abort',
                severity: 'warn',
                payload: {
                    name: toolName,
                    durationMs: Date.now() - startedAt,
                },
                note: summarizeForNote(`${toolName} aborted`),
            });
        }
    }

    private summarizeResult(value: unknown): unknown {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === 'string') {
            if (value.length <= 512) {
                return value;
            }
            return {
                preview: value.slice(0, 512),
                length: value.length,
                truncated: true,
            };
        }
        if (typeof value !== 'object') {
            return value;
        }
        if (Array.isArray(value)) {
            return value.slice(0, 10).map((item) => this.summarizeResult(item));
        }
        const output: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            if (typeof inner === 'string') {
                output[key] = inner.length > 512
                    ? {
                        preview: inner.slice(0, 512),
                        length: inner.length,
                        truncated: true,
                    }
                    : inner;
            } else if (typeof inner === 'object' && inner !== null) {
                output[key] = this.summarizeResult(inner);
            } else {
                output[key] = inner;
            }
        }
        return output;
    }

    private resolveOutcome(result: unknown): { outcome: 'success' | 'failure' | 'blocked'; outcomeReason?: string } {
        if (!result || typeof result !== 'object') {
            return { outcome: 'success' };
        }

        const record = result as Record<string, unknown>;
        const failed =
            'error' in record ||
            record.success === false ||
            record.ok === false ||
            record.forbidden === true;
        if (!failed) {
            return { outcome: 'success' };
        }

        const reason =
            typeof record.error === 'string'
                ? record.error
                : typeof record.reason === 'string'
                    ? record.reason
                    : typeof record.message === 'string'
                        ? record.message
                        : undefined;

        return {
            outcome: record.forbidden === true || record.denied === true ? 'blocked' : 'failure',
            outcomeReason: reason,
        };
    }
}

type ToolInvocationRecorder = {
    recordStart?: (input: ToolInvocationRecordInput) => Promise<string | null>;
    recordSuccess?: (invocationId: string, result: unknown) => Promise<void>;
    recordFailure?: (invocationId: string, error: unknown) => Promise<void>;
};
