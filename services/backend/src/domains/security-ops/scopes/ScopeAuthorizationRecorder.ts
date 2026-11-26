import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import { auditLogs, scopeExclusions, scopeTargets, scopes } from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { ImpactTolerance } from './ScopeService';
import {
  SCOPE_AUTHORIZATION_AUDIT_ACTION,
  buildAuthorizationEvidence,
  findWideningReasons,
  parseAuthorizationEvidence,
  type ScopeAuthorizationEvidence,
  type ScopeAuthorizationTrigger,
  type ScopeContract,
} from './scopeAuthorization';

/**
 * Writes and reads the customer's authorization statement.
 *
 * There is no `scope_authorizations` table and there will not be one: the
 * statement is an `audit_logs` row beside the change it authorizes. That table
 * already carries actor, timestamp, tenant and a jsonb payload, is indexed on
 * `(organization_id, resource_type, resource_id)`, is never pruned, and its
 * service takes a `DatabaseClient` — so it composes into the same transaction
 * as the scope write.
 *
 * Note what is absent: no status, no expiry, no revocation, no `current` flag.
 * There is nothing here for a run to consult, which is the point.
 */
export class ScopeAuthorizationRecorder {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * The contract as it stands in the database right now.
   *
   * Read inside the caller's transaction and *after* the write, so the digest
   * describes what was actually committed rather than what was requested.
   */
  async readContract(scopeId: string): Promise<ScopeContract> {
    const [scope] = await this.db
      .select({
        impactTolerance: scopes.impactTolerance,
        executionNetwork: scopes.executionNetwork,
      })
      .from(scopes)
      .where(eq(scopes.id, scopeId))
      .limit(1);

    if (!scope) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found');
    }

    const [roots, exclusions] = await Promise.all([
      this.db
        .select({ type: scopeTargets.type, value: scopeTargets.value })
        .from(scopeTargets)
        .where(eq(scopeTargets.scopeId, scopeId)),
      this.db
        .select({ type: scopeExclusions.type, value: scopeExclusions.value })
        .from(scopeExclusions)
        .where(eq(scopeExclusions.scopeId, scopeId)),
    ]);

    return {
      roots: roots as ScopeContract['roots'],
      exclusions: exclusions as ScopeContract['exclusions'],
      impactTolerance: scope.impactTolerance as ImpactTolerance,
      executionNetwork: scope.executionNetwork,
    };
  }

  /** The most recent statement, or null when the scope has never carried one. */
  async lastAuthorizedContract(
    organizationId: string,
    scopeId: string,
  ): Promise<ScopeContract | null> {
    const [row] = await this.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.resourceType, 'scope'),
          eq(auditLogs.resourceId, scopeId),
          eq(auditLogs.action, SCOPE_AUTHORIZATION_AUDIT_ACTION),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    return parseAuthorizationEvidence(row?.metadata)?.contract ?? null;
  }

  /**
   * Reject a write that widens the boundary without a fresh statement.
   *
   * This is input validation on a change the customer just asked for, at the
   * moment they asked for it. It is deliberately *not* a check on execution:
   * a scope whose contract has moved on since its last statement still runs.
   *
   * A scope with no statement on file is not refused. There is nothing to
   * widen: this check protects a warranty the customer has already given, and
   * where none exists there is none to contradict. Two real cases depend on it
   * — scopes that predate this feature, which would otherwise refuse even a
   * rename until someone re-stated a boundary they never widened; and
   * onboarding, where the website step creates the scope so it can issue a
   * verification record, and the statement is given on the step after. The
   * first statement records whatever the boundary is when it is given, and
   * everything after it is checked.
   */
  async assertStatementCoversChange(input: {
    organizationId: string;
    scopeId: string;
    nextContract: ScopeContract;
    statementAccepted: boolean;
  }): Promise<void> {
    if (input.statementAccepted) return;

    const authorized = await this.lastAuthorizedContract(input.organizationId, input.scopeId);
    if (!authorized) return;

    const reasons = findWideningReasons(authorized, input.nextContract);
    if (reasons.length === 0) return;

    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      'This change widens what may be tested. Accept the authorization statement to save it.',
      { context: { scopeId: input.scopeId, wideningReasons: reasons } },
    );
  }

  /** Append the statement. Call inside the same transaction as the scope write. */
  async record(input: {
    organizationId: string;
    scopeId: string;
    actorId: string;
    trigger: ScopeAuthorizationTrigger;
    contract: ScopeContract;
    requestMetadata?: Record<string, unknown>;
  }): Promise<ScopeAuthorizationEvidence> {
    const evidence = buildAuthorizationEvidence(input.trigger, input.contract);

    await this.db.insert(auditLogs).values({
      organizationId: input.organizationId,
      actorId: input.actorId,
      actorType: 'user',
      action: SCOPE_AUTHORIZATION_AUDIT_ACTION,
      resourceType: 'scope',
      resourceId: input.scopeId,
      changes: null,
      metadata: { ...(input.requestMetadata ?? {}), ...evidence },
    });

    return evidence;
  }

  /** History for the scope page. Read-only, and carries no status to gate on. */
  async history(organizationId: string, scopeId: string, limit = 50) {
    const rows = await this.db
      .select({
        id: auditLogs.id,
        actorId: auditLogs.actorId,
        actorType: auditLogs.actorType,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.resourceType, 'scope'),
          eq(auditLogs.resourceId, scopeId),
          eq(auditLogs.action, SCOPE_AUTHORIZATION_AUDIT_ACTION),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));

    return rows.flatMap((row) => {
      const evidence = parseAuthorizationEvidence(row.metadata);
      if (!evidence) return [];
      return [{
        id: row.id,
        actorId: row.actorId,
        actorType: row.actorType,
        createdAt: row.createdAt.toISOString(),
        ...evidence,
      }];
    });
  }
}
