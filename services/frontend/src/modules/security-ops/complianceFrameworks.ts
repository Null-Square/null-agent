import { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey } from '@null-ai/contracts';

export { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey };

export const COMPLIANCE_FRAMEWORK_SHORT_LABELS: Record<ComplianceFrameworkKey, string> = {
  soc2: 'SOC 2',
  gdpr: 'GDPR',
  hipaa: 'HIPAA',
  pci_dss: 'PCI DSS',
  iso27001: 'ISO 27001',
  nist_csf: 'NIST CSF',
};

export const COMPLIANCE_FRAMEWORK_CONTEXT_LABELS: Record<ComplianceFrameworkKey, string> = {
  soc2: 'SOC 2 Type II',
  gdpr: 'GDPR Readiness',
  hipaa: 'HIPAA Security Rule',
  pci_dss: 'PCI DSS v4.0.1',
  iso27001: 'ISO 27001',
  nist_csf: 'NIST CSF 2.0',
};

export const COMPLIANCE_FRAMEWORK_OPTIONS = COMPLIANCE_FRAMEWORK_KEYS.map((key) => ({
  key,
  label: COMPLIANCE_FRAMEWORK_SHORT_LABELS[key],
}));

export const COMPLIANCE_FRAMEWORK_CONTEXT_OPTIONS = COMPLIANCE_FRAMEWORK_KEYS.map((key) => ({
  id: key,
  title: COMPLIANCE_FRAMEWORK_CONTEXT_LABELS[key],
}));
