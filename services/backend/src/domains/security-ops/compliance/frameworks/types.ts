import type { ComplianceFrameworkKey } from '@null-ai/contracts';

export { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey } from '@null-ai/contracts';

export type EvidenceSupportLevel =
  | 'automated_testable'
  | 'manual_evidence_required'
  | 'integration_required'
  | 'out_of_selected_scope';

export type ControlImplementationSpec = 'required' | 'addressable' | 'mixed';
export type ControlPciApproach = 'defined' | 'customized_eligible' | 'compensating_possible';
export type ControlPciCdeScope = 'cde' | 'connected_to' | 'security_impacting' | 'payment_page' | 'program';

export interface ControlProofObligation {
  id: string;
  statement: string;
  requiredEvidence: string[];
  acceptedMethods?: string[];
}

export interface ControlDefinition {
  id: string;
  title: string;
  theme: string;
  supportLevel: EvidenceSupportLevel;
  implementationSpec?: ControlImplementationSpec;
  pciDssRequirement?: string;
  pciDssGoal?: string;
  pciDssApproach?: ControlPciApproach;
  pciDssSaqTypes?: string[];
  pciDssCdeScope?: ControlPciCdeScope;
  pciDssAccountData?: 'chd' | 'sad' | 'pan' | 'none';
  catalogRef?: string;
  proofObligation?: ControlProofObligation;
  evidenceExamples?: string[];
  freshnessWindowDays?: number;
  assessmentSkillSlugs?: string[];
  testSkillSlugs?: string[];
  deterministicTools?: string[];
  legacyInferenceAllowed?: boolean;
  skillSlugs?: string[];
  noteTypes?: string[];
  noteKeywords?: string[];
  scannerParsers?: string[];
  findingKeywords?: string[];
  cweIds?: string[];
  owaspKeywords?: string[];
  includeInventory?: boolean;
  positiveEvidenceLabel: string;
  missingGap: string;
}

export interface FrameworkDefinition {
  key: ComplianceFrameworkKey;
  label: string;
  reportTitle: string;
  reportTemplateFile: string;
  categories?: readonly string[];
  textMatchPatterns?: readonly RegExp[];
  controls: ControlDefinition[];
}
