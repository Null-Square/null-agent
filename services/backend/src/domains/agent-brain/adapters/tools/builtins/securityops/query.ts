
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { COMPLIANCE_FRAMEWORK_KEYS } from '@/domains/security-ops/compliance/frameworks';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { getSecurityOpsService } from '../securityopsServiceRegistry';
import { getHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';

import {
  COMPLIANCE_EVIDENCE_SOURCE_VALUES,
  COMPLIANCE_EVIDENCE_STATUS_VALUES,
  COMPLIANCE_READINESS_STATUS_VALUES,
  COMPLIANCE_SUPPORT_LEVEL_VALUES,
  formatToolError,
  isRecord,
  pickToolArgsPreview,
  requireUserId
} from './shared';

export const QueryInventory: ToolImpl = {
  meta: {
    name: 'query_inventory',
    description:
      'Query the current inventory to see what is already known. For planning, call mode="digest" first: it returns compact service summaries, evidence-ranked focus, broad-scan coverage, and versionAcquisition objectives for named products whose version is absent. For each such objective, try only recommendedMethod and record that exact versionReadMethod; exhausted means stop. Never infer a version. Normal results contain confirmed assets. Set includeLeads=true only when unconfirmed observations are needed. A lead has no verified target or durable evidence. Plan by evidence focus and coverage. Use mode="list" and includeServices/includeEndpoints only when detailed fields are needed.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['digest', 'list'], default: 'digest' },
        assetKind: { type: 'string', enum: ['domain', 'ip', 'all'] },
        includeServices: { type: 'boolean', default: false },
        includeEndpoints: { type: 'boolean', default: false },
        includeLeads: { type: 'boolean', default: false },
        staleThresholdDays: { type: 'integer', description: 'Only return items not seen in N days.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryInventory.meta,
      ctx,
      async () => {
        const context = resolveSecurityOpsToolContext(ctx);
        const hostedRun = context.runHost === 'research_lab'
          ? getHostedRunPersistencePort(context.runId)
          : null;
        if (hostedRun) {
          return { ok: true, data: await hostedRun.queryInventory(isRecord(args) ? args : {}) };
        }
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        try {
          const inventoryInput =
            isRecord(args) && typeof args.mode !== 'string'
              ? {
                  ...args,
                  mode: 'digest',
                  limit: typeof args.limit === 'number' ? args.limit : 100,
                }
              : args;
          const result = await service.queryInventory({
            userId,
            context,
            input: inventoryInput,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['mode', 'assetKind', 'includeServices', 'includeEndpoints', 'includeLeads', 'limit']),
    );
  },
};


export const QueryFindings: ToolImpl = {
  meta: {
    name: 'query_findings',
    description: 'Query existing findings to avoid duplicates or validate previously found issues. When a row includes a revalidationHint, use validatesFindingId on report_finding to attach fresh evidence to that existing finding.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        assetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        state: { type: 'string', enum: ['potential', 'verifying', 'confirmed', 'not_reproduced', 'dismissed', 'resolved', 'accepted', 'all'], default: 'all' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'all'], default: 'all' },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryFindings.meta,
      ctx,
      async () => {
        const context = resolveSecurityOpsToolContext(ctx);
        const hostedRun = context.runHost === 'research_lab'
          ? getHostedRunPersistencePort(context.runId)
          : null;
        if (hostedRun) {
          return { ok: true, data: await hostedRun.queryFindings(isRecord(args) ? args : {}) };
        }
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        try {
          const result = await service.queryFindings({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['assetRef', 'status', 'severity']),
    );
  },
};


export const QueryNotes: ToolImpl = {
  meta: {
    name: 'query_notes',
    description: 'Query historical observation notes by asset, type, and recency.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        assetRef: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['domain', 'ip'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        ntype: {
          type: 'string',
          description: 'Exact ntype or prefix ending with a dot (example: dns.)',
        },
        since: { type: 'string', description: 'ISO timestamp; only return notes seen at or after this time' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryNotes.meta,
      ctx,
      async () => {
        const context = resolveSecurityOpsToolContext(ctx);
        const hostedRun = context.runHost === 'research_lab'
          ? getHostedRunPersistencePort(context.runId)
          : null;
        if (hostedRun) {
          return { ok: true, data: await hostedRun.queryNotes(isRecord(args) ? args : {}) };
        }
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        try {
          const result = await service.queryNotes({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['assetRef', 'ntype', 'since', 'limit']),
    );
  },
};


export const QueryComplianceReadiness: ToolImpl = {
  meta: {
    name: 'query_compliance_readiness',
    description:
      'Query compliance readiness for the current scope. In a run-bound compliance session this is scoped to the selected framework only; do not request another framework. Use this before answering compliance status, control coverage, or evidence-support questions. This is readiness evidence, not audit attestation or certification.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        framework: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        controlId: { type: 'string', description: 'Optional framework control id such as CC6.1 or A.8.15.' },
        status: { type: 'string', enum: COMPLIANCE_READINESS_STATUS_VALUES },
        supportLevel: { type: 'string', enum: COMPLIANCE_SUPPORT_LEVEL_VALUES },
        includeEvidence: {
          type: 'boolean',
          default: true,
          description: 'Include compact evidence references under each returned control.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 100,
          description: 'Maximum controls returned after filters.',
        },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryComplianceReadiness.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.queryComplianceReadiness({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['framework', 'controlId', 'status', 'supportLevel', 'includeEvidence', 'limit']),
    );
  },
};


export const QueryComplianceEvidence: ToolImpl = {
  meta: {
    name: 'query_compliance_evidence',
    description:
      'Query compliance evidence items for the current scope, including review status, artifact metadata, and framework/control mappings. In a run-bound compliance session framework-specific results are scoped to the selected framework only. Set includeContent=true only when a bounded text preview is needed to map or review uploaded evidence.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        framework: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        controlId: { type: 'string', description: 'Optional framework control id such as CC6.1 or A.8.15.' },
        status: { type: 'string', enum: COMPLIANCE_EVIDENCE_STATUS_VALUES },
        sourceType: { type: 'string', enum: COMPLIANCE_EVIDENCE_SOURCE_VALUES },
        includeMetadata: {
          type: 'boolean',
          default: false,
          description: 'Include non-file metadata on each evidence item when needed for integration/provider context.',
        },
        includeContent: {
          type: 'boolean',
          default: false,
          description: 'Include a bounded, redacted text preview for text-like uploaded evidence. Binary files return metadata only.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryComplianceEvidence.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.queryComplianceEvidence({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['framework', 'controlId', 'status', 'sourceType', 'includeMetadata', 'includeContent', 'limit']),
    );
  },
};

export const QueryComplianceProofPackage: ToolImpl = {
  meta: {
    name: 'query_compliance_proof_package',
    description:
      'Retrieve a compact durable proof package for one compliance control in the active framework, including current verdict, agent checks, evidence references, durable artifact metadata, integrity hashes when available, and limitations. Does not return file contents or secrets.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        framework: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        controlId: { type: 'string', description: 'Framework control id such as CC6.1.' },
        maxChecks: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          default: 10,
          description: 'Maximum recent control checks to include.',
        },
      },
      required: ['framework', 'controlId'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryComplianceProofPackage.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.queryComplianceProofPackage({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['framework', 'controlId', 'maxChecks']),
    );
  },
};


export const QueryComplianceMissingEvidence: ToolImpl = {
  meta: {
    name: 'query_compliance_missing_evidence',
    description:
      'Query compliance controls in the current scope that still need manual or integration-backed evidence. In a run-bound compliance session this is scoped to the selected framework only. Use this for gap, missing evidence, and readiness follow-up questions.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        framework: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
        supportLevel: { type: 'string', enum: COMPLIANCE_SUPPORT_LEVEL_VALUES },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryComplianceMissingEvidence.meta,
      ctx,
      async () => {
        const userId = requireUserId(ctx);
        if (!userId) {
          return { ok: false, data: { error: 'userId is required to use SecurityOps tools' } };
        }
        const service = getSecurityOpsService(ctx);
        const context = resolveSecurityOpsToolContext(ctx);
        try {
          const result = await service.queryComplianceMissingEvidence({
            userId,
            context,
            input: args,
          });
          return { ok: true, data: result };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['framework', 'supportLevel', 'limit']),
    );
  },
};

