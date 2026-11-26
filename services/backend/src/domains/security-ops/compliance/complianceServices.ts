import { db } from '@/db/client';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';

import { ComplianceEvidenceService } from './ComplianceEvidenceService';
import { ComplianceControlCheckReviewService } from './ComplianceControlCheckReviewService';
import { ComplianceControlRequestService } from './ComplianceControlRequestService';
import { ComplianceControlStateService } from './ComplianceControlStateService';
import { ComplianceReadinessService } from './ComplianceReadinessService';

export const complianceOrganizationService = new OrganizationService(db);
export const complianceReadinessService = new ComplianceReadinessService(db);
export const complianceEvidenceService = new ComplianceEvidenceService(db);
export const complianceControlCheckReviewService = new ComplianceControlCheckReviewService(db);
export const complianceControlRequestService = new ComplianceControlRequestService(db);
export const complianceControlStateService = new ComplianceControlStateService(db);
export const complianceAuditService = new AuditService(db);
