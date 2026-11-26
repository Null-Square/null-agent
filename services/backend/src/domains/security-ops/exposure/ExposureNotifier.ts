import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  exposureMatches,
  inventoryComponents,
  organizationMembers,
  type ExposureMatchState,
} from '@/db/schema';
import { notifyAppEvent } from '@/domains/platform/notifications/notificationService';
import { getThreatWatchSettings } from '@/domains/platform/settings/threatWatchSettings';
import { isInterruptEligibleEvidenceTier } from '@/domains/security-ops/components/componentEvidence';
import { logger } from '@/shared/logger';

/**
 * Tells customers about exposures.
 *
 * This is the half of Threat Watch that makes it a watchtower rather than a
 * page you have to remember to visit. Every other feature in the platform is
 * *attended* — someone starts a run and comes back for the result. This one
 * produces news while nobody is looking, so an exposure nobody is told about is
 * worth close to nothing.
 *
 * Three rules shape it, and each exists to protect the same thing: the right to
 * interrupt someone.
 *
 *  1. **Only a narrow band earns an immediate notification.** By default that
 *     means CISA-KEV-listed advisories — actively exploited in the wild — plus
 *     anything scoring above a high priority floor. "A CVE exists for your
 *     version" is not news; "somebody is exploiting this right now" is.
 *  2. **A daily cap per organization.** The first real backfill against a busy
 *     inventory can produce dozens of matches at once. Mailing all of them
 *     would burn the trust the product is trying to build, on day one, before
 *     anything has been verified.
 *  3. **Notifying is recorded, not inferred.** Each in-app notice carries a
 *     dedupe key per exposure and `notified_at` is stamped only after the
 *     notice is written, so a retry cannot notify twice or lose the alert.
 */
export type ExposureNotifyResult = {
  considered: number;
  notified: number;
  suppressedByCap: number;
  skippedBelowThreshold: number;
  skippedIneligibleEvidence: number;
};

/** States worth telling somebody about: matched, not yet answered. */
const NOTIFIABLE_STATES: ExposureMatchState[] = ['candidate', 'notified'];

const DAY_MS = 24 * 60 * 60 * 1000;

