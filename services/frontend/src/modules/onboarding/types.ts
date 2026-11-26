import type { ComplianceFrameworkKey, ImpactTolerance } from '@/modules/security-ops/types';

export type SetupFormData = {
  orgName: string;
  operationalContext: string;
  scopeName: string;
  mission: string;
  impactTolerance: ImpactTolerance;
  complianceFrameworks: ComplianceFrameworkKey[];
  targetType: 'domain' | 'cidr';
  targetValue: string;
  domainVerificationMethod: 'dns_txt' | 'http_well_known';
  isTargetVerified: boolean;
};

export type OnboardingProgress = {
  version: 1;
  lastCompletedStep: number;
  formData: SetupFormData;
  scopeId: string | null;
  targetId: string | null;
  targetSnapshot: string;
  updatedAt: string;
};

export type UpdateSetupFormData = (updates: Partial<SetupFormData>) => void;
