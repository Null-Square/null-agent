export const COMPLIANCE_FRAMEWORK_KEYS = [
  'soc2',
  'gdpr',
  'hipaa',
  'pci_dss',
  'iso27001',
  'nist_csf',
] as const;

export type ComplianceFrameworkKey = (typeof COMPLIANCE_FRAMEWORK_KEYS)[number];

export const isComplianceFrameworkKey = (value: unknown): value is ComplianceFrameworkKey =>
  typeof value === 'string' && (COMPLIANCE_FRAMEWORK_KEYS as readonly string[]).includes(value);
