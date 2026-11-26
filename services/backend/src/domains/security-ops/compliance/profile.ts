import { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey } from './frameworks';

export const COMPLIANCE_FRAMEWORK_ORDER: ComplianceFrameworkKey[] = [...COMPLIANCE_FRAMEWORK_KEYS];

const complianceFrameworkKeySet = new Set<string>(COMPLIANCE_FRAMEWORK_ORDER);

export const isComplianceFrameworkKey = (value: unknown): value is ComplianceFrameworkKey =>
  typeof value === 'string' && complianceFrameworkKeySet.has(value);

export const normalizeComplianceFrameworkKeys = (value: unknown): ComplianceFrameworkKey[] => {
  if (!Array.isArray(value)) return [];
  const keys = new Set<ComplianceFrameworkKey>();
  for (const entry of value) {
    if (isComplianceFrameworkKey(entry)) {
      keys.add(entry);
      continue;
    }
    if (
      entry &&
      typeof entry === 'object' &&
      'key' in entry &&
      isComplianceFrameworkKey((entry as { key?: unknown }).key)
    ) {
      keys.add((entry as { key: ComplianceFrameworkKey }).key);
    }
  }
  return COMPLIANCE_FRAMEWORK_ORDER.filter((key) => keys.has(key));
};

export const parseComplianceFrameworkKeysInput = (
  raw: unknown,
  fieldName: string,
  options: { allowNull?: boolean } = {},
):
  | { valid: true; value: ComplianceFrameworkKey[] | null | undefined }
  | { valid: false; message: string } => {
  if (raw === undefined) return { valid: true, value: undefined };
  if (raw === null && options.allowNull) return { valid: true, value: null };
  if (!Array.isArray(raw)) {
    return { valid: false, message: `${fieldName} must be an array of compliance framework keys` };
  }
  const invalid = raw.filter((entry) => !isComplianceFrameworkKey(entry));
  if (invalid.length > 0) {
    return {
      valid: false,
      message: `${fieldName} contains unsupported framework key(s): ${invalid.join(', ')}`,
    };
  }
  return { valid: true, value: normalizeComplianceFrameworkKeys(raw) };
};
