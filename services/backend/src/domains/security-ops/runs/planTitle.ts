const MAX_RUN_TITLE_CHARS = 120;

const GENERIC_PLAN_TITLES = new Set([
  'plan',
  'assessment plan',
  'security assessment plan',
  'security plan',
  'test plan',
  'testing plan',
  'run plan',
  'overall plan',
  'general plan',
  'general assessment',
  'general testing',
]);

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const normalizeForComparison = (value: string): string =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();

export const extractRunTitleFromPlan = (plan: string): string | null => {
  const lines = plan.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headingMatch = /^#\s+(.+)$/.exec(line);
    if (!headingMatch) {
      return null;
    }

    const title = normalizeWhitespace(headingMatch[1] ?? '');
    if (!title) {
      return null;
    }

    return title.length > MAX_RUN_TITLE_CHARS ? `${title.slice(0, MAX_RUN_TITLE_CHARS - 3).trimEnd()}...` : title;
  }

  return null;
};

export const validateRunTitleFromPlan = (plan: string): string | null => {
  const title = extractRunTitleFromPlan(plan);
  if (!title) {
    return (
      'submit_plan requires the markdown plan to start with a level-1 heading (# Title). ' +
      'Use a specific operation title such as "Attack Surface Discovery for app.example.com".'
    );
  }

  const normalized = normalizeForComparison(title);
  if (GENERIC_PLAN_TITLES.has(normalized)) {
    return (
      `submit_plan title "${title}" is too generic. ` +
      'Use a title that names the overall operation, such as "Attack Surface Discovery for app.example.com" ' +
      'or "Vulnerability Assessment for api.example.com".'
    );
  }

  return null;
};
