/**
 * The severity ramp, declared once.
 *
 * It was declared five times outside the kit — an identical `CVSS_TONE` in
 * assets, exposures and risks, plus separate `SEVERITY_*` maps in the dashboard
 * and the scan preview. Five copies of one vocabulary is five chances to
 * disagree, and they had already taken one: the scan preview mapped `high` to
 * `orange-600` where the token is not orange.
 *
 * The ramp itself is fixed by the brand — critical / high / medium / low, plus
 * `info` for the tier that is a note rather than a risk. What varies is which
 * property it colours, so that is the argument rather than a separate map per
 * page.
 *
 * `unknown` is not an error: a finding whose severity the backend has not
 * scored yet is common, and it reads as muted rather than as a tier.
 */

export type SeverityKey = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Which property the ramp paints. */
export type SeverityChannel = 'text' | 'bg' | 'border';

const RAMP: Record<SeverityChannel, Record<SeverityKey, string>> = {
  text: {
    critical: 'text-critical',
    high: 'text-high',
    medium: 'text-medium',
    low: 'text-low',
    info: 'text-muted-foreground',
  },
  bg: {
    critical: 'bg-critical',
    high: 'bg-high',
    medium: 'bg-medium',
    low: 'bg-low',
    info: 'bg-muted-foreground',
  },
  border: {
    critical: 'border-critical',
    high: 'border-high',
    medium: 'border-medium',
    low: 'border-low',
    info: 'border-border',
  },
};

const FALLBACK: Record<SeverityChannel, string> = {
  text: 'text-muted-foreground',
  bg: 'bg-border',
  border: 'border-border',
};

/**
 * The class for one severity on one property.
 *
 *     severityTone(finding.severity)            // text-critical
 *     severityTone(row.severity, 'bg')          // bg-high
 *
 * Case and whitespace are normalised because this is fed straight from API
 * values at most call sites, and every copy it replaces was doing
 * `(x ?? '').toLowerCase()` by hand.
 */
export const severityTone = (
  severity: string | null | undefined,
  channel: SeverityChannel = 'text',
): string => {
  const key = severity?.trim().toLowerCase() as SeverityKey | undefined;
  return (key && RAMP[channel][key]) || FALLBACK[channel];
};

/** The tiers, worst first — for legends, filters and ordered lists. */
export const SEVERITY_ORDER: readonly SeverityKey[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;
