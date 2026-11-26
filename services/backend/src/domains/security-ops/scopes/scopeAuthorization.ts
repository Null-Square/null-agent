import { createHash } from 'node:crypto';
import {
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_AUTHORIZATION_STATEMENT_VERSION,
  findScopeWideningReasons,
  normalizeContract,
  scopeChangeRequiresStatement,
  type ScopeContract,
  type ScopeRule,
  type ScopeRuleType,
  type ScopeWideningReason,
} from '@null-ai/contracts';

/**
 * The storage side of the customer's authorization statement.
 *
 * The statement text and the widening rule live in `@null-ai/contracts`, so the
 * screen that asks and the route that accepts read the same definition. What is
 * here is what only the server can do: hash the contract, and shape the audit
 * row it is written into.
 *
 * Authorization is **evidence, not a gate**: it is written beside the change it
 * authorizes, in `audit_logs`, and nothing reads it to decide whether a run may
 * start. Target verification remains the single activation state — see
 * `scopeVerificationGate`.
 *
 * The distinction matters because the opposite was built once and shipped a
 * runtime gate that failed verified Website Watch sites with
 * `authorization_missing`. If anything here ever appears in a run prerequisite,
 * a scheduler, or `PreTurnChecks`, that is the bug.
 */

export {
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_AUTHORIZATION_STATEMENT_VERSION,
  normalizeContract,
};
export type { ScopeContract, ScopeRule, ScopeRuleType };

/** Local aliases so callers in this domain keep reading in domain language. */
export type WideningReason = ScopeWideningReason;
export const findWideningReasons = findScopeWideningReasons;
export const requiresNewStatement = scopeChangeRequiresStatement;

export const contractDigest = (contract: ScopeContract): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        statementVersion: SCOPE_AUTHORIZATION_STATEMENT_VERSION,
        contract: normalizeContract(contract),
      }),
    )
    .digest('hex');

/* `scope_updated` covers an exclusion removal now: the scope page commits the
   whole boundary in one PUT, so there is no separate exclusion write to name. */
export type ScopeAuthorizationTrigger = 'scope_created' | 'scope_updated' | 'target_added';

/** The `metadata` written on a `scope.authorization_recorded` audit row. */
export interface ScopeAuthorizationEvidence extends Record<string, unknown> {
  statementVersion: string;
  statementText: string;
  trigger: ScopeAuthorizationTrigger;
  contract: ScopeContract;
  contractDigest: string;
}

export const buildAuthorizationEvidence = (
  trigger: ScopeAuthorizationTrigger,
  contract: ScopeContract,
): ScopeAuthorizationEvidence => {
  const normalized = normalizeContract(contract);
  return {
    statementVersion: SCOPE_AUTHORIZATION_STATEMENT_VERSION,
    statementText: SCOPE_AUTHORIZATION_STATEMENT,
    trigger,
    contract: normalized,
    contractDigest: contractDigest(normalized),
  };
};

export const SCOPE_AUTHORIZATION_AUDIT_ACTION = 'scope.authorization_recorded';

/** Read an evidence payload back out of an audit row's `metadata`. */
export const parseAuthorizationEvidence = (
  metadata: Record<string, unknown> | null | undefined,
): ScopeAuthorizationEvidence | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const contract = metadata.contract as ScopeContract | undefined;
  const digest = metadata.contractDigest;
  if (!contract || typeof digest !== 'string') return null;
  return {
    statementVersion: String(metadata.statementVersion ?? ''),
    statementText: String(metadata.statementText ?? ''),
    trigger: (metadata.trigger as ScopeAuthorizationTrigger) ?? 'scope_updated',
    contract,
    contractDigest: digest,
  };
};
