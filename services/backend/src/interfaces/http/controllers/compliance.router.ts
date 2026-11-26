import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import {
  complianceAuditService,
  complianceControlRequestService,
  complianceControlStateService,
  complianceEvidenceService,
  complianceOrganizationService,
  complianceReadinessService,
} from '@/domains/security-ops/compliance/complianceServices';
import {
  complianceEvidenceStorageRoot,
  resolveComplianceEvidenceStoragePath,
} from '@/domains/security-ops/compliance/ComplianceEvidenceFileResolver';
import { COMPLIANCE_FRAMEWORK_KEYS, FRAMEWORK_REGISTRY } from '@/domains/security-ops/compliance/frameworks';
import { createPlatformKernel } from '@/app/platform/kernel';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  requireComplianceEvidenceOrgContext,
  requirePrimaryOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

const ComplianceProfileQuerySchema = z.object({
  scopeId: z.string().uuid('scopeId must be a valid UUID').optional(),
});

const ComplianceReportHistoryQuerySchema = ComplianceProfileQuerySchema.extend({
  framework: z.enum(COMPLIANCE_FRAMEWORK_KEYS).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive number')
    .optional(),
});

const ComplianceEvidenceStatusSchema = z.enum(['unreviewed', 'expired']);
const ComplianceEvidenceSourceSchema = z.enum(['user_upload', 'user_attestation', 'agent_finding', 'integration']);
const ComplianceEvidenceTypeSchema = z.enum([
  'policy',
  'access_review',
  'risk_register',
  'incident_record',
  'continuity_exercise',
  'vendor_review',
  'change_approval',
  'training_record',
  'system_export',
  'other',
]);
const OptionalDateSchema = z.string().datetime().transform((value) => new Date(value)).optional();

const ComplianceEvidenceQuerySchema = ComplianceProfileQuerySchema.extend({
  framework: z.enum(COMPLIANCE_FRAMEWORK_KEYS).optional(),
  status: ComplianceEvidenceStatusSchema.optional(),
  sourceType: ComplianceEvidenceSourceSchema.optional(),
  limit: z.string().regex(/^\d+$/, 'limit must be a positive number').optional(),
});

const ComplianceControlStateQuerySchema = ComplianceProfileQuerySchema.extend({
  framework: z.enum(COMPLIANCE_FRAMEWORK_KEYS).optional(),
});

const ComplianceControlStateUpdateBodySchema = z.object({
  scopeId: z.string().uuid(),
  state: z.enum(['monitored', 'excluded']),
  exclusionReason: z.string().max(2000).nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
});

const ComplianceControlStateBulkUpdateBodySchema = z.object({
  scopeId: z.string().uuid(),
  controlIds: z.array(z.string().min(1).max(80)).min(1).max(100),
  state: z.enum(['monitored', 'excluded']),
  exclusionReason: z.string().max(2000).nullable().optional(),
});

const ComplianceEvidenceMappingSchema = z.object({
  frameworkKey: z.enum(COMPLIANCE_FRAMEWORK_KEYS),
  controlId: z.string().min(1).max(80),
  mappingSource: z.enum(['user_declared', 'system_suggested']).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  rationale: z.string().max(2000).optional(),
  citationAnchors: z.array(z.object({
    page: z.number().int().positive().nullable().optional(),
    section: z.string().max(240).nullable().optional(),
    line: z.number().int().positive().nullable().optional(),
    chunkId: z.string().max(160).nullable().optional(),
    excerpt: z.string().max(1000).nullable().optional(),
    excerptSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  })).max(10).optional(),
});

