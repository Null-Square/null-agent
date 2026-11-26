import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';

import {
  applyTerminal,
  checkSessionTerminal,
} from '@/domains/agent-brain/application/terminal/TerminalActionLayer';

import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';
import { hydrateRemoteEvidenceFiles, requireUserId, resolveToolWorkspaceDir } from './shared';

/**
 * The way a verification run reports its verdict.
 *
 * Without this the loop never closes: the API can start a run, the agent can do
 * the work, and the match stays in `verifying` forever until the recovery pass
 * writes it off as inconclusive. The whole differentiator — turning "you might
 * be affected" into a tested answer — depends on this tool existing.
 *
 * The match is found by the run's own id, not by anything the model supplies.
 *
 * An earlier version read it from `session.flags.vars`, which `StartRunService`
 * never populates — it renders vars into the prompt and nothing more. The tool
 * was registered, unit-tested and completely non-functional at runtime, which is
 * the exact difference between green components and a working system.
 *
 * Binding through `exposure_matches.verification_run_id` fixes that and is
 * strictly better than plumbing vars through: the link is already persisted, it
 * is authoritative, and it makes run ownership a property of the lookup rather
 * than a separate check somebody has to remember.
 */
export const SubmitExposureVerification: ToolImpl = {
  meta: {
    name: 'submit_exposure_verification',
    description:
      'Report the verdict for the single advisory this verification run was started to answer. ' +
      'Use confirmed only when the documented vector reproduced with durable evidence and a negative control. ' +
      'Use not_reproduced when the component was present and testable and the vector did not work here — this is not a claim that the asset is safe, only that the attempt failed. ' +
      'Use inconclusive when a prerequisite was missing, the component could not be confirmed independently, access was blocked, or packaging could not be assessed. ' +
      'The exposure this closes is taken from the run context, not from arguments.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['confirmed', 'not_reproduced', 'inconclusive'],
          description:
            'confirmed = reproduced with evidence and a control; not_reproduced = testable but the documented vector did not work; inconclusive = could not decide.',
        },
        method: {
          type: 'string',
          description:
            'What was actually attempted, grounded in the requests and responses of this run.',
        },
        reason: {
          type: 'string',
          description: 'Short explanation, including any blocker for inconclusive outcomes.',
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: {
          type: 'array',
          description: 'Artifact paths from this run supporting the verdict.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, label: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['outcome', 'method'],
      additionalProperties: false,
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(SubmitExposureVerification.meta, ctx, async () => {
      const userId = requireUserId(ctx);
      if (!userId) {
        return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
      }

      const context = resolveSecurityOpsToolContext(ctx);

      const organizationId = context.organizationId;
      if (!organizationId) {
        return { ok: false, data: { error: 'organizationId is required' } };
      }

      const runId = context.runId;
      if (!runId) {
        return {
          ok: false,
          data: {
            error:
              'This run has no run id, so the exposure it was started for cannot be identified.',
          },
        };
      }

      // A replayed call after the verdict landed returns the original result
      // instead of erroring, so a retry cannot turn a completed run into a
      // failed one.
      const session = ctx.sessionStore.get(ctx.sessionId);
      const alreadyTerminal = session ? checkSessionTerminal(session) : undefined;
      if (alreadyTerminal?.kind === 'exposure_verification_submitted') {
        return {
          ok: true,
          data: {
            success: true,
            alreadySubmitted: true,
            ...(alreadyTerminal.existingResult as Record<string, unknown>),
            terminal: true,
            nextAction: 'stop',
          },
        };
      }

      const service = getSecurityOpsService(ctx);

      try {
        // Worker sandboxes keep evidence off the API host, so it has to be
        // pulled local before the resolver can stat it — same as every other
        // reporting tool that accepts evidence.
        await hydrateRemoteEvidenceFiles(ctx, args);

        const result = await service.submitExposureVerification({
          organizationId,
          runId,
          userId,
          sessionId: ctx.sessionId,
          workspaceDir: resolveToolWorkspaceDir(ctx, session),
          outcome: args.outcome as 'confirmed' | 'not_reproduced' | 'inconclusive',
          method: String(args.method ?? ''),
          reason: typeof args.reason === 'string' ? args.reason : null,
          confidence: typeof args.confidence === 'number' ? args.confidence : null,
          evidence: Array.isArray(args.evidence)
            ? (args.evidence as Array<{ path: string; label?: string }>)
            : [],
        });

        const payload = {
          success: true,
          exposureMatchId: result.exposureMatchId,
          state: result.state,
          riskId: result.riskId ?? null,
        };

        // `terminal: true` in the payload only tells the model to stop. Ending
        // the session is a platform action, and without it the automation engine
        // keeps driving this run-bound planner toward `submit_plan` — which its
        // own policy denies — until the run ends blocked rather than completed.
        if (session) {
          await applyTerminal(session, ctx, 'exposure_verification_submitted', payload);
        }

        return {
          ok: true,
          data: { ...payload, terminal: true, nextAction: 'stop' },
        };
      } catch (error) {
        return {
          ok: false,
          data: { error: error instanceof Error ? error.message : 'Failed to submit verification' },
        };
      }
    });
  },
};
