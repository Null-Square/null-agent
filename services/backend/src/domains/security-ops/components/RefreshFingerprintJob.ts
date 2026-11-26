import { and, eq, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { assets, inventoryComponents } from '@/db/schema';
import { collectHttp } from '@/domains/security-ops/components/fingerprint/http';
import { TargetRequestBudget } from '@/domains/security-ops/components/fingerprint/TargetRequestBudget';
import { splitProductVersion } from '@/domains/security-ops/tools/ingestion/ScannerRuntimeHelpers';
import { logger } from '@/shared/logger';
import { confirmedAssetClause } from '@/domains/security-ops/assets/assetConfirmation';

import type { ComponentInventoryService } from './ComponentInventoryService';

export type RefreshResult = {
  assetsConsidered: number;
  assetsRefreshed: number;
  assetsUnreachable: number;
  observationsRecorded: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Re-confirms what a customer runs, without an agent.
 *
 * The economics of continuous monitoring depend on this. Inventory goes stale
 * between assessments, and R3 says a match on stale evidence must not interrupt
 * anyone — but re-running the agent weekly per customer costs more than the
 * subscription. So this answers the narrower question "is this still here?"
 * using the same passive collectors the anonymous scan already uses: no agent,
 * no sandbox, no LLM.
 *
 * It deliberately does not try to *discover*. Discovery is the agent's job with
 * proper tooling; this only refreshes `last_confirmed_at` on what is already
 * known, plus whatever a passive look can see for free.
 */
export class RefreshFingerprintJob {
  constructor(
    private readonly db: DatabaseClient,
    private readonly componentInventory: Pick<ComponentInventoryService, 'recordObservation'>,
    private readonly deps: {
      collect?: typeof collectHttp;
      createBudget?: (hostname: string) => TargetRequestBudget;
    } = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Refresh assets whose components have not been confirmed recently.
   *
   * Ordered oldest-first so a capped run always spends its budget on the
   * evidence that has decayed furthest, rather than re-confirming assets that
   * were already fresh.
   */
  async refreshStaleAssets(params: {
    olderThanDays?: number;
    limit?: number;
  } = {}): Promise<RefreshResult> {
    const olderThanDays = params.olderThanDays ?? 7;
    const cutoff = new Date(this.now().getTime() - olderThanDays * DAY_MS);

    const result: RefreshResult = {
      assetsConsidered: 0,
      assetsRefreshed: 0,
      assetsUnreachable: 0,
      observationsRecorded: 0,
    };

    const stale = await this.db
      .select({
        assetId: inventoryComponents.assetId,
        organizationId: inventoryComponents.organizationId,
        assetValue: assets.value,
        oldestConfirmedAt: sql<Date>`min(${inventoryComponents.lastConfirmedAt})`,
      })
      .from(inventoryComponents)
      .innerJoin(assets, eq(assets.id, inventoryComponents.assetId))
      .where(
        and(
          // Only assets we can reach passively. An IP or a repository has no
          // homepage to read, and a lead has no durable confirmation.
          eq(assets.kind, 'domain'),
          confirmedAssetClause(),
          sql`${inventoryComponents.lastConfirmedAt} < ${cutoff}`,
        ),
      )
      .groupBy(inventoryComponents.assetId, inventoryComponents.organizationId, assets.value)
      .orderBy(sql`min(${inventoryComponents.lastConfirmedAt}) asc`)
      .limit(params.limit ?? 50);

    result.assetsConsidered = stale.length;

    for (const asset of stale) {
      const observations = await this.observeAsset(asset.assetValue);
      if (observations === null) {
        result.assetsUnreachable += 1;
        continue;
      }

      result.assetsRefreshed += 1;

      for (const observation of observations) {
        const recorded = await this.componentInventory.recordObservation({
          organizationId: asset.organizationId,
          assetId: asset.assetId,
          source: 'scan_preview',
          product: observation.product,
          version: observation.version,
          category: observation.category,
        });
        if (recorded.status === 'recorded') result.observationsRecorded += 1;
      }
    }

    logger.info(result, '[threat-watch] Fingerprint refresh complete');

    return result;
  }

  /**
   * One passive look at a host.
   *
   * Returns null when the site could not be reached — deliberately distinct
   * from an empty list. "We looked and saw nothing" would advance
   * `last_confirmed_at` and make stale evidence look fresh; "we could not look"
   * must leave the existing confirmation alone.
   */
  private async observeAsset(
    hostname: string,
  ): Promise<Array<{ product: string; version: string | null; category?: string }> | null> {
    const budget = this.deps.createBudget
      ? this.deps.createBudget(hostname)
      : new TargetRequestBudget(hostname);

    const outcome = await (this.deps.collect ?? collectHttp)(budget);
    if (outcome.status !== 'ok' || !outcome.data) return null;

    const signals = outcome.data;
    const observations: Array<{ product: string; version: string | null; category?: string }> = [];

    const pushBanner = (banner: string | null | undefined) => {
      if (!banner) return;
      const parsed = splitProductVersion(banner);
      if (parsed.product) {
        observations.push({ product: parsed.product, version: parsed.version ?? null });
      }
    };

    pushBanner(signals.server);
    pushBanner(signals.poweredBy);
    pushBanner(signals.generator);

    for (const tech of signals.technologies ?? []) {
      const parsed = splitProductVersion(tech);
      if (parsed.product) {
        observations.push({ product: parsed.product, version: parsed.version ?? null });
      }
    }

    for (const plugin of signals.wordpressPlugins ?? []) {
      observations.push({
        product: plugin.slug,
        version: plugin.version,
        category: 'wordpress-plugin',
      });
    }
    for (const theme of signals.wordpressThemes ?? []) {
      observations.push({
        product: theme.slug,
        version: theme.version,
        category: 'wordpress-theme',
      });
    }

    return observations;
  }
}
