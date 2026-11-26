
import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { parseAssignedSkillsFromExtraContext } from '@/domains/agent-brain/domain/workers/delegationActivation';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { skillOutcomeTotal } from '@/shared/metrics/prometheusMetrics';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';

import {
  buildSecurityOpsRelatedIds,
  completeValidationQueueFinding,
  emitSecurityOpsTimeline,
  formatToolError,
  getSecurityOpsFlags,
  getString,
  hydrateRemoteEvidenceFiles,
  isRecord,
  pickToolArgsPreview,
  queueValidationPhaseFinding,
  recordPromotedFinding,
  requireUserId,
  resolveToolWorkspaceDir,
  spawnValidationWorkerForFinding
} from './shared';

const recordSkillOutcomeMetrics = (
  session: ReturnType<typeof getSessionFromContext>,
  outcome: string,
): void => {
  const assigned = parseAssignedSkillsFromExtraContext(session?.extraContext);
  const versions = new Map(
    Object.entries(assigned.versions).map(([slug, versionHash]) => [
      slug,
      { slug, versionHash },
    ]),
  );
  const onDemand = isRecord(session?.flags?.skill_on_demand_loads)
    ? session?.flags?.skill_on_demand_loads.skills
    : [];
  if (Array.isArray(onDemand)) {
    for (const raw of onDemand) {
      if (!isRecord(raw)) continue;
      const slug = getString(raw.slug)?.trim().toLowerCase();
      const versionHash = getString(raw.versionHash)?.trim().toLowerCase();
      if (slug && versionHash && /^[a-f0-9]{64}$/.test(versionHash)) {
        versions.set(slug, { slug, versionHash });
      }
    }
  }
  for (const entry of versions.values()) {
    skillOutcomeTotal.inc({
      slug: entry.slug,
      version_hash: entry.versionHash,
      outcome,
    });
  }
};

