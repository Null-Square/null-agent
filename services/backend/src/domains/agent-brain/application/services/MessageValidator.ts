import { type Message } from '../../domain/types';
import { logger } from '@/shared/logger';
import {
    buildInterruptedToolRecoveryProjection,
    repairUnsafeInterruptedToolResult,
    type InterruptedToolExecutionEvidence,
    type InterruptedToolRecoveryEventV1,
} from '../../domain/recovery/interruptedToolResult';

const log = logger.child({ scope: 'MessageValidator' });

export class MessageIntegrityError extends Error {
    constructor(
        message: string,
        public readonly errors: string[],
        public readonly sessionId?: string,
        public readonly turnNumber?: number,
    ) {
        super(message);
        this.name = 'MessageIntegrityError';
    }
}

export interface MessageValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validates message integrity before sending to LLM API.
 * 
 * Catches issues like:
 * - Orphaned tool_calls (assistant with tool_calls but missing tool results)
 * - Orphaned tool results (tool message without matching assistant tool_call)
 * - Duplicate messages
 * - Invalid message sequences
 */
export class MessageValidator {
    /**
     * Validate message array integrity.
     * Returns validation result instead of throwing.
     */
    validate(messages: Message[]): MessageValidationResult {
        const errors: string[] = [];
        const seenIds = new Set<string>();

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            // Check for duplicate message IDs
            if (msg.id) {
                if (seenIds.has(msg.id)) {
                    errors.push(`Duplicate message ID "${msg.id}" at index ${i}`);
                }
                seenIds.add(msg.id);
            }

            // Check: Every assistant with tool_calls must have matching tool results after it
            if (msg.role === 'assistant' && this.hasToolCalls(msg)) {
                const toolCallIds = this.getToolCallIds(msg);
                const followingMessages = messages.slice(i + 1);

                for (const toolCallId of toolCallIds) {
                    const hasResult = followingMessages.some(
                        (m) => m.role === 'tool' && this.getToolCallId(m) === toolCallId,
                    );
                    if (!hasResult) {
                        errors.push(
                            `Orphaned tool_call "${toolCallId.substring(0, 16)}..." at message index ${i}`,
                        );
                    }
                }
            }

            // Check: Every tool message must have a preceding assistant with matching tool_call
            if (msg.role === 'tool') {
                const toolCallId = this.getToolCallId(msg);
                if (toolCallId) {
                    const precedingMessages = messages.slice(0, i);
                    const hasAssistant = precedingMessages.some(
                        (m) =>
                            m.role === 'assistant' &&
                            this.getToolCallIds(m).includes(toolCallId),
                    );
                    if (!hasAssistant) {
                        errors.push(
                            `Orphaned tool result "${toolCallId.substring(0, 16)}..." at message index ${i}`,
                        );
                    }
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors,
        };
    }

    /**
     * Validate and throw if invalid.
     * Use this before API calls for fail-fast behavior.
     */
    assertValid(
        messages: Message[],
        context?: { sessionId?: string; turnNumber?: number },
    ): void {
        const result = this.validate(messages);

        if (!result.valid) {
            log.error(
                {
                    sessionId: context?.sessionId,
                    turnNumber: context?.turnNumber,
                    errors: result.errors,
                    messageCount: messages.length,
                    messageSummary: messages.map((m, i) => ({
                        idx: i,
                        role: m.role,
                        id: m.id?.substring(0, 8),
                        hasToolCalls: this.hasToolCalls(m),
                        toolCallId: this.getToolCallId(m)?.substring(0, 12),
                    })),
                },
                '[MessageValidator] Message integrity validation FAILED',
            );

            throw new MessageIntegrityError(
                `Message validation failed: ${result.errors.join('; ')}`,
                result.errors,
                context?.sessionId,
                context?.turnNumber,
            );
        }

        log.debug(
            { sessionId: context?.sessionId, messageCount: messages.length },
            '[MessageValidator] Message integrity validated',
        );
    }

    /**
     * Attempt to repair common message issues.
     * Returns a new array with repairs applied.
     * 
     * Currently handles:
     * - Removing duplicate messages
     * - Adding placeholder results for orphaned tool_calls
     */
    repair(
        messages: Message[],
        options: {
            resolveEvidence?: (toolCallId: string) => InterruptedToolExecutionEvidence | undefined;
        } = {},
    ): {
        messages: Message[];
        repairsApplied: string[];
        recoveryEvents: InterruptedToolRecoveryEventV1[];
    } {
        const repairs: string[] = [];
        const seenIds = new Set<string>();
        const result: Message[] = [];
        const recoveryEvents: InterruptedToolRecoveryEventV1[] = [];

        for (const msg of messages) {
            // Skip duplicates
            if (msg.id && seenIds.has(msg.id)) {
                repairs.push(`Removed duplicate message ${msg.id.substring(0, 8)}`);
                continue;
            }
            if (msg.id) {
                seenIds.add(msg.id);
            }
            const toolCallId = this.getToolCallId(msg);
            const upgraded = msg.role === 'tool' && toolCallId
                ? repairUnsafeInterruptedToolResult({
                    toolCallId,
                    content: msg.content,
                    source: 'message_validator',
                })
                : undefined;
            if (upgraded) {
                result.push({ ...msg, content: upgraded.content });
                recoveryEvents.push(upgraded.event);
                repairs.push(
                    `Upgraded legacy interrupted result for tool_call ${toolCallId!.substring(0, 12)}`,
                );
            } else {
                result.push(msg);
            }
        }

        // Check for orphaned tool_calls and add placeholder results
        for (let i = 0; i < result.length; i++) {
            const msg = result[i];
            if (msg.role === 'assistant' && this.hasToolCalls(msg)) {
                const toolCallIds = this.getToolCallIds(msg);
                const followingMessages = result.slice(i + 1);

                for (const toolCallId of toolCallIds) {
                    const hasResult = followingMessages.some(
                        (m) => m.role === 'tool' && this.getToolCallId(m) === toolCallId,
                    );
                    if (!hasResult) {
                        const projection = buildInterruptedToolRecoveryProjection({
                            toolCallId,
                            source: 'message_validator',
                            evidence: options.resolveEvidence?.(toolCallId),
                        });
                        // Insert a placeholder result right after the assistant message
                        const placeholderResult: Message = {
                            id: `placeholder-${toolCallId}`,
                            role: 'tool',
                            content: projection.content,
                            toolCallId: toolCallId,
                            timestamp: Date.now(),
                        };
                        // Find insertion point (after all tool results for this assistant)
                        let insertIdx = i + 1;
                        while (
                            insertIdx < result.length &&
                            result[insertIdx].role === 'tool'
                        ) {
                            insertIdx++;
                        }
                        result.splice(insertIdx, 0, placeholderResult);
                        repairs.push(
                            `Added placeholder result for orphaned tool_call ${toolCallId.substring(0, 12)}`,
                        );
                        recoveryEvents.push(projection.event);
                    }
                }
            }
        }

        for (const recoveryEvent of recoveryEvents) {
            log.warn({
                event: 'message_recovery.interrupted_tool_result',
                ...recoveryEvent,
            }, '[MessageValidator] Repaired interrupted tool result');
        }

        return { messages: result, repairsApplied: repairs, recoveryEvents };
    }

    private hasToolCalls(msg: Message): boolean {
        return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    }

    private getToolCallIds(msg: Message): string[] {
        if (!Array.isArray(msg.tool_calls)) return [];
        return msg.tool_calls
            .map((tc) => tc?.id)
            .filter((id: unknown): id is string => typeof id === 'string');
    }

    private getToolCallId(msg: Message): string | undefined {
        return msg.tool_call_id ?? msg.toolCallId;
    }
}

