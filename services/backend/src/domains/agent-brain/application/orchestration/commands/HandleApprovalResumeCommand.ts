/**
 * HandleApprovalResumeCommand - Handles approval resume after server restart.
 * 
 * Extracted from OrchestratorAdapter.handleApprovalResume() to:
 * 1. Reduce OrchestratorAdapter complexity
 * 2. Make approval handling testable in isolation
 * 3. Follow Single Responsibility Principle
 */

import type { Message, ToolExecutionReceiptV1 } from '../../../domain/types';
import type { SessionStore } from '../../core/SessionStore';
import type { SessionEventPublisher, ToolRegistryPort } from '../../../ports';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { AppLogger } from '@/shared/logger';
import { stopProcessing } from '../utils/sessionProcessing';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '../utils/sessionStatusEvents';

export interface HandleApprovalResumeDeps {
  sessionStore: SessionStore;
  events: SessionEventPublisher;
  toolsRegistry: ToolRegistryPort;
  traceRecorder?: SessionTraceRecorder;
  log: AppLogger;
  processMessage: (sessionId: string, userInput: string, profileKey?: string) => Promise<void>;
  processClaimedMessage: (
    sessionId: string,
    claimToken: string,
    userInput?: string,
    profileKey?: string,
  ) => Promise<void>;
  ownsExecutionClaim?: (sessionId: string, claimToken: string) => Promise<boolean>;
}

export interface ApprovalData {
  actionId: string;
  toolCallId?: string;
  modelRequestId?: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface HandleApprovalResumeInput {
  sessionId: string;
  approval: ApprovalData;
  /** Present only when the journal worker already owns the session lease. */
  executionClaimToken?: string;
  /** The folded journal, rather than mutable metadata, proved the grant. */
  durablyGranted?: boolean;
}

export class HandleApprovalResumeCommand {
  constructor(private readonly deps: HandleApprovalResumeDeps) {}

  async execute(input: HandleApprovalResumeInput): Promise<void> {
    const { sessionId, approval } = input;

    const session = this.deps.sessionStore.get(sessionId);
    if (!session) {
      this.deps.log.warn({ sessionId, actionId: approval.actionId }, 'Session not found for approval resume');
      return;
    }

    // Check if session is still awaiting approval
    if (!session.pendingApproval && !input.durablyGranted) {
      this.deps.log.warn(
        { sessionId, actionId: approval.actionId, hasPendingApproval: false, version: session.version },
        '[ApprovalResume] Rejected: session no longer waiting for approval'
      );
      return;
    }

    if (
      input.durablyGranted
      && session.pendingApproval
      && (
        session.pendingApproval.actionId !== approval.actionId
        || session.pendingApproval.toolCallId !== approval.toolCallId
      )
    ) {
      throw new Error('approved_tool_projection_mismatch');
    }

    const claimedExecutionIsAuthorized = async (): Promise<boolean> => {
      if (!input.executionClaimToken) return true;
      if (!this.deps.ownsExecutionClaim
        || !(await this.deps.ownsExecutionClaim(sessionId, input.executionClaimToken))) {
        return false;
      }
      const journal = await this.deps.sessionStore.getJournalProjection?.(sessionId);
      return journal?.desiredExecution === 'running';
    };

    if (!(await claimedExecutionIsAuthorized())) return;

    this.deps.log.info(
      { sessionId, actionId: approval.actionId, tool: approval.toolName, toolCallId: approval.toolCallId },
      '[ApprovalResume] Resuming with approved tool execution'
    );

    const controller = new AbortController();
    const registered = await this.deps.sessionStore.startTurnAsync(
      sessionId,
      controller,
      { reason: 'approved_tool_execution' },
    );
    if (!registered) throw new Error('session_already_processing');

    try {
      // Close the Stop/claim race after registering the abort controller and
      // before the tool adapter can cross its durable dispatch boundary.
      if (!(await claimedExecutionIsAuthorized())) return;

      if (input.durablyGranted) {
        // The journal grant is authoritative. Materialize only the short-lived
        // permission context needed by the tool policy so execution cannot race
        // the mutable session projection written by the HTTP decision path.
        session.flags = {
          ...(session.flags ?? {}),
          approval_resume: {
            actionId: approval.actionId,
            toolCallId: approval.toolCallId,
            tool: approval.toolName,
            ...(approval.modelRequestId ? { modelRequestId: approval.modelRequestId } : {}),
          },
        };
      }

      const toolExecution = await this.executeApprovedTool(sessionId, approval, controller.signal);

      // A tool may settle while Stop is racing it. Preserve that outcome as a
      // fact even though no further model continuation is allowed.
      await this.injectToolResult(sessionId, approval, toolExecution.result, toolExecution.receipt);

      const continuationAuthorized = await claimedExecutionIsAuthorized();
      const previousStatus = deriveSessionStatusForEvent(session);
      session.pendingApproval = undefined;
      if (continuationAuthorized) session.blockedReason = undefined;
      if (session.flags && 'approval_resume' in session.flags) {
        const nextFlags = { ...(session.flags ?? {}) };
        delete nextFlags.approval_resume;
        session.flags = nextFlags;
      }
      stopProcessing(session, {
        reason: 'approval_resume',
        turnNumber: session.turn,
        caller: 'HandleApprovalResumeCommand',
      });
      await this.deps.sessionStore.setAsync(sessionId, session, 'approval_resume');
      const resumedSession = this.deps.sessionStore.get(sessionId) ?? session;
      emitSessionStatusEvent(this.deps.events, resumedSession, previousStatus, 'approval_resume', this.deps.traceRecorder);

      await this.logApprovalResume(sessionId, session.turn ?? 0, approval);

      this.deps.events.emit(sessionId, {
        type: 'approval_granted',
        data: { actionId: approval.actionId },
      });
    } finally {
      const approvalResume = session.flags?.approval_resume;
      if (
        approvalResume
        && typeof approvalResume === 'object'
        && !Array.isArray(approvalResume)
        && (approvalResume as Record<string, unknown>).actionId === approval.actionId
      ) {
        const nextFlags = { ...(session.flags ?? {}) };
        delete nextFlags.approval_resume;
        session.flags = nextFlags;
      }
      await this.deps.sessionStore.clearCurrentTurnAsync(sessionId);
    }

    if (input.executionClaimToken) {
      if (!(await claimedExecutionIsAuthorized())) return;
      await this.deps.processClaimedMessage(sessionId, input.executionClaimToken, '', session.profileKey);
    } else {
      await this.deps.processMessage(sessionId, '', session.profileKey);
    }
  }