export const PromoteFinding: ToolImpl = {
  meta: {
    name: 'promote_finding',
    description:
      'Move a potential Risk to verifying only after durable evidence satisfies the reportable gate. Durable evidence means structured http_exchange proof or a real non-missing artifact path. If an equivalent reportable Risk already exists, attach new evidence to that row with report_finding(validatesFindingId=...) instead. The Risk is not reportable until submit_validation_outcome moves it to confirmed. Use submit_validation_lead_outcome only for validation.lead notes, not candidate Risks.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        findingId: { type: 'string', description: 'Candidate finding ID returned by report_finding.' },
        to: { type: 'string', enum: ['reportable'], default: 'reportable' },
        rationale: {
          type: 'string',
          description: 'Short explanation of why the evidence satisfies the reportable gate.',
        },
      },
      required: ['findingId'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      PromoteFinding.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.promoteFinding({
            userId,
            context,
            input: args,
          });
          const rationale = isRecord(args) ? getString(args.rationale) : undefined;
          const validationQueue =
            'validationPending' in result
              ? await queueValidationPhaseFinding(ctx, result.findingId, rationale)
              : undefined;
          const validationWorker =
            'validationPending' in result && validationQueue?.queued !== true
              ? await spawnValidationWorkerForFinding(ctx, result.findingId, rationale)
              : undefined;
          if (result.lifecycleStage === 'reportable') {
            await recordPromotedFinding(ctx, result.findingId);
          }
          emitSecurityOpsTimeline(ctx, {
            kind: 'securityops',
            status: 'success',
            title: result.lifecycleStage === 'reportable' ? 'Risk confirmed' : 'Validation queued',
            detail: result.findingId,
            importance: 'high',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: {
              ...result,
              ...(validationQueue?.queued ? { validationQueue } : {}),
              ...(validationWorker ? { validationWorker } : {}),
              ...(!validationQueue?.queued && validationQueue?.error ? { validationQueue } : {}),
              },
              reason: 'promote_finding',
              scopes: ['findings', 'leads', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['findingId', 'to']),
    );
  },
};


export const SubmitValidationOutcome: ToolImpl = {
  meta: {
    name: 'submit_validation_outcome',
    description:
      'Restricted to validator_worker sessions and the dedicated validation phase session. Writes the independent fresh-context validation result for a potential Risk the parent context cannot confirm. A validated proof moves the Risk to confirmed and makes it reportable. Every outcome must include proof.claim plus either proof.evidenceIds or proof.notReplayedReason so the result is reviewable without changing proof semantics. Use false_positive only when scoped validation disproves the claim with the required prerequisites available. Use inconclusive when attempts cannot decide because of missing credentials, auth requirements, WAF/rate limits, target unavailability, tooling limits, or insufficient evidence. An inconclusive Risk stays verifying and surfaces for operator review. Calls from other contexts are rejected.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        findingId: { type: 'string', description: 'Finding ID being validated.' },
        outcome: {
          type: 'string',
          enum: ['validated', 'false_positive', 'inconclusive'],
          description:
            'validated = reproduced with fresh evidence; false_positive = disproven with required prerequisites available; inconclusive = cannot decide due to auth, credentials, WAF/rate limits, target/tooling limits, or insufficient evidence.',
        },
        reason: {
          type: 'string',
          description: 'Short explanation grounded in commands, requests, and observed responses from this validator session.',
        },
        evidence: {
          type: 'array',
          description:
            'Optional validator-session artifact paths. For validated outcomes, attach durable evidence here or first call report_finding with validatesFindingId.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['path'],
          },
        },
        proof: {
          type: 'object',
          description:
            'Reviewable proof trail for the validation outcome. Required. Set claim to the exact assertion tested. Set evidenceIds to attached finding evidence paths/HTTP exchange IDs/PoC artifacts, or set notReplayedReason when replay is legitimately not applicable.',
          properties: {
            claim: { type: 'string' },
            evidenceIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bound evidence IDs or paths, such as http:..., raw-http:<id>, .artifacts/... files, or evidence paths attached to the finding.',
            },
            replayAttempted: { type: 'boolean', default: false },
            replayArtifact: {
              type: 'string',
              description: 'Replay result artifact or saved PoC path when replay was attempted.',
            },
            replayReproduced: { type: 'boolean' },
            notReplayedReason: {
              type: 'string',
              enum: [
                'blind_oob',
                'race',
                'one_time_token',
                'non_idempotent',
                'unsafe_to_replay',
                'target_drift',
                'other',
              ],
              description:
                'Use when replay/evidence binding is not applicable or safe. This is advisory and does not demote non-replayable true positives.',
            },
          },
          required: ['claim'],
        },
        proofObligations: {
          type: 'array',
          description:
            'Advisory checklist of observables for this finding type. If omitted, the backend attaches a conservative default checklist.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              observable: { type: 'string' },
              status: { type: 'string', enum: ['proven', 'unproven', 'needs_context'] },
              evidenceIds: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
            required: ['observable', 'status'],
          },
        },
        advisoryTriage: {
          type: 'object',
          description:
            'Optional passive second-opinion fields. Advisory only; disagree/weak/duplicate/risky flags never auto-reject or demote.',
          properties: {
            verdict: { type: 'string', enum: ['agree', 'disagree', 'needs_context'] },
            reason: { type: 'string' },
            triagedBy: { type: 'string' },
            evidenceIds: { type: 'array', items: { type: 'string' } },
            duplicateOf: { type: 'string' },
            flags: {
              type: 'array',
              items: { type: 'string', enum: ['duplicate', 'weak_evidence', 'risky_to_replay'] },
            },
          },
          required: ['verdict', 'reason'],
        },
      },
      required: ['findingId', 'outcome', 'reason', 'proof'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitValidationOutcome.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const session = getSessionFromContext(ctx);
        const securityopsFlags = getSecurityOpsFlags(session);
        const isValidatorWorker =
          session?.coordination?.role === 'worker' && session.coordination.workerType === 'validator_worker';
        const isValidationPhaseSession =
          getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase() === 'validation';
        if (!isValidatorWorker && !isValidationPhaseSession) {
          return {
            ok: false,
            data: {
              error:
                'submit_validation_outcome is restricted to validator_worker sessions or the dedicated validation phase session. Root agents request validation with promote_finding.',
            },
          };
        }
        const terminal = checkSessionTerminal(session);
        if (terminal.kind === 'validation_outcome_submitted') {
          return {
            ok: true,
            data: {
              success: true,
              alreadySubmitted: true,
              terminal: true,
              result: terminal.existingResult,
              nextAction: 'stop',
            },
          };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx, session);
        try {
          await hydrateRemoteEvidenceFiles(ctx, args);
          const result = await service.submitValidationOutcome({
            userId,
            sessionId: ctx.sessionId,
            workspaceDir,
            context,
            input: args,
          });
          if (result.lifecycleStage === 'reportable') {
            await recordPromotedFinding(ctx, result.findingId);
          }
          await completeValidationQueueFinding(ctx, result.findingId, result.outcome);
          recordSkillOutcomeMetrics(session, result.outcome);
          emitSecurityOpsTimeline(ctx, {
            kind: 'securityops',
            status: result.outcome === 'validated' ? 'success' : result.outcome === 'false_positive' ? 'error' : 'info',
            title:
              result.outcome === 'validated'
                ? 'Finding validated'
                : result.outcome === 'false_positive'
                  ? 'Finding rejected'
                  : 'Validation inconclusive',
            detail: result.findingId,
            importance: result.outcome === 'validated' ? 'high' : 'medium',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          if (isValidatorWorker && session) {
            await applyTerminal(session, ctx, 'validation_outcome_submitted', result);
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'submit_validation_outcome',
              scopes: ['findings', 'evidence', 'leads', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['findingId', 'outcome']),
    );
  },
};

export const SubmitFindingDispositionOutcome: ToolImpl = {
  meta: {
    name: 'submit_finding_disposition_outcome',
    description:
      'Terminal proof contract for a focused finding disposition verification Run. This tool is available only when the session is bound to a findingDispositionVerificationId. Submit fixed/still_present/inconclusive for a resolved request, or false_positive/validated/inconclusive for a false-positive request. Fixed and false_positive require a fresh non-reproducing replay plus functioning prerequisite/control evidence. A history_entry_id returned by http_payload in this session may be referenced directly in proof evidence IDs and is stored as durable structured HTTP evidence. Missing evidence or blockers must be inconclusive and can never change canonical finding truth.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Exact finding disposition verification ID from session context.' },
        findingId: { type: 'string', description: 'Exact finding ID from session context.' },
        outcome: {
          type: 'string',
          enum: ['fixed', 'still_present', 'false_positive', 'validated', 'inconclusive'],
        },
        reason: {
          type: 'string',
          description: 'Concise explanation grounded in fresh observations from this verification session.',
        },
        blockerCode: {
          type: 'string',
          description:
            'Required for inconclusive. Prefer credential_required, auth_required, account_state_required, rate_limited, target_unavailable, out_of_scope, waf_blocked, insufficient_evidence, unsafe_to_replay, tooling_blocked, or budget_exhausted.',
        },
        evidence: {
          type: 'array',
          description: 'Fresh validator-session artifacts or HTTP captures to attach before proof references are checked.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['path'],
          },
        },
        proof: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'The exact historical security claim tested.' },
            replayAttempted: { type: 'boolean' },
            replayReproduced: { type: 'boolean' },
            prerequisitesSatisfied: {
              type: 'boolean',
              description: 'Whether target, routing, authentication/account state, and required setup functioned.',
            },
            evidenceIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs or paths of fresh replay/disproof evidence attached by this session, including http_payload history_entry_id values.',
            },
            controlEvidenceIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs or paths proving controls/prerequisites functioned, including http_payload history_entry_id values from this session.',
            },
          },
          required: [
            'claim',
            'replayAttempted',
            'prerequisitesSatisfied',
            'evidenceIds',
            'controlEvidenceIds',
          ],
        },
      },
      required: ['requestId', 'findingId', 'outcome', 'reason', 'proof'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitFindingDispositionOutcome.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const session = getSessionFromContext(ctx);
        const securityopsFlags = getSecurityOpsFlags(session);
        const requestId = getString(securityopsFlags?.findingDispositionVerificationId)?.trim();
        const findingId = getString(securityopsFlags?.findingId)?.trim();
        const activePhaseKey = getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase();
        if (!requestId || !findingId || activePhaseKey !== 'validation') {
          return {
            ok: false,
            data: {
              error:
                'submit_finding_disposition_outcome is restricted to the focused finding disposition validation path.',
            },
          };
        }
        const input = isRecord(args) ? args : {};
        if (getString(input.requestId)?.trim() !== requestId || getString(input.findingId)?.trim() !== findingId) {
          return {
            ok: false,
            data: { error: 'requestId and findingId must exactly match the immutable session context.' },
          };
        }

        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        const workspaceDir = resolveToolWorkspaceDir(ctx, session);
        try {
          await hydrateRemoteEvidenceFiles(ctx, args);
          const result = await service.submitFindingDispositionOutcome({
            userId,
            sessionId: ctx.sessionId,
            sessionStartedAt: session?.createdAt,
            workspaceDir,
            context,
            input: args,
          });
          await ctx.sessionStore.mergeFlagNamespaceAsync(ctx.sessionId, 'securityops', {
            findingDispositionOutcomeSubmitted: true,
            findingDispositionOutcome: result.outcome,
          });
          recordSkillOutcomeMetrics(session, result.outcome);
          emitSecurityOpsTimeline(ctx, {
            kind: 'securityops',
            status:
              result.outcome === 'fixed' || result.outcome === 'false_positive'
                ? 'success'
                : result.outcome === 'inconclusive'
                  ? 'info'
                  : 'error',
            title: 'Finding disposition verified',
            detail: `${result.findingId}: ${result.outcome}`,
            importance: 'high',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: {
                ...result,
                terminal: true,
                nextAction: 'submit_phase_handoff',
              },
              reason: 'submit_finding_disposition_outcome',
              scopes: ['findings', 'evidence', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['requestId', 'findingId', 'outcome']),
    );
  },
};


export const SubmitValidationLeadOutcome: ToolImpl = {
  meta: {
    name: 'submit_validation_lead_outcome',
    description:
      'Restricted to validator_worker sessions and the dedicated validation phase session. Closes a rendered validation.lead using required observations and a terminal outcome. promptSha256 is optional; include it only when the rendered lead prompt surfaced it. Use this for validation leads; use submit_validation_outcome for candidate findings. For blocked/deferred blockerCode, prefer the standard vocabulary when it fits: credential_required, auth_required, account_state_required, rate_limited, target_unavailable, out_of_scope, waf_blocked, insufficient_evidence, tooling_blocked. Use a precise custom code only when none of these preserve the blocker.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'validation.lead note ID being closed.' },
        promptSha256: { type: 'string', description: 'Optional SHA256 from the rendered lead prompt artifact; omitted values are accepted.' },
        outcome: {
          type: 'string',
          enum: ['validated', 'false_positive', 'blocked', 'deferred', 'superseded'],
        },
        blockerCode: {
          type: 'string',
          description: 'Required for blocked or deferred outcomes. Prefer standard codes: credential_required, auth_required, account_state_required, rate_limited, target_unavailable, out_of_scope, waf_blocked, insufficient_evidence, tooling_blocked. Custom codes are accepted when more precise.',
        },
        observations: {
          type: 'array',
          description: 'Probe observations. Required for false_positive or deferred outcomes.',
          items: {
            type: 'object',
            properties: {
              technique: { type: 'string' },
              probe: { type: 'string' },
              result: { type: 'string', enum: ['confirmed', 'contradicted', 'partial', 'inconclusive'] },
              evidenceRef: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['technique', 'result'],
          },
        },
        nextPrerequisite: { type: 'string' },
        replacementLead: { type: 'object' },
      },
      required: ['leadId', 'outcome'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitValidationLeadOutcome.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const session = getSessionFromContext(ctx);
        const securityopsFlags = getSecurityOpsFlags(session);
        const isValidatorWorker =
          session?.coordination?.role === 'worker' && session.coordination.workerType === 'validator_worker';
        const isValidationPhaseSession =
          getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase() === 'validation';
        if (!isValidatorWorker && !isValidationPhaseSession) {
          return {
            ok: false,
            data: {
              error:
                'submit_validation_lead_outcome is restricted to validator_worker sessions or the dedicated validation phase session.',
            },
          };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.submitValidationLeadOutcome({
            userId,
            context,
            input: args,
          });
          recordSkillOutcomeMetrics(session, result.outcome);
          emitSecurityOpsTimeline(ctx, {
            kind: 'securityops',
            status: result.outcome === 'validated' ? 'success' : result.outcome === 'false_positive' ? 'error' : 'info',
            title: 'Validation lead closed',
            detail: `${result.leadId}: ${result.outcome}`,
            importance: result.outcome === 'validated' ? 'high' : 'medium',
            relatedIds: buildSecurityOpsRelatedIds(context, result as Record<string, unknown>),
          });
          if (ctx.trace) {
            void ctx.trace
              .write(ctx.sessionId, ctx.turnNumber ?? 0, {
                event: 'validation.lead_outcome_submitted',
                severity: 'info',
                payload: result,
                note: `validation lead ${result.leadId} ${result.outcome}`,
              })
              .catch(() => {});
          }
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result as Record<string, unknown>,
              reason: 'submit_validation_lead_outcome',
              scopes: ['leads', 'findings', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['leadId', 'outcome']),
    );
  },
};

