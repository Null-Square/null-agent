import type { RunPhaseReplanRow, RunPhaseRow, RunRow } from '@/db/schema';
import type { AgentApiServices } from '@/app/services/agent/types';
import type { Message, SessionState } from '@/domains/agent-brain/domain/types';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  isRunAwaitingPlanApproval,
  type PhaseDiscoveryReplanSignals,
  type RunService,
} from './RunService';
import {
  attachMissionPhases,
  normalizePhaseKey,
  type RunPhaseKey,
} from './PhaseProfileRegistry';
import {
  MAX_OPEN_REPLAN_DISPATCH_ATTEMPTS,
  buildPhaseReplanPrompt,
  buildPlanFeedbackPrompt,
  isRecord,
  phaseHandoffTerminalStatus,
  remainingPlanCoversHighPriorityLeads,
  resolveStoredMissionEnvelopeNodes,
  summarizeHandoffPayload,
  type PhaseHandoffPayload,
} from './StartRunPromptHelpers';

export type RequestPlanFeedbackParams = {
  orgId: string;
  runId: string;
  feedback: string;
};

export type RequestPlanFeedbackResult = {
  run: RunRow;
  plannerSessionId: string;
};

type StartRunReplanSessionRepository = {
  setCompleted?: (id: string, completed: boolean) => Promise<boolean>;
  setBlockedReason?: (id: string, reason: string, meta?: Record<string, unknown>) => Promise<boolean>;
  clearBlockedReason?: (id: string, expectedReason?: string) => Promise<boolean>;
};

export type StartRunReplanServiceDeps = {
  runService: RunService;
  agentServices: Pick<AgentApiServices, 'sessionStore' | 'orchestrator'>;
  sessionRepository?: StartRunReplanSessionRepository;
};

export class StartRunReplanService {
  constructor(private readonly deps: StartRunReplanServiceDeps) {}

