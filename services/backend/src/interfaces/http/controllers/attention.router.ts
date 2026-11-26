/**
 * The nav "new item" badge: what has arrived since this person last looked.
 *
 *   GET  /api/app/attention        counts per destination
 *   POST /api/app/attention/seen   they opened one — move the watermark
 *
 * The GET is answered on every page load by the sidebar, so it does the least
 * work that can be correct: indexed counts over the caller's own organization,
 * one row of stored state per person per destination, nothing fanned out.
 *
 * It is READ-ONLY AND CAPABILITY-GATED PER SURFACE rather than as a whole. A
 * viewer who cannot read findings must not learn how many exist from a number
 * in the chrome — a count is a disclosure, and a dot on a nav item they cannot
 * open is noise besides. Surfaces the caller cannot see are simply absent from
 * the response, which is also what the client wants: no key, no dot.
 */
import { Router } from 'express';

import {
  AttentionService,
  isAttentionSurface,
  type AttentionSurface,
} from '@/app/services/attention/AttentionService';
import { type OrgCapability, roleHasCapability } from '@/shared/auth/capabilities';
import type { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { requirePrimaryOrgContext } from '@/interfaces/http/middleware/orgContext';
import { ERROR_CODES, sendApiError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { authMiddleware } from '@/shared/middleware/auth.middleware';

const log = logger.child({ scope: 'AttentionRouter' });

/**
 * The capability each surface's count is a disclosure of.
 *
 * These are the BACKEND's `OrgCapability` names (`findings.read`), which are
 * not the strings the frontend nav uses for the same idea (`org.finding.read`).
 * Two vocabularies for one concept is a trap; it is called out here rather than
 * quietly bridged, because the compiler catches this side and nothing catches
 * the other.
 */
const SURFACE_CAPABILITY: Record<AttentionSurface, OrgCapability> = {
  risks: 'findings.read',
  runs: 'runs.read',
  settings: 'members.manage',
};

interface AttentionRouterDeps {
  orgService: OrganizationService;
}

export function createAttentionRouter(deps: AttentionRouterDeps): Router {
  const router = Router();
  const attention = new AttentionService();

  router.use(authMiddleware);

  router.get('/attention', requirePrimaryOrgContext, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not authenticated',
      });
    }

    try {
      const orgId = req.organizationId ?? (await deps.orgService.getForUser(userId)).id;
      const counts = await attention.forUser(userId, orgId);

      /* `requirePrimaryOrgContext` has already established the role; the
         capability question here is per surface, not per request, so it is
         asked directly rather than through `requireCapability` middleware —
         which can only reject the whole call. */
      const role = req.orgRole;
      const visible: Record<string, number> = {};
      for (const [surface, value] of Object.entries(counts)) {
        if (!isAttentionSurface(surface)) continue;
        if (role && roleHasCapability(role, SURFACE_CAPABILITY[surface])) {
          visible[surface] = value;
        }
      }

      return res.json({ attention: visible });
    } catch (error) {
      /* ── CHROME MUST NOT BE ABLE TO BREAK A PAGE ──
         This is decoration on every screen in the console. A failed count is a
         missing dot, never an error banner over somebody's findings, so it
         answers with nothing and says so in the log instead. */
      log.warn({ err: error, userId }, 'attention counts unavailable; returning empty');
      return res.json({ attention: {} });
    }
  });

  /**
   * They opened a destination. Moves that watermark to now, which is the entire
   * mechanism by which a dot disappears.
   *
   * Idempotent, so the client calls it on every arrival without tracking
   * whether it already has. A failure here is also silent for the same reason
   * the GET is: the worst case is a dot that stays up one navigation longer,
   * and that is not worth an error in front of somebody's work.
   */
  router.post('/attention/seen', requirePrimaryOrgContext, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not authenticated',
      });
    }

    const surface = String((req.body as { surface?: unknown })?.surface ?? '');
    if (!isAttentionSurface(surface)) {
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
        message: 'Unknown surface',
      });
    }

    /* Marking a surface seen is not a disclosure — it stores a timestamp about
       the caller and reveals nothing — but it is still refused for a surface
       they cannot open, so a watermark can never be moved past rows the person
       was never allowed to see. */
    const role = req.orgRole;
    if (!role || !roleHasCapability(role, SURFACE_CAPABILITY[surface])) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not permitted for this surface',
      });
    }

    try {
      await attention.markSeen(userId, surface);
      return res.json({ ok: true });
    } catch (error) {
      log.warn({ err: error, userId, surface }, 'could not mark surface seen');
      return res.json({ ok: false });
    }
  });

  return router;
}
