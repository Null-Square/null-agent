import { eq, and, count, sql, notExists } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  organizations,
  organizationMembers,
  users,
  type OrganizationRow,
  type NewOrganizationRow,
} from '@/db/schema';
import type { OrgRole } from '@/shared/auth/orgRoles';

// ============================================================================
// Types
// ============================================================================

export type OrgProfile = Pick<
  OrganizationRow,
  | 'name'
  | 'operationalContext'
>;

export interface OrgContext {
  name: string;
  context: string | null;
}

export interface OrganizationMemberSummary {
  userId: string;
  email: string;
  role: string;
  fullName: string | null;
}

export const LAST_ORGANIZATION_ADMIN_ERROR =
  'An organization must always have at least one admin';

// ============================================================================
// Service
// ============================================================================

export class OrganizationService {
  constructor(private readonly db: DatabaseClient) {}

  private async withMembershipMutationLock<T>(
    orgId: string,
    operation: (database: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtext(${`organization_members:${orgId}`}))
      `);
      return operation(tx as unknown as DatabaseClient);
    });
  }

  private async countAdmins(database: DatabaseClient, orgId: string): Promise<number> {
    const [row] = await database
      .select({ count: count() })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'admin')));

    return Number(row?.count ?? 0);
  }

  private async getMemberWithDatabase(
    database: DatabaseClient,
    orgId: string,
    userId: string,
  ): Promise<OrganizationMemberSummary | null> {
    const [row] = await database
      .select({
        userId: users.id,
        email: users.email,
        role: organizationMembers.role,
        fullName: users.full_name,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      userId: row.userId,
      email: row.email,
      role: row.role,
      fullName: row.fullName ?? null,
    };
  }

  private async assertCanRemoveAdminRole(
    database: DatabaseClient,
    orgId: string,
    userId: string,
    nextRole?: OrgRole,
  ): Promise<void> {
    if (nextRole === 'admin') {
      return;
    }

    const member = await this.getMemberWithDatabase(database, orgId, userId);
    if (!member || member.role !== 'admin') {
      return;
    }

    const adminCount = await this.countAdmins(database, orgId);
    if (adminCount <= 1) {
      throw new Error(LAST_ORGANIZATION_ADMIN_ERROR);
    }
  }

  /**
   * Get the organization for a given user (returns their first org — single-org for now).
   * Auto-creates a default org if none exists.
   */
  async getForUser(userId: string): Promise<OrganizationRow> {
    const rows = await this.db
      .select({ org: organizations })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId))
      .limit(1);

    if (rows.length === 0) {
      // Auto-provision a default org for new users
      return this.createDefaultOrg(userId);
    }

    return rows[0].org;
  }

  /**
   * Update an org profile.
   */
  async update(orgId: string, updates: Partial<OrgProfile>): Promise<OrganizationRow> {
    const now = new Date();
    const [updated] = await this.db
      .update(organizations)
      .set({ ...updates, updatedAt: now })
      .where(eq(organizations.id, orgId))
      .returning();

    if (!updated) {
      throw new Error('Organization not found');
    }

    return updated;
  }

  /**
   * Build a structured context object for the agent system prompt.
   */
  async getOrgContext(orgId: string): Promise<OrgContext> {
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      throw new Error('Organization not found');
    }

    return {
      name: org.name,
      context: org.operationalContext,
    };
  }

  /**
   * List members for an organization for assignment workflows.
   */
  async listMembers(orgId: string): Promise<OrganizationMemberSummary[]> {
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        role: organizationMembers.role,
        fullName: users.full_name,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, orgId));

    return rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      role: row.role,
      fullName: row.fullName ?? null,
    }));
  }

  /**
   * Get one organization member by user ID.
   */
  async getMember(orgId: string, userId: string): Promise<OrganizationMemberSummary | null> {
    return this.getMemberWithDatabase(this.db, orgId, userId);
  }

  /**
   * Update an organization member role and return the updated member summary.
   */
  async updateMemberRole(orgId: string, userId: string, role: OrgRole): Promise<OrganizationMemberSummary | null> {
    return this.withMembershipMutationLock(orgId, async (database) => {
      await this.assertCanRemoveAdminRole(database, orgId, userId, role);

      const [updated] = await database
        .update(organizationMembers)
        .set({ role })
        .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)))
        .returning({ userId: organizationMembers.userId });

      if (!updated) {
        return null;
      }

      return this.getMemberWithDatabase(database, orgId, userId);
    });
  }

  /**
   * Remove a member from the organization. Returns true if a row was deleted.
   */
  async removeMember(orgId: string, userId: string): Promise<boolean> {
    return this.withMembershipMutationLock(orgId, async (database) => {
      await this.assertCanRemoveAdminRole(database, orgId, userId);

      const [deleted] = await database
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)))
        .returning({ userId: organizationMembers.userId });
      return Boolean(deleted);
    });
  }

  /**
   * List the organizations a given user is a member of, with their per-org role.
   */
  async listOrganizationsForUser(userId: string): Promise<
    Array<{
      organizationId: string;
      organizationName: string;
      organizationSlug: string;
      role: OrgRole;
      joinedAt: Date | null;
    }>
  > {
    const rows = await this.db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        role: organizationMembers.role,
        joinedAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId));

    return rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      organizationSlug: row.organizationSlug,
      role: row.role as OrgRole,
      joinedAt: row.joinedAt ?? null,
    }));
  }

  /**
   * Create a default organization for a newly signed-up user.
   */
  async createDefaultOrg(
    userId: string,
    name?: string,
  ): Promise<OrganizationRow> {
    const slug = `org-${userId.replace(/-/g, '').slice(0, 16)}`;
    const orgName = name || 'My Organization';

    const [insertedOrg] = await this.db
      .insert(organizations)
      .values({
        name: orgName,
        slug,
      } satisfies Partial<NewOrganizationRow> as NewOrganizationRow)
      .onConflictDoNothing({ target: organizations.slug })
      .returning();

    const org = insertedOrg ?? (await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1))[0];

    if (!org) {
      throw new Error('Failed to create default organization');
    }

    await this.db.insert(organizationMembers).values({
      organizationId: org.id,
      userId,
      role: 'admin',
    }).onConflictDoNothing({
      target: [organizationMembers.organizationId, organizationMembers.userId],
    });

    return org;
  }

  /**
   * Delete organizations that have no members. Every org gets its creator as a
   * member at creation, so a member-less org is an orphan — e.g. one left behind
   * when an unverified user is reaped, or from legacy signups that created an org
   * before email verification. Subordinate rows are removed via ON DELETE CASCADE.
   */
  async deleteOrphanOrganizations(): Promise<number> {
    const deleted = await this.db
      .delete(organizations)
      .where(
        notExists(
          this.db
            .select({ one: sql`1` })
            .from(organizationMembers)
            .where(eq(organizationMembers.organizationId, organizations.id)),
        ),
      )
      .returning({ id: organizations.id });
    return deleted.length;
  }
}
