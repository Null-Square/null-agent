/**
 * ReconcileStage - Reconcile plan after turn
 * @module agent-brain/application/orchestration/stages/ReconcileStage
 */

import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import { isResumablePlanBlockReason } from '../../../domain/helpers/PlanState';
import type {
  ReconcileStage,
  ReconcilePlanArgs,
  ReconcilePlanResult,
} from './types';

const pipelineLogger = logger.child({ scope: 'OrchestratorPipeline' });

export class DefaultReconcileStage implements ReconcileStage {
  async run(args: ReconcilePlanArgs): Promise<ReconcilePlanResult> {
    const log = pipelineLogger.child({ sessionId: args.sessionId });
    const session = args.sessionStore.get(args.sessionId);
    if (!session || !Array.isArray(session.plan) || session.plan.length === 0) {
      return { pendingSteps: [] };
    }

    if (args.turnStatus === 'max_tool_calls') {
      const resumableSteps = session.plan.filter(
        (step) =>
          step.status === 'pending' ||
          step.status === 'running' ||
          (step.status === 'blocked' && isResumablePlanBlockReason(step.blockedReason)),
      );
      return { pendingSteps: resumableSteps };
    }

    if (args.turnStatus !== 'completed' || args.initialPendingPlanStepIds.size === 0) {
      return { pendingSteps: [] };
    }

    const pendingStill = session.plan.filter(
      (step) => args.initialPendingPlanStepIds.has(step.id) && step.status === 'pending',
    );

    if (pendingStill.length === 0) {
      return { pendingSteps: [] };
    }

    const pendingStepIds = pendingStill.map((step) => step.id);
    const message = `Plan assertion: ${pendingStill.length} step(s) remained pending at end of turn ${args.turnNumber} `;

    args.stream.raw('plan_warning', {
      turn: args.turnNumber,
      pendingStepIds,
      pendingSteps: pendingStill.map((step) => ({ id: step.id, title: step.title })),
      message,
    });

    log.warn({ pendingStepIds }, '[AI Agent] Pending plan steps remain at end of turn');

    if (args.recorder) {
      await args.recorder.write(args.sessionId, args.turnNumber, {
        event: 'plan.assertion.pending',
        severity: 'warn',
        payload: {
          pendingStepIds,
          pendingSteps: pendingStill,
        },
        note: summarizeForNote(pendingStepIds.join(', ') || 'pending plan steps'),
      });
    }

    return { pendingSteps: pendingStill };
  }
}
