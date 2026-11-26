import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  inventoryComponents,
  type ComponentObservationSource,
  type ComponentVersionReadAttempt,
  type ComponentVersionReadAttempts,
  type ComponentVersionReadMethod,
} from '@/db/schema';

/**
 * Bounded active methods, in the order a later run should try them.
 *
 * Each method is attempted at most once while a component remains unversioned.
 * Re-observation can update the method's ledger entry, but cannot grow the
 * ledger or send the agent back to a method it already tried.
 */
export const ACTIVE_VERSION_READ_METHODS = [
  'http_banner',
  'service_probe',
  'application_fingerprint',
  'error_behavior',
  'tls_fingerprint',
] as const satisfies readonly ComponentVersionReadMethod[];

export type ActiveVersionReadMethod = (typeof ACTIVE_VERSION_READ_METHODS)[number];

const ACTIVE_METHOD_SET = new Set<ComponentVersionReadMethod>(ACTIVE_VERSION_READ_METHODS);

export type VersionAcquisitionObjective = {
  componentId: string;
  componentKey: string;
  product: string;
  ecosystem: string;
  status: 'needs_version' | 'exhausted';
  recommendedMethod: ActiveVersionReadMethod | null;
  attemptedMethods: ActiveVersionReadMethod[];
  remainingMethods: ActiveVersionReadMethod[];
};

/** Map ingestion provenance to the concrete read method it represents. */
export const versionReadMethodForSource = (
  source: ComponentObservationSource,
): ComponentVersionReadMethod => {
  switch (source) {
    case 'httpx':
      return 'http_banner';
    case 'connected_site':
      return 'connected_manifest';
    case 'lockfile':
      return 'dependency_manifest';
    case 'scan_preview':
      return 'passive_fingerprint';
    case 'agent':
      return 'agent_observation';
  }
};

export const buildVersionReadAttempt = (params: {
  method: ComponentVersionReadMethod;
  source: ComponentObservationSource;
  version: string | null;
  attemptedAt: Date;
}): ComponentVersionReadAttempt => ({
  method: params.method,
  source: params.source,
  outcome: params.version ? 'version_observed' : 'version_absent',
  attemptedAt: params.attemptedAt.toISOString(),
});

const attemptedActiveMethods = (
  attempts: ComponentVersionReadAttempts | null | undefined,
): ActiveVersionReadMethod[] =>
  ACTIVE_VERSION_READ_METHODS.filter((method) => {
    const attempt = attempts?.[method];
    return attempt?.method === method && ACTIVE_METHOD_SET.has(attempt.method);
  });

export const nextVersionReadMethod = (
  attempts: ComponentVersionReadAttempts | null | undefined,
): ActiveVersionReadMethod | null => {
  const attempted = new Set(attemptedActiveMethods(attempts));
  return ACTIVE_VERSION_READ_METHODS.find((method) => !attempted.has(method)) ?? null;
};

export const buildVersionAcquisitionObjective = (component: {
  id: string;
  componentKey: string;
  displayName: string;
  ecosystem: string;
  versionReadAttempts: ComponentVersionReadAttempts | null | undefined;
}): VersionAcquisitionObjective => {
  const attemptedMethods = attemptedActiveMethods(component.versionReadAttempts);
  const attempted = new Set(attemptedMethods);
  const remainingMethods = ACTIVE_VERSION_READ_METHODS.filter((method) => !attempted.has(method));
  const recommendedMethod = remainingMethods[0] ?? null;

  return {
    componentId: component.id,
    componentKey: component.componentKey,
    product: component.displayName,
    ecosystem: component.ecosystem,
    status: recommendedMethod ? 'needs_version' : 'exhausted',
    recommendedMethod,
    attemptedMethods,
    remainingMethods,
  };
};

export type LoadVersionAcquisitionByAssetIds = (params: {
  organizationId: string;
  assetIds: string[];
}) => Promise<Map<string, VersionAcquisitionObjective[]>>;

/** Load explicit objectives only for named components whose version is absent. */
export const createVersionAcquisitionLoader = (
  db: DatabaseClient,
): LoadVersionAcquisitionByAssetIds => async ({ organizationId, assetIds }) => {
  const byAsset = new Map<string, VersionAcquisitionObjective[]>();
  if (assetIds.length === 0) return byAsset;

  const rows = await db
    .select({
      id: inventoryComponents.id,
      assetId: inventoryComponents.assetId,
      componentKey: inventoryComponents.componentKey,
      displayName: inventoryComponents.displayName,
      ecosystem: inventoryComponents.ecosystem,
      versionReadAttempts: inventoryComponents.versionReadAttempts,
    })
    .from(inventoryComponents)
    .where(
      and(
        eq(inventoryComponents.organizationId, organizationId),
        inArray(inventoryComponents.assetId, assetIds),
        isNull(inventoryComponents.resolvedVersion),
      ),
    );

  for (const row of rows) {
    const objectives = byAsset.get(row.assetId) ?? [];
    objectives.push(buildVersionAcquisitionObjective(row));
    byAsset.set(row.assetId, objectives);
  }

  return byAsset;
};
