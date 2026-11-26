import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  assets,
  automations,
  complianceEvidenceItems,
  findings,
  organizationMembers,
  runners,
  scopes,
} from '@/db/schema';

const findMembershipRole = async (organizationId: string, userId: string): Promise<string | null> => {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
};

const findAssetOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: assets.organizationId })
    .from(assets)
    .where(eq(assets.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

const findAutomationOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: automations.organizationId })
    .from(automations)
    .where(eq(automations.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

const findComplianceEvidenceOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: complianceEvidenceItems.organizationId })
    .from(complianceEvidenceItems)
    .where(eq(complianceEvidenceItems.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

const findFindingOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: findings.organizationId })
    .from(findings)
    .where(eq(findings.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

const findRunnerOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: runners.organizationId })
    .from(runners)
    .where(eq(runners.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

const findScopeOrganizationId = async (id: string): Promise<string | null> => {
  const [row] = await db
    .select({ organizationId: scopes.organizationId })
    .from(scopes)
    .where(eq(scopes.id, id))
    .limit(1);
  return row?.organizationId ?? null;
};

export const organizationContextAppService = {
  findMembershipRole,
  findAssetOrganizationId,
  findAutomationOrganizationId,
  findComplianceEvidenceOrganizationId,
  findFindingOrganizationId,
  findRunnerOrganizationId,
  findScopeOrganizationId,
};