export class ExposureNotifier {
  constructor(
    private readonly db: DatabaseClient,
    private readonly deps: {
      emit?: typeof notifyAppEvent;
      canNotifyOrganization?: (organizationId: string) => Promise<boolean>;
    } = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async notifyNewExposures(): Promise<ExposureNotifyResult> {
    const result: ExposureNotifyResult = {
      considered: 0,
      notified: 0,
      suppressedByCap: 0,
      skippedBelowThreshold: 0,
      skippedIneligibleEvidence: 0,
    };

    const settings = await getThreatWatchSettings();
    if (!settings.notificationsEnabled) return result;

    // Fail closed: enabling the switch is not enough. An operator must choose
    // an activation instant after shadow-mode review, preventing the notifier
    // from draining an unreviewed historical backlog.
    if (!settings.notificationActivationAt) return result;
    const activationAt = new Date(settings.notificationActivationAt);
    if (!Number.isFinite(activationAt.getTime())) return result;

    const minPriority = settings.immediateNotifyMinPriority ?? 70;
    const notifyOnKev = settings.immediateNotifyOnKev ?? true;
    const dailyCap = settings.maxImmediateNotificationsPerDay ?? 5;
    const evidenceMaxAgeDays = settings.notificationEvidenceMaxAgeDays ?? 14;

    const now = this.now();
    const evidenceCutoff = new Date(now.getTime() - evidenceMaxAgeDays * DAY_MS);

    // Only matches never notified before. `notified_at` is the idempotency
    // anchor rather than a timestamp comparison, so a replica restarting
    // mid-pass cannot re-send.
    const candidates = await this.db
      .select({
        matchId: exposureMatches.id,
        organizationId: exposureMatches.organizationId,
        matchConfidence: exposureMatches.matchConfidence,
        evidenceTier: exposureMatches.evidenceTier,
        evidenceSource: exposureMatches.evidenceSource,
        inventoryObservedAt: exposureMatches.inventoryObservedAt,
        firstSeenAt: exposureMatches.firstSeenAt,
        priorityScore: exposureMatches.priorityScore,
        advisoryId: advisories.canonicalId,
        severity: advisories.severity,
        kevListed: advisories.kevListed,
        componentName: inventoryComponents.displayName,
        componentVersion: exposureMatches.versionEvaluated,
        versionConflict: inventoryComponents.versionConflict,
        backportRisk: inventoryComponents.backportRisk,
        assetValue: assets.value,
        assetId: assets.id,
      })
      .from(exposureMatches)
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
      .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
      .where(
        and(
          inArray(exposureMatches.state, NOTIFIABLE_STATES),
          isNull(exposureMatches.notifiedAt),
          eq(exposureMatches.matchConfidence, 'exact_version'),
          inArray(exposureMatches.evidenceTier, ['observed_exact', 'attested_exact']),
          isNotNull(exposureMatches.versionEvaluated),
          gte(exposureMatches.firstSeenAt, activationAt),
          gte(exposureMatches.inventoryObservedAt, evidenceCutoff),
          eq(inventoryComponents.versionConflict, false),
          eq(inventoryComponents.backportRisk, false),
        ),
      )
      // Interleave organizations before applying the global batch limit. A
      // single large tenant can otherwise occupy all 500 rows while its daily
      // cap allows only a handful through, starving every other tenant on
      // every pass. Ranking inside each organization gives each one a first,
      // second, and subsequent candidate before any gets the next slot.
      .orderBy(
        sql`row_number() over (
          partition by ${exposureMatches.organizationId}
          order by ${exposureMatches.priorityScore} desc, ${exposureMatches.firstSeenAt} asc
        )`,
        desc(exposureMatches.priorityScore),
      )
      .limit(500);

    result.considered = candidates.length;
    if (candidates.length === 0) return result;

    const sentToday = new Map<string, number>();

    for (const candidate of candidates) {
      const evidenceEligible =
        candidate.matchConfidence === 'exact_version' &&
        Boolean(candidate.componentVersion) &&
        isInterruptEligibleEvidenceTier(candidate.evidenceTier) &&
        candidate.firstSeenAt.getTime() >= activationAt.getTime() &&
        candidate.inventoryObservedAt.getTime() >= evidenceCutoff.getTime() &&
        candidate.versionConflict !== true &&
        candidate.backportRisk !== true;
      if (!evidenceEligible) {
        result.skippedIneligibleEvidence += 1;
        continue;
      }

      const earnsInterrupt =
        (notifyOnKev && candidate.kevListed === true) ||
        (candidate.priorityScore ?? 0) >= minPriority;

      if (!earnsInterrupt) {
        result.skippedBelowThreshold += 1;
        continue;
      }

      const orgId = candidate.organizationId;
      const platformEligible = this.deps.canNotifyOrganization
        ? await this.deps.canNotifyOrganization(orgId)
        : true;
      if (!platformEligible) continue;
      if (!sentToday.has(orgId)) {
        sentToday.set(orgId, await this.countNotifiedInLastDay(orgId, now));
      }
      const alreadySent = sentToday.get(orgId) ?? 0;
      if (alreadySent >= dailyCap) {
        // Left unnotified rather than marked sent, so it can still reach the
        // customer through the digest or tomorrow's pass.
        result.suppressedByCap += 1;
        continue;
      }

      const recipients = await this.recipientsFor(orgId);
      if (recipients.length === 0) continue;

      const component = `${candidate.componentName} ${candidate.componentVersion}`;
      const evidenceLabel = candidate.evidenceSource === 'connected_site'
        ? 'an authenticated connected-site manifest'
        : candidate.evidenceSource === 'lockfile'
          ? 'an authenticated dependency manifest'
          : candidate.evidenceSource === 'customer_override'
            ? 'your time-bounded version correction'
            : 'current inventory evidence';
      const observedAt = candidate.inventoryObservedAt.toISOString();
      const emit = this.deps.emit ?? notifyAppEvent;
      for (const userId of recipients) {
        await emit({
          userId,
          type: 'threat_watch_exposure',
          title: candidate.kevListed
            ? `Urgent potential exposure: ${candidate.advisoryId} is exploited in the wild`
            : `Potential exposure: ${candidate.advisoryId} may affect ${candidate.assetValue}`,
          // States the claim honestly. Saying "you are vulnerable" here would
          // be a lie we have not tested, and the verify step is the product.
          message:
            `We identified ${component} on ${candidate.assetValue} from ${evidenceLabel} ` +
            `confirmed at ${observedAt}, and the evaluated version falls inside ` +
            `the affected range for ${candidate.advisoryId}. This potential exposure has not ` +
            `been tested on your asset. Run a focused verification to determine whether the ` +
            `documented issue is exploitable here.`,
          link: `/exposures/${candidate.matchId}`,
          data: {
            reason: 'threat_watch_exposure',
            exposureMatchId: candidate.matchId,
            advisoryId: candidate.advisoryId,
            severity: candidate.severity,
            kevListed: candidate.kevListed,
            evidenceTier: candidate.evidenceTier,
            evidenceSource: candidate.evidenceSource,
            inventoryObservedAt: observedAt,
            organizationId: orgId,
          },
        });
      }

      // Notify first, then mark the exposure notified: a crash between the two
      // re-notifies once, while marking first could lose the only alert.
      const [claimed] = await this.db
        .update(exposureMatches)
        .set({ state: 'notified', notifiedAt: now, updatedAt: now })
        .where(and(eq(exposureMatches.id, candidate.matchId), isNull(exposureMatches.notifiedAt)))
        .returning({ id: exposureMatches.id });

      if (!claimed) continue;

      sentToday.set(orgId, alreadySent + 1);
      result.notified += 1;
    }

    if (result.notified > 0 || result.suppressedByCap > 0) {
      logger.info(result, '[threat-watch] Exposure notifications dispatched');
    }

    return result;
  }

  /**
   * Immediate notifications sent to this organization in the last 24 hours.
   *
   * Counted from the matches themselves rather than a separate ledger: the
   * `notified_at` stamp is the record, so the cap cannot drift from what was
   * actually sent.
   */
  private async countNotifiedInLastDay(organizationId: string, now: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(exposureMatches)
      .where(
        and(
          eq(exposureMatches.organizationId, organizationId),
          gte(exposureMatches.notifiedAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    return Number(row?.count ?? 0);
  }

  /**
   * Who hears about it.
   *
   * Admins and leads only. An exposure has no reporter — it is generated — so
   * there is no natural recipient, and a member who cannot start a verification
   * cannot act on the message. Telling them anyway is noise attached to
   * somebody else's decision.
   */
  private async recipientsFor(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          inArray(organizationMembers.role, ['admin', 'owner', 'lead']),
        ),
      );
    return rows.map((row) => row.userId);
  }
}
