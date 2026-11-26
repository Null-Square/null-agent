import { asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { organizationMembers } from '@/db/schema';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { normalizeOrgRole, type OrgRole } from '@/shared/auth/orgRoles';

const orgService = new OrganizationService(db);

export type OrgMembership = {
  organizationId: string;
  role: OrgRole;
};

export const resolvePrimaryOrganizationMembership = async (userId: string): Promise<OrgMembership> => {
  const [membership] = await db
    .select({
      organizationId: organizationMembers.organizationId,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);

  if (!membership) {
    const org = await orgService.createDefaultOrg(userId);
    return { organizationId: org.id, role: 'admin' };
  }

  const role = normalizeOrgRole(membership.role);
  if (!role) {
    throw new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'Invalid organization role');
  }

  return {
    organizationId: membership.organizationId,
    role,
  };
};
