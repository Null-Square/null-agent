import { and, sql, type SQL } from 'drizzle-orm';

import {
  assetScopeMemberships,
  assets,
  findings,
  inventoryNotes,
  inventoryServices,
  scannerObservations,
  scopeTargets,
} from '@/db/schema';
import { assetInScopeClause } from '@/domains/security-ops/assets/assetScopeFilter';

/**
 * A lead is an active asset row with no durable supporting fact.
 *
 * Confirmation is derived from the facts that the product already stores. It
 * is not a lifecycle state and it cannot become stale when evidence changes.
 */
export const assetHasDurableConfirmationClause = (scopeId?: string | null): SQL => {
  const exactVerifiedTarget = sql`EXISTS (
    SELECT 1
    FROM ${scopeTargets}
    WHERE ${scopeTargets.verified} = TRUE
      AND ${scopeTargets.type} = ${assets.kind}
      AND LOWER(${scopeTargets.value}) = LOWER(${assets.value})
      AND (
        ${scopeTargets.scopeId} = ${assets.scopeId}
        OR EXISTS (
          SELECT 1
          FROM ${assetScopeMemberships}
          WHERE ${assetScopeMemberships.assetId} = ${assets.id}
            AND ${assetScopeMemberships.scopeId} = ${scopeTargets.scopeId}
        )
      )
      ${scopeId ? sql`AND ${scopeTargets.scopeId} = ${scopeId}` : sql``}
  )`;

  return sql`(
    ${exactVerifiedTarget}
    OR jsonb_array_length(COALESCE(${assets.evidence}, '[]'::jsonb)) > 0
    OR EXISTS (SELECT 1 FROM ${inventoryServices} WHERE ${inventoryServices.assetId} = ${assets.id})
    OR EXISTS (SELECT 1 FROM ${inventoryNotes} WHERE ${inventoryNotes.assetId} = ${assets.id})
    OR EXISTS (SELECT 1 FROM ${findings} WHERE ${findings.assetId} = ${assets.id})
    OR EXISTS (SELECT 1 FROM ${scannerObservations} WHERE ${scannerObservations.assetId} = ${assets.id})
  )`;
};

/** Retired repository projections stay as memory, but are not active assets. */
export const assetIsActiveClause = (): SQL => sql`(
  NOT ('repository_disconnected' = ANY(COALESCE(${assets.tags}, ARRAY[]::text[])))
  AND NOT ('repository_archived' = ANY(COALESCE(${assets.tags}, ARRAY[]::text[])))
)`;

export const confirmedAssetClause = (scopeId?: string | null): SQL => {
  const clauses: SQL[] = [assetIsActiveClause(), assetHasDurableConfirmationClause(scopeId)];
  if (scopeId) clauses.unshift(assetInScopeClause(scopeId));
  return and(...clauses)!;
};

/** Customer inventory excludes internal repository memory as well as leads. */
export const customerVisibleAssetClause = (scopeId?: string | null): SQL =>
  and(confirmedAssetClause(scopeId), sql`${assets.kind} <> 'repository'`)!;

export const assetIsLeadExpression = (scopeId?: string | null): SQL<boolean> =>
  sql<boolean>`NOT (${assetHasDurableConfirmationClause(scopeId)})`;
