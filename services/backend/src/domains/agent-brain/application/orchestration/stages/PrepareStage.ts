/**
 * PrepareStage - Session preparation before LLM turn
 * @module agent-brain/application/orchestration/stages/PrepareStage
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import type {
  PrepareStage,
  PrepareSessionArgs,
  PrepareSessionResult,
} from './types';
import { startProcessing, stopProcessing } from '../utils/sessionProcessing';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '../utils/sessionStatusEvents';

const pipelineLogger = logger.child({ scope: 'OrchestratorPipeline' });

export class DefaultPrepareStage implements PrepareStage {
  async run(args: PrepareSessionArgs): Promise<PrepareSessionResult> {
    const log = pipelineLogger.child({ sessionId: args.sessionId });
    // Sessions are hydrated on startup with a recency cap. If a user resumes an older
    // session (or a worker picks up a scheduled retry), we must hydrate on-demand.
    let sessionState = await args.sessionStore.getOrHydrate(args.sessionId);
    if (!sessionState) {
      args.events.emit(args.sessionId, {
        type: 'error',
        data: { code: 'SESSION_NOT_FOUND', message: `Session ${args.sessionId} not found` },
      });
      throw new Error('session_not_found');
    }

    let policyDirty = false;
    const lockedProfile =
      typeof (sessionState.flags?.policy_lock as Record<string, unknown> | undefined)?.profileKey === 'string'
        ? ((sessionState.flags?.policy_lock as Record<string, unknown>).profileKey as string).trim()
        : undefined;
    if (typeof args.profileKey === 'string') {
      const trimmedProfile = args.profileKey.trim();
      const requestedProfile = trimmedProfile.length > 0 ? trimmedProfile : undefined;
      const nextProfile = lockedProfile || requestedProfile;
      if (lockedProfile && requestedProfile && requestedProfile !== lockedProfile) {
        log.warn(
          {
            requestedProfile,
            lockedProfile,
          },
          'Ignored profile override for locked session',
        );
      }
      if (nextProfile !== sessionState.profileKey) {
        sessionState.profileKey = nextProfile;
        policyDirty = true;
      }
    } else if (lockedProfile && lockedProfile !== sessionState.profileKey) {
      sessionState.profileKey = lockedProfile;
      policyDirty = true;
    }

    if (!sessionState.flags?.policy_base?.toolPolicy && sessionState.toolPolicy) {
      sessionState.flags = sessionState.flags ?? {};
      sessionState.flags.policy_base = {
        ...(sessionState.flags.policy_base ?? {}),
        toolPolicy: sessionState.toolPolicy,
      };
    }

    const hasPolicySnapshot = Boolean(sessionState.flags?.brain_policy);
    const needsPolicyRefresh = policyDirty || !hasPolicySnapshot;

    if (needsPolicyRefresh) {
      try {
        sessionState = await args.policyResolver.resolve(sessionState, sessionState.profileKey ?? undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === 'policy.default_missing') {
          throw error;
        }
        log.warn({ err: error }, 'Failed to refresh brain policy for session');
      }
    }

    sessionState.extraContext = args.extraContext ?? sessionState.extraContext;

    // ========================================================================
    // CONCURRENCY GUARD: Skip if session is already processing
    // Uses state machine for centralized state management (Phase 2)
    // ========================================================================
    const stateMachine = sessionState.stateMachine;
    
    // Check both stateMachine (if available) and legacy isProcessing flag
    const alreadyProcessing = stateMachine 
      ? !stateMachine.canStartProcessing() 
      : false;
    
    if (alreadyProcessing) {
      log.info(
        { sessionId: args.sessionId, turn: sessionState.turn },
        '[Pipeline] Session already processing, skipping duplicate turn'
      );
      throw new Error('session_already_processing');
    }

    // Transition to processing state (stateMachine when available, fallback to flag)
    const previousStatus = deriveSessionStatusForEvent(sessionState);
    startProcessing(sessionState, {
      reason: 'turn_start',
      turnNumber: sessionState.turn,
      caller: 'pipeline.prepareSession',
    });
    await args.sessionStore.setAsync(args.sessionId, sessionState, 'pipeline.prepareSession.turn');
    const refreshedAfterTurn = args.sessionStore.get(args.sessionId);
    if (refreshedAfterTurn) {
      sessionState = refreshedAfterTurn;
      emitSessionStatusEvent(args.events, sessionState, previousStatus, 'turn_started', args.traceRecorder);
    }

    // ========================================================================
    // SANDBOX HEALTH CHECK: Verify container is healthy before processing
    // Prevents infinite loops after backend restart when sandbox is dead
    // ========================================================================
    if (args.sandboxHealthChecker && sessionState.containerId) {
      const health = await args.sandboxHealthChecker.check(sessionState.containerId);
      if (!health.healthy) {
        log.warn(
          { sessionId: args.sessionId, containerId: sessionState.containerId, errors: health.errors },
          '[Pipeline] Sandbox unhealthy - clearing stale container for recovery'
        );
        
        // The old container binding is a stale projection, not a durable
        // prerequisite. Clear it so the scheduled continuation provisions a
        // replacement instead of turning infrastructure loss into a pause.
        const previousHealthStatus = deriveSessionStatusForEvent(sessionState);
        sessionState.containerId = undefined;
        stopProcessing(sessionState, {
          reason: 'sandbox_unhealthy',
          turnNumber: sessionState.turn,
          caller: 'pipeline.healthCheck',
        });
        await args.sessionStore.setAsync(args.sessionId, sessionState, 'pipeline.healthCheck.container_reset');
        const refreshedSession = args.sessionStore.get(args.sessionId);
        if (refreshedSession) {
          emitSessionStatusEvent(
            args.events,
            refreshedSession,
            previousHealthStatus,
            'sandbox_unhealthy_recovery_scheduled',
            args.traceRecorder,
          );
        }
        
        throw new Error('sandbox_unhealthy');
      }
    }

    const initialPendingPlanStepIds = new Set<string>(
      Array.isArray(sessionState.plan)
        ? sessionState.plan.filter((step) => step.status === 'pending').map((step) => step.id)
        : [],
    );

    const continuingProjection = !args.userInput?.trim()
      ? await args.sessionStore.getJournalProjection?.(args.sessionId)
      : undefined;
    const turnController = new AbortController();
    // SIMPLIFIED: Always use sessionStore.startTurnAsync
    const turnStarted = await args.sessionStore.startTurnAsync(args.sessionId, turnController);
    if (turnStarted === false) {
      throw new Error('session_already_processing');
    }
    const turnNumber = continuingProjection?.openTurnNumber
      ?? (sessionState.turn ?? 0) + 1;
    const recorder = args.traceRecorder;
    const turnStream = args.streamFactory((event) => args.events.emit(args.sessionId, event));

    // Only create and append user message when there's actual user input
    // When resuming after user action, userInput is empty and we should NOT
    // create a new user message - the tool result is already in the history
    let userMessage: PrepareSessionResult['userMessage'];
    if (args.userInput && args.userInput.trim().length > 0) {
      userMessage = {
        id: uuidv4(),
        role: 'user',
        content: args.userInput,
        timestamp: Date.now(),
        metadata: args.messageMetadata,
      };

      await args.sessionStore.beginJournalTurnAsync?.(args.sessionId, turnNumber, userMessage);
      await args.sessionStore.appendMessageAsync(args.sessionId, userMessage);
      if (userMessage.metadata?.visibility !== 'internal') {
        turnStream.message(userMessage);
      }
    } else {
      await args.sessionStore.beginJournalTurnAsync?.(args.sessionId, turnNumber);
    }

    // Always reload session after mutations to avoid stale prompt history
    const refreshedSession = args.sessionStore.get(args.sessionId);
    if (refreshedSession) {
      sessionState = refreshedSession;
      // Persist turn number early so subsequent turns increment correctly
      sessionState.turn = turnNumber;
      await args.sessionStore.setAsync(args.sessionId, sessionState, 'pipeline.prepareSession.refresh');
    } else {
      log.warn('Failed to refresh session state');
    }

    if (recorder && userMessage) {
      await recorder.write(args.sessionId, turnNumber, {
        event: 'user.message',
        severity: 'info',
        payload: {
          id: userMessage.id,
          length: userMessage.content.length,
          preview: userMessage.content.slice(0, 256),
        },
        note: summarizeForNote(userMessage.content),
      });
    }

    return {
      sessionState,
      turnNumber,
      turnController,
      turnStream,
      initialPendingPlanStepIds,
      userMessage,
      recorder,
    };
  }
}

