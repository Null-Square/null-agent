import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { COMPLIANCE_FRAMEWORK_KEYS } from '@/domains/security-ops/compliance/frameworks';
import { attachProjectionWarning } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';

import { getSecurityOpsService } from '../securityopsServiceRegistry';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import {
  formatToolError,
  pickToolArgsPreview,
  requireUserId,
  resolveToolWorkspaceDir,
} from './shared';

export const RecordControlCheck: ToolImpl = {
  meta: {
    name: 'record_control_check',
    description:
      'Record an agent-authored, evidence-backed compliance control check for the current run and scope. Use basis=agent_tested for direct technical checks, basis=agent_reviewed_user_evidence for uploaded evidence review, and basis=agent_reviewed_integration for integration evidence review. Pass and fail require resolvable evidence references. When verdict=fail, also record a requestType=remediation control request with a concrete remediationHint unless an equivalent open remediation request already exists. Accepted evidence refs include compliance-evidence:<id>, structured HTTP/raw-HTTP exchange ids returned by HTTP tools, finding evidence paths, or /workspace/.artifacts/... files you wrote. Do not cite note ids, short labels, or prose-only refs. This tool cannot accept risk or create audit certification claims.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        frameworkKey: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        controlId: { type: 'string' },
        basis: {
          type: 'string',
          enum: ['agent_tested', 'agent_reviewed_user_evidence', 'agent_reviewed_integration'],
          description: 'Verdict basis. Defaults to agent_tested for direct technical checks.',
        },
        verdict: { type: 'string', enum: ['pass', 'fail', 'needs_context', 'not_attempted'] },
        reasonCode: {
          type: 'string',
          enum: ['control_operating', 'control_failed', 'missing_credentials', 'missing_scope', 'target_unavailable', 'tooling_limit', 'insufficient_evidence', 'not_tested'],
        },
        reason: { type: 'string', description: 'Plain-language result grounded in the observed evidence.' },
        proofObligationId: { type: 'string', description: 'Exact authored proof obligation id, or evidence-review:{framework}:{control-id-lowercase} for evidence-review controls.' },
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Resolvable durable refs only: compliance-evidence:<id>, structured HTTP/raw-HTTP exchange ids returned by tools, finding evidence paths, or /workspace/.artifacts/... files. Do not use note:<id>, short labels, or prose-only refs.',
        },
        findingIds: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string' } },
        targetRef: { type: 'string' },
        method: { type: 'string' },
        limitations: { type: 'array', items: { type: 'string' } },
        toolName: { type: 'string' },
        skillSlug: { type: 'string' },
        freshUntil: { type: 'string', description: 'Optional ISO timestamp; capped by the control freshness policy.' },
        proof: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            evidenceIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Same durable ref format as evidenceRefs. Use the exact returned ids/paths; unresolved refs block pass/fail checks.',
            },
            replayAttempted: { type: 'boolean', default: false },
            replayArtifact: { type: 'string' },
            replayReproduced: { type: 'boolean' },
            notReplayedReason: {
              type: 'string',
              enum: ['blind_oob', 'race', 'one_time_token', 'non_idempotent', 'unsafe_to_replay', 'target_drift', 'document_evidence_review', 'integration_evidence_review', 'other'],
            },
          },
          required: ['claim'],
        },
      },
      required: ['frameworkKey', 'controlId', 'verdict', 'reasonCode', 'reason', 'proofObligationId', 'targetRef', 'method', 'proof'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      RecordControlCheck.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        try {
          const result = await getSecurityOpsService(ctx).recordComplianceControlCheck({
            userId,
            workspaceDir: resolveToolWorkspaceDir(ctx),
            sessionId: ctx.sessionId,
            context: resolveSecurityOpsToolContext(ctx),
            input: args,
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result,
              reason: 'record_control_check',
              scopes: ['compliance', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['frameworkKey', 'controlId', 'verdict', 'targetRef', 'method']),
    );
  },
};

export const RecordControlRequest: ToolImpl = {
  meta: {
    name: 'record_control_request',
    description:
      'Record an agent-authored action request for a compliance control when the current evidence is not enough, remediation is needed, or access/context is required. Use this instead of hiding a blocker in prose.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        frameworkKey: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        controlId: { type: 'string' },
        requestType: {
          type: 'string',
          enum: ['evidence', 'access', 'context', 'remediation'],
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          default: 'medium',
        },
        title: { type: 'string' },
        reason: { type: 'string', description: 'Why the control cannot be strengthened without this action.' },
        requestedEvidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete files, exports, access handles, answers, records, or remediation proof needed from the organization. Evidence requests must include at least one item.',
        },
        remediationHint: { type: 'string', description: 'Required when requestType=remediation. Explain the concrete fix and what evidence will prove it.' },
        assignedToUserId: { type: 'string' },
        dueAt: { type: 'string', description: 'Optional ISO timestamp.' },
      },
      required: ['frameworkKey', 'controlId', 'requestType', 'title', 'reason', 'requestedEvidence'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      RecordControlRequest.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        try {
          const result = await getSecurityOpsService(ctx).recordComplianceControlRequest({
            userId,
            sessionId: ctx.sessionId,
            context: resolveSecurityOpsToolContext(ctx),
            input: args,
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result,
              reason: 'record_control_request',
              scopes: ['compliance', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['frameworkKey', 'controlId', 'requestType', 'priority']),
    );
  },
};

export const ReviewControlRequest: ToolImpl = {
  meta: {
    name: 'review_control_request',
    description:
      'Close the loop on a fulfilled compliance control request after recording an evidence-review control check. Mark it reviewed, insufficient, or contradicted, with the control check that backs the review and the next re-verification date when accepted.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        outcome: {
          type: 'string',
          enum: ['reviewed', 'insufficient', 'contradicted'],
        },
        controlCheckId: {
          type: 'string',
          description: 'The evidence-review control check recorded in the current run.',
        },
        note: {
          type: 'string',
          description: 'Plain-language review result explaining why the fulfillment was accepted, insufficient, or contradicted.',
        },
        nextReverificationAt: {
          type: 'string',
          description: 'Optional ISO timestamp for the next scheduled review; accepted reviews default to the check freshness date.',
        },
      },
      required: ['requestId', 'outcome', 'controlCheckId', 'note'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReviewControlRequest.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        try {
          const result = await getSecurityOpsService(ctx).reviewComplianceControlRequest({
            userId,
            sessionId: ctx.sessionId,
            context: resolveSecurityOpsToolContext(ctx),
            input: args,
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result,
              reason: 'review_control_request',
              scopes: ['compliance', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['requestId', 'outcome', 'controlCheckId']),
    );
  },
};

export const AnnotateComplianceEvidence: ToolImpl = {
  meta: {
    name: 'annotate_compliance_evidence',
    description:
      'Fill in metadata for an uploaded compliance evidence item after reading it: a clear title, a description of what the document is and what it proves, the evidence type, and a freshness window (validUntil). Users upload files without metadata; you are responsible for describing them so they can be reasoned about and reused across frameworks later. This does not map controls (use map_compliance_evidence) and does not grant readiness credit.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        evidenceItemId: { type: 'string' },
        title: { type: 'string', description: 'Concise human-readable title for the artifact.' },
        description: {
          type: 'string',
          description: 'What the document is, what it contains, and what it can support. Write enough that a later audit for another framework can decide how to use it.',
        },
        evidenceType: {
          type: 'string',
          enum: ['policy', 'access_review', 'risk_register', 'incident_record', 'continuity_exercise', 'vendor_review', 'change_approval', 'training_record', 'system_export', 'other'],
        },
        validUntil: { type: 'string', description: 'ISO timestamp for when this evidence should be considered stale and re-collected.' },
      },
      required: ['evidenceItemId'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      AnnotateComplianceEvidence.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        try {
          const result = await getSecurityOpsService(ctx).annotateComplianceEvidence({
            userId,
            context: resolveSecurityOpsToolContext(ctx),
            input: args,
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result,
              reason: 'annotate_compliance_evidence',
              scopes: ['compliance', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['evidenceItemId', 'evidenceType']),
    );
  },
};

export const MapComplianceEvidence: ToolImpl = {
  meta: {
    name: 'map_compliance_evidence',
    description:
      'Create or update agent-suggested mappings between an existing compliance evidence item and framework controls. Use this after query_compliance_evidence finds unmapped uploaded evidence that appears relevant to specific controls. Mappings are advisory context only; readiness credit requires a later record_control_check by the agent.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        evidenceItemId: { type: 'string' },
        mappings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              frameworkKey: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
              controlId: { type: 'string' },
              mappingSource: {
                type: 'string',
                enum: ['system_suggested'],
                default: 'system_suggested',
              },
              confidence: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                default: 'medium',
              },
              rationale: { type: 'string' },
              citationAnchors: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    page: { type: 'number' },
                    section: { type: 'string' },
                    line: { type: 'number' },
                    chunkId: { type: 'string' },
                    excerpt: { type: 'string' },
                    excerptSha256: { type: 'string' },
                  },
                },
              },
            },
            required: ['frameworkKey', 'controlId', 'rationale'],
          },
        },
      },
      required: ['evidenceItemId', 'mappings'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      MapComplianceEvidence.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        try {
          const result = await getSecurityOpsService(ctx).mapComplianceEvidence({
            userId,
            context: resolveSecurityOpsToolContext(ctx),
            input: args,
          });
          return {
            ok: true,
            data: await attachProjectionWarning({
              ctx,
              data: result,
              reason: 'map_compliance_evidence',
              scopes: ['compliance', 'model'],
            }),
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['evidenceItemId']),
    );
  },
};
