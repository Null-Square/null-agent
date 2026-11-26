/**
 * Scope target ownership gate — single source of truth for "may this scope do
 * metered, scope-contextual work?".
 *
 * Proven ownership is an authorization boundary, not a billing rule: a scope
 * with no verified target may not start runs, and may not run assistant chat
 * turns that inject that scope's targets, findings, assets, and RoE into a
 * model prompt. Every credit-consuming path resolves the answer here so a new
 * path cannot silently skip the check.
 *
 * Enforcement layers:
 *   1. `PreTurnChecks` (authoritative) — halts any turn on a scope-bound
 *      session before a model call, regardless of HTTP entry point.
 *   2. Route handlers — reject up front with a typed error so the client gets
 *      a clean 403 instead of a session that immediately halts.
 *   3. Frontend — renders a verify CTA instead of a composer.
 */

import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import { scopeTargets } from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';

export type ScopeVerificationBlockReason = 'no_target' | 'unverified' | 'lookup_failed';

/** Surface deciding the wording; the rule itself is identical everywhere. */
export type ScopeVerificationSurface = 'run' | 'assistant';

export interface ScopeTargetCounts {
  totalTargetsCount: number;
  verifiedTargetsCount: number;
}

export interface ScopeVerificationStatus {
  verified: boolean;
  reason?: ScopeVerificationBlockReason;
}

export const SCOPE_VERIFICATION_MESSAGES: Record<
  ScopeVerificationSurface,
  Record<ScopeVerificationBlockReason, string>
> = {
  run: {
    no_target: 'Set the scope target and verify ownership before starting a run.',
    unverified: 'Target ownership must be verified before starting a run.',
    lookup_failed: 'Target ownership could not be confirmed for this scope. Try again shortly.',
  },
  assistant: {
    no_target: 'Add a target to this scope and verify ownership before using the assistant.',
    unverified: 'Verify target ownership for this scope before using the assistant.',
    lookup_failed: 'Target ownership could not be confirmed for this scope. Try again shortly.',
  },
};

export const scopeVerificationMessage = (
  reason: ScopeVerificationBlockReason,
  surface: ScopeVerificationSurface,
): string => SCOPE_VERIFICATION_MESSAGES[surface][reason];

/**
 * Pure rule. Callers that already hold target counts (run creation) use this
 * directly instead of re-querying.
 */
export const evaluateScopeVerification = (counts: ScopeTargetCounts): ScopeVerificationStatus => {
  if (counts.totalTargetsCount <= 0) {
    return { verified: false, reason: 'no_target' };
  }
  if (counts.verifiedTargetsCount <= 0) {
    return { verified: false, reason: 'unverified' };
  }
  return { verified: true };
};

/** Positive results only, so verifying unblocks on the very next turn. */
const DEFAULT_ALLOW_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;

export class ScopeVerificationGate {
  private readonly allowCache = new Map<string, number>();

  constructor(
    private readonly db: DatabaseClient,
    private readonly allowCacheTtlMs: number = DEFAULT_ALLOW_CACHE_TTL_MS,
  ) {}

  async getCounts(scopeId: string): Promise<ScopeTargetCounts> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where ${scopeTargets.verified})::int`,
      })
      .from(scopeTargets)
      .where(eq(scopeTargets.scopeId, scopeId));

    return {
      totalTargetsCount: Number(row?.total ?? 0),
      verifiedTargetsCount: Number(row?.verified ?? 0),
    };
  }

  /**
   * Never throws — a lookup failure resolves to `lookup_failed`, which callers
   * treat as blocked. Ownership checks fail closed; unlike the credit check,
   * "we could not tell" must not mean "allowed".
   */
  async check(scopeId: string): Promise<ScopeVerificationStatus> {
    const trimmed = typeof scopeId === 'string' ? scopeId.trim() : '';
    if (!trimmed) {
      return { verified: false, reason: 'no_target' };
    }

    const allowedUntil = this.allowCache.get(trimmed);
    if (typeof allowedUntil === 'number' && allowedUntil > Date.now()) {
      return { verified: true };
    }

    try {
      const status = evaluateScopeVerification(await this.getCounts(trimmed));
      if (status.verified) {
        this.rememberAllowed(trimmed);
      }
      return status;
    } catch {
      return { verified: false, reason: 'lookup_failed' };
    }
  }

  async assert(
    scopeId: string,
    surface: ScopeVerificationSurface,
  ): Promise<void> {
    const status = await this.check(scopeId);
    if (status.verified) {
      return;
    }
    const reason = status.reason ?? 'unverified';
    const message = scopeVerificationMessage(reason, surface);
    throw new AppError(ERROR_CODES.SCOPE_TARGET_UNVERIFIED, message, {
      userMessage: message,
      context: { scopeId, reason },
    });
  }

  /** Called whenever a scope's target set changes, so revocation is immediate. */
  invalidate(scopeId: string): void {
    if (typeof scopeId === 'string' && scopeId.trim()) {
      this.allowCache.delete(scopeId.trim());
    }
  }

  private rememberAllowed(scopeId: string): void {
    if (this.allowCache.size >= MAX_CACHE_ENTRIES) {
      this.allowCache.clear();
    }
    this.allowCache.set(scopeId, Date.now() + this.allowCacheTtlMs);
  }
}
