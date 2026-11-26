import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  scopeExclusions,
  scopes,
  scopeTargets,
  type ScopeExclusionRow,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { sha256Hex } from '@/shared/utils/hash';
import {
  decideScopeTargetRef,
  normalizeScopeRule,
  type ScopeNamespaceDecision,
  type ScopeNamespaceRule,
} from './scopeBoundaryPolicy';

export interface ScopeBoundarySnapshot {
  rulesDigest: string;
  roots: ScopeNamespaceRule[];
  exclusions: ScopeNamespaceRule[];
}

const sortedRules = (rules: ScopeNamespaceRule[]): ScopeNamespaceRule[] =>
  [...rules].sort((left, right) =>
    left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
  );

const normalizeRules = (rules: ScopeNamespaceRule[]): ScopeNamespaceRule[] =>
  sortedRules(rules
    .map(normalizeScopeRule)
    .filter((rule): rule is ScopeNamespaceRule => rule !== undefined));

/**
 * One scope system: verified targets define the roots and explicit exclusions
 * narrow them. There is no second authorization/attestation lifecycle here.
 */
export class ScopeBoundaryService {
  constructor(private readonly db: DatabaseClient) {}

  async listExclusions(scopeId: string): Promise<ScopeExclusionRow[]> {
    return this.db
      .select()
      .from(scopeExclusions)
      .where(eq(scopeExclusions.scopeId, scopeId));
  }

  async addExclusion(input: {
    organizationId: string;
    scopeId: string;
    type: 'domain' | 'cidr';
    value: string;
    userId: string;
  }): Promise<ScopeExclusionRow> {
    await this.assertScopeOwned(input.organizationId, input.scopeId);
    const normalized = normalizeScopeRule({ type: input.type, value: input.value });
    if (!normalized) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        `Invalid ${input.type} exclusion`,
      );
    }
    const [created] = await this.db
      .insert(scopeExclusions)
      .values({
        scopeId: input.scopeId,
        type: normalized.type,
        value: normalized.value,
        createdByUserId: input.userId,
      })
      .returning();
    if (!created) {
      throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create scope exclusion');
    }
    return created;
  }

  async removeExclusion(input: {
    organizationId: string;
    scopeId: string;
    exclusionId: string;
  }): Promise<ScopeExclusionRow> {
    await this.assertScopeOwned(input.organizationId, input.scopeId);
    const [removed] = await this.db
      .delete(scopeExclusions)
      .where(and(
        eq(scopeExclusions.id, input.exclusionId),
        eq(scopeExclusions.scopeId, input.scopeId),
      ))
      .returning();
    if (!removed) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope exclusion not found');
    }
    return removed;
  }

  async getBoundaryByScopeId(scopeId: string): Promise<ScopeBoundarySnapshot> {
    const [scopeRows, targetRows, exclusionRows] = await Promise.all([
      this.db.select({ id: scopes.id }).from(scopes).where(eq(scopes.id, scopeId)).limit(1),
      this.db.select({ type: scopeTargets.type, value: scopeTargets.value })
        .from(scopeTargets)
        .where(and(eq(scopeTargets.scopeId, scopeId), eq(scopeTargets.verified, true))),
      this.db.select({ type: scopeExclusions.type, value: scopeExclusions.value })
        .from(scopeExclusions)
        .where(eq(scopeExclusions.scopeId, scopeId)),
    ]);
    if (!scopeRows[0]) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found');
    }
    const roots = normalizeRules(targetRows as ScopeNamespaceRule[]);
    const exclusions = normalizeRules(exclusionRows as ScopeNamespaceRule[]);
    return {
      rulesDigest: sha256Hex(JSON.stringify({ roots, exclusions })),
      roots,
      exclusions,
    };
  }

  async decideTarget(scopeId: string, targetRef: string): Promise<{
    boundary: ScopeBoundarySnapshot;
    decision: ScopeNamespaceDecision;
  }> {
    const boundary = await this.getBoundaryByScopeId(scopeId);
    return {
      boundary,
      decision: decideScopeTargetRef({
        targetRef,
        roots: boundary.roots,
        exclusions: boundary.exclusions,
      }),
    };
  }

  async assertTarget(scopeId: string, targetRef: string): Promise<ScopeNamespaceDecision> {
    const { decision } = await this.decideTarget(scopeId, targetRef);
    if (!decision.allowed) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        decision.reason === 'excluded'
          ? `Target is explicitly excluded from this pentest: ${decision.normalizedValue ?? targetRef}`
          : `Target is outside the verified pentest scope: ${decision.normalizedValue ?? targetRef}`,
        { context: { scopeId, targetRef, decision } },
      );
    }
    return decision;
  }

  private async assertScopeOwned(organizationId: string, scopeId: string): Promise<void> {
    const [scope] = await this.db
      .select({ id: scopes.id })
      .from(scopes)
      .where(and(eq(scopes.id, scopeId), eq(scopes.organizationId, organizationId)))
      .limit(1);
    if (!scope) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found');
    }
  }
}
