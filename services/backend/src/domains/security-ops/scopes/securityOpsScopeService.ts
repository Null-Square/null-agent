import { db } from '@/db/client';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';

export const securityOpsScopeService = new ScopeService(db);
