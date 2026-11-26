import { SeverityBadge } from '../SeverityBadge';
import { StatusPill, type StatusTone } from '../StatusPill';

/**
 * Exposure states, deliberately worded to keep the claim honest.
 *
 * `candidate` and `notified` both mean "we matched a version, we have not
 * tested it" — the UI collapses them to *Potential* rather than exposing an
 * internal distinction the customer cannot act on differently.
 *
 * `not_reproduced` is never labelled "safe". The vector we tried did not work
 * here; that is not the same as the asset being unaffected, and the wording has
 * to carry that difference.
 *
 * Presentation is the shared pill: a lifecycle state is a word graded by
 * colour. This file used to hand-roll rounded chips with tinted fills, borders
 * and round dots — three devices the brand had already reduced away, in a shape
 * the system does not have.
 */
const STATE_CONFIG: Record<string, { label: string; tone: StatusTone }> = {
  candidate: { label: 'Potential', tone: 'warning' },
  notified: { label: 'Potential', tone: 'warning' },
  verifying: { label: 'Verification running', tone: 'signal' },
  confirmed: { label: 'Confirmed exploitable', tone: 'destructive' },
  not_reproduced: { label: 'Not Reproduced', tone: 'success' },
  inconclusive: { label: 'Inconclusive', tone: 'neutral' },
  dismissed: { label: 'Closed as not applicable', tone: 'neutral' },
  stale: { label: 'Observation stale', tone: 'neutral' },
  resolved: { label: 'Resolved', tone: 'success' },
};

export function ExposureStateBadge({ state }: { state: string | null | undefined }) {
  const normalized = (state ?? '').toLowerCase();
  const config = STATE_CONFIG[normalized] ?? {
    label: normalized ? normalized.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Unknown',
    tone: 'neutral' as StatusTone,
  };

  // `verifying` is genuinely live, so it is the one state that blinks.
  return (
    <StatusPill tone={config.tone} pulse={normalized === 'verifying'}>
      {config.label}
    </StatusPill>
  );
}

/**
 * Actively exploited in the wild, per CISA KEV.
 *
 * Kept louder than the state pill because it is a categorically different
 * claim: CVSS says how bad it would be, KEV says somebody is doing it now. It
 * is also the only signal that earns an immediate notification, so the page and
 * the email need to agree on what it looks like.
 *
 * It reads as the top of the severity ramp because that is what it means — so
 * it borrows the severity chip rather than inventing a louder shape.
 */
export function KevBadge() {
  return <SeverityBadge severity="critical" label="CISA KEV" />;
}

/**
 * Reasons the version we matched on might not be the version that is running.
 *
 * Shown on the row rather than buried in a detail view, because it changes how
 * much weight the customer should put on the match before spending credits to
 * verify it. Hiding this would make the list look more certain than it is.
 *
 * A caveat is not a state and not a severity — it is a note about confidence,
 * so it is set as quiet mono data, with the explanation on hover.
 */
export function MatchCaveatBadge({ kind }: { kind: 'backport' | 'conflict' }) {
  const label = kind === 'backport' ? 'Backport risk' : 'Version conflict';
  const title =
    kind === 'backport'
      ? 'The distribution may have patched this without changing the version string, so the banner alone cannot settle it.'
      : 'Two sources reported different versions for this component.';

  return (
    <span
      title={title}
      className="inline-flex w-fit whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
    >
      {label}
    </span>
  );
}
