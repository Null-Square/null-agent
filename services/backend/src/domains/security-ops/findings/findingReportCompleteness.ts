export type FinalReportRequiredField =
  | 'businessImpact'
  | 'technicalAnalysis'
  | 'pocDescription'
  | 'assumptions'
  | 'remediation';

export type FinalReportAdvisoryField =
  | 'fixEffort'
  | 'cweIds'
  | 'cvss'
  | 'owaspCategory';

export type FindingReportCompleteness = {
  missingReportFields: FinalReportRequiredField[];
  advisoryMissingFields: FinalReportAdvisoryField[];
  canFinalizeReportable: boolean;
  repairInstruction?: string;
};

export type FindingReportCompletenessInput = {
  id: string;
  title: string;
  businessImpact?: string | null;
  technicalAnalysis?: string | null;
  pocDescription?: string | null;
  assumptions?: string | null;
  remediation?: string | null;
  fixEffort?: string | null;
  cweId?: string | null;
  cweIds?: string[] | null;
  owaspCategory?: string | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
};

export const FINAL_REPORT_REQUIRED_FIELDS: Array<{
  key: FinalReportRequiredField;
  label: string;
}> = [
  { key: 'businessImpact', label: 'business impact' },
  { key: 'technicalAnalysis', label: 'technical analysis' },
  { key: 'pocDescription', label: 'proof of concept / validation steps' },
  { key: 'assumptions', label: 'assumptions' },
  { key: 'remediation', label: 'remediation' },
];

const hasReportText = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
};

const finalReportAdvisoryFields: Array<{
  key: FinalReportAdvisoryField;
  isMissing: (finding: FindingReportCompletenessInput) => boolean;
}> = [
  { key: 'fixEffort', isMissing: (finding) => !hasReportText(finding.fixEffort) },
  {
    key: 'cweIds',
    isMissing: (finding) => normalizeStringArray(finding.cweIds).length === 0 && !hasReportText(finding.cweId),
  },
  {
    key: 'cvss',
    isMissing: (finding) =>
      !hasReportText(finding.cvssVector) && (finding.cvssScore === null || finding.cvssScore === undefined),
  },
  { key: 'owaspCategory', isMissing: (finding) => !hasReportText(finding.owaspCategory) },
];

const buildFindingRepairInstruction = (
  finding: FindingReportCompletenessInput,
  missingReportFields: FinalReportRequiredField[],
): string | undefined => {
  if (missingReportFields.length === 0) {
    return undefined;
  }
  const labels = FINAL_REPORT_REQUIRED_FIELDS
    .filter((field) => missingReportFields.includes(field.key))
    .map((field) => field.label)
    .join(', ');
  return `Call report_finding with validatesFindingId="${finding.id}" and backfill evidence-specific ${labels}. Avoid generic placeholder prose.`;
};

export const buildFindingReportCompleteness = (
  finding: FindingReportCompletenessInput,
): FindingReportCompleteness => {
  const missingReportFields = FINAL_REPORT_REQUIRED_FIELDS
    .filter((field) => !hasReportText(finding[field.key]))
    .map((field) => field.key);
  const advisoryMissingFields = finalReportAdvisoryFields
    .filter((field) => field.isMissing(finding))
    .map((field) => field.key);
  return {
    missingReportFields,
    advisoryMissingFields,
    canFinalizeReportable: missingReportFields.length === 0,
    ...(missingReportFields.length > 0
      ? { repairInstruction: buildFindingRepairInstruction(finding, missingReportFields) }
      : {}),
  };
};
