import type { SkillMetadata } from './SkillLoader';

export interface SkillRankingInput {
  text: string;
  phaseKey?: string;
  assignedSkillSlugs?: readonly string[];
  limit?: number;
}

export interface SkillRankingMatch {
  slug: string;
  name: string;
  phase?: string;
  score: number;
  assigned: boolean;
  matchedStrongTerms: string[];
  matchedTechTriggers: string[];
  matchedNtypeTriggers: string[];
  reasons: string[];
}

const MAX_CACHED_RANKINGS_PER_CATALOG = 512;
const rankingCache = new WeakMap<
  readonly SkillMetadata[],
  Map<string, SkillRankingMatch[]>
>();

const normalize = (value: string): string => value.trim().toLowerCase();

const normalizeText = (value: string): string =>
  normalize(value).replace(/[_-]+/g, '-');

const includesTrigger = (haystack: string, trigger: string): boolean => {
  const normalizedTrigger = normalizeText(trigger);
  if (!normalizedTrigger) {
    return false;
  }
  return haystack.includes(normalizedTrigger) || haystack.includes(normalizedTrigger.replace(/-/g, '.'));
};

const isPhaseCompatible = (skill: SkillMetadata, phaseKey?: string): boolean => {
  if (!phaseKey) {
    return true;
  }
  const normalizedPhase = normalize(phaseKey);
  const phases = skill.compatiblePhases && skill.compatiblePhases.length > 0
    ? skill.compatiblePhases
    : skill.phase
      ? [skill.phase]
      : [];
  return phases.length === 0 || phases.map(normalize).includes(normalizedPhase);
};

const cloneMatches = (matches: SkillRankingMatch[]): SkillRankingMatch[] =>
  matches.map((match) => ({
    ...match,
    matchedStrongTerms: [...match.matchedStrongTerms],
    matchedTechTriggers: [...match.matchedTechTriggers],
    matchedNtypeTriggers: [...match.matchedNtypeTriggers],
    reasons: [...match.reasons],
  }));

const rankingCacheKey = (input: SkillRankingInput, limit: number): string => [
  normalizeText(input.text),
  normalize(input.phaseKey ?? ''),
  [...(input.assignedSkillSlugs ?? [])].map(normalize).sort().join(','),
  limit,
].join('\u0000');

export const rankSkillsForState = (
  catalog: readonly SkillMetadata[],
  input: SkillRankingInput,
): SkillRankingMatch[] => {
  const haystack = normalizeText(input.text);
  const assigned = new Set((input.assignedSkillSlugs ?? []).map(normalize));
  const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 8)));
  const cacheKey = rankingCacheKey(input, limit);
  const catalogCache = rankingCache.get(catalog);
  const cached = catalogCache?.get(cacheKey);
  if (cached) {
    return cloneMatches(cached);
  }

  const ranked = catalog
    .filter((skill) => skill.enabled)
    .map((skill): SkillRankingMatch | null => {
      const matchedStrongTerms = skill.strongTerms.filter((term) => includesTrigger(haystack, term));
      const matchedTechTriggers = skill.techTriggers.filter((trigger) => includesTrigger(haystack, trigger));
      const matchedNtypeTriggers = skill.ntypeTriggers.filter((trigger) => includesTrigger(haystack, trigger));
      const phaseCompatible = isPhaseCompatible(skill, input.phaseKey);
      const isAssigned = assigned.has(normalize(skill.slug));
      let score = 0;
      const reasons: string[] = [];

      if (matchedStrongTerms.length > 0) {
        score += matchedStrongTerms.length * 6;
        reasons.push(`strong:${matchedStrongTerms.slice(0, 4).join(',')}`);
      }
      if (matchedNtypeTriggers.length > 0) {
        score += matchedNtypeTriggers.length * 5;
        reasons.push(`ntype:${matchedNtypeTriggers.slice(0, 4).join(',')}`);
      }
      if (matchedTechTriggers.length > 0) {
        score += matchedTechTriggers.length * 4;
        reasons.push(`tech:${matchedTechTriggers.slice(0, 4).join(',')}`);
      }
      if (phaseCompatible && (matchedStrongTerms.length > 0 || matchedTechTriggers.length > 0 || matchedNtypeTriggers.length > 0)) {
        score += 2;
        reasons.push(`phase:${input.phaseKey ?? skill.phase ?? 'any'}`);
      }
      if (isAssigned) {
        score += 1;
        reasons.push('assigned');
      }
      if (!phaseCompatible && score > 0) {
        score = Math.max(1, score - 3);
        reasons.push(`phase_mismatch:${input.phaseKey}`);
      }

      if (score <= 0) {
        return null;
      }

      return {
        slug: skill.slug,
        name: skill.name,
        ...(skill.phase ? { phase: skill.phase } : {}),
        score,
        assigned: isAssigned,
        matchedStrongTerms,
        matchedTechTriggers,
        matchedNtypeTriggers,
        reasons,
      };
    })
    .filter((entry): entry is SkillRankingMatch => entry !== null)
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, limit);

  const nextCache = catalogCache ?? new Map<string, SkillRankingMatch[]>();
  if (nextCache.size >= MAX_CACHED_RANKINGS_PER_CATALOG) {
    const oldestKey = nextCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) nextCache.delete(oldestKey);
  }
  nextCache.set(cacheKey, cloneMatches(ranked));
  if (!catalogCache) rankingCache.set(catalog, nextCache);
  return ranked;
};