const ComplianceEvidenceCreateBodySchema = z.object({
  scopeId: z.string().uuid('scopeId is required for compliance evidence'),
  title: z.string().min(3).max(240),
  description: z.string().max(4000).nullable().optional(),
  sourceType: ComplianceEvidenceSourceSchema.optional(),
  evidenceType: ComplianceEvidenceTypeSchema.optional(),
  owner: z.string().max(240).nullable().optional(),
  artifact: z
    .object({
      fileName: z.string().max(300).nullable().optional(),
      mimeType: z.string().max(160).nullable().optional(),
      sizeBytes: z.number().int().nonnegative().nullable().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 must be a 64 character hex digest').nullable().optional(),
      storageRef: z.string().max(1000).nullable().optional(),
      sourceRef: z.string().max(1000).nullable().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  observationStartedAt: OptionalDateSchema.nullable(),
  observationEndedAt: OptionalDateSchema.nullable(),
  validUntil: OptionalDateSchema.nullable(),
  mappings: z.array(ComplianceEvidenceMappingSchema).max(20).default([]),
});

const ComplianceEvidenceUpdateBodySchema = z.object({
  title: z.string().min(3).max(240),
  description: z.string().max(4000).nullable().optional(),
  evidenceType: ComplianceEvidenceTypeSchema,
  owner: z.string().max(240).nullable().optional(),
  observationStartedAt: OptionalDateSchema.nullable(),
  observationEndedAt: OptionalDateSchema.nullable(),
  validUntil: OptionalDateSchema.nullable(),
  mappings: z.array(ComplianceEvidenceMappingSchema).max(20).default([]),
});

const ComplianceEvidenceMappingsUpsertBodySchema = z.object({
  mappings: z.array(ComplianceEvidenceMappingSchema).min(1).max(20),
});

const ComplianceControlRequestFulfillBodySchema = z.object({
  evidenceItemId: z.string().uuid(),
  note: z.string().max(2000).nullable().optional(),
});

const ComplianceControlRequestReviewBodySchema = z.object({
  outcome: z.enum(['reviewed', 'insufficient', 'contradicted']),
  controlCheckId: z.string().uuid(),
  note: z.string().min(10).max(2000),
  nextReverificationAt: OptionalDateSchema.nullable().optional(),
});

const ComplianceEvidenceFromFindingBodySchema = z.object({
  scopeId: z.string().uuid().nullable().optional(),
  findingId: z.string().uuid(),
  mappings: z.array(ComplianceEvidenceMappingSchema).min(1).max(20),
});

const ComplianceAcceptedRiskCreateBodySchema = z.object({
  scopeId: z.string().uuid().nullable().optional(),
  frameworkKey: z.enum(COMPLIANCE_FRAMEWORK_KEYS),
  controlId: z.string().min(1).max(80),
  evidenceItemId: z.string().uuid().nullable().optional(),
  owner: z.string().min(2).max(240),
  rationale: z.string().min(10).max(4000),
  expiresAt: z.string().datetime().transform((value) => new Date(value)),
});

const orgService = complianceOrganizationService;
const readinessService = complianceReadinessService;
const evidenceService = complianceEvidenceService;
const controlStateService = complianceControlStateService;
const controlRequestService = complianceControlRequestService;
const auditService = complianceAuditService;
const EVIDENCE_UPLOAD_MAX_BYTES = Number.parseInt(process.env.COMPLIANCE_EVIDENCE_UPLOAD_MAX_BYTES ?? '', 10) || 25 * 1024 * 1024;
const evidenceStorageRoot = complianceEvidenceStorageRoot();
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: EVIDENCE_UPLOAD_MAX_BYTES,
    files: 1,
  },
});

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId,
  ip: req.ip,
  userAgent: req.get('user-agent') ?? null,
});

const firstString = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value : undefined;
};

const nullableField = (value: unknown): string | null | undefined => {
  const stringValue = firstString(value);
  if (stringValue === undefined) return undefined;
  const trimmed = stringValue.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseJsonField = (value: unknown, fallback: unknown): unknown => {
  const stringValue = firstString(value);
  if (!stringValue || stringValue.trim().length === 0) return fallback;
  return JSON.parse(stringValue);
};

const parseMultipartEvidenceBody = (req: Request): unknown => {
  const body = req.body as Record<string, unknown>;
  return {
    scopeId: firstString(body.scopeId),
    title: firstString(body.title) ?? '',
    description: nullableField(body.description),
    sourceType: firstString(body.sourceType) ?? 'user_upload',
    evidenceType: firstString(body.evidenceType) ?? 'other',
    owner: nullableField(body.owner),
    metadata: parseJsonField(body.metadata, undefined),
    observationStartedAt: nullableField(body.observationStartedAt),
    observationEndedAt: nullableField(body.observationEndedAt),
    validUntil: nullableField(body.validUntil),
    mappings: parseJsonField(body.mappings, []),
  };
};

const sanitizeEvidenceFileName = (fileName: string): string => {
  const base = path.basename(fileName || 'evidence.bin');
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 180);
  return sanitized || 'evidence.bin';
};

