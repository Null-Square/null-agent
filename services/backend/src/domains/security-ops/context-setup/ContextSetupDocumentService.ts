import type {
  OrgContextSetupAnswers,
  RoeContextSetupAnswers,
} from '@/interfaces/http/controllers/context-setup.schemas';

const MAX_FIELD_CHARS = 1_000;

const normalizeValue = (value: string | null | undefined, maxChars: number = MAX_FIELD_CHARS): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) {
    return '';
  }
  const bounded = normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()} [TRUNCATED]` : normalized;
  return bounded.replace(/\s+/g, ' ');
};

const normalizeList = (values: readonly string[] | undefined): string => {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }
  return values
    .map((value) => normalizeValue(value, 120))
    .filter((value) => value.length > 0)
    .join(', ');
};

const pushSection = (sections: string[], header: string, value: string): void => {
  const normalized = normalizeValue(value);
  if (normalized) {
    sections.push(`${header}: ${normalized}`);
  }
};

const summarizeEscalation = (contact: string, sla: string): string => {
  const contactText = normalizeValue(contact, 240);
  const slaText = normalizeValue(sla, 120);
  if (contactText && slaText) return `${contactText} (${slaText})`;
  return contactText || slaText;
};

export const hasMeaningfulOrgAnswers = (answers: OrgContextSetupAnswers): boolean => {
  const values: Array<string | undefined> = [
    answers.businessContext,
    answers.sensitiveDataWhere,
    answers.hardNoActions,
    answers.escalationContact,
    answers.escalationSla,
    answers.pciDssProfile,
  ];
  if (values.some((value) => normalizeValue(value).length > 0)) return true;
  if (Array.isArray(answers.sensitiveDataTypes) && answers.sensitiveDataTypes.length > 0) return true;
  if (Array.isArray(answers.compliance) && answers.compliance.length > 0) return true;
  return false;
};

export const hasMeaningfulRoeAnswers = (answers: RoeContextSetupAnswers): boolean => {
  const values: Array<string | undefined> = [
    answers.excludedPaths,
    answers.forbiddenTechniques,
    answers.priorKnowledge,
    answers.operatorNotes,
  ];
  if (values.some((value) => normalizeValue(value).length > 0)) return true;
  if (Array.isArray(answers.excludedServices) && answers.excludedServices.length > 0) return true;
  return false;
};

export const buildOrgFallbackDocument = (answers: OrgContextSetupAnswers): string => {
  const sections: string[] = [];
  pushSection(sections, 'Business Context', normalizeValue(answers.businessContext));
  pushSection(
    sections,
    'Sensitive Data',
    [normalizeList(answers.sensitiveDataTypes), normalizeValue(answers.sensitiveDataWhere)]
      .filter(Boolean)
      .join(' | '),
  );
  pushSection(sections, 'Compliance', normalizeList(answers.compliance));
  pushSection(sections, 'PCI DSS Profile', answers.pciDssProfile ?? '');

  const hardNo = normalizeValue(answers.hardNoActions);
  const escalation = summarizeEscalation(answers.escalationContact ?? '', answers.escalationSla ?? '');
  pushSection(
    sections,
    "Hard No's",
    [hardNo, escalation ? `Escalation: ${escalation}` : '']
      .filter(Boolean)
      .join(' | '),
  );

  return sections.join('\n');
};

export const buildRoeFallbackDocument = (answers: RoeContextSetupAnswers): string => {
  const sections: string[] = [];
  pushSection(
    sections,
    'Specific Exclusions',
    [normalizeValue(answers.excludedPaths), normalizeList(answers.excludedServices)]
      .filter(Boolean)
      .join(' | '),
  );
  pushSection(sections, 'Forbidden Techniques', normalizeValue(answers.forbiddenTechniques, 700));
  pushSection(sections, 'Prior Knowledge', normalizeValue(answers.priorKnowledge, 1_000));
  pushSection(sections, 'Operator Notes', normalizeValue(answers.operatorNotes, 1_000));
  return sections.join('\n');
};
