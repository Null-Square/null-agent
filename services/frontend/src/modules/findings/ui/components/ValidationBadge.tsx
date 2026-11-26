import { StatusPill, type StatusTone } from '@null-ai/design-tokens/ui';

// Validation state → the shared pill. Validated is a win, failed is a problem,
// the in-flight states need attention, and false-positive/inconclusive are neutral.
const CONFIG: Record<string, { tone: StatusTone; label: string }> = {
  validated: { tone: 'success', label: 'Validated' },
  unvalidated: { tone: 'warning', label: 'Unvalidated' },
  under_review: { tone: 'warning', label: 'Under Review' },
  validation_pending: { tone: 'warning', label: 'Validation Pending' },
  validation_failed: { tone: 'destructive', label: 'Validation Failed' },
  false_positive: { tone: 'neutral', label: 'False Positive' },
  inconclusive: { tone: 'neutral', label: 'Inconclusive' },
};

const prettify = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function ValidationBadge({ state }: { state: string | null | undefined }) {
  const key = (state ?? '').toLowerCase();
  const config = CONFIG[key] ?? { tone: 'neutral' as StatusTone, label: key ? prettify(key) : 'Unknown' };
  return <StatusPill tone={config.tone}>{config.label}</StatusPill>;
}
