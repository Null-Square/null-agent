import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { createPlatformKernel } from '@/app/platform/kernel';
import { db } from '@/db/client';
import { inventoryNotes } from '@/db/schema';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import type {
  ScopeTargetType,
  ScopeTargetVerificationMethod,
} from '@/domains/security-ops/scopes/ScopeService';
import { ScopeBoundaryService } from '@/domains/security-ops/scopes/ScopeBoundaryService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { ScopeAuthorizationRecorder } from '@/domains/security-ops/scopes/ScopeAuthorizationRecorder';
import {
  CodeSourceService,
  toPublicCodeSource,
} from '@/domains/security-ops/code-sources/CodeSourceService';
import { CodeSourceBodySchema } from './scopes.schemas';
import {
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_AUTHORIZATION_STATEMENT_VERSION,
} from '@/domains/security-ops/scopes/scopeAuthorization';
import {
  ScopeDocumentService,
  SCOPE_DOCUMENT_UPLOAD_MAX_BYTES,
} from '@/domains/security-ops/setup/ScopeDocumentService';
import { parseComplianceFrameworkKeysInput } from '@/domains/security-ops/compliance/profile';
import type { ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  requireScopeOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import { sendApiError, ERROR_CODES } from '@/shared/errors';
import { toAppError } from '@/shared/errors';
import type { ErrorCodeValue } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isDevOnlyFeatureEnabled } from '@/shared/devOnly';
import { rateLimit } from '@/shared/ratelimit';
import { and, desc, eq, isNull } from 'drizzle-orm';

const orgService = new OrganizationService(db);
const scopeService = new ScopeService(db);
const scopeAccessMaterialService = new ScopeAccessMaterialService(db);
const scopeDocumentService = new ScopeDocumentService(db);
const codeSourceService = new CodeSourceService(db);
const auditService = new AuditService(db);
const scopeDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SCOPE_DOCUMENT_UPLOAD_MAX_BYTES,
    files: 1,
  },
});
const MAX_MISSION_LENGTH = 2_000;
const targetVerificationLimit = rateLimit({
  name: 'scopes:target-verification',
  max: 30,
  windowMs: 10 * 60_000,
  keyGenerator: (req) => {
    const authenticated = req as Request & {
      organizationId?: string;
      user?: { id?: string };
    };
    return `${authenticated.organizationId ?? 'no-org'}:${authenticated.user?.id ?? req.ip ?? 'anonymous'}`;
  },
});
const VALID_IMPACT_TOLERANCES = new Set<'non_destructive' | 'poc' | 'full'>([
  'non_destructive',
  'poc',
  'full',
]);

const firstString = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value : undefined;
};

const runScopeDocumentUpload = (req: Request, res: Response): Promise<void> =>
  new Promise((resolve, reject) => {
    scopeDocumentUpload.single('file')(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const isScopeAutoVerifyEnabled = (): boolean =>
  isDevOnlyFeatureEnabled();

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const normalizeOptionalDocument = (
  raw: unknown,
  fieldName: string,
  maxLength: number,
): { valid: true; value: string | null | undefined } | { valid: false; code: ErrorCodeValue; message: string } => {
  if (raw === undefined) {
    return { valid: true, value: undefined };
  }
  if (raw === null) {
    return { valid: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: `${fieldName} must be a string or null`,
    };
  }

  const normalized = raw.trim();
  if (normalized.length > maxLength) {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      message: `${fieldName} must be ${maxLength} characters or fewer`,
    };
  }

  return { valid: true, value: normalized.length > 0 ? normalized : null };
};

const normalizeOptionalEnum = <T extends string>(
  raw: unknown,
  fieldName: string,
  allowed: ReadonlySet<T>,
): { valid: true; value: T | undefined } | { valid: false; code: ErrorCodeValue; message: string } => {
  if (raw === undefined) {
    return { valid: true, value: undefined };
  }
  if (typeof raw !== 'string' || !allowed.has(raw as T)) {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: `${fieldName} must be one of: ${[...allowed].join(', ')}`,
    };
  }
  return { valid: true, value: raw as T };
};

type EngagementBriefFields = {
  mission?: string | null;
  impactTolerance?: 'non_destructive' | 'poc' | 'full';
  complianceFrameworks?: ComplianceFrameworkKey[] | null;
};

const parseEngagementBrief = (
  body: Record<string, unknown>,
):
  | { valid: true; fields: EngagementBriefFields }
  | { valid: false; code: ErrorCodeValue; message: string } => {
  const out: EngagementBriefFields = {};

  const mission = normalizeOptionalDocument(body.mission, 'mission', MAX_MISSION_LENGTH);
  if (!mission.valid) return mission;
  if (mission.value !== undefined) out.mission = mission.value;

  const impact = normalizeOptionalEnum(body.impactTolerance, 'impactTolerance', VALID_IMPACT_TOLERANCES);
  if (!impact.valid) return impact;
  if (impact.value !== undefined) out.impactTolerance = impact.value;

  const complianceFrameworks = parseComplianceFrameworkKeysInput(
    body.complianceFrameworks,
    'complianceFrameworks',
    { allowNull: true },
  );
  if (!complianceFrameworks.valid) {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: complianceFrameworks.message,
    };
  }
  if (complianceFrameworks.value !== undefined) {
    out.complianceFrameworks = complianceFrameworks.value;
  }

  return { valid: true, fields: out };
};

