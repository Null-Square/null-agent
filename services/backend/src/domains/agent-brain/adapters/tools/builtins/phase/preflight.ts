
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import {
  normalizePhaseKey,
  type RunPhaseKey
} from '@/domains/security-ops/runs/PhaseProfileRegistry';

import {
  buildHandoffPayloadSkeleton,
  buildPhaseHandoffPreflightSchema,
  buildPreflightDraft,
  CANONICAL_PHASE_KEYS,
  derivePhaseState,
  collectScannerDebtState,
  evaluatePhaseHandoffGates,
  formatToolError,
  getSecurityOpsFlags,
  listCompatibleSkillSlugs,
  phaseHandoffPreflightSchema,
  phaseRepo,
  readSecurityOpsFlagNumber
} from './shared';

const buildPhaseHandoffPreflightTool = (
  phaseKey: Exclude<RunPhaseKey, 'planning'>,
): ToolImpl => {
  const toolName = `${phaseKey}_handoff_preflight`;
  const tool: ToolImpl = {
    meta: {
      name: toolName,
      description:
        `Dry-run the ${phaseKey} phase handoff gates before calling submit_phase_handoff. Returns typed gate failures, current debts, and a safe payload skeleton without closing the phase.`,
      category: 'securityops',
      schema: buildPhaseHandoffPreflightSchema(phaseKey),
      risks: ['read'],
      returns: 'json',
    },

    async run(args, ctx: ToolContext) {
      return runWithGuards(
        tool.meta,
        ctx,
        async () => {
          try {
            const input = phaseHandoffPreflightSchema.parse(args);
            const activePhase = await phaseRepo.findActiveBySessionId(ctx.sessionId);
            const draft = buildPreflightDraft(phaseKey, input, activePhase);
            const failures = await evaluatePhaseHandoffGates(ctx, draft, activePhase, { collectAll: true });
            const targetPhase = normalizePhaseKey(draft.recommendedNextPhase) ?? phaseKey;
            // D9 - one canonical answer, so the model does not spend model calls
            // rediscovering a state that is a pure function of records already held.
            const derivedState = await derivePhaseState(
              ctx,
              phaseKey,
              failures.map((failure) => failure.code),
            );
            const securityops = getSecurityOpsFlags(ctx);
            const openValidationLeadIds = Array.isArray(securityops.openValidationLeadIds)
              ? securityops.openValidationLeadIds.filter((id): id is string => typeof id === 'string')
              : [];

            return {
              ok: true,
              data: {
                success: true,
                toolName,
                phase: phaseKey,
                activePhase: activePhase
                  ? {
                    phaseId: activePhase.id,
                    phase: activePhase.phaseKey,
                    runId: activePhase.runId,
                  }
                  : null,
                intendedStatus: draft.status,
                canSubmit: failures.length === 0,
                derivedPhaseState: derivedState,
                failures,
                failureCodes: failures.map((failure) => failure.code),
                submitTool: 'submit_phase_handoff',
                scannerIngest: collectScannerDebtState(ctx, draft.scannerIngestWaivers),
                openValidationLeadIds,
                reportingFindingCounts: {
                  candidateFindingCount: readSecurityOpsFlagNumber(ctx, 'candidateFindingCount'),
                  reportableFindingCount: readSecurityOpsFlagNumber(ctx, 'reportableFindingCount'),
                },
                allowedNextPhases: CANONICAL_PHASE_KEYS.filter((phase) => phase !== 'planning'),
                compatibleRecommendedNextSkills: await listCompatibleSkillSlugs(targetPhase),
                handoffPayloadSkeleton: buildHandoffPayloadSkeleton(phaseKey, activePhase),
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
  return tool;
};

export const ReconHandoffPreflight = buildPhaseHandoffPreflightTool('recon');
export const EnumerationHandoffPreflight = buildPhaseHandoffPreflightTool('enumeration');
export const ValidationHandoffPreflight = buildPhaseHandoffPreflightTool('validation');
export const EvidenceHandoffPreflight = buildPhaseHandoffPreflightTool('evidence');
export const ControlAssessmentHandoffPreflight = buildPhaseHandoffPreflightTool('control_assessment');
export const ReportingHandoffPreflight = buildPhaseHandoffPreflightTool('reporting');

