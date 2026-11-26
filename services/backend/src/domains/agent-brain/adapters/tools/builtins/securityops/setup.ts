import { z } from 'zod';

import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import {
  COMPLIANCE_FRAMEWORK_KEYS,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';
import { normalizeModelCategory, type ModelCategory } from '@null-ai/contracts';
import type {
  ImpactTolerance,
  ScopeTargetVerificationMethod,
  ScopeWithSummary,
} from '@/domains/security-ops/scopes/ScopeService';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import {
  getAccessControlService,
  getAutomationService,
  getModelConfigPort,
  getOrganizationService,
  getScopeDocumentService,
  getScopeService,
  getSetupReadinessService,
  getWebsitePlatformDetectionService,
} from '../securityopsServiceRegistry';
import {
  formatToolError,
  isRecord,
  pickToolArgsPreview,
  requireUserId,
} from './shared';

const complianceFrameworkSchema = z.enum([
  ...COMPLIANCE_FRAMEWORK_KEYS,
] as [ComplianceFrameworkKey, ...ComplianceFrameworkKey[]]);

const scopeBriefSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    mission: z.string().trim().max(4_000).nullable().optional(),
    impactTolerance: z.enum(['non_destructive', 'poc', 'full']).optional(),
    complianceFrameworks: z.array(complianceFrameworkSchema).max(20).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.values(value).every((entry) => entry === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one scope field is required.',
      });
    }
  });

const organizationContextSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    operationalContext: z.string().trim().max(12_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.values(value).every((entry) => entry === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one organization field is required.',
      });
    }
  });

const addTargetSchema = z.object({
  type: z.enum(['domain', 'cidr']),
  value: z.string().trim().min(1).max(253),
  verificationMethod: z.enum([
    'dns_txt',
    'http_well_known',
    'manual_review',
    'none',
  ]).optional(),
}).strict();

const triggerConfigSchema = z.record(z.string(), z.unknown());

const automationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).optional(),
  goal: z.string().trim().min(1).max(4_000),
  triggerType: z.enum(['scheduled', 'continuous', 'event']),
  triggerConfig: triggerConfigSchema,
  executionTarget: z.enum(['cloud', 'scope_runner']).optional(),
  modelId: z.string().trim().min(1).max(255).nullable().optional(),
  modelCategory: z.string().trim().min(1).max(80).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

type SetupContext = {
  userId: string;
  organizationId: string;
  scopeId: string;
};

type ParsedAutomationInput = z.infer<typeof automationSchema>;

const UUID_V4ISH_PATTERN = /^[0-9a-fA-F-]{36}$/;

const resolveSetupContext = (ctx: ToolContext): {
  userId?: string;
  organizationId?: string;
  scopeId?: string;
  error?: string;
} => {
  const userId = requireUserId(ctx) ?? undefined;
  const securityOpsContext = resolveSecurityOpsToolContext(ctx);
  if (!userId) {
    return { error: 'userId is required to use setup tools' };
  }
  if (!securityOpsContext.scopeId) {
    return { userId, error: 'A selected scope is required to use setup tools' };
  }
  if (!securityOpsContext.organizationId) {
    return {
      userId,
      scopeId: securityOpsContext.scopeId,
      error: 'organizationId is required to use setup tools',
    };
  }
  return {
    userId,
    organizationId: securityOpsContext.organizationId,
    scopeId: securityOpsContext.scopeId,
  };
};

const parseModelIdInput = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) return value;
  const normalized = value.trim();
  if (!normalized) return null;
  if (!UUID_V4ISH_PATTERN.test(normalized)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelId must be a valid UUID');
  }
  return normalized;
};

const parseModelCategoryInput = (value: string | null | undefined): ModelCategory | null | undefined => {
  if (value === undefined || value === null) return value;
  const normalized = normalizeModelCategory(value);
  if (!normalized) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelCategory must be one of low, medium, high, extra_high');
  }
  return normalized;
};

const resolveActiveModelId = async (value: string | null | undefined): Promise<string | null | undefined> => {
  const modelId = parseModelIdInput(value);
  if (!modelId) return modelId;

  const model = await getModelConfigPort().getModel(modelId);
  if (!model || model.isActive === false) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model not found', {
      httpStatus: 404,
    });
  }
  return modelId;
};

const resolveActiveModelCategory = async (
  value: string | null | undefined,
): Promise<ModelCategory | null | undefined> => {
  const modelCategory = parseModelCategoryInput(value);
  if (!modelCategory) return modelCategory;

  const models = await getModelConfigPort().listModelsForCategory(modelCategory);
  if (models.length === 0) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model category not found', {
      httpStatus: 404,
    });
  }
  return modelCategory;
};

