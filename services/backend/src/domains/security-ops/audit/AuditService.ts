import { and, desc, eq, gte, like, lte, type SQL } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { auditLogs, type AuditLogRow } from '@/db/schema';

export type AuditActorType = 'user' | 'runner' | 'system';

export interface AuditLogInput {
  organizationId: string;
  actorId: string;
  actorType: AuditActorType;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditLogListParams {
  limit?: number;
  action?: string;
  actionPrefix?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}

export class AuditService {
  constructor(private readonly db: DatabaseClient) {}

  async log(input: AuditLogInput): Promise<AuditLogRow> {
    const [row] = await this.db
      .insert(auditLogs)
      .values({
        organizationId: input.organizationId,
        actorId: input.actorId,
        actorType: input.actorType,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        changes: input.changes ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    return row;
  }

  async list(organizationId: string, params: AuditLogListParams = {}): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);

    const filters: SQL<unknown>[] = [eq(auditLogs.organizationId, organizationId)];
    if (params.action) {
      filters.push(eq(auditLogs.action, params.action));
    }
    if (params.actionPrefix) {
      filters.push(like(auditLogs.action, `${params.actionPrefix}%`));
    }
    if (params.resourceType) {
      filters.push(eq(auditLogs.resourceType, params.resourceType));
    }
    if (params.resourceId) {
      filters.push(eq(auditLogs.resourceId, params.resourceId));
    }
    if (params.from) {
      filters.push(gte(auditLogs.createdAt, params.from));
    }
    if (params.to) {
      filters.push(lte(auditLogs.createdAt, params.to));
    }

    return this.db
      .select()
      .from(auditLogs)
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }
}