  private async executeApprovedTool(
    sessionId: string,
    approval: ApprovalData,
    abortSignal: AbortSignal,
  ): Promise<{ result: unknown; receipt: ToolExecutionReceiptV1 }> {
    try {
      return await this.deps.toolsRegistry.executeWithReceipt(
        approval.toolName,
        approval.args ?? {},
        {
          sessionId,
          abortSignal,
          ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
          ...(approval.modelRequestId ? { modelRequestId: approval.modelRequestId } : {}),
        }
      );
    } catch (error) {
      this.deps.log.error({ err: error, sessionId, tool: approval.toolName }, '[ApprovalResume] Tool execution failed');
      return {
        result: { error: error instanceof Error ? error.message : 'Unknown error during tool execution' },
        receipt: {
          schema: 'tool-execution-receipt/v1',
          toolName: approval.toolName,
          ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
          ...(approval.modelRequestId ? { modelRequestId: approval.modelRequestId } : {}),
          outcome: 'failed',
        },
      };
    }
  }

  private async injectToolResult(
    sessionId: string,
    approval: ApprovalData,
    toolResult: unknown,
    receipt: ToolExecutionReceiptV1,
  ): Promise<void> {
    const toolResultContent = typeof toolResult === 'string'
      ? toolResult
      : JSON.stringify(toolResult, null, 2);

    const toolResultMessage: Message = {
      id: `tool-result-${approval.actionId}`,
      role: 'tool' as const,
      content: toolResultContent,
      timestamp: Date.now(),
      metadata: { toolExecution: receipt },
    };
    if (approval.toolCallId) {
      toolResultMessage.toolCallId = approval.toolCallId;
    }

    await this.deps.sessionStore.recordToolOutcomesAcceptedAsync?.(
      sessionId,
      this.deps.sessionStore.get(sessionId)?.turn ?? 0,
      [toolResultMessage],
    );
    await this.deps.sessionStore.appendMessageAsync(sessionId, toolResultMessage);
  }

  private async logApprovalResume(sessionId: string, turnNumber: number, approval: ApprovalData): Promise<void> {
    if (!this.deps.traceRecorder) return;

    await this.deps.traceRecorder.write(sessionId, turnNumber, {
      event: 'approval.resumed',
      severity: 'info',
      payload: {
        actionId: approval.actionId,
        toolCallId: approval.toolCallId,
        modelRequestId: approval.modelRequestId,
        toolName: approval.toolName,
        injectedMessageId: `tool-result-${approval.actionId}`,
      },
      note: `approval resumed: ${approval.toolName} (tool_call_id: ${approval.toolCallId || 'unknown'})`,
    });
  }
}