const resolveModelCategoryForGate = async (
  modelId: string | null | undefined,
  modelCategory: ModelCategory | null | undefined,
): Promise<ModelCategory | null> => {
  if (modelCategory) return modelCategory;
  if (!modelId) return null;

  const model = await getModelConfigPort().getModel(modelId);
  if (!model || model.isActive === false) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model not found', {
      httpStatus: 404,
    });
  }
  return model.selectionCategory ?? null;
};

const enforceCreateScopeAutomationEntitlements = async (
  setupContext: SetupContext,
  parsed: ParsedAutomationInput,
): Promise<{ modelId: string | null | undefined; modelCategory: ModelCategory | null | undefined }> => {
  const automationService = getAutomationService();
  const accessControl = getAccessControlService();
  const existingAutomationCount = await automationService.countAutomations(setupContext.organizationId);

  await accessControl.enforceAutomationCreation({
    userId: setupContext.userId,
    organizationId: setupContext.organizationId,
    existingAutomationCount,
  });

  if (parsed.executionTarget === 'scope_runner') {
    await accessControl.enforcePrivateRunnerAccess({
      userId: setupContext.userId,
      organizationId: setupContext.organizationId,
    });
  }

  const modelId = await resolveActiveModelId(parsed.modelId);
  const modelCategory = await resolveActiveModelCategory(parsed.modelCategory);
  await accessControl.enforceModelCategoryAccess({
    userId: setupContext.userId,
    organizationId: setupContext.organizationId,
    requestedModelCategory: await resolveModelCategoryForGate(modelId, modelCategory),
  });

  return { modelId, modelCategory };
};

const serializeScopeBrief = (scope: ScopeWithSummary) => ({
  id: scope.id,
  name: scope.name,
  status: scope.status,
  mission: scope.mission,
  impactTolerance: scope.impactTolerance,
  complianceFrameworks: scope.complianceFrameworks,
  targetCount: scope.targetCount,
  verifiedTargetCount: scope.verifiedTargetCount,
  connectedRepoCount: scope.connectedRepoCount,
  accessMaterialCount: scope.accessMaterialCount,
});

const serializeOrganizationContext = (organization: {
  id?: string;
  name: string;
  operationalContext?: string | null;
  context?: string | null;
}) => ({
  ...(organization.id ? { id: organization.id } : {}),
  name: organization.name,
  operationalContext: organization.operationalContext ?? organization.context ?? null,
});

const providerLabel = (provider: string | null): string | null => {
  switch (provider) {
    case 'wordpress':
      return 'WordPress';
    case 'shopify':
      return 'Shopify';
    case 'wix':
      return 'Wix';
    case 'squarespace':
      return 'Squarespace';
    default:
      return null;
  }
};

const buildManualVerificationGuidance = (method: string | null | undefined): string =>
  method === 'http_well_known'
    ? 'Fastest available path is HTTP file verification: publish the verification token at the well-known URL, then check file status.'
    : 'Fastest available path is DNS TXT verification: add the TXT record, then check DNS records.';

const buildTargetVerificationRecommendation = async (target: {
  type: string;
  value: string;
  verified: boolean;
  verificationMethod?: string | null;
}) => {
  if (target.type !== 'domain' || target.verified) {
    return null;
  }

  try {
    const detection = await getWebsitePlatformDetectionService().detect(target.value);
    const providerName = providerLabel(detection.recommendation.provider);
    const fastestMethod = target.verificationMethod === 'http_well_known' ? 'http_well_known' : 'dns_txt';

    return {
      siteUrl: detection.siteUrl,
      detectedProvider: detection.detectedProvider,
      method: detection.recommendation.method,
      provider: detection.recommendation.provider,
      providerLabel: providerName,
      confidence: detection.recommendation.confidence,
      label: detection.recommendation.label,
      description: detection.recommendation.description,
      evidence: detection.recommendation.evidence,
      fallbackMethods: detection.recommendation.fallbackMethods,
      fastestMethod,
      guidance: buildManualVerificationGuidance(target.verificationMethod),
    };
  } catch {
    return {
      siteUrl: null,
      detectedProvider: null,
      method: 'manual',
      provider: null,
      providerLabel: null,
      confidence: 'low',
      label: 'Manual verification',
      description: 'Use DNS TXT or HTTP file verification for this domain.',
      evidence: ['Platform detection was unavailable.'],
      fallbackMethods: ['dns_txt', 'http_well_known'],
      fastestMethod: target.verificationMethod === 'http_well_known' ? 'http_well_known' : 'dns_txt',
      guidance: buildManualVerificationGuidance(target.verificationMethod),
    };
  }
};

