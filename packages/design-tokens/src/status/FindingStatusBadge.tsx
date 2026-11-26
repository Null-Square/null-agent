import { StatusPill, type StatusTone } from '../StatusPill';

// Finding lifecycle status → the shared pill. Open is a neutral pending state
// (not an alarm), in-progress needs attention, resolved is a win.
const TONE: Record<string, StatusTone> = {
  open: 'neutral',
  in_progress: 'warning',
  resolved: 'success',
  accepted_risk: 'neutral',
};

const LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Fixed',
  accepted_risk: 'Accepted Risk',
};

const prettify = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function FindingStatusBadge({ status }: { status: string | null | undefined }) {
  const key = (status ?? '').toLowerCase();
  return (
    <StatusPill tone={TONE[key] ?? 'neutral'}>
      {LABEL[key] ?? (key ? prettify(key) : 'Unknown')}
    </StatusPill>
  );
}
