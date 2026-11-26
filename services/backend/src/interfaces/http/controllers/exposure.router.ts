import { Router } from 'express';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  advisories,
  advisoryAffectedRanges,
  assets,
  componentObservations,
  componentOverrides,
  exposureMatchEvents,
  exposureMatches,
  inventoryComponents,
  runs,
  type ExposureMatchState,
} from '@/db/schema';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ExposureVerificationService } from '@/domains/security-ops/exposure/ExposureVerificationService';
import { ExposureMatchService } from '@/domains/security-ops/exposure/ExposureMatchService';
import { assetInScopeClause } from '@/domains/security-ops/assets/assetScopeFilter';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { AppError, ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { ExecutionSelection } from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';

const COMPONENT_CORRECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Threat Watch exposure API.
 *
 * The verification endpoint is the reason this file needs care. `StartRunService`
 * applies no access control of its own — the runs router does it before calling —
 * so a second entry point that starts runs inherits nothing. Entitlement, RBAC,
 * credits and concurrency are therefore applied explicitly here, and the
 * capability split is deliberate: seeing an exposure and paying agent credits to
 * test it are different rights.
 */

const LIST_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OPEN_STATES: ExposureMatchState[] = ['candidate', 'notified', 'verifying', 'inconclusive'];
const CORRECTABLE_STATES: ExposureMatchState[] = ['candidate', 'notified', 'inconclusive', 'stale'];

export function createExposureRouter(deps: {
  /**
   * Structurally the platform `AccessControlService`; narrowed to the two gates
   * this route needs so the dependency is legible at the call site.
   */
  accessControl: Pick<AccessControlService, 'enforceThreatWatchAccess' | 'enforceRunCreation'>;
  /**
   * Optional, mirroring `allowExecution` on the automation run executor: not
   * every node can start runs. When absent the read surface still works and
   * verification reports plainly that it is unavailable here, rather than
   * failing somewhere deeper with a confusing error.
   */
  startVerificationRun?: (params: {
    organizationId: string;
    userId: string;
    scopeId: string;
    goal: string;
    vars: Record<string, unknown>;
    executionSelection?: ExecutionSelection;
  }) => Promise<{ runId: string }>;
}): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const matchService = new ExposureMatchService(db);

  const verificationService = new ExposureVerificationService(db, {
    /**
     * Both gates, in order. Entitlement decides whether the organization may use
     * the feature at all; run creation decides whether it can afford this run
     * right now. Skipping either would let this route spend an organization's
     * credits through a door the runs router guards.
     */
    enforceVerificationAdmission: async ({ organizationId, userId }) => {
      await deps.accessControl.enforceThreatWatchAccess({ userId, organizationId });
      const activeRunCount = await countActivePlanRuns(organizationId);
      await deps.accessControl.enforceRunCreation({ userId, organizationId, activeRunCount });
    },
    startVerificationRun: async (params) => {
      if (!deps.startVerificationRun) {
        throw new AppError(
          ERROR_CODES.INTERNAL_CONFIGURATION,
          'Verification runs are not available on this node',
        );
      }
      return deps.startVerificationRun(params);
    },
  });

  const getOrgId = async (req: {
    user?: { id: string };
    organizationId?: string;
  }): Promise<string> => {
    if (req.organizationId) return req.organizationId;
    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    req.organizationId = org.id;
    return org.id;
  };

  /**
   * Organization plus plan entitlement, for every endpoint.
   *
   * A role capability says the *user* may look; the entitlement says the
   * *organization* is paying for the feature. Checking only the capability let a
   * Free or Plus organization read exposure data as soon as any existed, which
   * is both a billing hole and a way to leak a feature before it is launched.
   */
  const requireEntitledOrg = async (req: {
    user?: { id: string };
    organizationId?: string;
  }): Promise<string> => {
    const orgId = await getOrgId(req);
    await deps.accessControl.enforceThreatWatchAccess({ userId: req.user?.id, organizationId: orgId });
    return orgId;
  };

  /**
   * Runs that currently count against the plan's concurrency limit.
   *
   * Queried here rather than taken as a dependency: the gate only needs the
   * number, and assembling a RunService for it would be a second place for the
   * definition of "active" to drift from the runs router's.
   */
  const countActivePlanRuns = async (orgId: string): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.organizationId, orgId),
          inArray(runs.status, ['queued', 'running', 'awaiting_approval']),
        ),
      );
    return Number(row?.count ?? 0);
  };

  const toIso = (value: Date | string | null | undefined): string | null =>
    value instanceof Date ? value.toISOString() : (value ?? null);

  router.get('/', requireCapability('threatwatch.read'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);
      const { state, severity, scopeId } = req.query as Record<string, string | undefined>;

      if (scopeId && !UUID_RE.test(scopeId)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'scopeId must be a valid UUID',
        });
      }

      const clauses: Array<SQL | undefined> = [eq(exposureMatches.organizationId, orgId)];
      if (scopeId) clauses.push(assetInScopeClause(scopeId));
      if (state === 'open') {
        clauses.push(inArray(exposureMatches.state, OPEN_STATES));
      } else if (state) {
        clauses.push(eq(exposureMatches.state, state as ExposureMatchState));
      }
      if (severity) clauses.push(eq(advisories.severity, severity));

      const rows = await db
        .select({
          id: exposureMatches.id,
          riskId: exposureMatches.riskId,
          state: exposureMatches.state,
          matchConfidence: exposureMatches.matchConfidence,
          evidenceTier: exposureMatches.evidenceTier,
          evidenceSource: exposureMatches.evidenceSource,
          priorityScore: exposureMatches.priorityScore,
          inventoryObservedAt: exposureMatches.inventoryObservedAt,
          firstSeenAt: exposureMatches.firstSeenAt,
          advisoryId: advisories.canonicalId,
          severity: advisories.severity,
          cvssScore: advisories.cvssV31Score,
          kevListed: advisories.kevListed,
          epssPercentile: advisories.epssPercentile,
          componentName: inventoryComponents.displayName,
          componentVersion: exposureMatches.versionEvaluated,
          backportRisk: inventoryComponents.backportRisk,
          versionConflict: inventoryComponents.versionConflict,
          assetValue: assets.value,
        })
        .from(exposureMatches)
        .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
        .where(and(...clauses.filter((clause): clause is SQL => clause !== undefined)))
        .orderBy(desc(exposureMatches.priorityScore))
        .limit(LIST_LIMIT);

      return res.json({
        matches: rows.map((row) => ({
          ...row,
          inventoryObservedAt: toIso(row.inventoryObservedAt),
          firstSeenAt: toIso(row.firstSeenAt),
        })),
      });
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[Exposure] Failed to list matches');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  router.get('/:id', requireCapability('threatwatch.read'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);

      const [match] = await db
        .select({
          match: exposureMatches,
          advisory: advisories,
          component: inventoryComponents,
          assetValue: assets.value,
        })
        .from(exposureMatches)
        .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
        .where(and(eq(exposureMatches.id, req.params.id), eq(exposureMatches.organizationId, orgId)))
        .limit(1);

      if (!match) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Exposure match not found',
          status: 404,
        });
      }

      const [events, observations, affectedRanges, overrideRows] = await Promise.all([
        db
          .select()
          .from(exposureMatchEvents)
          .where(eq(exposureMatchEvents.matchId, req.params.id))
          .orderBy(desc(exposureMatchEvents.createdAt))
          .limit(50),
        db
          .select({
            id: componentObservations.id,
            source: componentObservations.source,
            port: componentObservations.port,
            versionRaw: componentObservations.versionRaw,
            versionNormalized: componentObservations.versionNormalized,
            confidence: componentObservations.confidence,
            evidence: componentObservations.evidence,
            observedAt: componentObservations.observedAt,
          })
          .from(componentObservations)
          .where(
            and(
              eq(componentObservations.componentId, match.match.componentId),
              eq(componentObservations.organizationId, orgId),
            ),
          )
          .orderBy(desc(componentObservations.observedAt))
          .limit(20),
        db
          .select({
            id: advisoryAffectedRanges.id,
            versionScheme: advisoryAffectedRanges.versionScheme,
            introducedVersion: advisoryAffectedRanges.introducedVersion,
            introducedInclusive: advisoryAffectedRanges.introducedInclusive,
            fixedVersion: advisoryAffectedRanges.fixedVersion,
            fixedInclusive: advisoryAffectedRanges.fixedInclusive,
          })
          .from(advisoryAffectedRanges)
          .where(
            and(
              eq(advisoryAffectedRanges.advisoryId, match.match.advisoryId),
              eq(advisoryAffectedRanges.ecosystem, match.component.ecosystem),
              eq(advisoryAffectedRanges.componentKey, match.component.componentKey),
            ),
          ),
        db
          .select({
            id: componentOverrides.id,
            action: componentOverrides.action,
            correctedVersion: componentOverrides.correctedVersion,
            reason: componentOverrides.reason,
            expiresAt: componentOverrides.expiresAt,
            createdAt: componentOverrides.createdAt,
            updatedAt: componentOverrides.updatedAt,
          })
          .from(componentOverrides)
          .where(
            and(
              eq(componentOverrides.organizationId, orgId),
              eq(componentOverrides.assetId, match.match.assetId),
              eq(componentOverrides.ecosystem, match.component.ecosystem),
              eq(componentOverrides.componentKey, match.component.componentKey),
            ),
          )
          .limit(1),
      ]);

      const now = Date.now();
      const activeOverride = overrideRows[0]
        && (!overrideRows[0].expiresAt || overrideRows[0].expiresAt.getTime() > now)
        ? overrideRows[0]
        : null;

      return res.json({
        // `match` is the joined row — `{ match, advisory, component, assetValue }`
        // — so it is spread, not nested. Nesting it published a `match` that
        // held four sub-objects instead of the exposure, and every sibling the
        // contract names went missing: the page read `component.resolvedVersion`
        // off `undefined` and the route died.
        ...match,
        events,
        affectedRanges,
        override: activeOverride,
        observations: observations.map((observation) => ({
          ...observation,
          // Workspace paths are internal implementation details. The customer
          // gets the evidence label and excerpt without a server-side path.
          evidence: (observation.evidence ?? []).map((item) => ({
            label: item.label ?? null,
            excerpt: item.excerpt ?? null,
          })),
        })),
      });
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[Exposure] Failed to load match');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  /**
   * Start a focused verification run.
   *
   * Idempotent by match state rather than by request key: a match already
   * `verifying` returns its in-flight run, so a double-click or a client retry
   * cannot spend twice.
   */
  router.post('/:id/verify', requireCapability('threatwatch.verify'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }

      const result = await verificationService.startVerification({
        organizationId: orgId,
        userId,
        matchId: req.params.id,
      });

      return res.status(result.alreadyRunning ? 200 : 202).json(result);
    } catch (error) {
      const appError = toAppError(error);
      logger.warn({ err: error, matchId: req.params.id }, '[Exposure] Verification request rejected');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  /**
   * Correct the inventory belief behind a match.
   *
   * This is deliberately component-scoped: "not installed" and "wrong
   * version" are facts about the software observed on an asset, not only about
   * the CVE currently on screen. A CVE-specific disagreement remains the
   * dismissal endpoint below.
   */
  router.put('/:id/override', requireCapability('threatwatch.verify'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }

      const action = req.body?.action;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      const correctedVersion = typeof req.body?.correctedVersion === 'string'
        ? req.body.correctedVersion.trim()
        : '';

      if (action !== 'not_present' && action !== 'version_correction') {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Correction action must be not_present or version_correction',
          status: 400,
        });
      }
      if (reason.length < 3 || reason.length > 500) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'A reason between 3 and 500 characters is required',
          status: 400,
        });
      }
      if (action === 'version_correction' && (!correctedVersion || correctedVersion.length > 120)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'A corrected version of at most 120 characters is required',
          status: 400,
        });
      }

      const [context] = await db
        .select({
          componentId: exposureMatches.componentId,
          assetId: exposureMatches.assetId,
          state: exposureMatches.state,
          ecosystem: inventoryComponents.ecosystem,
          componentKey: inventoryComponents.componentKey,
        })
        .from(exposureMatches)
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .where(and(eq(exposureMatches.id, req.params.id), eq(exposureMatches.organizationId, orgId)))
        .limit(1);

      if (!context || !CORRECTABLE_STATES.includes(context.state)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Match not found, or not in a state that can be corrected',
          status: 409,
        });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + COMPONENT_CORRECTION_TTL_MS);
      const [override] = await db
        .insert(componentOverrides)
        .values({
          organizationId: orgId,
          assetId: context.assetId,
          ecosystem: context.ecosystem,
          componentKey: context.componentKey,
          action,
          correctedVersion: action === 'version_correction' ? correctedVersion : null,
          reason,
          actorUserId: userId,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            componentOverrides.organizationId,
            componentOverrides.assetId,
            componentOverrides.ecosystem,
            componentOverrides.componentKey,
          ],
          set: {
            action,
            correctedVersion: action === 'version_correction' ? correctedVersion : null,
            reason,
            actorUserId: userId,
            expiresAt,
            updatedAt: now,
          },
        })
        .returning();

      let reconciliationPending = false;
      try {
        await matchService.reconcileComponent(context.componentId);
      } catch (error) {
        // The correction is the durable source of truth. If immediate
        // reconciliation fails, the regular reconciliation pass will apply it;
        // do not tell the customer their saved correction was lost.
        reconciliationPending = true;
        logger.error(
          { err: error, matchId: req.params.id, componentId: context.componentId },
          '[Exposure] Correction saved but immediate reconciliation failed',
        );
      }

      return res.json({ override, reconciliationPending });
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[Exposure] Failed to save component correction');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  /** Remove a component correction and re-evaluate its advisory matches. */
  router.delete('/:id/override', requireCapability('threatwatch.verify'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);

      const [context] = await db
        .select({
          componentId: exposureMatches.componentId,
          assetId: exposureMatches.assetId,
          ecosystem: inventoryComponents.ecosystem,
          componentKey: inventoryComponents.componentKey,
        })
        .from(exposureMatches)
        .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
        .where(and(eq(exposureMatches.id, req.params.id), eq(exposureMatches.organizationId, orgId)))
        .limit(1);

      if (!context) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Exposure match not found',
          status: 404,
        });
      }

      const removed = await db
        .delete(componentOverrides)
        .where(
          and(
            eq(componentOverrides.organizationId, orgId),
            eq(componentOverrides.assetId, context.assetId),
            eq(componentOverrides.ecosystem, context.ecosystem),
            eq(componentOverrides.componentKey, context.componentKey),
          ),
        )
        .returning({ id: componentOverrides.id });

      let reconciliationPending = false;
      if (removed.length > 0) {
        try {
          await matchService.reconcileComponent(context.componentId);
        } catch (error) {
          reconciliationPending = true;
          logger.error(
            { err: error, matchId: req.params.id, componentId: context.componentId },
            '[Exposure] Correction removed but immediate reconciliation failed',
          );
        }
      }

      return res.json({ removed: removed.length > 0, reconciliationPending });
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[Exposure] Failed to remove component correction');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  /** Close only this advisory match; the underlying inventory remains unchanged. */
  router.post('/:id/dismiss', requireCapability('threatwatch.verify'), async (req, res) => {
    try {
      const orgId = await requireEntitledOrg(req as never);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

      if (reason.length < 3 || reason.length > 500) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'A reason between 3 and 500 characters is required',
          status: 400,
        });
      }

      const updated = await db
        .update(exposureMatches)
        .set({
          state: 'dismissed',
          stateReason: reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(exposureMatches.id, req.params.id),
            eq(exposureMatches.organizationId, orgId),
            // A verified exposure records something we observed to be true; a
            // dismissal should not erase that.
            inArray(exposureMatches.state, CORRECTABLE_STATES),
          ),
        )
        .returning({ id: exposureMatches.id });

      if (updated.length === 0) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Match not found, or not in a state that can be dismissed',
          status: 409,
        });
      }

      await db.insert(exposureMatchEvents).values({
        matchId: req.params.id,
        organizationId: orgId,
        type: 'state_changed',
        toState: 'dismissed',
        actorUserId: req.user?.id ?? null,
        note: reason,
      });

      return res.json({ id: req.params.id, state: 'dismissed' });
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[Exposure] Failed to dismiss match');
      return sendApiError(res, { code: appError.code, message: appError.message, status: appError.httpStatus });
    }
  });

  return router;
}
