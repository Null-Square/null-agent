export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

export type PromptSectionKind = 'static' | 'soft' | 'dynamic';

export interface PromptSection {
  key: string;
  kind: PromptSectionKind;
  order: number;
  content: string;
  title?: string;
}

const normalizeContent = (content: string): string => content.trim();

export const createPromptSection = ({
  key,
  kind,
  order,
  content,
  title,
}: PromptSection): PromptSection | null => {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return null;
  }

  return {
    key,
    kind,
    order,
    title,
    content: normalized,
  };
};

export const renderPromptSection = (section: PromptSection): string =>
  section.title ? `## ${section.title}\n${section.content}` : section.content;

export const renderPromptSections = (sections: PromptSection[]): string =>
  sections
    .slice()
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map(renderPromptSection)
    .join('\n\n');