const buildAccessMaterialAuditSnapshot = (material: {
  id: string;
  kind: string;
  label: string;
  username: string | null;
  headerName: string | null;
  notes: string | null;
  appliesToHosts: string[];
  lastUsedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}) => ({
  id: material.id,
  kind: material.kind,
  label: material.label,
  username: material.username,
  headerName: material.headerName,
  notes: material.notes,
  appliesToHosts: material.appliesToHosts,
  lastUsedAt: material.lastUsedAt,
  createdAt: material.createdAt,
  updatedAt: material.updatedAt,
});

const buildScopeDocumentAuditSnapshot = (document: {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string | null;
  byteSize: number;
  sha256: string;
  parseStatus: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}) => ({
  id: document.id,
  kind: document.kind,
  fileName: document.fileName,
  mimeType: document.mimeType,
  byteSize: document.byteSize,
  sha256: document.sha256,
  parseStatus: document.parseStatus,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

export function createScopesRouter(): Router {
  const router = Router();
  const accessControl = createPlatformKernel().accessControl;

  router.use(authMiddleware);

  // Helper: resolve orgId from authenticated user
  async function getOrgId(req: { user?: { id: string }; organizationId?: string }): Promise<string> {
    if (req.organizationId) return req.organizationId;
    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    req.organizationId = org.id;
    return org.id;
  }

  /* The customer accepted the statement. Read once, here, so no route re-derives it. */
  const statementAccepted = (body: unknown): boolean =>
    Boolean((body as { authorization?: { accepted?: unknown } } | null)?.authorization?.accepted === true);

  /**
   * The boundary edits a single Save carries.
   *
   * The scope page stages every change locally and commits them together, so
   * one revision of the contract is written and one statement covers it. Sent
   * as separate requests these were separate revisions, each racing the others
   * for what the widening check compared against.
   */
  type BoundaryEdit = {
    targets: { add: Array<{ type: string; value: string; verificationMethod?: string }>; remove: string[] };
    exclusions: { add: Array<{ type: 'domain' | 'cidr'; value: string }>; remove: string[] };
  };

  const parseBoundaryEdit = (
    body: unknown,
  ): { valid: true; edit: BoundaryEdit } | { valid: false; message: string } => {
    const source = (body ?? {}) as {
      targets?: { add?: unknown; remove?: unknown };
      exclusions?: { add?: unknown; remove?: unknown };
    };
    const edit: BoundaryEdit = { targets: { add: [], remove: [] }, exclusions: { add: [], remove: [] } };

    /* `targets` is a batch only when it is an object carrying add/remove. The
       array form belongs to POST /scopes and is not this route's business. */
    if (source.targets && !Array.isArray(source.targets)) {
      for (const raw of Array.isArray(source.targets.add) ? source.targets.add : []) {
        const candidate = raw as { type?: unknown; value?: unknown; verificationMethod?: unknown };
        if (typeof candidate.type !== 'string' || typeof candidate.value !== 'string' || !candidate.value.trim()) {
          return { valid: false, message: 'Each added target needs a type and a value.' };
        }
        edit.targets.add.push({
          type: candidate.type,
          value: candidate.value,
          ...(typeof candidate.verificationMethod === 'string'
            ? { verificationMethod: candidate.verificationMethod }
            : {}),
        });
      }
      for (const raw of Array.isArray(source.targets.remove) ? source.targets.remove : []) {
        if (typeof raw !== 'string') return { valid: false, message: 'Removed target ids must be strings.' };
        edit.targets.remove.push(raw);
      }
    }

    if (source.exclusions && !Array.isArray(source.exclusions)) {
      for (const raw of Array.isArray(source.exclusions.add) ? source.exclusions.add : []) {
        const candidate = raw as { type?: unknown; value?: unknown };
        if ((candidate.type !== 'domain' && candidate.type !== 'cidr') || typeof candidate.value !== 'string') {
          return { valid: false, message: 'Each added exclusion needs type domain or cidr and a value.' };
        }
        edit.exclusions.add.push({ type: candidate.type, value: candidate.value });
      }
      for (const raw of Array.isArray(source.exclusions.remove) ? source.exclusions.remove : []) {
        if (typeof raw !== 'string') return { valid: false, message: 'Removed exclusion ids must be strings.' };
        edit.exclusions.remove.push(raw);
      }
    }

    return { valid: true, edit };
  };

  const isEmptyBoundaryEdit = (edit: BoundaryEdit): boolean =>
    edit.targets.add.length === 0 &&
    edit.targets.remove.length === 0 &&
    edit.exclusions.add.length === 0 &&
    edit.exclusions.remove.length === 0;

  async function ensureScopeOwned(req: { user?: { id: string }; organizationId?: string }, scopeId: string): Promise<string> {
    const orgId = await getOrgId(req);
    await scopeService.getById(orgId, scopeId);
    return orgId;
  }

  // GET /api/app/scopes — list scopes
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const list = await scopeService.list(orgId);
      res.json(list);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to list scopes');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to list scopes' });
    }
  });

  // POST /api/app/scopes — create scope
  router.post('/', requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const { name } = req.body;

      if (!name) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_MISSING_REQUIRED, message: 'name is required' });
      }

      const brief = parseEngagementBrief(req.body);
      if (!brief.valid) {
        return sendApiError(res, { code: brief.code, message: brief.message });
      }
      const activeScopeCount = await scopeService.countActive(orgId);
      await accessControl.enforceScopeCreation({
        userId: actorId ?? undefined,
        organizationId: orgId,
        activeScopeCount,
      });

      /* Create the scope, its targets and the customer's statement in one
         transaction. Onboarding previously issued create-then-addTarget as two
         requests, which is why the wizard carries `resumableEmptyScope`: a
         failure between them left a scope with no target. */
      const requestedTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
      const accepted = statementAccepted(req.body);

      const scope = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db;
        const txScopeService = new ScopeService(tx);
        const created = await txScopeService.create(orgId, {
          name,
          ...brief.fields,
        });

        const createdTargets = [];
        for (const target of requestedTargets) {
          createdTargets.push(await txScopeService.addTarget(created.id, {
            type: target.type,
            value: target.value,
            ...(target.verificationMethod ? { verificationMethod: target.verificationMethod } : {}),
          }));
        }

        if (accepted && actorId) {
          const recorder = new ScopeAuthorizationRecorder(tx);
          await recorder.record({
            organizationId: orgId,
            scopeId: created.id,
            actorId,
            trigger: 'scope_created',
            contract: await recorder.readContract(created.id),
          });
        }

        /* Returned so the caller need not re-query to learn the target it just asked for. */
        return { ...created, targets: createdTargets };
      });


      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.created',
            resourceType: 'scope',
            resourceId: scope.id,
            changes: {
              after: {
                name: scope.name,
                executionNetwork: scope.executionNetwork,
                mission: scope.mission,
                impactTolerance: scope.impactTolerance,
                complianceFrameworks: scope.complianceFrameworks,
                status: scope.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, scopeId: scope.id }, '[scopes] Failed to write audit log for scope create');
        }
      }

      res.status(201).json(scope);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to create scope');
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
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to create scope' });
    }
  });

  // GET /api/app/scopes/:id — get scope detail
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await scopeService.getById(orgId, req.params.id);
      res.json(detail);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to get scope');
      sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Scope not found' });
    }
  });

  /* The granular exclusion routes are gone. The scope page stages exclusion
     edits and commits them through PUT /:id, which applies them in the same
     transaction as the rest of the boundary and runs the widening check over
     the result. The DELETE route recorded a statement but never demanded one,
     so it was the one way to widen a scope without being asked. */

  /* The scope's code source: one folder or one git URL. CodeSourceService
     owns the row and the clone; these routes only translate HTTP. */
  const sendCodeSourceError = (res: Response, error: unknown, scopeId: string, action: string) => {
    const err = toAppError(error);
    logger.error({ err, scopeId }, `[scopes] Failed to ${action} code source`);
    sendApiError(res, {
      code: err.code,
      message: err.message,
      status: err.httpStatus,
      context: err.context,
      userMessage: err.message,
    });
  };

  const auditCodeSource = async (
    req: Request,
    orgId: string,
    action: string,
    changes: { before?: unknown; after?: unknown },
  ) => {
    const actorId = req.user?.id ?? null;
    if (!actorId) return;
    try {
      await auditService.log({
        organizationId: orgId,
        actorId,
        actorType: 'user',
        action,
        resourceType: 'scope',
        resourceId: req.params.id,
        changes,
        metadata: buildAuditMetadata(req),
      });
    } catch (auditError) {
      logger.error({ err: toAppError(auditError), scopeId: req.params.id }, `[scopes] Failed to write audit log for ${action}`);
    }
  };

  router.get('/:id/code-source', requireScopeOrgContext(), requireCapability('scopes.read'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      res.json({ codeSource: toPublicCodeSource(await codeSourceService.getForScope(orgId, req.params.id)) });
    } catch (error) {
      sendCodeSourceError(res, error, req.params.id, 'read');
    }
  });

  router.put('/:id/code-source', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const parsed = CodeSourceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsed.error.issues[0]?.message ?? 'Invalid code source',
        });
      }
      const before = toPublicCodeSource(await codeSourceService.getForScope(orgId, req.params.id));
      const codeSource = toPublicCodeSource(await codeSourceService.put(orgId, req.params.id, parsed.data));
      await auditCodeSource(req, orgId, 'scope.code_source.set', { before, after: codeSource });
      res.status(codeSource?.status === 'cloning' ? 202 : 200).json({ codeSource });
    } catch (error) {
      sendCodeSourceError(res, error, req.params.id, 'set');
    }
  });

  router.delete('/:id/code-source', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const removed = toPublicCodeSource(await codeSourceService.remove(orgId, req.params.id));
      if (removed) {
        await auditCodeSource(req, orgId, 'scope.code_source.removed', { before: removed });
      }
      res.status(204).end();
    } catch (error) {
      sendCodeSourceError(res, error, req.params.id, 'remove');
    }
  });

  router.post('/:id/code-source/refresh', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const codeSource = toPublicCodeSource(await codeSourceService.refresh(orgId, req.params.id));
      await auditCodeSource(req, orgId, 'scope.code_source.refreshed', { after: codeSource });
      res.status(codeSource?.status === 'cloning' ? 202 : 200).json({ codeSource });
    } catch (error) {
      sendCodeSourceError(res, error, req.params.id, 'refresh');
    }
  });

  router.get('/:id/documents', requireScopeOrgContext(), requireCapability('scopes.read'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const documents = await scopeDocumentService.listForScope(orgId, req.params.id);
      res.json({ documents });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id }, '[scopes] Failed to list scope documents');
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.post('/:id/documents', requireScopeOrgContext(), requireCapability('context.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      if (!req.is('multipart/form-data')) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Scope document upload requires multipart/form-data',
        });
      }

      await runScopeDocumentUpload(req, res);
      const uploadRequest = req as Request & { file?: Express.Multer.File };
      if (!uploadRequest.file) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'Scope document upload requires a file',
        });
      }

      const document = await scopeDocumentService.createFromUpload({
        organizationId: orgId,
        scopeId: req.params.id,
        uploadedByUserId: actorId,
        kind: firstString((req.body as Record<string, unknown> | undefined)?.kind) ?? 'other',
        file: uploadRequest.file,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.document.created',
            resourceType: 'scope_document',
            resourceId: document.id,
            changes: {
              after: buildScopeDocumentAuditSnapshot(document),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, scopeId: req.params.id, documentId: document.id }, '[scopes] Failed to write audit log for scope document create');
        }
      }

      res.status(201).json({ document });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id }, '[scopes] Failed to upload scope document');
      if (error instanceof multer.MulterError) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? `Scope document file exceeds ${Math.floor(SCOPE_DOCUMENT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`
              : error.message,
        });
      }
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.delete('/:id/documents/:documentId', requireScopeOrgContext(), requireCapability('context.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const document = await scopeDocumentService.deleteForScope({
        organizationId: orgId,
        scopeId: req.params.id,
        documentId: req.params.documentId,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.document.deleted',
            resourceType: 'scope_document',
            resourceId: document.id,
            changes: {
              before: buildScopeDocumentAuditSnapshot(document),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, scopeId: req.params.id, documentId: req.params.documentId }, '[scopes] Failed to write audit log for scope document delete');
        }
      }

      res.status(204).send();
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id, documentId: req.params.documentId }, '[scopes] Failed to delete scope document');
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  /* Read-only history for the scope page.
     Returns no status, no `current` flag and no staleness reason, so there is
     nothing here a client could turn back into a gate. */
  router.get('/:id/authorization-history', requireScopeOrgContext(), requireCapability('scopes.read'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const recorder = new ScopeAuthorizationRecorder(db);
      const [events, lastContract, currentContract] = await Promise.all([
        recorder.history(orgId, req.params.id),
        recorder.lastAuthorizedContract(orgId, req.params.id),
        recorder.readContract(req.params.id),
      ]);
      res.json({
        events,
        statement: {
          version: SCOPE_AUTHORIZATION_STATEMENT_VERSION,
          text: SCOPE_AUTHORIZATION_STATEMENT,
        },
        /* What the customer would be agreeing to if they saved right now. The
           client uses this to decide whether to render the checkbox — it is a
           form-shaping hint, never an execution condition. */
        currentContract,
        lastAuthorizedContract: lastContract,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id }, '[scopes] Failed to read authorization history');
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.get('/:id/access-materials', requireScopeOrgContext(), requireCapability('credentials.read'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const materials = await scopeAccessMaterialService.listForScope(orgId, req.params.id);
      res.json(materials);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id }, '[scopes] Failed to list access materials');
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.post('/:id/access-materials', requireScopeOrgContext(), requireCapability('credentials.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const material = await scopeAccessMaterialService.createForScope({
        orgId,
        scopeId: req.params.id,
        actorUserId: actorId,
        input: req.body,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.access_material.created',
            resourceType: 'scope_access_material',
            resourceId: material.id,
            changes: {
              after: buildAccessMaterialAuditSnapshot(material),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, scopeId: req.params.id, materialId: material.id },
            '[scopes] Failed to write audit log for access material create',
          );
        }
      }

      res.status(201).json(material);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, scopeId: req.params.id }, '[scopes] Failed to create access material');
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.put('/:id/access-materials/:materialId', requireScopeOrgContext(), requireCapability('credentials.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const before = await scopeAccessMaterialService
        .listForScope(orgId, req.params.id)
        .then((rows) => rows.find((row) => row.id === req.params.materialId) ?? null);
      const material = await scopeAccessMaterialService.updateForScope({
        orgId,
        scopeId: req.params.id,
        materialId: req.params.materialId,
        actorUserId: actorId,
        input: req.body,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.access_material.updated',
            resourceType: 'scope_access_material',
            resourceId: material.id,
            changes: {
              before: before ? buildAccessMaterialAuditSnapshot(before) : null,
              after: buildAccessMaterialAuditSnapshot(material),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, scopeId: req.params.id, materialId: material.id },
            '[scopes] Failed to write audit log for access material update',
          );
        }
      }

      res.json(material);
    } catch (error) {
      const err = toAppError(error);
      logger.error(
        { err, scopeId: req.params.id, materialId: req.params.materialId },
        '[scopes] Failed to update access material',
      );
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.delete('/:id/access-materials/:materialId', requireScopeOrgContext(), requireCapability('credentials.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const before = await scopeAccessMaterialService
        .listForScope(orgId, req.params.id)
        .then((rows) => rows.find((row) => row.id === req.params.materialId) ?? null);
      await scopeAccessMaterialService.deleteForScope({
        orgId,
        scopeId: req.params.id,
        materialId: req.params.materialId,
      });

      if (actorId && before) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.access_material.deleted',
            resourceType: 'scope_access_material',
            resourceId: before.id,
            changes: {
              before: buildAccessMaterialAuditSnapshot(before),
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, scopeId: req.params.id, materialId: req.params.materialId },
            '[scopes] Failed to write audit log for access material delete',
          );
        }
      }

      res.status(204).send();
    } catch (error) {
      const err = toAppError(error);
      logger.error(
        { err, scopeId: req.params.id, materialId: req.params.materialId },
        '[scopes] Failed to delete access material',
      );
      sendApiError(res, {
        code: err.code,
        message: err.message,
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  // GET /api/app/scopes/:id/plan — latest scope-level pentest plan note
  router.get('/:id/plan', async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);

      const [plan] = await db
        .select()
        .from(inventoryNotes)
        .where(
          and(
            eq(inventoryNotes.organizationId, orgId),
            eq(inventoryNotes.scopeId, req.params.id),
            eq(inventoryNotes.ntype, 'pentest.plan'),
            isNull(inventoryNotes.assetId),
          ),
        )
        .orderBy(desc(inventoryNotes.lastSeenAt), desc(inventoryNotes.createdAt))
        .limit(1);

      res.json({ plan: plan ?? null });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to get scope plan');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get scope plan' });
    }
  });

  // PUT /api/app/scopes/:id — update scope
  router.put('/:id', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const { name, status } = req.body;
      const before = await scopeService.getById(orgId, req.params.id);

      const brief = parseEngagementBrief(req.body);
      if (!brief.valid) {
        return sendApiError(res, { code: brief.code, message: brief.message });
      }
      const boundary = parseBoundaryEdit(req.body);
      if (!boundary.valid) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_INVALID_FORMAT, message: boundary.message });
      }
      if (boundary.edit.exclusions.add.length > 0 && !actorId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Authentication is required',
          status: 401,
        });
      }
      const beforeTargets = before.targets ?? [];

      /* Apply the revision, its boundary edits and its statement together. The
         widening check runs against the post-write contract inside the
         transaction, so what is validated is what is actually committed. */
      const saved = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db;
        const recorder = new ScopeAuthorizationRecorder(tx);
        const txScopeService = new ScopeService(tx);
        const applied = await txScopeService.update(orgId, req.params.id, {
          ...(name !== undefined && { name }),
          ...brief.fields,
          ...(status !== undefined && { status }),
        });

        /* Removals first: dropping a root and adding a narrower one in the same
           Save should not collide on the way through. */
        for (const targetId of boundary.edit.targets.remove) {
          await txScopeService.removeTarget(req.params.id, targetId);
        }
        const addedTargets = [];
        for (const target of boundary.edit.targets.add) {
          addedTargets.push(await txScopeService.addTarget(req.params.id, {
            type: target.type as ScopeTargetType,
            value: target.value,
            ...(target.verificationMethod
              ? { verificationMethod: target.verificationMethod as ScopeTargetVerificationMethod }
              : {}),
          }));
        }

        const txBoundaryService = new ScopeBoundaryService(tx);
        const removedExclusions = [];
        for (const exclusionId of boundary.edit.exclusions.remove) {
          removedExclusions.push(await txBoundaryService.removeExclusion({
            organizationId: orgId,
            scopeId: req.params.id,
            exclusionId,
          }));
        }
        const addedExclusions = [];
        for (const exclusion of boundary.edit.exclusions.add) {
          addedExclusions.push(await txBoundaryService.addExclusion({
            organizationId: orgId,
            scopeId: req.params.id,
            type: exclusion.type,
            value: exclusion.value,
            userId: actorId as string,
          }));
        }

        const nextContract = await recorder.readContract(req.params.id);
        const accepted = statementAccepted(req.body);
        await recorder.assertStatementCoversChange({
          organizationId: orgId,
          scopeId: req.params.id,
          nextContract,
          statementAccepted: accepted,
        });

        if (accepted && actorId) {
          await recorder.record({
            organizationId: orgId,
            scopeId: req.params.id,
            actorId,
            trigger: 'scope_updated',
            contract: nextContract,
          });
        }

        return { applied, addedTargets, removedExclusions, addedExclusions };
      });
      const updated = saved.applied;

      /* One audit row per thing that moved, using the same actions the granular
         routes write, so the trail does not depend on which screen was used. */
      if (actorId && !isEmptyBoundaryEdit(boundary.edit)) {
        const boundaryAudits = [
          ...saved.addedTargets.map((target) => ({
            action: 'scope.target_added',
            resourceType: 'scope_target',
            resourceId: target.id,
            changes: {
              after: { scopeId: req.params.id, type: target.type, value: target.value, verified: target.verified },
            },
          })),
          ...boundary.edit.targets.remove.map((targetId) => {
            const removed = beforeTargets.find((target) => target.id === targetId) ?? null;
            return {
              action: 'scope.target_removed',
              resourceType: 'scope_target',
              resourceId: targetId,
              changes: {
                before: removed
                  ? { scopeId: req.params.id, type: removed.type, value: removed.value, verified: removed.verified }
                  : { scopeId: req.params.id },
              },
            };
          }),
          ...saved.addedExclusions.map((exclusion) => ({
            action: 'scope.exclusion.created',
            resourceType: 'scope_exclusion',
            resourceId: exclusion.id,
            changes: { after: { type: exclusion.type, value: exclusion.value } },
          })),
          ...saved.removedExclusions.map((exclusion) => ({
            action: 'scope.exclusion.deleted',
            resourceType: 'scope_exclusion',
            resourceId: exclusion.id,
            changes: { before: { type: exclusion.type, value: exclusion.value } },
          })),
        ];
        for (const entry of boundaryAudits) {
          try {
            await auditService.log({
              organizationId: orgId,
              actorId,
              actorType: 'user',
              ...entry,
              metadata: buildAuditMetadata(req),
            });
          } catch (auditError) {
            const auditErr = toAppError(auditError);
            logger.error(
              { err: auditErr, scopeId: req.params.id, action: entry.action },
              '[scopes] Failed to write audit log for boundary edit',
            );
          }
        }
      }

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.updated',
            resourceType: 'scope',
            resourceId: req.params.id,
            changes: {
              before: {
                name: before.scope.name,
                executionNetwork: before.scope.executionNetwork,
                mission: before.scope.mission,
                impactTolerance: before.scope.impactTolerance,
                complianceFrameworks: before.scope.complianceFrameworks,
                status: before.scope.status,
              },
              after: {
                name: updated.name,
                executionNetwork: updated.executionNetwork,
                mission: updated.mission,
                impactTolerance: updated.impactTolerance,
                complianceFrameworks: updated.complianceFrameworks,
                status: updated.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, scopeId: req.params.id }, '[scopes] Failed to write audit log for scope update');
        }
      }

      res.json(updated);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to update scope');
      /* A refused widening and an invalid exclusion are the customer's to read;
         only a genuine 5xx becomes the generic message. */
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        return sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to update scope' });
    }
  });

  // DELETE /api/app/scopes/:id — archive scope
  router.delete('/:id', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const before = await scopeService.getById(orgId, req.params.id);
      await scopeService.archive(orgId, req.params.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.archived',
            resourceType: 'scope',
            resourceId: req.params.id,
            changes: {
              before: {
                name: before.scope.name,
                status: before.scope.status,
              },
              after: {
                status: 'archived',
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, scopeId: req.params.id }, '[scopes] Failed to write audit log for scope archive');
        }
      }

      res.status(204).end();
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to archive scope');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to archive scope' });
    }
  });

  // GET /api/app/scopes/:id/targets — list targets for scope
  router.get('/:id/targets', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await scopeService.getById(orgId, req.params.id);
      res.json(detail.targets);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to list targets');
      sendApiError(res, { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Scope not found' });
    }
  });

  // POST /api/app/scopes/:id/targets — add target
  router.post('/:id/targets', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const { type, value, verificationMethod } = req.body;
      if (!type || !value) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_MISSING_REQUIRED, message: 'type and value are required' });
      }
      /* Adding a root widens the boundary, so it carries its own statement. */
      const target = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db;
        const recorder = new ScopeAuthorizationRecorder(tx);
        const added = await new ScopeService(tx).addTarget(req.params.id, {
          type,
          value,
          verificationMethod,
        });

        const nextContract = await recorder.readContract(req.params.id);
        const accepted = statementAccepted(req.body);
        await recorder.assertStatementCoversChange({
          organizationId: orgId,
          scopeId: req.params.id,
          nextContract,
          statementAccepted: accepted,
        });

        if (accepted && actorId) {
          await recorder.record({
            organizationId: orgId,
            scopeId: req.params.id,
            actorId,
            trigger: 'target_added',
            contract: nextContract,
          });
        }

        return added;
      });


      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.target_added',
            resourceType: 'scope_target',
            resourceId: target.id,
            changes: {
              after: {
                scopeId: req.params.id,
                type: target.type,
                value: target.value,
                verified: target.verified,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, scopeId: req.params.id, targetId: target.id },
            '[scopes] Failed to write audit log for target add',
          );
        }
      }

      res.status(201).json(target);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to add target');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        return sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to add target' });
    }
  });

  // DELETE /api/app/scopes/:id/targets/:targetId — remove target
  router.delete('/:id/targets/:targetId', requireScopeOrgContext(), requireCapability('scopes.manage'), async (req, res) => {
    try {
      const orgId = await ensureScopeOwned(req, req.params.id);
      const actorId = req.user?.id ?? null;
      const detail = await scopeService.getById(orgId, req.params.id);
      const targetBefore = detail.targets.find((target) => target.id === req.params.targetId) ?? null;
      await scopeService.removeTarget(req.params.id, req.params.targetId);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'scope.target_removed',
            resourceType: 'scope_target',
            resourceId: req.params.targetId,
            changes: {
              before: targetBefore
                ? {
                    scopeId: req.params.id,
                    type: targetBefore.type,
                    value: targetBefore.value,
                    verified: targetBefore.verified,
                  }
                : { scopeId: req.params.id },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, scopeId: req.params.id, targetId: req.params.targetId },
            '[scopes] Failed to write audit log for target remove',
          );
        }
      }

      res.status(204).end();
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to remove target');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to remove target' });
    }
  });

  // POST /api/app/scopes/:id/verify — trigger target verification
  router.post('/:id/verify', targetVerificationLimit, async (req, res) => {
    try {
      await ensureScopeOwned(req, req.params.id);
      const { targetId, method } = req.body;
      if (!targetId) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_MISSING_REQUIRED, message: 'targetId is required' });
      }
      // `method` is optional ('dns_txt' | 'http_well_known'); verifyTarget ignores anything else.
      const result = await scopeService.verifyTarget(req.params.id, targetId, method);
      res.json(result);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to verify target');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to verify target' });
    }
  });

  // POST /api/app/scopes/:id/verify-auto — testing-only verification override
  router.post('/:id/verify-auto', targetVerificationLimit, async (req, res) => {
    try {
      if (!isScopeAutoVerifyEnabled()) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Auto verification is disabled in this environment',
        });
      }

      await ensureScopeOwned(req, req.params.id);
      const { targetId } = req.body;
      if (!targetId) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'targetId is required',
        });
      }

      const result = await scopeService.autoVerifyTarget(req.params.id, targetId);
      res.json(result);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to auto-verify target');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to auto-verify target',
      });
    }
  });

  // GET /api/app/scopes/:id/verify-status — check target verification status
  router.get('/:id/verify-status', async (req, res) => {
    try {
      await ensureScopeOwned(req, req.params.id);
      const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : undefined;
      if (!targetId) {
        return sendApiError(res, { code: ERROR_CODES.VALIDATION_MISSING_REQUIRED, message: 'targetId is required' });
      }
      const result = await scopeService.checkVerificationStatus(req.params.id, targetId);
      res.json(result);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[scopes] Failed to get verification status');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get verification status' });
    }
  });

  return router;
}
