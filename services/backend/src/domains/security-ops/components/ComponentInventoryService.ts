import { and, desc, eq, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  componentAliases,
  componentObservations,
  componentUnmapped,
  inventoryComponents,
  type ComponentEcosystem,
  type ComponentObservationSource,
  type ComponentVersionReadAttempts,
  type ComponentVersionReadMethod,
} from '@/db/schema';
import { logger } from '@/shared/logger';

import {
  isNonMatchableProduct,
  normalizeAliasText,
  normalizeObservation,
  resolveComponentVersion,
  type ComponentAliasLookup,
} from './componentIdentity';
import { evidenceTierForObservation } from './componentEvidence';
import {
  buildVersionReadAttempt,
  versionReadMethodForSource,
} from './componentVersionAcquisition';

export type RecordComponentObservationInput = {
  organizationId: string;
  assetId: string;
  scopeId?: string | null;
  observedByUserId?: string | null;
  sessionId?: string | null;
  source: ComponentObservationSource;
  /** Concrete method used to try to read the version. Defaults from source. */
  versionReadMethod?: ComponentVersionReadMethod;
  product: string;
  version?: string | null;
  /** e.g. 'wordpress-plugin' — lets slug-identified ecosystems resolve. */
  category?: string | null;
  port?: number | null;
  serviceId?: string | null;
  confidence?: number | null;
  sourceAnchor?: string | null;
  evidence?: Array<{ path: string; label?: string; excerpt?: string }>;
};

export type RecordComponentObservationResult =
  | { status: 'recorded'; componentId: string; componentKey: string; created: boolean }
  | { status: 'unmapped'; aliasText: string };

/**
 * Writes what a customer runs into a matchable form.
 *
 * This is the projection side of the rule that keeps `inventory_notes` usable:
 * narrative stays there, facts land here. The matcher reads only the resolved
 * row on `inventory_components`; `component_observations` retains every
 * individual sighting so a disagreement stays visible and a customer can be
 * shown why we believe what we believe.
 */
export class ComponentInventoryService {
  /** Alias table is small and read on every observation, so it is cached. */
  private aliasCache: Map<string, { ecosystem: ComponentEcosystem; componentKey: string; confidence: number }> | null =
    null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Drop the alias cache after a seed or admin edit. */
  invalidateAliasCache(): void {
    this.aliasCache = null;
  }

  private async loadAliasLookup(): Promise<ComponentAliasLookup> {
    if (!this.aliasCache) {
      const rows = await this.db
        .select({
          aliasText: componentAliases.aliasText,
          ecosystem: componentAliases.ecosystem,
          componentKey: componentAliases.componentKey,
          confidence: componentAliases.confidence,
        })
        .from(componentAliases);

      this.aliasCache = new Map(
        rows.map((row) => [
          row.aliasText,
          { ecosystem: row.ecosystem, componentKey: row.componentKey, confidence: row.confidence },
        ]),
      );
    }

    const cache = this.aliasCache;
    return (aliasText: string) => cache.get(aliasText);
  }