const runEvidenceUpload = (req: Request, res: Response): Promise<void> =>
  new Promise((resolve, reject) => {
    evidenceUpload.single('file')(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const prepareUploadedEvidenceArtifact = (organizationId: string, file: Express.Multer.File) => {
  const fileId = randomUUID();
  const safeName = sanitizeEvidenceFileName(file.originalname);
  const storageName = `${fileId}-${safeName}`;
  const storageRef = path.posix.join(organizationId, storageName);
  const absolutePath = path.resolve(evidenceStorageRoot, organizationId, storageName);
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');

  return {
    absolutePath,
    directory: path.dirname(absolutePath),
    artifact: {
      fileName: safeName,
      mimeType: file.mimetype || 'application/octet-stream',
      sizeBytes: file.size,
      sha256,
      storageRef,
      sourceRef: `uploaded:${safeName}`,
    },
  };
};

const deleteUploadedEvidenceFile = async (absolutePath: string | null): Promise<void> => {
  if (!absolutePath) return;
  try {
    await fs.rm(absolutePath, { force: true });
  } catch (error) {
    logger.warn({ err: toAppError(error), absolutePath }, '[compliance] Failed to clean up compliance evidence file');
  }
};

async function getOrgId(req: { user?: { id: string }; organizationId?: string }): Promise<string> {
  if (req.organizationId) return req.organizationId;
  const userId = req.user?.id;
  if (!userId) throw new Error('Not authenticated');
  const org = await orgService.getForUser(userId);
  req.organizationId = org.id;
  return org.id;
}

export function createComplianceRouter(): Router {
  const router = Router();
  const accessControl = createPlatformKernel().accessControl;

  router.use(async (req, res, next) => {
    try {
      const orgId = await getOrgId(req);
      await accessControl.enforceComplianceAccess({
        userId: req.user?.id,
        organizationId: orgId,
      });
      next();
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Plan gate denied compliance access');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to authorize compliance access',
      });
    }
  });

  router.get('/readiness', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceProfileQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid compliance readiness query',
        });
      }

      const readiness = await readinessService.getScopeReadiness({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
      });
      res.json(readiness);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load compliance readiness');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to load compliance readiness',
      });
    }
  });

  router.get('/control-states', requirePrimaryOrgContext, requireCapability('compliance.read'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceControlStateQuerySchema.safeParse(req.query);
      if (!parsedQuery.success || !parsedQuery.data.scopeId) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.success
            ? 'scopeId is required'
            : parsedQuery.error.issues[0]?.message ?? 'Invalid compliance control state query',
        });
      }
      const states = await controlStateService.listExplicitStates({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId,
        frameworkKey: parsedQuery.data.framework ?? null,
      });
      res.json({ states });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load compliance control states');
      sendApiError(res, {
        code: err.message === 'Scope not found' ? ERROR_CODES.RESOURCE_NOT_FOUND : ERROR_CODES.INTERNAL_UNEXPECTED,
        message: err.message === 'Scope not found' ? 'Scope not found' : 'Failed to load compliance control states',
      });
    }
  });

  router.get(
    '/control-states/:frameworkKey/:controlId/history',
    requirePrimaryOrgContext,
    requireCapability('compliance.read'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const frameworkParse = z.enum(COMPLIANCE_FRAMEWORK_KEYS).safeParse(req.params.frameworkKey);
        if (!frameworkParse.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid compliance framework',
          });
        }
        const framework = frameworkParse.data;
        const controlParam = decodeURIComponent(req.params.controlId).trim();
        const targetResourceId = `${framework}:${controlParam}`.toLowerCase();
        const targetControl = controlParam.toLowerCase();
        // Include per-control updates AND group bulk updates that touched this control.
        const events = await auditService.list(orgId, {
          actionPrefix: 'compliance.control_state',
          limit: 300,
        });
        const timeline = events
          .filter((event) => {
            if (event.resourceType === 'compliance_control') {
              return (event.resourceId ?? '').toLowerCase() === targetResourceId;
            }
            if (event.resourceType === 'compliance_control_group') {
              if ((event.resourceId ?? '').toLowerCase() !== framework.toLowerCase()) return false;
              const changes = event.changes as { controlIds?: unknown } | null;
              const ids = Array.isArray(changes?.controlIds) ? changes!.controlIds : [];
              return ids.some((id) => String(id).toLowerCase() === targetControl);
            }
            return false;
          })
          .map((event) => ({
            id: event.id,
            actorId: event.actorId,
            actorType: event.actorType,
            action: event.action,
            changes: event.changes ?? null,
            createdAt: event.createdAt,
          }));
        res.json({ events: timeline });
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err }, '[compliance] Failed to load compliance control history');
        sendApiError(res, {
          code: ERROR_CODES.INTERNAL_UNEXPECTED,
          message: 'Failed to load compliance control history',
        });
      }
    },
  );

  router.put(
    '/control-states/:frameworkKey/:controlId',
    requirePrimaryOrgContext,
    requireCapability('compliance.manage'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const frameworkParse = z.enum(COMPLIANCE_FRAMEWORK_KEYS).safeParse(req.params.frameworkKey);
        if (!frameworkParse.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid compliance framework',
          });
        }
        const parsedBody = ComplianceControlStateUpdateBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance control state payload',
          });
        }
        const state = await controlStateService.upsertState({
          organizationId: orgId,
          scopeId: parsedBody.data.scopeId,
          frameworkKey: frameworkParse.data,
          controlId: req.params.controlId,
          state: parsedBody.data.state,
          exclusionReason: parsedBody.data.exclusionReason ?? null,
          assignedToUserId: parsedBody.data.assignedToUserId ?? null,
          actorUserId: req.user?.id ?? null,
        });
        res.json({ state });
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err }, '[compliance] Failed to update compliance control state');
        const isValidation = [
          'Exclusion reason is required when excluding a compliance control',
          'Assigned user is not a member of this organization',
        ].includes(err.message) || err.message.startsWith('Unknown compliance control') || err.message.startsWith('Unsupported compliance framework');
        sendApiError(res, {
          code: err.message === 'Scope not found'
            ? ERROR_CODES.RESOURCE_NOT_FOUND
            : isValidation
              ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
              : ERROR_CODES.INTERNAL_UNEXPECTED,
          message: err.message === 'Scope not found' || isValidation
            ? err.message
            : 'Failed to update compliance control state',
        });
      }
    },
  );

  router.put(
    '/control-states-bulk/:frameworkKey',
    requirePrimaryOrgContext,
    requireCapability('compliance.manage'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const frameworkParse = z.enum(COMPLIANCE_FRAMEWORK_KEYS).safeParse(req.params.frameworkKey);
        if (!frameworkParse.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid compliance framework',
          });
        }
        const parsedBody = ComplianceControlStateBulkUpdateBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance control state payload',
          });
        }
        const states = await controlStateService.bulkUpsertState({
          organizationId: orgId,
          scopeId: parsedBody.data.scopeId,
          frameworkKey: frameworkParse.data,
          controlIds: parsedBody.data.controlIds,
          state: parsedBody.data.state,
          exclusionReason: parsedBody.data.exclusionReason ?? null,
          actorUserId: req.user?.id ?? null,
        });
        if (req.user?.id) {
          await auditService.log({
            organizationId: orgId,
            actorId: req.user.id,
            actorType: 'user',
            action: 'compliance.control_state.bulk_updated',
            resourceType: 'compliance_control_group',
            resourceId: frameworkParse.data,
            changes: {
              state: parsedBody.data.state,
              exclusionReason: parsedBody.data.exclusionReason ?? null,
              controlIds: states.map((state) => state.controlId),
            },
            metadata: buildAuditMetadata(req),
          });
        }
        res.json({ states, updatedCount: states.length });
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err }, '[compliance] Failed to bulk update compliance control states');
        const isValidation = [
          'At least one compliance control is required',
          'Cannot update more than 100 compliance controls at once',
          'Exclusion reason is required when excluding a compliance control',
        ].includes(err.message) || err.message.startsWith('Unknown compliance control') || err.message.startsWith('Unsupported compliance framework');
        sendApiError(res, {
          code: err.message === 'Scope not found'
            ? ERROR_CODES.RESOURCE_NOT_FOUND
            : isValidation
              ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
              : ERROR_CODES.INTERNAL_UNEXPECTED,
          message: err.message === 'Scope not found' || isValidation
            ? err.message
            : 'Failed to bulk update compliance control states',
        });
      }
    },
  );

  router.post(
    '/control-requests/:requestId/fulfill',
    requirePrimaryOrgContext,
    requireCapability('compliance.evidence.write'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const requestId = z.string().uuid().safeParse(req.params.requestId);
        if (!requestId.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid compliance control request id',
          });
        }
        const parsedBody = ComplianceControlRequestFulfillBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance request fulfillment payload',
          });
        }
        const result = await controlRequestService.fulfill({
          userId: req.user?.id ?? '',
          organizationId: orgId,
          requestId: requestId.data,
          input: parsedBody.data,
        });
        res.json(result);
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err, requestId: req.params.requestId }, '[compliance] Failed to fulfill control request');
        const isValidation = [
          'Compliance control request not found',
          'Compliance evidence item not found',
          'Compliance evidence item is outside the request scope',
          'Compliance evidence item is not mapped to this requested control',
        ].includes(err.message) || err.message.startsWith('Compliance control request is already');
        sendApiError(res, {
          code: err.message === 'Compliance control request not found' || err.message === 'Compliance evidence item not found'
            ? ERROR_CODES.RESOURCE_NOT_FOUND
            : isValidation
              ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
              : ERROR_CODES.INTERNAL_UNEXPECTED,
          message: isValidation ? err.message : 'Failed to fulfill compliance control request',
        });
      }
    },
  );

  router.post(
    '/control-requests/:requestId/review',
    requirePrimaryOrgContext,
    requireCapability('compliance.manage'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const requestId = z.string().uuid().safeParse(req.params.requestId);
        if (!requestId.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid compliance control request id',
          });
        }
        const parsedBody = ComplianceControlRequestReviewBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance request review payload',
          });
        }
        const result = await controlRequestService.review({
          actorId: req.user?.id ?? '',
          actorType: 'operator',
          organizationId: orgId,
          requestId: requestId.data,
          input: parsedBody.data,
        });
        res.json(result);
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err, requestId: req.params.requestId }, '[compliance] Failed to review control request');
        const isValidation = [
          'Compliance control request not found',
          'Compliance control check not found',
          'Compliance control check does not review this request control',
          'Compliance request review must be backed by an evidence-review control check',
          'Compliance control check is not from the current review run',
          'nextReverificationAt must be in the future',
        ].includes(err.message) || err.message.startsWith('Compliance control request is already');
        sendApiError(res, {
          code: err.message === 'Compliance control request not found' || err.message === 'Compliance control check not found'
            ? ERROR_CODES.RESOURCE_NOT_FOUND
            : isValidation
              ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
              : ERROR_CODES.INTERNAL_UNEXPECTED,
          message: isValidation ? err.message : 'Failed to review compliance control request',
        });
      }
    },
  );

  router.get('/profile', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceProfileQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid compliance profile query',
        });
      }

      const readiness = await readinessService.getScopeReadiness({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
      });
      const selectionSources = new Set(readiness.selectedFrameworks.flatMap((framework) => framework.sources));
      const hasScopeProfile = selectionSources.has('scope_profile');
      const hasOrganizationProfile = selectionSources.has('organization_profile');
      const hasLegacyContext =
        selectionSources.has('organization_context') || selectionSources.has('scope_roe');
      const source = hasScopeProfile || hasOrganizationProfile
        ? 'structured_profile'
        : hasLegacyContext
          ? 'legacy_context'
          : 'none';
      const scopeBinding = parsedQuery.data.scopeId
        ? hasScopeProfile
          ? 'scope_profile_override'
          : hasOrganizationProfile
            ? 'inherited_organization_profile'
            : hasLegacyContext
              ? 'legacy_scope_or_org_context'
              : 'none'
        : hasOrganizationProfile
          ? 'organization_profile'
          : hasLegacyContext
            ? 'legacy_organization_context'
            : 'none';

      res.json({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
        frameworkKeys: readiness.selectedFrameworks.map((framework) => framework.key),
        selectedFrameworks: readiness.selectedFrameworks,
        supportedFrameworks: readiness.supportedFrameworks,
        selectedCategories: Object.fromEntries(
          readiness.selectedFrameworks
            .map((framework) => [framework.key, FRAMEWORK_REGISTRY[framework.key]?.categories ?? []] as const)
            .filter(([, categories]) => categories.length > 0),
        ),
        evidenceBoundary: 'agent_proven_plus_reviewed_user_evidence',
        runInfluenceMode: readiness.selectedFrameworks.length > 0 ? 'prioritize_agent_provable' : 'off',
        scopeBinding,
        source,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load compliance profile');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to load compliance profile',
      });
    }
  });

  router.get('/reports', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceReportHistoryQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid compliance report history query',
        });
      }

      const reports = await readinessService.listReportHistory({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
        framework: parsedQuery.data.framework,
        limit: parsedQuery.data.limit ? Number(parsedQuery.data.limit) : undefined,
      });
      res.json({ reports });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load compliance report history');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to load compliance report history',
      });
    }
  });

  router.get('/evidence', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceEvidenceQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid compliance evidence query',
        });
      }

      const evidence = await evidenceService.listEvidenceItems({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
        framework: parsedQuery.data.framework,
        status: parsedQuery.data.status,
        sourceType: parsedQuery.data.sourceType,
        limit: parsedQuery.data.limit ? Number(parsedQuery.data.limit) : undefined,
      });
      res.json({ evidence });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load compliance evidence');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to load compliance evidence',
      });
    }
  });

  router.get(
    '/evidence/:id/file',
    requireComplianceEvidenceOrgContext(),
    requireCapability('compliance.read'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const evidence = await evidenceService.getEvidenceItem({
        organizationId: orgId,
        evidenceItemId: req.params.id,
      });
      if (!evidence) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Compliance evidence item not found',
        });
      }

      const artifact = evidence.artifact ?? {};
      if (!artifact.storageRef || !artifact.fileName) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Compliance evidence file is not available',
        });
      }

      const absolutePath = resolveComplianceEvidenceStoragePath(artifact.storageRef);
      res.download(absolutePath, artifact.fileName);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, evidenceId: req.params.id }, '[compliance] Failed to download compliance evidence file');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: err.message || 'Failed to download compliance evidence file',
      });
    }
    },
  );

  router.get('/missing-evidence', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = ComplianceProfileQuerySchema.extend({
        framework: z.enum(COMPLIANCE_FRAMEWORK_KEYS).optional(),
      }).safeParse(req.query);
      if (!parsedQuery.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid missing evidence query',
        });
      }

      const missing = await evidenceService.listMissingEvidence({
        organizationId: orgId,
        scopeId: parsedQuery.data.scopeId ?? null,
        framework: parsedQuery.data.framework,
      });
      res.json({ missing });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to load missing compliance evidence');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to load missing compliance evidence',
      });
    }
  });

  router.post('/evidence', requirePrimaryOrgContext, requireCapability('compliance.evidence.write'), async (req, res) => {
    let uploadedFilePath: string | null = null;
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const isMultipart = Boolean(req.is('multipart/form-data'));
      let bodyPayload: unknown = req.body;

      if (isMultipart) {
        await runEvidenceUpload(req, res);
        const uploadRequest = req as Request & { file?: Express.Multer.File };
        if (!uploadRequest.file) {
          logger.warn(
            {
              contentType: req.get('content-type') ?? null,
              bodyFields: Object.keys((req.body ?? {}) as Record<string, unknown>),
            },
            '[compliance] Evidence upload rejected because file part is missing',
          );
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
            message: 'Compliance evidence upload requires a file',
          });
        }

        const preparedUpload = prepareUploadedEvidenceArtifact(orgId, uploadRequest.file);
        uploadedFilePath = preparedUpload.absolutePath;
        bodyPayload = {
          ...(parseMultipartEvidenceBody(req) as Record<string, unknown>),
          artifact: preparedUpload.artifact,
        };
      }

      const parsedBody = ComplianceEvidenceCreateBodySchema.safeParse(bodyPayload);
      if (!parsedBody.success) {
        logger.warn(
          {
            isMultipart,
            contentType: req.get('content-type') ?? null,
            issues: parsedBody.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            bodyFields:
              bodyPayload && typeof bodyPayload === 'object' && !Array.isArray(bodyPayload)
                ? Object.keys(bodyPayload as Record<string, unknown>)
                : [],
          },
          '[compliance] Evidence upload payload validation failed',
        );
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance evidence payload',
        });
      }
      const sourceType = parsedBody.data.sourceType ?? 'user_upload';
      if (sourceType !== 'user_upload') {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Direct compliance evidence uploads must use sourceType user_upload',
        });
      }
      if (!isMultipart) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'User-submitted compliance evidence requires multipart file upload',
        });
      }
      const evidenceScopeId = parsedBody.data.scopeId;

      if (uploadedFilePath) {
        await fs.mkdir(path.dirname(uploadedFilePath), { recursive: true });
        const uploadRequest = req as Request & { file?: Express.Multer.File };
        await fs.writeFile(uploadedFilePath, uploadRequest.file!.buffer);
      }

      const evidence = await evidenceService.createEvidenceItem({
        organizationId: orgId,
        scopeId: evidenceScopeId,
        uploadedBy: actorId,
        title: parsedBody.data.title,
        description: parsedBody.data.description ?? null,
        sourceType: parsedBody.data.sourceType,
        evidenceType: parsedBody.data.evidenceType,
        owner: parsedBody.data.owner ?? null,
        artifact: parsedBody.data.artifact,
        metadata: parsedBody.data.metadata ?? {},
        observationStartedAt: parsedBody.data.observationStartedAt ?? null,
        observationEndedAt: parsedBody.data.observationEndedAt ?? null,
        validUntil: parsedBody.data.validUntil ?? null,
        mappings: parsedBody.data.mappings,
      });
      uploadedFilePath = null;

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'compliance.evidence.created',
            resourceType: 'compliance_evidence_item',
            resourceId: evidence.id,
            changes: {
              title: evidence.title,
              status: evidence.status,
              scopeId: evidence.scopeId,
              mappings: evidence.mappings.map((mapping) => ({
                frameworkKey: mapping.frameworkKey,
                controlId: mapping.controlId,
              })),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          logger.error({ err: toAppError(auditError), evidenceId: evidence.id }, '[compliance] Failed to write evidence audit log');
        }
      }

      res.status(201).json({ evidence });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to create compliance evidence');
      await deleteUploadedEvidenceFile(uploadedFilePath);
      if (error instanceof multer.MulterError) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? `Compliance evidence file exceeds ${Math.floor(EVIDENCE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`
              : error.message,
        });
      }
      sendApiError(res, {
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        message: err.message || 'Failed to create compliance evidence',
      });
    }
  });

  router.post(
    '/evidence/from-finding',
    requirePrimaryOrgContext,
    requireCapability('compliance.evidence.write'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const parsedBody = ComplianceEvidenceFromFindingBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid finding evidence payload',
        });
      }

      const evidence = await evidenceService.createEvidenceFromFinding({
        organizationId: orgId,
        scopeId: parsedBody.data.scopeId ?? null,
        uploadedBy: actorId,
        findingId: parsedBody.data.findingId,
        mappings: parsedBody.data.mappings,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'compliance.evidence.created_from_finding',
            resourceType: 'compliance_evidence_item',
            resourceId: evidence.id,
            changes: {
              findingId: parsedBody.data.findingId,
              mappings: evidence.mappings.map((mapping) => ({
                frameworkKey: mapping.frameworkKey,
                controlId: mapping.controlId,
              })),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          logger.error({ err: toAppError(auditError), evidenceId: evidence.id }, '[compliance] Failed to write finding evidence audit log');
        }
      }

      res.status(201).json({ evidence });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to create evidence from finding');
      sendApiError(res, {
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        message: err.message || 'Failed to create evidence from finding',
      });
    }
    },
  );

  router.put(
    '/evidence/:id',
    requireComplianceEvidenceOrgContext(),
    requireCapability('compliance.evidence.write'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const actorId = req.user?.id ?? null;
        const parsedParams = z.object({ id: z.string().uuid() }).safeParse(req.params);
        if (!parsedParams.success) {
          return sendApiError(res, { code: ERROR_CODES.VALIDATION_INVALID_FORMAT, message: 'Invalid evidence id' });
        }
        const parsedBody = ComplianceEvidenceUpdateBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance evidence update payload',
          });
        }

        const evidence = await evidenceService.updateEvidenceItem({
          organizationId: orgId,
          evidenceItemId: parsedParams.data.id,
          actorUserId: actorId,
          title: parsedBody.data.title,
          description: parsedBody.data.description ?? null,
          evidenceType: parsedBody.data.evidenceType,
          owner: parsedBody.data.owner ?? null,
          observationStartedAt: parsedBody.data.observationStartedAt ?? null,
          observationEndedAt: parsedBody.data.observationEndedAt ?? null,
          validUntil: parsedBody.data.validUntil ?? null,
          mappings: parsedBody.data.mappings,
        });

        if (actorId) {
          try {
            await auditService.log({
              organizationId: orgId,
              actorId,
              actorType: 'user',
              action: 'compliance.evidence.updated',
              resourceType: 'compliance_evidence_item',
              resourceId: evidence.id,
              changes: {
                title: evidence.title,
                evidenceType: evidence.evidenceType,
                validUntil: evidence.validUntil?.toISOString() ?? null,
                mappings: evidence.mappings.map((mapping) => ({
                  frameworkKey: mapping.frameworkKey,
                  controlId: mapping.controlId,
                  mappingSource: mapping.mappingSource,
                  confidence: mapping.confidence,
                })),
              },
              metadata: buildAuditMetadata(req),
            });
          } catch (auditError) {
            logger.error({ err: toAppError(auditError), evidenceId: evidence.id }, '[compliance] Failed to write evidence update audit log');
          }
        }

        res.json({ evidence });
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err, evidenceId: req.params.id }, '[compliance] Failed to update compliance evidence item');
        const isValidation = err.message === 'Compliance evidence item not found' ||
          err.message.startsWith('Control ') ||
          err.message.startsWith('Unsupported compliance framework') ||
          err.message === 'At least one compliance evidence mapping is required';
        sendApiError(res, {
          code: err.message === 'Compliance evidence item not found'
            ? ERROR_CODES.RESOURCE_NOT_FOUND
            : isValidation
              ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
              : ERROR_CODES.INTERNAL_UNEXPECTED,
          message: isValidation ? err.message : 'Failed to update compliance evidence item',
        });
      }
    },
  );

  router.delete(
    '/evidence/:id',
    requireComplianceEvidenceOrgContext(),
    requireCapability('compliance.evidence.write'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const actorId = req.user?.id ?? null;
        const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
        if (!parsed.success) {
          return sendApiError(res, { code: ERROR_CODES.VALIDATION_INVALID_FORMAT, message: 'Invalid evidence id' });
        }
        const evidence = await evidenceService.getEvidenceItem({ organizationId: orgId, evidenceItemId: parsed.data.id });
        if (!evidence) {
          return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Evidence item not found' });
        }
        const deleted = await evidenceService.deleteEvidenceItem({ organizationId: orgId, evidenceItemId: parsed.data.id });
        if (!deleted) {
          return sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Evidence item not found' });
        }
        const artifact = evidence.artifact ?? {};
        if (artifact.storageRef) {
          await deleteUploadedEvidenceFile(resolveComplianceEvidenceStoragePath(artifact.storageRef));
        }
        if (actorId) {
          try {
            await auditService.log({
              organizationId: orgId,
              actorId,
              actorType: 'user',
              action: 'compliance.evidence.deleted',
              resourceType: 'compliance_evidence_item',
              resourceId: evidence.id,
              changes: {
                title: evidence.title,
                mappings: evidence.mappings.map((mapping) => ({
                  frameworkKey: mapping.frameworkKey,
                  controlId: mapping.controlId,
                })),
              },
              metadata: buildAuditMetadata(req),
            });
          } catch (auditError) {
            logger.error({ err: toAppError(auditError), evidenceId: evidence.id }, '[compliance] Failed to write evidence deletion audit log');
          }
        }
        res.json({ deleted: true });
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err }, '[compliance] Failed to delete evidence item');
        sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to delete evidence item' });
      }
    },
  );

  router.put(
    '/evidence/:id/mappings',
    requireComplianceEvidenceOrgContext(),
    requireCapability('compliance.evidence.write'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const parsedParams = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!parsedParams.success) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_INVALID_FORMAT, message: 'Invalid evidence id' });
      }
      const parsedBody = ComplianceEvidenceMappingsUpsertBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid compliance evidence mapping payload',
        });
      }

      const evidence = await evidenceService.upsertEvidenceMappings({
        organizationId: orgId,
        evidenceItemId: parsedParams.data.id,
        actorUserId: actorId,
        mappings: parsedBody.data.mappings,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'compliance.evidence.mappings_updated',
            resourceType: 'compliance_evidence_item',
            resourceId: evidence.id,
            changes: {
              mappings: parsedBody.data.mappings.map((mapping) => ({
                frameworkKey: mapping.frameworkKey,
                controlId: mapping.controlId,
                mappingSource: mapping.mappingSource ?? 'user_declared',
                confidence: mapping.confidence ?? 'medium',
              })),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          logger.error({ err: toAppError(auditError), evidenceId: evidence.id }, '[compliance] Failed to write evidence mapping audit log');
        }
      }

      res.json({ evidence });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, evidenceId: req.params.id }, '[compliance] Failed to update compliance evidence mappings');
      const isValidation = err.message === 'Compliance evidence item not found' ||
        err.message.startsWith('Control ') ||
        err.message.startsWith('Unsupported compliance framework');
      sendApiError(res, {
        code: err.message === 'Compliance evidence item not found'
          ? ERROR_CODES.RESOURCE_NOT_FOUND
          : isValidation
            ? ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
            : ERROR_CODES.INTERNAL_UNEXPECTED,
        message: isValidation ? err.message : 'Failed to update compliance evidence mappings',
      });
    }
    },
  );

  router.post('/accepted-risks', requirePrimaryOrgContext, requireCapability('compliance.manage'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const parsedBody = ComplianceAcceptedRiskCreateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid accepted risk payload',
        });
      }

      const acceptedRisk = await evidenceService.createAcceptedRisk({
        organizationId: orgId,
        scopeId: parsedBody.data.scopeId ?? null,
        approvedBy: actorId,
        frameworkKey: parsedBody.data.frameworkKey,
        controlId: parsedBody.data.controlId,
        evidenceItemId: parsedBody.data.evidenceItemId ?? null,
        owner: parsedBody.data.owner,
        rationale: parsedBody.data.rationale,
        expiresAt: parsedBody.data.expiresAt,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'compliance.accepted_risk.created',
            resourceType: 'compliance_accepted_risk',
            resourceId: acceptedRisk.id,
            changes: {
              frameworkKey: acceptedRisk.frameworkKey,
              controlId: acceptedRisk.controlId,
              expiresAt: acceptedRisk.expiresAt.toISOString(),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          logger.error({ err: toAppError(auditError), acceptedRiskId: acceptedRisk.id }, '[compliance] Failed to write accepted risk audit log');
        }
      }

      res.status(201).json({ acceptedRisk });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[compliance] Failed to create accepted risk');
      sendApiError(res, {
        code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        message: err.message || 'Failed to create accepted risk',
      });
    }
  });

  return router;
}
