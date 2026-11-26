import { db } from '@/db/client';
import { ScopeVerificationGate } from './scopeVerificationGate';

/**
 * Process-wide gate instance. Every enforcement point shares it so the allow
 * cache stays coherent and target mutations invalidate a single place.
 */
export const scopeVerificationGate = new ScopeVerificationGate(db);