export const ReadSetupState: ToolImpl = {
  meta: {
    name: 'read_setup_state',
    description:
      'Read setup readiness plus the current scope brief, ROE, targets, and provider-aware verification recommendations for the selected scope before answering onboarding or setup questions.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReadSetupState.meta,
      ctx,
      async () => {
        const setupContext = resolveSetupContext(ctx);
        if (setupContext.error || !setupContext.userId || !setupContext.organizationId || !setupContext.scopeId) {
          return { ok: false, data: { error: setupContext.error ?? 'setup context is incomplete' } };
        }

        try {
          const [readiness, detail, organization, documents] = await Promise.all([
            getSetupReadinessService().buildForUser({
              userId: setupContext.userId,
              scopeId: setupContext.scopeId,
            }),
            getScopeService().getById(setupContext.organizationId, setupContext.scopeId),
            getOrganizationService().getOrgContext(setupContext.organizationId),
            getScopeDocumentService().listForScope(setupContext.organizationId, setupContext.scopeId),
          ]);
          const targetSummaries = await Promise.all(detail.targets.map(async (target) => ({
            id: target.id,
            type: target.type,
            value: target.value,
            verified: target.verified,
            verificationMethod: target.verificationMethod,
            verifiedAt: target.verifiedAt,
            verificationRecommendation: await buildTargetVerificationRecommendation(target),
          })));

          return {
            ok: true,
            data: {
              readiness,
              organization: serializeOrganizationContext({
                id: setupContext.organizationId,
                ...organization,
              }),
              scope: serializeScopeBrief(detail.scope),
              targets: targetSummaries,
              documents,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, []),
    );
  },
};

export const UpdateOrganizationContext: ToolImpl = {
  meta: {
    name: 'update_organization_context',
    description:
      'Update the organization setup brief for the current organization after operator approval. Use for organization name or operational context that should steer future scope setup and assessments.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        operationalContext: { type: 'string', nullable: true, maxLength: 12000 },
      },
      required: [],
      additionalProperties: false,
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      UpdateOrganizationContext.meta,
      ctx,
      async () => {
        const setupContext = resolveSetupContext(ctx);
        if (setupContext.error || !setupContext.organizationId) {
          return { ok: false, data: { error: setupContext.error ?? 'setup context is incomplete' } };
        }

        try {
          const parsed = organizationContextSchema.parse(args);
          const updated = await getOrganizationService().update(setupContext.organizationId, {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.operationalContext !== undefined ? { operationalContext: parsed.operationalContext } : {}),
          });

          return {
            ok: true,
            data: {
              organization: serializeOrganizationContext(updated),
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['name', 'operationalContext']),
    );
  },
};

export const UpdateScopeBrief: ToolImpl = {
  meta: {
    name: 'update_scope_brief',
    description:
      'Update the selected scope brief after the operator approves the exact change. Use for scope name, mission guidance, PoC impact boundary, or compliance frameworks. Verified targets and exclusions use their dedicated scope APIs.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        mission: { type: ['string', 'null'], maxLength: 4000 },
        impactTolerance: { type: 'string', enum: ['non_destructive', 'poc', 'full'] },
        complianceFrameworks: {
          type: ['array', 'null'],
          items: { type: 'string', enum: COMPLIANCE_FRAMEWORK_KEYS },
          maxItems: 20,
        },
      },
      required: [],
      additionalProperties: false,
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      UpdateScopeBrief.meta,
      ctx,
      async () => {
        const setupContext = resolveSetupContext(ctx);
        if (setupContext.error || !setupContext.organizationId || !setupContext.scopeId) {
          return { ok: false, data: { error: setupContext.error ?? 'setup context is incomplete' } };
        }

        try {
          const parsed = scopeBriefSchema.parse(args);
          const updated = await getScopeService().update(setupContext.organizationId, setupContext.scopeId, {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.mission !== undefined ? { mission: parsed.mission } : {}),
            ...(parsed.impactTolerance !== undefined ? { impactTolerance: parsed.impactTolerance as ImpactTolerance } : {}),
            ...(parsed.complianceFrameworks !== undefined ? { complianceFrameworks: parsed.complianceFrameworks } : {}),
          });

          return {
            ok: true,
            data: {
              scope: serializeScopeBrief(updated),
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, [
        'name',
        'mission',
        'impactTolerance',
        'complianceFrameworks',
      ]),
    );
  },
};

export const AddScopeTarget: ToolImpl = {
  meta: {
    name: 'add_scope_target',
    description:
      'Add a domain or CIDR target to the selected scope after operator approval. The selected scope is taken from chat context; do not accept or invent another scope ID.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['domain', 'cidr'] },
        value: { type: 'string', minLength: 1, maxLength: 253 },
        verificationMethod: {
          type: 'string',
          enum: ['dns_txt', 'http_well_known', 'manual_review', 'none'],
        },
      },
      required: ['type', 'value'],
      additionalProperties: false,
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      AddScopeTarget.meta,
      ctx,
      async () => {
        const setupContext = resolveSetupContext(ctx);
        if (setupContext.error || !setupContext.organizationId || !setupContext.scopeId) {
          return { ok: false, data: { error: setupContext.error ?? 'setup context is incomplete' } };
        }

        try {
          const parsed = addTargetSchema.parse(args);
          await getScopeService().getById(setupContext.organizationId, setupContext.scopeId);
          const target = await getScopeService().addTarget(setupContext.scopeId, {
            type: parsed.type,
            value: parsed.value,
            verificationMethod: parsed.verificationMethod as ScopeTargetVerificationMethod | undefined,
          });

          return {
            ok: true,
            data: {
              target: {
                id: target.id,
                type: target.type,
                value: target.value,
                verified: target.verified,
                verificationMethod: target.verificationMethod,
                verificationToken: target.verificationToken,
                verifiedAt: target.verifiedAt,
              },
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['type', 'value', 'verificationMethod']),
    );
  },
};

export const CreateScopeAutomation: ToolImpl = {
  meta: {
    name: 'create_scope_automation',
    description:
      'Create a scheduled, continuous, or event-based automation for the selected scope after operator approval. Defaults to inactive unless isActive is explicitly true in the approved request.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 1000 },
        goal: { type: 'string', minLength: 1, maxLength: 4000 },
        triggerType: { type: 'string', enum: ['scheduled', 'continuous', 'event'] },
        triggerConfig: {
          type: 'object',
          additionalProperties: true,
          description:
            'scheduled: {cron, timezone}; continuous: {intervalMinutes}; event: {eventType, filter?}.',
        },
        executionTarget: { type: 'string', enum: ['cloud', 'scope_runner'] },
        modelId: { type: ['string', 'null'], maxLength: 255 },
        modelCategory: { type: ['string', 'null'], maxLength: 80 },
        isActive: { type: 'boolean', default: false },
      },
      required: ['name', 'goal', 'triggerType', 'triggerConfig'],
      additionalProperties: false,
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      CreateScopeAutomation.meta,
      ctx,
      async () => {
        const setupContext = resolveSetupContext(ctx);
        if (setupContext.error || !setupContext.userId || !setupContext.organizationId || !setupContext.scopeId) {
          return { ok: false, data: { error: setupContext.error ?? 'setup context is incomplete' } };
        }
        const resolvedSetupContext: SetupContext = {
          userId: setupContext.userId,
          organizationId: setupContext.organizationId,
          scopeId: setupContext.scopeId,
        };

        try {
          const parsed = automationSchema.parse(args);
          const resolvedModel = await enforceCreateScopeAutomationEntitlements(resolvedSetupContext, parsed);
          const automation = await getAutomationService().createAutomation(
            resolvedSetupContext.organizationId,
            resolvedSetupContext.userId,
            {
              name: parsed.name,
              description: parsed.description,
              scopeId: resolvedSetupContext.scopeId,
              goal: parsed.goal,
              triggerType: parsed.triggerType,
              triggerConfig: parsed.triggerConfig,
              executionTarget: parsed.executionTarget,
              modelId: resolvedModel.modelId,
              modelCategory: resolvedModel.modelCategory,
              isActive: parsed.isActive ?? false,
            },
          );

          return {
            ok: true,
            data: {
              automation,
              activationNote: automation.isActive
                ? 'Automation was created active because isActive=true was included in the approved request.'
                : 'Automation was created inactive. Enable it from Automations when ready.',
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      isRecord(args)
        ? {
            ...pickToolArgsPreview(args, [
              'name',
              'description',
              'goal',
              'triggerType',
              'triggerConfig',
              'executionTarget',
              'modelCategory',
              'isActive',
            ]),
            scopeId: resolveSecurityOpsToolContext(ctx).scopeId,
          }
        : {},
    );
  },
};
