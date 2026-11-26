import { db } from '@/db/client';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';

import { AuditService } from './AuditService';

export const securityOpsAuditService = new AuditService(db);
export const securityOpsOrganizationService = new OrganizationService(db);
