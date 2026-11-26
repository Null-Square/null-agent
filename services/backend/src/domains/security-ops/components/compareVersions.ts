import type { VersionScheme } from '@/db/schema';

/**
 * Version comparison for advisory range matching.
 *
 * Schemes are not interchangeable and conflating them produces wrong answers in
 * both directions — semver orders `1.0.0-rc.1` *below* `1.0.0`, while a naive
 * dotted comparison would call them equal or reverse them. Every function here
 * returns `null` rather than a guess when it cannot compare confidently, and a
 * null propagates all the way out to "no match" (PRD R1/§8.5).
 *
 * Pure and dependency-free on purpose: this is the function that decides
 * whether a customer gets told they are exposed.
 */

/** Result is negative, zero or positive like a comparator; null means incomparable. */
export type VersionComparison = number | null;

const NUMERIC_ONLY = /^\d+$/u;

const splitCore = (version: string): { core: string; prerelease: string | null } => {
  // Build metadata never affects precedence (semver.org §10).
  const withoutBuild = version.split('+', 1)[0]!;
  const dashIndex = withoutBuild.indexOf('-');
  if (dashIndex === -1) {
    return { core: withoutBuild, prerelease: null };
  }
  return {
    core: withoutBuild.slice(0, dashIndex),
    prerelease: withoutBuild.slice(dashIndex + 1) || null,
  };
};

/**
 * Compare dot-separated numeric components, padding the shorter side with zero
 * so `1.2` and `1.2.0` are equal. Returns null if either side has a component
 * that is not purely numeric.
 */
const compareNumericParts = (left: string, right: string): VersionComparison => {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftRaw = leftParts[index] ?? '0';
    const rightRaw = rightParts[index] ?? '0';

    if (!NUMERIC_ONLY.test(leftRaw) || !NUMERIC_ONLY.test(rightRaw)) {
      return null;
    }

    const delta = Number(leftRaw) - Number(rightRaw);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }

  return 0;
};

/**
 * Semver prerelease precedence (semver.org §11).
 *
 * Numeric identifiers compare numerically and rank below alphanumeric ones; if
 * every shared identifier is equal, the longer list wins.
 */
const comparePrerelease = (left: string | null, right: string | null): VersionComparison => {
  if (left === null && right === null) return 0;
  // A prerelease ranks below the release it precedes.
  if (left === null) return 1;
  if (right === null) return -1;

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftId = leftParts[index];
    const rightId = rightParts[index];

    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const leftNumeric = NUMERIC_ONLY.test(leftId);
    const rightNumeric = NUMERIC_ONLY.test(rightId);

    if (leftNumeric && rightNumeric) {
      const delta = Number(leftId) - Number(rightId);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }

    if (leftNumeric !== rightNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return leftNumeric ? -1 : 1;
    }

    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }

  return 0;
};

/**
 * Compare CPE-style components, which may carry alphanumeric segments such as
 * `1.0.2k` (OpenSSL) that a purely numeric comparison cannot order.
 */
const compareCpeParts = (left: string, right: string): VersionComparison => {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftRaw = leftParts[index] ?? '0';
    const rightRaw = rightParts[index] ?? '0';

    if (leftRaw === rightRaw) continue;

    const leftMatch = /^(\d*)([A-Za-z]*)$/u.exec(leftRaw);
    const rightMatch = /^(\d*)([A-Za-z]*)$/u.exec(rightRaw);
    if (!leftMatch || !rightMatch) return null;

    const leftNumber = leftMatch[1] === '' ? 0 : Number(leftMatch[1]);
    const rightNumber = rightMatch[1] === '' ? 0 : Number(rightMatch[1]);
    if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;

    const leftSuffix = leftMatch[2] ?? '';
    const rightSuffix = rightMatch[2] ?? '';
    if (leftSuffix !== rightSuffix) return leftSuffix < rightSuffix ? -1 : 1;
  }

  return 0;
};

/**
 * Compare two normalized versions under a declared scheme.
 *
 * `unknown` always returns null: refusing to compare is the whole point, since
 * a guessed ordering here becomes a vulnerability claim about a real customer.
 */
export const compareVersions = (
  scheme: VersionScheme,
  left: string,
  right: string,
): VersionComparison => {
  if (scheme === 'unknown') return null;

  const trimmedLeft = left.trim();
  const trimmedRight = right.trim();
  if (!trimmedLeft || !trimmedRight) return null;

  if (scheme === 'cpe') {
    return compareCpeParts(trimmedLeft, trimmedRight);
  }

  const leftSplit = splitCore(trimmedLeft);
  const rightSplit = splitCore(trimmedRight);

  const coreComparison = compareNumericParts(leftSplit.core, rightSplit.core);
  if (coreComparison === null) return null;
  if (coreComparison !== 0) return coreComparison;

  if (scheme === 'semver') {
    return comparePrerelease(leftSplit.prerelease, rightSplit.prerelease);
  }

  // 'dotted' has no prerelease concept; a suffix we cannot order is a refusal
  // rather than an assumption that the versions are equal.
  if (leftSplit.prerelease !== null || rightSplit.prerelease !== null) {
    return comparePrerelease(leftSplit.prerelease, rightSplit.prerelease);
  }

  return 0;
};

export type AffectedRangeBounds = {
  introducedVersion: string | null;
  introducedInclusive: boolean;
  fixedVersion: string | null;
  fixedInclusive: boolean;
};

/**
 * Decide whether an observed version falls inside an advisory's affected range.
 *
 * Returns null when the question cannot be answered — unknown scheme, an
 * unparseable bound, or a version we cannot order. Null must be treated as
 * "no match", never as "affected": the cost of a wrong yes is a customer told
 * they are vulnerable when they are not.
 *
 * Boundary inclusivity is carried explicitly because NVD distinguishes all four
 * forms (versionStartIncluding/Excluding, versionEndIncluding/Excluding), and
 * collapsing them shifts every range edge by one release.
 */
export const isVersionInRange = (params: {
  scheme: VersionScheme;
  version: string;
  range: AffectedRangeBounds;
}): boolean | null => {
  const { scheme, version, range } = params;
  if (scheme === 'unknown') return null;

  // A range with no bounds at all would match every version of the component,
  // which is never a claim we want to make from inference.
  if (!range.introducedVersion && !range.fixedVersion) return null;

  if (range.introducedVersion) {
    const comparison = compareVersions(scheme, version, range.introducedVersion);
    if (comparison === null) return null;
    if (range.introducedInclusive ? comparison < 0 : comparison <= 0) return false;
  }

  if (range.fixedVersion) {
    const comparison = compareVersions(scheme, version, range.fixedVersion);
    if (comparison === null) return null;
    if (range.fixedInclusive ? comparison > 0 : comparison >= 0) return false;
  }

  return true;
};
