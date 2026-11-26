/**
 * Domain status badges.
 *
 * Three vocabularies — a finding's lifecycle, a run's, and an exposure's —
 * each mapped onto the one `StatusPill`. They are not the same component, and
 * merging them would be wrong: a run can be "awaiting approval" and a finding
 * cannot. What they share is the pill, which they already composed.
 *
 * They live in the kit because six frontend modules were importing them across
 * feature boundaries — assets reaching into findings, risks into exposures,
 * runners into runs. A component three features import is a shared component
 * filed under whichever feature happened to need it first.
 */
export { FindingStatusBadge } from './FindingStatusBadge';
export { RunStatusBadge } from './RunStatusBadge';
export { ExposureStateBadge, KevBadge, MatchCaveatBadge } from './ExposureStateBadge';
