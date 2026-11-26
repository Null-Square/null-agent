import { and, eq } from 'drizzle-orm';

import { db, type DatabaseClient } from '@/db/client';
import { organizationMembers } from '@/db/schema';
import { normalizeOrgRole, type OrgRole } from '@/shared/auth/orgRoles';
import { logger } from '@/shared/logger';
import type { OrganizationCapabilityKey } from './capabilities';
import { ORGANIZATION_ROLE_CAPABILITY_MAP } from './roles';

export type OrganizationAccess = {
  roles: Array<{
    key: OrgRole;
    scope: 'organization';
    organizationId: string;
    source: 'membership';
    expiresAt: null;
  }>;
  capabilities: OrganizationCapabilityKey[];
};

const log = logger.child({ scope: 'AuthorizationService' });

/**
 * What the person may do in an organization. Null AI has one person and no staff: roles come only
 * from organization membership, and there are no platform roles, grants or break-glass.
 */
export class AuthorizationService {
  constructor(private readonly client: DatabaseClient = db) {}

  async organizationAccess(userId: string, organizationId: string): Promise<OrganizationAccess> {
    let rows: Array<{ role: string }> = [];
    try {
      rows = await this.client
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, organizationId)));
    } catch (error) {
      log.debug({ err: error }, 'Failed to load organization memberships for authorization');
    }
    const roles = rows
      .map((row) => normalizeOrgRole(row.role))
      .filter((role): role is OrgRole => role !== null);
    const capabilities = [...new Set(roles.flatMap((role) => ORGANIZATION_ROLE_CAPABILITY_MAP[role]))].sort();
    return {
      roles: roles.map((key) => ({
        key,
        scope: 'organization',
        organizationId,
        source: 'membership',
        expiresAt: null,
      })),
      capabilities,
    };
  }
}

export const authorizationService = new AuthorizationService();
