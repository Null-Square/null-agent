import { promises as fs } from 'fs';

import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';

import {
  closeSessionPlanForHandoff,
  evaluatePhaseHandoffGates,
  formatToolError,
  getString,
  materializeValidationTargets,
  phaseCheckpointSchema,
  phaseHandoffSchema,
  phaseRepo,
  recordPhaseHandoffGateFailure,
  uniqueLinks,
  writePhaseArtifact
} from './shared';

export const SubmitPhaseHandoff: ToolImpl = {
  meta: {
    name: 'submit_phase_handoff',
    description:
      'Submit the structured handoff that closes the current first-class run phase. This persists a narrow transition payload for the next phase and terminalizes the current phase session.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        phaseId: { type: 'string' },
        phase: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        summary: { type: 'string' },
        completedObjectives: { type: 'array', items: { type: 'string' } },
        unresolvedQuestions: { type: 'array', items: { type: 'string' } },
        artifacts: { type: 'array', items: { type: 'string' } },
        canonicalWrites: {
          type: 'object',
          properties: {
            notes: { type: 'array', items: { type: 'string' } },
            findings: { type: 'array', items: { type: 'string' } },
            assets: { type: 'array', items: { type: 'string' } },
            services: { type: 'array', items: { type: 'string' } },
          },
        },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        validationQueue: { type: 'array', items: { type: 'string' } },
        validationTargets: { type: 'array', items: { type: 'object' } },
        scannerIngestWaivers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              parser: { type: 'string' },
              artifactPath: { type: 'string' },
              reason: { type: 'string' },
              nextStep: { type: 'string' },
            },
            required: ['artifactPath', 'reason', 'nextStep'],
          },
        },
        recommendedNextPhase: {
          type: 'string',
          enum: ['recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting'],
          description: 'Optional canonical next phase. Omit this field for terminal reporting closeout; do not send an empty string.',
        },
        recommendedNextSkills: { type: 'array', items: { type: 'string' } },
        closeoutOutcome: {
          type: 'string',
          enum: ['no_findings_after_coverage', 'interim_blocked', 'needs_operator_input'],
        },
        replanRequest: {
          type: 'object',
          properties: {
            needed: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['needed'],
        },
        operatorActionRequired: {
          type: 'object',
          properties: {
            needed: { type: 'boolean' },
            request: { type: 'string' },
          },
          required: ['needed'],
        },
      },
      required: ['status', 'summary'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitPhaseHandoff.meta,
      ctx,
      async () => {
        try {
          const session = ctx.sessionStore.get(ctx.sessionId);
          const securityops =
            session?.flags && typeof session.flags.securityops === 'object' && session.flags.securityops !== null
              ? session.flags.securityops as Record<string, unknown>
              : undefined;
          const terminal = checkSessionTerminal(session);
          if (session && terminal.kind === 'phase_handoff_submitted') {
            if (!terminal.completionRecorded) {
              await applyTerminal(session, ctx, 'phase_handoff_submitted', terminal.existingResult);
            }
            const existing = terminal.existingResult as Record<string, unknown> | undefined;
            return {
              ok: true,
              data: {
                success: true,
                alreadySubmitted: true,
                terminal: true,
                handoffAccepted: true,
                phaseId: getString(existing?.phaseId) ?? getString(securityops?.activePhaseId),
                phase: getString(existing?.phase) ?? getString(securityops?.activePhaseKey),
                status: getString(existing?.status) ?? getString(securityops?.phaseHandoffStatus),
                handoffRef: getString(existing?.handoffRef) ?? getString(securityops?.phaseHandoffRef),
                nextAction: 'stop',
              },
            };
          }
          const existingHandoffRef = getString(securityops?.phaseHandoffRef);
          if (securityops?.phaseHandoffSubmitted === true && existingHandoffRef) {
            const existingPhase = getString(securityops.activePhaseKey);
            const existingReportingHandoff = existingPhase?.toLowerCase() === 'reporting';
            return {
              ok: true,
              data: {
                success: true,
                alreadySubmitted: true,
                terminal: !existingReportingHandoff,
                handoffAccepted: true,
                phaseId: getString(securityops.activePhaseId),
                phase: existingPhase,
                status: getString(securityops.phaseHandoffStatus),
                handoffRef: existingHandoffRef,
                nextAction: existingReportingHandoff ? 'call finalize_run_artifacts' : 'stop',
              },
            };
          }
          const parsed = phaseHandoffSchema.parse(args);
          const hostedContext = resolveSecurityOpsToolContext(ctx);
          const hostedRun = hostedContext.runHost === 'research_lab'
            ? getHostedRunPersistencePort(hostedContext.runId)
            : null;
          if (hostedRun) {
            const activePhase = await hostedRun.findActivePhaseBySessionId(ctx.sessionId);
            if (!activePhase) {
              return {
                ok: false,
                data: { error: 'submit_phase_handoff requires an active hosted run phase for this session' },
              };
            }
            if (parsed.phaseId && parsed.phaseId !== activePhase.id) {
              return {
                ok: false,
                data: { error: `phaseId must match the active hosted phase ${activePhase.id}` },
              };
            }
            if (parsed.phase && parsed.phase.trim().toLowerCase() !== activePhase.phaseKey) {
              return {
                ok: false,
                data: { error: `phase must match the active hosted phase ${activePhase.phaseKey}` },
              };
            }
            const liveWorkerTasks = (session?.workerTasks ?? []).filter((task) =>
              !['blocked', 'completed', 'failed', 'cancelled'].includes(task.status));
            if (liveWorkerTasks.length > 0) {
              return {
                ok: false,
                data: {
                  error: `${liveWorkerTasks.length} delegated worker task(s) are still live`,
                  workerTaskIds: liveWorkerTasks.map((task) => task.taskId),
                },
              };
            }
            const payload = {
              schemaVersion: activePhase.handoffSchemaVersion,
              phaseId: activePhase.id,
              phase: activePhase.phaseKey,
              runId: activePhase.runId,
              sessionId: ctx.sessionId,
              submittedAt: new Date().toISOString(),
              ...parsed,
            };
            const result = await hostedRun.submitPhaseHandoff({
              runId: hostedRun.runId,
              phaseId: activePhase.id,
              phaseKey: activePhase.phaseKey,
              sessionId: ctx.sessionId,
              payload,
            });
            if (session) {
              session.flags = {
                ...(session.flags ?? {}),
                securityops: {
                  ...(securityops ?? {}),
                  activePhaseId: activePhase.id,
                  activePhaseKey: activePhase.phaseKey,
                  phaseHandoffSubmitted: true,
                  phaseHandoffRef: result.handoffRef,
                  phaseHandoffStatus: result.status,
                },
              };
              await applyTerminal(session, ctx, 'phase_handoff_submitted', {
                phaseId: activePhase.id,
                phase: activePhase.phaseKey,
                status: result.status,
                handoffRef: result.handoffRef,
              });
            }
            return {
              ok: true,
              data: {
                success: true,
                runId: hostedRun.runId,
                phaseId: activePhase.id,
                phase: activePhase.phaseKey,
                status: result.status,
                handoffRef: result.handoffRef,
                handoffAccepted: true,
                nextAction: 'stop',
              },
            };
          }
          const activePhase = await phaseRepo.findActiveBySessionId(ctx.sessionId);
          const gateFailures = await evaluatePhaseHandoffGates(ctx, parsed, activePhase, { collectAll: false });
          if (gateFailures.length > 0) {
            const gate = gateFailures[0]!;
            const gateState = await recordPhaseHandoffGateFailure(ctx, SubmitPhaseHandoff.meta.name, gate, parsed);
            return {
              ok: false,
              data: {
                error: gate.message,
                gate,
                ...(gateState ? {
                  gateFailureCount: gateState.count,
                  circuitBreaker: gateState.circuitBreaker,
                } : {}),
              },
            };
          }
          if (!activePhase) {
            return { ok: false, data: { error: 'submit_phase_handoff requires an active run phase for this session' } };
          }

          const payload = {
            schemaVersion: activePhase.handoffSchemaVersion,
            phaseId: activePhase.id,
            phase: activePhase.phaseKey,
            runId: activePhase.runId,
            sessionId: ctx.sessionId,
            submittedAt: new Date().toISOString(),
            ...parsed,
          };
          const artifact = await writePhaseArtifact(ctx.workspaceDir, 'phase-handoffs', activePhase.id, payload);
          const materializedValidationLeadNoteIds = await materializeValidationTargets(ctx, {
            phaseKey: activePhase.phaseKey,
            handoffRef: artifact.relativePath,
            validationTargets: parsed.validationTargets,
          });
          if (materializedValidationLeadNoteIds.length > 0) {
            payload.canonicalWrites = {
              ...payload.canonicalWrites,
              notes: uniqueLinks([
                ...payload.canonicalWrites.notes,
                ...materializedValidationLeadNoteIds,
              ]),
            };
            await fs.writeFile(artifact.absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
          }
          await phaseRepo.updateStatus({
            phaseId: activePhase.id,
            status: parsed.status,
            handoffOutRef: artifact.relativePath,
            ...(parsed.status !== 'completed' ? { lastError: parsed.summary } : {}),
          });
          await closeSessionPlanForHandoff(ctx, activePhase, parsed.status, parsed.summary, artifact.relativePath);
          if (session) {
            // Closing the phase plan may replace the cached session object. Reacquire
            // it before writing the terminal handoff projection so completion and
            // handoff flags cannot split across stale and current cache instances.
            const terminalSession = ctx.sessionStore.get(ctx.sessionId) ?? session;
            const terminalSecurityOps =
              terminalSession.flags && typeof terminalSession.flags.securityops === 'object'
                && terminalSession.flags.securityops !== null
                ? terminalSession.flags.securityops as Record<string, unknown>
                : undefined;
            terminalSession.flags = {
              ...(terminalSession.flags ?? {}),
              securityops: {
                ...(terminalSecurityOps ?? {}),
                activePhaseId: activePhase.id,
                activePhaseKey: activePhase.phaseKey,
                phaseHandoffSubmitted: true,
                phaseHandoffRef: artifact.relativePath,
                phaseHandoffStatus: parsed.status,
                phaseReplanRequested: parsed.replanRequest?.needed === true,
                ...(parsed.replanRequest?.reason ? { phaseReplanReason: parsed.replanRequest.reason } : {}),
                ...(parsed.closeoutOutcome ? { phaseCloseoutOutcome: parsed.closeoutOutcome } : {}),
              },
            };
            if (activePhase.phaseKey === 'reporting') {
              await ctx.sessionStore.setAsync(ctx.sessionId, terminalSession, 'securityops.phase_handoff_submitted');
            } else {
              await applyTerminal(terminalSession, ctx, 'phase_handoff_submitted', {
                phaseId: activePhase.id,
                phase: activePhase.phaseKey,
                status: parsed.status,
                handoffRef: artifact.relativePath,
              });
            }
          }

          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: {
              success: true,
              runId: resolveSecurityOpsToolContext(ctx).runId ?? activePhase.runId,
              phaseId: activePhase.id,
              phase: activePhase.phaseKey,
              status: parsed.status,
              handoffRef: artifact.relativePath,
              materializedValidationLeadNoteIds,
              handoffAccepted: true,
              },
              reason: 'submit_phase_handoff',
              scopes: ['leads', 'coverage', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      {},
    );
  },
};

export const SubmitPhaseCheckpoint: ToolImpl = {
  meta: {
    name: 'submit_phase_checkpoint',
    description:
      'Persist a lightweight checkpoint for a long-running or partially complete phase without completing the phase.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        phaseId: { type: 'string' },
        phase: { type: 'string' },
        sessionId: { type: 'string' },
        summary: { type: 'string' },
        completedObjectives: { type: 'array', items: { type: 'string' } },
        pendingObjectives: { type: 'array', items: { type: 'string' } },
        canonicalWrites: {
          type: 'object',
          properties: {
            notes: { type: 'array', items: { type: 'string' } },
            findings: { type: 'array', items: { type: 'string' } },
            assets: { type: 'array', items: { type: 'string' } },
            services: { type: 'array', items: { type: 'string' } },
          },
        },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        nextSuggestedAction: { type: 'string' },
      },
      required: ['summary'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitPhaseCheckpoint.meta,
      ctx,
      async () => {
        try {
          const parsed = phaseCheckpointSchema.parse(args);
          const activePhase = await phaseRepo.findActiveBySessionId(ctx.sessionId);
          if (!activePhase) {
            return { ok: false, data: { error: 'submit_phase_checkpoint requires an active run phase for this session' } };
          }
          if (parsed.phaseId && parsed.phaseId !== activePhase.id) {
            return { ok: false, data: { error: `phaseId does not match active phase ${activePhase.id}` } };
          }
          if (parsed.phase && parsed.phase !== activePhase.phaseKey) {
            return { ok: false, data: { error: `phase does not match active phase ${activePhase.phaseKey}` } };
          }
          if (parsed.sessionId && parsed.sessionId !== ctx.sessionId) {
            return { ok: false, data: { error: `sessionId does not match current session ${ctx.sessionId}` } };
          }

          const payload = {
            phaseId: activePhase.id,
            phase: activePhase.phaseKey,
            runId: activePhase.runId,
            sessionId: ctx.sessionId,
            createdAt: new Date().toISOString(),
            ...parsed,
          };
          const artifact = await writePhaseArtifact(ctx.workspaceDir, 'phase-checkpoints', activePhase.id, payload);
          await phaseRepo.updateStatus({
            phaseId: activePhase.id,
            status: 'active',
            checkpointRef: artifact.relativePath,
          });

          return {
            ok: true,
            data: {
              success: true,
              runId: resolveSecurityOpsToolContext(ctx).runId ?? activePhase.runId,
              phaseId: activePhase.id,
              phase: activePhase.phaseKey,
              checkpointRef: artifact.relativePath,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      {},
    );
  },
};

