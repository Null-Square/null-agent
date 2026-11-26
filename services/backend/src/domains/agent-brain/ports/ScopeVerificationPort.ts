/**
 * ScopeVerificationPort - target ownership status for a scope.
 *
 * Lets the orchestrator refuse metered work on a scope whose target ownership
 * is unproven without importing the security-ops domain. Implementations must
 * fail closed: if the status cannot be determined, report unverified.
 */

export type ScopeVerificationBlockReason = 'no_target' | 'unverified' | 'lookup_failed';

export interface ScopeVerificationResult {
  verified: boolean;
  reason?: ScopeVerificationBlockReason;
  /** Operator-facing explanation, already worded for the surface. */
  message?: string;
}

export interface ScopeVerificationPort {
  checkScope(scopeId: string): Promise<ScopeVerificationResult>;
}
