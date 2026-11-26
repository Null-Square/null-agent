import { HIPAA_FRAMEWORK } from './hipaa';
import { GDPR_FRAMEWORK } from './gdpr';
import { ISO27001_FRAMEWORK } from './iso27001';
import { NIST_CSF_FRAMEWORK } from './nist-csf';
import { PCI_DSS_FRAMEWORK } from './pci-dss';
import { SOC2_FRAMEWORK } from './soc2';
import { FRAMEWORK_CONTROL_METHOD_SKILLS } from './controlMethodSkills';
import { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey, type FrameworkDefinition } from './types';

const RAW_FRAMEWORK_REGISTRY = {
  soc2: SOC2_FRAMEWORK,
  gdpr: GDPR_FRAMEWORK,
  hipaa: HIPAA_FRAMEWORK,
  pci_dss: PCI_DSS_FRAMEWORK,
  iso27001: ISO27001_FRAMEWORK,
  nist_csf: NIST_CSF_FRAMEWORK,
} satisfies Record<ComplianceFrameworkKey, FrameworkDefinition>;

const withControlMethodSkills = (
  framework: FrameworkDefinition,
): FrameworkDefinition => {
  const mappings = FRAMEWORK_CONTROL_METHOD_SKILLS[framework.key];
  return {
    ...framework,
    controls: framework.controls.map((control) => {
      const mappedSkills = (mappings as Record<string, readonly string[]>)[control.id] ?? [];
      if (mappedSkills.length === 0) {
        return control;
      }
      return {
        ...control,
        skillSlugs: Array.from(new Set([...(control.skillSlugs ?? []), ...mappedSkills])).sort(),
      };
    }),
  };
};

export const FRAMEWORK_REGISTRY = Object.fromEntries(
  COMPLIANCE_FRAMEWORK_KEYS.map((key) => [key, withControlMethodSkills(RAW_FRAMEWORK_REGISTRY[key])]),
) as Record<ComplianceFrameworkKey, FrameworkDefinition>;

export const FRAMEWORK_LABELS = Object.fromEntries(
  COMPLIANCE_FRAMEWORK_KEYS.map((key) => [key, FRAMEWORK_REGISTRY[key].label]),
) as Record<ComplianceFrameworkKey, string>;

export const SUPPORTED_FRAMEWORKS = COMPLIANCE_FRAMEWORK_KEYS.filter((key) =>
  Boolean(FRAMEWORK_REGISTRY[key]),
);

export { COMPLIANCE_FRAMEWORK_KEYS };
export type { ComplianceFrameworkKey, ControlDefinition, EvidenceSupportLevel, FrameworkDefinition } from './types';
