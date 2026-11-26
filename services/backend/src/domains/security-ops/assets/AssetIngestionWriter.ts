import { and, eq, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { assetObservations, assetScopeMemberships, assets, runs, scopeTargets } from '@/db/schema';
import type { ScopeService } from '@/domains/security-ops/scopes/ScopeService';

export type AssetWriterAssetKind = 'domain' | 'ip';

export type AssetWriterAssetRef = {
  kind: AssetWriterAssetKind;
  value: string;
};

export type AssetWriterEvidenceRef = {
  path: string;
  label?: string;
};

export type AssetWriterResolvedEvidenceRef = AssetWriterEvidenceRef & { path: string };

export type AssetWriterContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
};

export type AssetIngestionWriterDeps = {
  db: DatabaseClient;
  now: () => Date;
  scopeService?: Pick<ScopeService, 'isAssetInScope'>;
  resolveEvidenceRefs: (
    workspaceDir: string,
    evidence: AssetWriterEvidenceRef[] | undefined,
  ) => Promise<AssetWriterResolvedEvidenceRef[]>;
  normalizeAssetValue: (kind: AssetWriterAssetKind, rawValue: string) => string;
  mergeStringSet: (
    existing: string[] | null | undefined,
    incoming: string[] | null | undefined,
  ) => string[];
  mergeEvidenceByPath: (
    existing: Array<{ path: string; label?: string }> | null | undefined,
    incoming: Array<{ path: string; label?: string }> | null | undefined,
  ) => Array<{ path: string; label?: string }>;
  isSubdomainOf: (candidateHost: string, rootHost: string) => boolean;
  isUniqueViolation: (error: unknown) => boolean;
  isMissingSessionObservationForeignKey: (error: unknown) => boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = DatabaseClient | any;

type VerifiedScopeTarget = {
  type: string;
  value: string;
};

export class AssetIngestionWriter {
  private readonly verifiedScopeTargetsCache = new Map<string, VerifiedScopeTarget[]>();

  constructor(private readonly deps: AssetIngestionWriterDeps) {}

  async updateAssetLastScannedAt(assetId: string, now: Date): Promise<void> {
    await this.deps.db
      .update(assets)
      .set({
        lastScannedAt: now,
        updatedAt: now,
      })
      .where(eq(assets.id, assetId));
  }

  async incrementRunCounter(
    runId: string | undefined,
    counter: 'inventoryAdded' | 'findingsCount',
    executor: DbExecutor = this.deps.db,
  ): Promise<void> {
    if (!runId) {
      return;
    }

    if (counter === 'inventoryAdded') {
      await executor
        .update(runs)
        .set({
          inventoryAdded: sql`${runs.inventoryAdded} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, runId));
      return;
    }

    await executor
      .update(runs)
      .set({
        findingsCount: sql`${runs.findingsCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  }

  async resolveCandidateParentAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: AssetWriterContext;
    hostname: string;
    rootAssetRef?: AssetWriterAssetRef;
    executor?: DbExecutor;
  }): Promise<{ assetRef: AssetWriterAssetRef; created: boolean } | null> {
    const scopeId = this.requireScopeId(params.context);
    const executor = params.executor ?? this.deps.db;

    if (params.rootAssetRef?.kind === 'domain') {
      const rootValue = this.deps.normalizeAssetValue('domain', params.rootAssetRef.value);
      const result = await this.ensureScopeTargetAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        targetValue: rootValue,
        executor,
      });
      return {
        assetRef: { kind: 'domain', value: rootValue },
        created: result.created,
      };
    }

    const targets = await this.loadVerifiedScopeTargets(scopeId, executor);
    const matchedTarget = this.findBestMatchingVerifiedDomainTarget(params.hostname, targets);
    if (!matchedTarget) {
      return null;
    }

    const result = await this.ensureScopeTargetAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      targetValue: matchedTarget,
      executor,
    });

    return {
      assetRef: { kind: 'domain', value: matchedTarget },
      created: result.created,
    };
  }

  async upsertAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: AssetWriterContext;
    input: {
      kind: AssetWriterAssetKind;
      value: string;
      tags?: string[];
      evidence?: AssetWriterEvidenceRef[];
      parentAssetId?: string | null;
    };
    executor?: DbExecutor;
  }): Promise<{ assetId: string; created: boolean }> {
    const now = this.deps.now();
    const normalizedValue = this.deps.normalizeAssetValue(params.input.kind, params.input.value);
    const organizationId = this.requireOrganizationId(params.context);
    const scopeId = this.requireScopeId(params.context);
    const executor = params.executor ?? this.deps.db;
    const tags = params.input.tags ? this.deps.mergeStringSet([], params.input.tags) : [];
    const evidence = await this.deps.resolveEvidenceRefs(params.workspaceDir, params.input.evidence);

    if (this.deps.scopeService) {
      const inScope = await this.deps.scopeService.isAssetInScope(
        scopeId,
        params.input.kind,
        normalizedValue,
      );
      if (!inScope) {
        throw new Error(
          `Asset ${normalizedValue} is outside the authorized scope target. ` +
          `If the target was recently added, ensure it is marked as verified in the scope settings.`,
        );
      }
    }

    const surfaceHints = await this.resolveAssetSurfaceHints({
      scopeId,
      kind: params.input.kind,
      normalizedValue,
      executor,
    });

    const parentAssetId =
      params.input.parentAssetId ??
      (params.input.kind === 'domain' && surfaceHints.parentDomainTarget
        ? (
            await this.ensureScopeTargetAsset({
              userId: params.userId,
              workspaceDir: params.workspaceDir,
              sessionId: params.sessionId,
              context: params.context,
              targetValue: surfaceHints.parentDomainTarget,
              executor,
            })
          ).assetId
        : null);

    const [existing] = await executor
      .select({
        id: assets.id,
        tags: assets.tags,
        evidence: assets.evidence,
        parentAssetId: assets.parentAssetId,
      })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, organizationId),
          eq(assets.kind, params.input.kind),
          eq(assets.value, normalizedValue),
        ),
      )
      .limit(1);

    if (existing) {
      // organizationId and scopeId are deliberately absent from this update.
      // Writing them here is what allowed an asset to change tenancy, and to
      // migrate to whichever scope observed it last. Organization is identity
      // and cannot change; scope is recorded as a membership below.
      await executor
        .update(assets)
        .set({
          tags: this.deps.mergeStringSet(existing.tags, tags),
          evidence: this.deps.mergeEvidenceByPath(existing.evidence, evidence),
          parentAssetId: existing.parentAssetId ?? parentAssetId ?? null,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(assets.id, existing.id));
      await this.touchScopeMembership({
        organizationId,
        assetId: existing.id,
        scopeId,
        now,
        executor,
      });
      if (params.sessionId) {
        await this.touchAssetObservation({
          userId: params.userId,
          organizationId,
          assetId: existing.id,
          sessionId: params.sessionId,
          now,
          executor,
        });
      }
      return { assetId: existing.id, created: false };
    }

    try {
      const [row] = await executor
        .insert(assets)
        .values({
          organizationId,
          scopeId,
          userId: params.userId,
          kind: params.input.kind,
          value: normalizedValue,
          tags,
          evidence,
          parentAssetId,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: assets.id });
      await this.touchScopeMembership({
        organizationId,
        assetId: row.id,
        scopeId,
        now,
        executor,
      });
      if (params.sessionId) {
        await this.touchAssetObservation({
          userId: params.userId,
          organizationId,
          assetId: row.id,
          sessionId: params.sessionId,
          now,
          executor,
        });
      }
      await this.incrementRunCounter(params.context?.runId, 'inventoryAdded', executor);
      return { assetId: row.id, created: true };
    } catch (error) {
      if (!this.deps.isUniqueViolation(error)) {
        throw error;
      }
    }

    const [afterRace] = await executor
      .select({
        id: assets.id,
        tags: assets.tags,
        evidence: assets.evidence,
        parentAssetId: assets.parentAssetId,
      })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, organizationId),
          eq(assets.kind, params.input.kind),
          eq(assets.value, normalizedValue),
        ),
      )
      .limit(1);
    if (!afterRace) {
      throw new Error('Failed to upsert asset');
    }
    // As above: organization is identity and scope is a membership, so neither
    // is overwritten on the lost-race path either.
    await executor
      .update(assets)
      .set({
        tags: this.deps.mergeStringSet(afterRace.tags, tags),
        evidence: this.deps.mergeEvidenceByPath(afterRace.evidence, evidence),
        parentAssetId: afterRace.parentAssetId ?? parentAssetId ?? null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(assets.id, afterRace.id));
    await this.touchScopeMembership({
      organizationId,
      assetId: afterRace.id,
      scopeId,
      now,
      executor,
    });
    if (params.sessionId) {
      await this.touchAssetObservation({
        userId: params.userId,
        organizationId,
        assetId: afterRace.id,
        sessionId: params.sessionId,
        now,
        executor,
      });
    }
    return { assetId: afterRace.id, created: false };
  }

  /**
   * Record that this scope has observed this asset.
   *
   * An asset legitimately appears in several scopes. Before memberships existed
   * the writer expressed that by moving `assets.scope_id`, which silently took
   * the asset — and everything hanging off it — away from the previous scope.
   */
  private async touchScopeMembership(params: {
    organizationId: string;
    assetId: string;
    scopeId: string;
    now: Date;
    executor: DbExecutor;
  }): Promise<void> {
    // A single statement rather than select-then-insert: `executor` is often a
    // transaction, and a unique violation caught in application code would have
    // already aborted it.
    await params.executor
      .insert(assetScopeMemberships)
      .values({
        organizationId: params.organizationId,
        assetId: params.assetId,
        scopeId: params.scopeId,
        firstSeenAt: params.now,
        lastSeenAt: params.now,
        createdAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [assetScopeMemberships.assetId, assetScopeMemberships.scopeId],
        set: { lastSeenAt: params.now, updatedAt: params.now },
      });
  }

  private async loadVerifiedScopeTargets(
    scopeId: string,
    executor: DbExecutor = this.deps.db,
  ): Promise<VerifiedScopeTarget[]> {
    const cached = this.verifiedScopeTargetsCache.get(scopeId);
    if (cached && executor === this.deps.db) {
      return cached;
    }

    const rows = await executor
      .select({
        type: scopeTargets.type,
        value: scopeTargets.value,
      })
      .from(scopeTargets)
      .where(and(eq(scopeTargets.scopeId, scopeId), eq(scopeTargets.verified, true)));

    const normalized = rows.map((row: { type: string; value: string }) => ({
      type: row.type,
      value: row.type === 'domain' ? this.deps.normalizeAssetValue('domain', row.value) : row.value,
    }));

    if (executor === this.deps.db) {
      this.verifiedScopeTargetsCache.set(scopeId, normalized);
    }

    return normalized;
  }

  private findBestMatchingVerifiedDomainTarget(
    hostname: string,
    targets: VerifiedScopeTarget[],
  ): string | null {
    let bestMatch: string | null = null;
    for (const target of targets) {
      if (target.type !== 'domain') {
        continue;
      }
      if (hostname === target.value) {
        return target.value;
      }
      if (!this.deps.isSubdomainOf(hostname, target.value)) {
        continue;
      }
      if (!bestMatch || target.value.length > bestMatch.length) {
        bestMatch = target.value;
      }
    }
    return bestMatch;
  }

  private async resolveAssetSurfaceHints(params: {
    scopeId: string;
    kind: AssetWriterAssetKind;
    normalizedValue: string;
    executor?: DbExecutor;
  }): Promise<{ parentDomainTarget: string | null }> {
    const targets = await this.loadVerifiedScopeTargets(params.scopeId, params.executor);

    if (params.kind !== 'domain') {
      return {
        parentDomainTarget: null,
      };
    }

    const parentDomainTarget = this.findBestMatchingVerifiedDomainTarget(
      params.normalizedValue,
      targets,
    );

    return {
      parentDomainTarget:
        parentDomainTarget && parentDomainTarget !== params.normalizedValue
          ? parentDomainTarget
          : null,
    };
  }

  private async ensureScopeTargetAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: AssetWriterContext;
    targetValue: string;
    executor?: DbExecutor;
  }): Promise<{ assetId: string; created: boolean }> {
    return this.upsertAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        kind: 'domain',
        value: params.targetValue,
      },
      executor: params.executor,
    });
  }

  private async touchAssetObservation(params: {
    userId: string;
    organizationId: string;
    assetId: string;
    sessionId: string;
    now: Date;
    executor?: DbExecutor;
  }): Promise<void> {
    const executor = params.executor ?? this.deps.db;

    const [existing] = await executor
      .select({
        id: assetObservations.id,
      })
      .from(assetObservations)
      .where(
        and(
          eq(assetObservations.userId, params.userId),
          eq(assetObservations.assetId, params.assetId),
          eq(assetObservations.sessionId, params.sessionId),
        ),
      )
      .limit(1);

    if (existing) {
      await executor
        .update(assetObservations)
        .set({
          organizationId: params.organizationId,
          lastSeenAt: params.now,
          updatedAt: params.now,
        })
        .where(eq(assetObservations.id, existing.id));
      return;
    }

    try {
      await executor.insert(assetObservations).values({
        organizationId: params.organizationId,
        userId: params.userId,
        assetId: params.assetId,
        sessionId: params.sessionId,
        firstSeenAt: params.now,
        lastSeenAt: params.now,
        createdAt: params.now,
        updatedAt: params.now,
      });
      return;
    } catch (error) {
      if (this.deps.isMissingSessionObservationForeignKey(error)) {
        // Session linkage is secondary metadata. If the session row was pruned or never persisted,
        // keep the core inventory/finding write instead of failing the whole report path.
        return;
      }
      if (!this.deps.isUniqueViolation(error)) {
        throw error;
      }
    }

    const [afterRace] = await executor
      .select({ id: assetObservations.id })
      .from(assetObservations)
      .where(
        and(
          eq(assetObservations.userId, params.userId),
          eq(assetObservations.assetId, params.assetId),
          eq(assetObservations.sessionId, params.sessionId),
        ),
      )
      .limit(1);

    if (!afterRace) {
      throw new Error('Failed to upsert asset observation');
    }

    await executor
      .update(assetObservations)
      .set({
        organizationId: params.organizationId,
        lastSeenAt: params.now,
        updatedAt: params.now,
      })
      .where(eq(assetObservations.id, afterRace.id));
  }

  private requireOrganizationId(context: AssetWriterContext | undefined): string {
    if (!context?.organizationId) {
      throw new Error('organizationId is required in SecurityOps context');
    }
    return context.organizationId;
  }

  private requireScopeId(context: AssetWriterContext | undefined): string {
    if (!context?.scopeId) {
      throw new Error('scopeId is required in SecurityOps context');
    }
    return context.scopeId;
  }
}