  async requestPlanFeedback(params: RequestPlanFeedbackParams): Promise<RequestPlanFeedbackResult> {
    const detail = await this.deps.runService.getById(params.orgId, params.runId);
    if (!detail.goal) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'Only goal-based planner runs can request plan feedback',
      );
    }
    if (!isRunAwaitingPlanApproval(detail)) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Run is not awaiting plan approval');
    }
    if (!detail.plannerSessionId) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Planner session is missing. Start a new run instead of revising this one.',
      );
    }

    const plannerSessionId = detail.plannerSessionId;
    const feedbackPrompt = buildPlanFeedbackPrompt(params.feedback.trim());
    const feedbackRequestedAt = detail.updatedAt instanceof Date
      ? detail.updatedAt.getTime()
      : 0;
    const feedbackMessage: Message = {
      id: `plan-feedback:${params.runId}:${feedbackRequestedAt}`,
      role: 'user',
      content: feedbackPrompt,
      timestamp: feedbackRequestedAt,
      metadata: {
        visibility: 'internal',
        source: 'plan_feedback',
      },
    };
    const scheduled = await this.deps.agentServices.sessionStore.recordInputAndStartRequestedAsync?.(
      plannerSessionId,
      feedbackMessage,
      'plan_feedback',
      'operator',
    ) ?? false;
    if (!scheduled) {
      await this.reopenPlannerSessionForRevision(plannerSessionId);
      await this.deps.agentServices.orchestrator.processMessage(
        plannerSessionId,
        feedbackPrompt,
        undefined,
        undefined,
        feedbackMessage.metadata,
      );
    }

    const updatedRun = await this.deps.runService.transitionStatus(
      params.orgId,
      params.runId,
      'running',
    );

    return {
      run: updatedRun,
      plannerSessionId,
    };
  }

  async requestPhaseReplanIfNeeded(params: {
    orgId: string;
    detail: RunRow;
    previousHandoff: RunPhaseRow | null;
    handoffPayload: PhaseHandoffPayload | null;
    handoffInRef: string | null;
    plannedNextPhaseKey: RunPhaseKey;
  }): Promise<RunRow | null> {
    if (!params.previousHandoff) {
      return null;
    }

    let openReplan = false;
    let alreadyAppliedReplan = false;
    try {
      [openReplan, alreadyAppliedReplan] = await Promise.all([
        this.deps.runService.hasOpenPhaseReplan({
          runId: params.detail.id,
          phaseId: params.previousHandoff.id,
        }),
        this.deps.runService.hasAppliedPhaseReplan({
          runId: params.detail.id,
          phaseId: params.previousHandoff.id,
        }),
      ]);
    } catch (error) {
      logger.warn(
        { err: error, runId: params.detail.id, phaseId: params.previousHandoff?.id },
        '[runs] Failed to check phase replan state; suppressing duplicate replan enforcement for this lifecycle tick',
      );
      return params.detail;
    }
    if (openReplan) {
      return params.detail;
    }
    if (alreadyAppliedReplan) {
      return null;
    }

    const replanReasons: string[] = [];
    const ignoredNonReplanReasons: string[] = [];
    const replanRequest = params.handoffPayload?.replanRequest;
    if (replanRequest?.needed === true) {
      const alreadyApplied = await this.deps.runService
        .hasAppliedPhaseReplan({ runId: params.detail.id, phaseId: params.previousHandoff.id })
        .catch((error) => {
          logger.warn(
            { err: error, runId: params.detail.id, phaseId: params.previousHandoff?.id },
            '[runs] Failed to check applied phase replan state',
          );
          return false;
        });
      if (alreadyApplied) {
        ignoredNonReplanReasons.push(
          'ignored already-applied replanRequest from phase handoff; continuing revised approved phase graph',
        );
      } else {
        replanReasons.push(
          replanRequest.reason?.trim() ||
            'The completed phase materially changed the remaining plan assumptions.',
        );
      }
    }

    const rawRecommendedNextPhase = params.handoffPayload?.recommendedNextPhase;
    const recommendedNextPhaseRaw =
      typeof rawRecommendedNextPhase === 'string' ? rawRecommendedNextPhase.trim() : undefined;
    const recommendedNextPhase = normalizePhaseKey(recommendedNextPhaseRaw);
    const ignoredRecommendedNextPhaseReason =
      recommendedNextPhaseRaw && !recommendedNextPhase
        ? `ignored invalid advisory recommendedNextPhase "${recommendedNextPhaseRaw}"; continuing approved next phase "${params.plannedNextPhaseKey}"`
        : recommendedNextPhase && recommendedNextPhase !== params.plannedNextPhaseKey
          ? `ignored advisory recommendedNextPhase "${recommendedNextPhase}"; continuing approved next phase "${params.plannedNextPhaseKey}"`
          : null;

    const validationTargets = Array.isArray(params.handoffPayload?.validationTargets)
      ? params.handoffPayload.validationTargets
      : [];
    if (validationTargets.length > 0 && params.plannedNextPhaseKey === 'reporting') {
      replanReasons.push(
        `handoff provided ${validationTargets.length} validation target(s), but the remaining phase graph skips validation`,
      );
    }

    const missionEnvelopeNodes = attachMissionPhases(resolveStoredMissionEnvelopeNodes(params.detail.missionEnvelope));
    const signals = await this.deps.runService
      .getPhaseDiscoveryReplanSignals({
        orgId: params.orgId,
        scopeId: params.detail.scopeId,
        since: params.previousHandoff.startedAt,
      })
      .catch((error) => {
        logger.warn(
          { err: error, runId: params.detail.id, phaseId: params.previousHandoff?.id },
          '[runs] Failed to compute phase discovery replan signals',
        );
        return {
          newRoutes: 0,
          newParameterizedRoutes: 0,
          newHighPriorityLeads: 0,
          openHighPriorityLeads: 0,
          openHighPriorityLeadFamilies: [],
          priorResourceBlocker: null,
        } satisfies PhaseDiscoveryReplanSignals;
      });

    const remainingCoversHighPriorityLeads = remainingPlanCoversHighPriorityLeads(
      params.plannedNextPhaseKey,
      missionEnvelopeNodes,
      signals,
    );
    if (signals.priorResourceBlocker && signals.newParameterizedRoutes >= 5 && !remainingCoversHighPriorityLeads) {
      replanReasons.push(
        `replan forced: prior resource-endpoint blocker was resolved by ${signals.newParameterizedRoutes} parameterized route(s), but remaining validation missions do not cover the new leads`,
      );
    }
    if (
      (signals.newRoutes >= 20 || signals.newParameterizedRoutes >= 5 || signals.newHighPriorityLeads >= 3) &&
      !remainingCoversHighPriorityLeads
    ) {
      replanReasons.push(
        `replan forced: phase produced plan-changing discovery (newRoutes=${signals.newRoutes}, newParameterizedRoutes=${signals.newParameterizedRoutes}, newHighPriorityLeads=${signals.newHighPriorityLeads}) without matching remaining validation coverage`,
      );
    }

    if (ignoredRecommendedNextPhaseReason) {
      ignoredNonReplanReasons.push(ignoredRecommendedNextPhaseReason);
    }

    if (replanReasons.length === 0) {
      if (ignoredNonReplanReasons.length > 0) {
        await this.deps.runService.recordPhaseHandoffReconciliation({
          runId: params.detail.id,
          phaseId: params.previousHandoff.id,
          phaseKey: params.previousHandoff.phaseKey,
          accepted: [],
          rejected: [],
          injected: [],
          replanned: false,
          reason: Array.from(new Set(ignoredNonReplanReasons)).join('; '),
        }).catch((error) => {
          logger.warn(
            { err: error, runId: params.detail.id, phaseId: params.previousHandoff?.id },
            '[runs] Failed to record ignored phase handoff replan reconciliation',
          );
        });
      }
      return null;
    }

    const phaseStatus = phaseHandoffTerminalStatus(params.handoffPayload);
    const replanReason = Array.from(new Set(replanReasons)).join('; ');
    await this.deps.runService.recordPhaseHandoffReconciliation({
      runId: params.detail.id,
      phaseId: params.previousHandoff.id,
      phaseKey: params.previousHandoff.phaseKey,
      accepted: [],
      rejected: [],
      injected: [],
      replanned: true,
      reason: replanReason,
    }).catch((error) => {
      logger.warn(
        { err: error, runId: params.detail.id, phaseId: params.previousHandoff?.id },
        '[runs] Failed to record phase handoff replan reconciliation',
      );
    });
    const updatedRun = await this.deps.runService.requestPhaseReplan({
      orgId: params.orgId,
      runId: params.detail.id,
      phaseId: params.previousHandoff.id,
      phaseStatus,
      handoffRef: params.handoffInRef,
      reason: replanReason,
    });

    return updatedRun;
  }

  private async reopenPlannerSessionForRevision(
    sessionId: string,
    options: { clearBlockedReason?: boolean } = { clearBlockedReason: true },
  ): Promise<void> {
    const clearBlockedReason = options.clearBlockedReason !== false;
    if (!this.deps.sessionRepository?.setCompleted) {
      throw new Error('durable_planner_reopen_writer_unavailable');
    }
    const completedUpdated = await this.deps.sessionRepository.setCompleted(sessionId, false);
    if (!completedUpdated) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Planner session is missing. Start a new run instead of revising this one.',
      );
    }

    if (clearBlockedReason) {
      if (!this.deps.sessionRepository.clearBlockedReason) {
        throw new Error('durable_planner_block_writer_unavailable');
      }
      const cleared = await this.deps.sessionRepository.clearBlockedReason(sessionId);
      if (!cleared) {
        throw new Error('durable_planner_block_clear_failed');
      }
    }

    const liveSession =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId)) ??
      this.deps.agentServices.sessionStore.get(sessionId);
    if (!liveSession) return;
    this.clearPlannerCompletionState(liveSession, clearBlockedReason);
    await this.deps.agentServices.sessionStore.setAsync(
      sessionId,
      liveSession,
      'plan_feedback.reopen_planner',
    );
  }

  private clearPlannerCompletionState(session: SessionState, clearBlockedReason: boolean): void {
    const nextFlags = { ...(session.flags ?? {}) } as SessionState['flags'] & Record<string, unknown>;
    const sessionFlags = isRecord(nextFlags.session)
      ? { ...nextFlags.session }
      : {};

    delete sessionFlags.completed;
    if (Object.keys(sessionFlags).length > 0) {
      nextFlags.session = sessionFlags;
    } else {
      delete nextFlags.session;
    }
    if (clearBlockedReason) {
      delete nextFlags.blocked_reason;
    }
    delete nextFlags.plannerSubmitRetry;

    session.flags = nextFlags;
    session.completed = false;
    if (clearBlockedReason) {
      session.blockedReason = undefined;
      session.blockedMeta = undefined;
      session.pendingApproval = undefined;
    }
  }

  private async loadPhaseHandoffPayloadForReplan(
    phase: Pick<RunPhaseRow, 'sessionId'>,
    handoffRef: string | null,
  ): Promise<PhaseHandoffPayload | null> {
    if (!phase.sessionId || !handoffRef) {
      return null;
    }

    const phaseSession =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(phase.sessionId)) ??
      this.deps.agentServices.sessionStore.get(phase.sessionId);

    return this.readPhaseArtifactPayload<PhaseHandoffPayload>(
      phaseSession?.workspaceDir,
      handoffRef,
      '.artifacts/phase-handoffs/',
    );
  }

  private async readPhaseArtifactPayload<T extends object>(
    workspaceDir: string | null | undefined,
    artifactRef: string | null | undefined,
    expectedRoot: '.artifacts/phase-handoffs/',
  ): Promise<T | null> {
    if (!workspaceDir || !artifactRef) {
      return null;
    }

    const normalizedRef = artifactRef.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedRef.startsWith(expectedRoot)) {
      return null;
    }

    try {
      const raw = await fs.readFile(path.resolve(workspaceDir, normalizedRef), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as T
        : null;
    } catch {
      return null;
    }
  }

  async dispatchClaimedPhaseReplan(params: {
    run: RunRow;
    phase: RunPhaseRow;
    replan: RunPhaseReplanRow;
  }): Promise<void> {
    const plannerSessionId = params.run.plannerSessionId;
    if (!plannerSessionId) {
      throw new Error('Phase replan cannot dispatch because the run has no planner session.');
    }

    if (params.replan.dispatchAttempts > MAX_OPEN_REPLAN_DISPATCH_ATTEMPTS) {
      throw new Error(`Phase replan exceeded ${MAX_OPEN_REPLAN_DISPATCH_ATTEMPTS} dispatch attempts.`);
    }

    const handoffPayload = await this.loadPhaseHandoffPayloadForReplan(params.phase, params.replan.handoffRef);
    const prompt = buildPhaseReplanPrompt({
      phaseId: params.phase.id,
      phaseKey: params.phase.phaseKey,
      phaseStatus: params.replan.requestedPhaseStatus,
      handoffRef: params.replan.handoffRef,
      replanReason: params.replan.reason ?? 'The completed phase materially changed the remaining plan assumptions.',
      handoffSummary: summarizeHandoffPayload(handoffPayload),
      currentPlan: params.run.plan ?? '',
    });

    const message: Message = {
      id: `phase-replan:${params.replan.id}`,
      role: 'user',
      content: prompt,
      timestamp: params.replan.requestedAt.getTime(),
      metadata: {
        visibility: 'internal',
        source: 'phase_replan_request',
        dispatchSource: 'system_recovery_worker',
        replanId: params.replan.id,
      },
    };
    const scheduled = await this.deps.agentServices.sessionStore
      .recordInternalContinuationInputAsync?.(plannerSessionId, message) ?? false;
    if (!scheduled) {
      await this.reopenPlannerSessionForRevision(plannerSessionId, { clearBlockedReason: false });
      await this.deps.agentServices.orchestrator.processMessage(
        plannerSessionId,
        prompt,
        undefined,
        undefined,
        message.metadata,
      );
    }
  }
}
