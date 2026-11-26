import type {
  ComponentEvidenceTier,
  ComponentObservationSource,
} from '@/db/schema';

/** Sources that report an installed version from an authenticated manifest. */
const AUTHORITATIVE_VERSION_SOURCES = new Set<ComponentObservationSource>([
  'connected_site',
  'lockfile',
]);

export const evidenceTierForObservation = (
  source: ComponentObservationSource | null | undefined,
  version: string | null | undefined,
): ComponentEvidenceTier => {
  if (!version) return 'absent';
  if (source && AUTHORITATIVE_VERSION_SOURCES.has(source)) return 'observed_exact';
  return 'reported_exact';
};

/** Only authoritative inventory and fresh customer attestations may interrupt. */
export const isInterruptEligibleEvidenceTier = (
  tier: ComponentEvidenceTier | null | undefined,
): boolean => tier === 'observed_exact' || tier === 'attested_exact';

