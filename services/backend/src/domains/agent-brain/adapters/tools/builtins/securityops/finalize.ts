
import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';

import {
  buildSecurityOpsRelatedIds,
  emitSecurityOpsTimeline,
  formatToolError,
  getSecurityOpsFlags,
  getString,
  isRecord,
  markPhaseFinalizedFromFlags,
  phaseToolGuardError,
  pickToolArgsPreview,
  recordRunCompletion,
  requireUserId,
  resolveToolWorkspaceDir,
  summarizeFinalizeRunArtifactsResult,
  summarizePrepareReportContextResult,
  summarizeReportFinalizerPreflightResult,
  uniqueStrings
} from './shared';

export const FinalizeRunArtifacts: ToolImpl = {
  meta: {
    name: 'finalize_run_artifacts',
    description:
      'Restricted to the dedicated reporting phase session. Validates authored summary.md and report.md, records RunCompletion, and publishes closeout artifacts. This tool does not write report prose. Mandatory order inside the reporting phase: (1) report_finalizer_preflight, (2) prepare_report_context, (3) file_write summary.md and report.md, (4) submit_phase_handoff for the reporting phase, (5) finalize_run_artifacts. Calls outside the reporting phase, or before submit_phase_handoff, are rejected.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['final', 'interim'], default: 'final' },
        reason: {
          type: 'string',
          description: 'Required when mode is interim; optional context for final closeout.',
        },
      },
      required: [],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      FinalizeRunArtifacts.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const session = getSessionFromContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx, session);
        const securityopsFlags = getSecurityOpsFlags(session);
        const shellJobs = isRecord(session?.flags?.shellJobs) ? session.flags.shellJobs : undefined;
        const reportedFindingIds = Array.isArray(securityopsFlags?.reportedFindingIds)
          ? uniqueStrings(securityopsFlags.reportedFindingIds)
          : [];
        const previousRunCompletion = isRecord(securityopsFlags?.runCompletion)
          ? securityopsFlags.runCompletion
          : undefined;
        try {
          const terminal = checkSessionTerminal(session);
          if (terminal.kind === 'run_finalized') {
            if (session && !terminal.completionRecorded) {
              await applyTerminal(session, ctx, 'run_finalized', terminal.existingResult);
            }
            const existing = terminal.existingResult as Record<string, unknown> | undefined;
            return {
              ok: true,
              data: {
                success: true,
                alreadySubmitted: true,
                terminal: true,
                mode:
                  existing?.mode === 'interim' || existing?.mode === 'final'
                    ? existing.mode
                    : 'final',
                runCompletionState: 'completed',
                finalized: true,
                finalizedAt: getString(existing?.finalizedAt) ?? getString(securityopsFlags?.artifactsFinalizedAt),
                nextAction: 'stop',
              },
            };
          }
          const phaseError = await phaseToolGuardError(securityopsFlags, {
            requireReportingHandoff: true,
            runId: context.runId,
          });
          if (phaseError) {
            return { ok: false, data: { error: phaseError } };
          }
          let finalizedSecurityOpsFlags = securityopsFlags;
          if (
            session &&
            getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase() === 'reporting' &&
            securityopsFlags?.phaseHandoffSubmitted !== true
          ) {
            // phaseToolGuardError only reaches here after the authoritative DB
            // handoff fallback succeeds. Repair the stale session projection so
            // phase closeout, terminal state, and recovery all see one truth.
            finalizedSecurityOpsFlags = {
              ...(securityopsFlags ?? {}),
              phaseHandoffSubmitted: true,
            };
            session.flags = {
              ...(session.flags ?? {}),
              securityops: finalizedSecurityOpsFlags,
            };
            await ctx.sessionStore.setAsync(
              session.id,
              session,
              'securityops.reporting_handoff_reconciled',
            );
          }
          const result = await service.finalizeRunArtifacts({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
            plan: session?.plan,
            reportedFindingIds,
            shellJobs,
            alreadyFinalized:
              previousRunCompletion?.state === 'completed' ||
              typeof securityopsFlags?.finalizedAt === 'string',
            finalizedMode:
              securityopsFlags?.finalizedMode === 'interim' || securityopsFlags?.finalizedMode === 'final'
                ? securityopsFlags.finalizedMode
                : undefined,
          });
          await markPhaseFinalizedFromFlags(finalizedSecurityOpsFlags, result.mode);
          await recordRunCompletion(ctx, result);
          if (session) {
            await applyTerminal(session, ctx, 'run_finalized', result);
          }
          emitSecurityOpsTimeline(ctx, {
            kind: 'artifact',
            status: 'success',
            title: result.mode === 'final' ? 'Final report finalized' : 'Interim report finalized',
            detail: `authored summary.md and report.md validated`,
            importance: result.mode === 'final' ? 'high' : 'medium',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: summarizeFinalizeRunArtifactsResult(result) as Record<string, unknown>,
              reason: 'finalize_run_artifacts',
              scopes: ['model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['mode', 'reason']),
    );
  },
};


export const ReportFinalizerPreflight: ToolImpl = {
  meta: {
    name: 'report_finalizer_preflight',
    description:
      'Restricted to the dedicated reporting phase session. Run before drafting summary.md or report.md. Writes .artifacts/report/finalizer-preflight.json and returns candidate/reportable counts, durable evidence blockers, required final/interim mode, exact compliance boundary wording, export expectations, and whether finalize_run_artifacts(mode="final") can pass from current canonical state.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        intendedMode: {
          type: 'string',
          enum: ['final', 'interim'],
          description: 'Optional mode to validate if authored files already exist; omitted means use the computed required mode.',
        },
        checkAuthoredFiles: {
          type: 'boolean',
          default: false,
          description: 'Set true only after summary.md/report.md are authored to include authored artifact validation in the preflight.',
        },
      },
      required: [],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportFinalizerPreflight.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const session = getSessionFromContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx, session);
        const securityopsFlags = getSecurityOpsFlags(session);
        const shellJobs = isRecord(session?.flags?.shellJobs) ? session.flags.shellJobs : undefined;
        const reportedFindingIds = Array.isArray(securityopsFlags?.reportedFindingIds)
          ? uniqueStrings(securityopsFlags.reportedFindingIds)
          : [];
        const previousRunCompletion = isRecord(securityopsFlags?.runCompletion)
          ? securityopsFlags.runCompletion
          : undefined;
        try {
          const phaseError = await phaseToolGuardError(securityopsFlags);
          if (phaseError) {
            return { ok: false, data: { error: phaseError } };
          }
          const result = await service.reportFinalizerPreflight({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
            plan: session?.plan,
            reportedFindingIds,
            shellJobs,
            alreadyFinalized:
              previousRunCompletion?.state === 'completed' ||
              typeof securityopsFlags?.finalizedAt === 'string',
          });
          const findingWarnings = Array.isArray(result.findingWarnings) ? result.findingWarnings : [];
          emitSecurityOpsTimeline(ctx, {
            kind: 'artifact',
            status: 'success',
            title: 'Report finalizer preflight',
            detail: `required mode: ${result.requiredMode}; final ready: ${result.canFinalizeFinal ? 'yes' : 'no'}`,
            importance: result.canFinalizeFinal ? 'medium' : 'high',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          if (ctx.trace) {
            void ctx.trace
              .write(ctx.sessionId, ctx.turnNumber ?? 0, {
                event: 'report.finalizer_preflight',
                severity: result.canFinalizeFinal ? 'info' : 'warn',
                payload: {
                  canFinalizeFinal: result.canFinalizeFinal,
                  requiredMode: result.requiredMode,
                  runCompletionState: result.runCompletion.state,
                  blockerCount: result.finalizerBlockers.length,
                  missingReportFieldBlockerCount: Array.isArray(result.missingReportFieldBlockers)
                    ? result.missingReportFieldBlockers.length
                    : 0,
                  preflightPath: result.preflightPath,
                },
                note: `report finalizer preflight selected ${result.requiredMode}`,
              })
              .catch(() => {});
          }
          if (session) {
            session.flags = {
              ...(session.flags ?? {}),
              securityops: {
                ...(isRecord(session.flags?.securityops) ? session.flags.securityops : {}),
                findingCount: result.findingCount,
                reportableFindingCount: result.reportableCount,
                candidateFindingCount: result.candidateCount,
                validatingFindingCount: result.validatingCount,
                runCompletion: result.runCompletion,
                reportFinalizerPreflight: {
                  canFinalizeFinal: result.canFinalizeFinal,
                  canFinalizeInterim: result.canFinalizeInterim,
                  requiredMode: result.requiredMode,
                  intendedMode: result.intendedMode,
                  runCompletionState: result.runCompletion.state,
                  preflightPath: result.preflightPath,
                  findingWarningCount: findingWarnings.length,
                  missingReportFieldBlockerCount: Array.isArray(result.missingReportFieldBlockers)
                    ? result.missingReportFieldBlockers.length
                    : 0,
                  blockerCount: result.finalizerBlockers.length,
                },
              },
            };
            await ctx.sessionStore.setAsync(ctx.sessionId, session, 'securityops.report_finalizer_preflight_recorded');
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: summarizeReportFinalizerPreflightResult(result) as Record<string, unknown>,
              reason: 'report_finalizer_preflight',
              scopes: ['findings', 'evidence', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['intendedMode', 'checkAuthoredFiles']),
    );
  },
};


export const PrepareReportContext: ToolImpl = {
  meta: {
    name: 'prepare_report_context',
    description:
      'Restricted to the dedicated reporting phase session. Writes .artifacts/report/brief.md and .artifacts/report/context.json with canonical findings, notes, evidence, plan state, and scanner summaries so the reporter can manually author summary.md and report.md. Calls from non-reporting phases are rejected. Run after report_finalizer_preflight and before any file_write or finalize_run_artifacts.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          default: 'brief',
          description: 'Use full only when the reporter needs raw note payloads in context.json.',
        },
      },
      required: [],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      PrepareReportContext.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const session = getSessionFromContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx, session);
        const securityopsFlags = getSecurityOpsFlags(session);
        const shellJobs = isRecord(session?.flags?.shellJobs) ? session.flags.shellJobs : undefined;
        const reportedFindingIds = Array.isArray(securityopsFlags?.reportedFindingIds)
          ? uniqueStrings(securityopsFlags.reportedFindingIds)
          : [];
        const previousRunCompletion = isRecord(securityopsFlags?.runCompletion)
          ? securityopsFlags.runCompletion
          : undefined;
        try {
          const phaseError = await phaseToolGuardError(securityopsFlags);
          if (phaseError) {
            return { ok: false, data: { error: phaseError } };
          }
          const result = await service.prepareReportContext({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
            plan: session?.plan,
            reportedFindingIds,
            shellJobs,
            alreadyFinalized:
              previousRunCompletion?.state === 'completed' ||
              typeof securityopsFlags?.finalizedAt === 'string',
          });
          emitSecurityOpsTimeline(ctx, {
            kind: 'artifact',
            status: 'success',
            title: 'Report context prepared',
            detail: `.artifacts/report/brief.md and context.json are ready for authored reporting`,
            importance: 'medium',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          if (session) {
            session.flags = {
              ...(session.flags ?? {}),
              securityops: {
                ...(isRecord(session.flags?.securityops) ? session.flags.securityops : {}),
                findingCount: result.findingCount,
                reportableFindingCount: result.reportableFindingCount,
                candidateFindingCount: result.candidateFindingCount,
                validatingFindingCount: result.validatingFindingCount,
                runCompletion: result.runCompletion,
              },
            };
            await ctx.sessionStore.setAsync(ctx.sessionId, session, 'securityops.prepare_report_context_recorded');
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: summarizePrepareReportContextResult(result) as Record<string, unknown>,
              reason: 'prepare_report_context',
              scopes: ['findings', 'evidence', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['detail']),
    );
  },
};

