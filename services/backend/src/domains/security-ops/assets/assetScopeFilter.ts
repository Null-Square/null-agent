import { and, eq, sql, type SQL } from 'drizzle-orm';

import { assetScopeMemberships, assets } from '@/db/schema';

/**
 * Restrict an asset query to the assets a scope has observed.
 *
 * Assets used to be keyed per user, so every query filtered on
 * `assets.user_id` and each member of an organization effectively had a private
 * copy of the inventory. Organization now owns the asset, which makes a user
 * filter a visibility bug: a domain first observed by one member would be
 * invisible to another member's run.
 *
 * Scope is likewise a relation rather than a column. `assets.scope_id` records
 * only the scope that first observed the asset, so filtering on it would hide
 * an asset a second scope has since observed. Membership is the superset — both
 * ingestion writers record one for the originating scope as well.
 *
 * Written as a correlated EXISTS rather than a subquery builder so the clause
 * needs no database handle: callers can build it in any context, and it stays
 * composable inside an existing `and(...)`.
 *
 * The originating column is still accepted alongside membership, and that is
 * deliberate rather than transitional caution. Membership rows are written by
 * the ingestion writers, so any asset created by another path — or before
 * memberships existed — has none, and a membership-only filter made those
 * assets silently vanish from every scope-filtered query. Inventory and run
 * context both depend on this shared membership boundary.
 *
 * Accepting both is a superset of the old behaviour, so adopting this clause
 * can never hide an asset a caller used to see. It can be tightened once every
 * writer is guaranteed to record membership.
 */
export const assetInScopeClause = (scopeId: string): SQL =>
  sql`(
    ${assets.scopeId} = ${scopeId}
    OR EXISTS (
      SELECT 1
      FROM ${assetScopeMemberships}
      WHERE ${assetScopeMemberships.assetId} = ${assets.id}
        AND ${assetScopeMemberships.scopeId} = ${scopeId}
    )
  )`;

/**
 * Tenancy predicate for asset-joined queries: always the organization, and the
 * scope only when one is in context.
 */
export const assetTenancyClause = (params: {
  organizationId: string;
  scopeId?: string | null;
}): SQL | undefined => {
  const clauses: SQL[] = [eq(assets.organizationId, params.organizationId)];

  if (params.scopeId) {
    clauses.push(assetInScopeClause(params.scopeId));
  }

  return and(...clauses);
};