  /**
   * Record one sighting and re-resolve the component it belongs to.
   *
   * An unrecognised product is deliberately *not* an error and *not* a guess:
   * it is counted in `component_unmapped` so alias coverage becomes a
   * prioritised backlog rather than an invisible hole (PRD R1).
   */
  async recordObservation(
    input: RecordComponentObservationInput,
  ): Promise<RecordComponentObservationResult> {
    const lookup = await this.loadAliasLookup();
    const normalized = normalizeObservation({
      product: input.product,
      version: input.version,
      category: input.category,
      lookup,
    });

    if (!normalized) {
      const aliasText = normalizeAliasText(input.product);
      // A CDN or managed host is correctly unmatched rather than unidentified:
      // there is no customer-controlled version to compare. Queueing it as
      // alias work would bury the gaps that actually cost us matches.
      if (aliasText && !isNonMatchableProduct(input.product)) {
        await this.recordUnmapped(aliasText);
      }
      return { status: 'unmapped', aliasText };
    }

    const now = this.now();
    const { identity } = normalized;
    const versionReadMethod = input.versionReadMethod ?? versionReadMethodForSource(input.source);
    const versionReadAttempt = buildVersionReadAttempt({
      method: versionReadMethod,
      source: input.source,
      version: normalized.versionNormalized,
      attemptedAt: now,
    });
    const versionReadAttempts: ComponentVersionReadAttempts = {
      [versionReadMethod]: versionReadAttempt,
    };
    const versionReadAttemptsJson = JSON.stringify(versionReadAttempts);

    const component = await this.db.transaction(async (tx) => {
      const database = tx as unknown as DatabaseClient;
      const [component] = await database
      .insert(inventoryComponents)
      .values({
        organizationId: input.organizationId,
        assetId: input.assetId,
        ecosystem: identity.ecosystem,
        componentKey: identity.componentKey,
        displayName: identity.displayName,
        resolvedVersion: normalized.versionNormalized,
        resolvedVersionScheme: normalized.versionScheme,
        resolvedConfidence: input.confidence ?? null,
        resolvedObservationSource: input.source,
        resolvedVersionObservedAt: normalized.versionNormalized ? now : null,
        resolvedEvidenceTier: evidenceTierForObservation(
          input.source,
          normalized.versionNormalized,
        ),
        versionReadAttempts,
        backportRisk: identity.backportRisk,
        firstSeenAt: now,
        lastSeenAt: now,
        lastConfirmedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inventoryComponents.organizationId,
          inventoryComponents.assetId,
          inventoryComponents.ecosystem,
          inventoryComponents.componentKey,
        ],
        set: {
          displayName: identity.displayName,
          backportRisk: identity.backportRisk,
          // Collectors can finish out of order. A slower, older completion
          // must not move component freshness backwards.
          lastSeenAt: sql`greatest(${inventoryComponents.lastSeenAt}, ${now})`,
          lastConfirmedAt: sql`greatest(${inventoryComponents.lastConfirmedAt}, ${now})`,
          // Atomic object merge: one latest value per method keeps the ledger
          // bounded even when a source reconfirms the same component forever.
          versionReadAttempts: sql<ComponentVersionReadAttempts>`
            coalesce(${inventoryComponents.versionReadAttempts}, '{}'::jsonb)
            || ${versionReadAttemptsJson}::jsonb
          `,
          updatedAt: sql`greatest(${inventoryComponents.updatedAt}, ${now})`,
        },
      })
      .returning({ id: inventoryComponents.id, createdAt: inventoryComponents.createdAt });

    if (!component) {
      throw new Error('Component upsert did not return a row');
    }

    // `ON CONFLICT DO UPDATE` holds this component row's lock until commit.
    // Keeping the observation insert and re-resolution in this transaction
    // serializes writers for one component, so a stale read cannot win last.
    //
    // A missing port is stored as -1 rather than null: the uniqueness of an
    // observation includes the port, and NULLs are distinct in Postgres unique
    // indexes, so null would let identical sightings pile up unbounded.
    await database
      .insert(componentObservations)
      .values({
        componentId: component.id,
        organizationId: input.organizationId,
        scopeId: input.scopeId ?? null,
        observedByUserId: input.observedByUserId ?? null,
        sessionId: input.sessionId ?? null,
        source: input.source,
        port: input.port ?? -1,
        serviceId: input.serviceId ?? null,
        versionRaw: normalized.versionRaw,
        versionNormalized: normalized.versionNormalized,
        versionScheme: normalized.versionScheme,
        confidence: input.confidence ?? null,
        sourceAnchor: input.sourceAnchor ?? null,
        evidence: input.evidence ?? [],
        observedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          componentObservations.componentId,
          componentObservations.source,
          componentObservations.port,
          componentObservations.versionRaw,
        ],
        set: {
          observedAt: sql`greatest(${componentObservations.observedAt}, ${now})`,
          confidence: input.confidence ?? null,
          sourceAnchor: input.sourceAnchor ?? null,
          evidence: input.evidence ?? [],
        },
      });

      await this.reresolveComponent(database, component.id, now);
      return component;
    });

    return {
      status: 'recorded',
      componentId: component.id,
      componentKey: identity.componentKey,
      created: component.createdAt.getTime() === now.getTime(),
    };
  }

  /**
   * Recompute the resolved version from every sighting of this component.
   *
   * Done as a read-then-write rather than inline on the observation insert
   * because resolution depends on the whole set, not on the latest arrival.
   */
  private async reresolveComponent(
    database: DatabaseClient,
    componentId: string,
    now: Date,
  ): Promise<void> {
    const observations = await database
      .select({
        versionNormalized: componentObservations.versionNormalized,
        versionScheme: componentObservations.versionScheme,
        confidence: componentObservations.confidence,
        observedAt: componentObservations.observedAt,
        source: componentObservations.source,
      })
      .from(componentObservations)
      .where(eq(componentObservations.componentId, componentId))
      .orderBy(desc(componentObservations.observedAt))
      .limit(200);

    const resolution = resolveComponentVersion(observations);

    await database
      .update(inventoryComponents)
      .set({
        resolvedVersion: resolution.resolvedVersion,
        resolvedVersionScheme: resolution.resolvedVersionScheme,
        resolvedConfidence: resolution.resolvedConfidence,
        resolvedObservationSource: resolution.resolvedObservationSource,
        resolvedVersionObservedAt: resolution.resolvedVersionObservedAt,
        resolvedEvidenceTier: evidenceTierForObservation(
          resolution.resolvedObservationSource,
          resolution.resolvedVersion,
        ),
        versionConflict: resolution.versionConflict,
        observationCount: observations.length,
        updatedAt: now,
      })
      .where(eq(inventoryComponents.id, componentId));
  }

  private async recordUnmapped(aliasText: string): Promise<void> {
    const now = this.now();
    try {
      await this.db
        .insert(componentUnmapped)
        .values({ aliasText, observationCount: 1, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [componentUnmapped.aliasText],
          set: {
            observationCount: sql`${componentUnmapped.observationCount} + 1`,
            lastSeenAt: now,
          },
        });
    } catch (error) {
      // Coverage bookkeeping must never fail an ingestion run.
      logger.warn({ err: error, aliasText }, '[threat-watch] Failed to record unmapped component');
    }
  }

  /** Components for one asset, most recently confirmed first. */
  async listComponentsForAsset(params: { organizationId: string; assetId: string }) {
    return this.db
      .select()
      .from(inventoryComponents)
      .where(
        and(
          eq(inventoryComponents.organizationId, params.organizationId),
          eq(inventoryComponents.assetId, params.assetId),
        ),
      )
      .orderBy(desc(inventoryComponents.lastConfirmedAt));
  }
}
