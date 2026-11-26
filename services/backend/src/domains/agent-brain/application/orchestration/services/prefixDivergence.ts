/**
 * D17 — why a continuation turn cannot resume a warm prefix.
 *
 * Every `cache.resume` event in production run r1 — all four of them — reported
 * `prefixStable: false`. The event said the prefix had changed and nothing said what changed,
 * so the question "can this be fixed?" had no evidence behind it.
 *
 * A prompt prefix is a list of named sections. When the hash moves, exactly one set of
 * sections moved with it, and the system already holds both sides. This module names them.
 *
 * It diagnoses; it does not decide. What to do about a section that keeps moving — pin it,
 * demote it out of the cacheable prefix, or accept it — is a judgement that needs the answer
 * this produces first.
 */

/**
 * A 64-bit FNV-1a, written out rather than imported.
 *
 * This layer is not allowed to reach for node builtins, and it does not need to: the digest
 * answers "did this section change since last turn", which is a change detector, not a
 * security primitive. Nothing trusts it against an adversary and nothing stores it durably.
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const digestOf = (value: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    // Mix the code unit a byte at a time so characters above U+00FF still separate.
    const codeUnit = value.charCodeAt(index);
    hash = ((hash ^ BigInt(codeUnit & 0xff)) * FNV_PRIME) & MASK_64;
    hash = ((hash ^ BigInt(codeUnit >> 8)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
};

export interface PrefixSectionDigest {
  key: string;
  digest: string;
}

/** A stable digest per section, small enough to carry in session flags between turns. */
export const digestPrefixSections = (
  sections: ReadonlyArray<{ key: string; content: string }>,
): PrefixSectionDigest[] => sections.map((section) => ({
  key: section.key,
  digest: digestOf(section.content),
}));

export interface PrefixDivergence {
  /** Sections present in both but with different content. The usual cause. */
  changed: string[];
  /** Sections the new prefix has and the old one did not. */
  added: string[];
  /** Sections the old prefix had and the new one does not. */
  removed: string[];
  /** True when the section list is identical in order as well as membership. */
  orderStable: boolean;
  /** Whether anything at all moved. */
  diverged: boolean;
}

/**
 * Compares two section digest lists. Order matters as well as content: a prefix whose
 * sections are the same but reordered is a different prefix to a provider.
 */
export const diffPrefixSections = (
  previous: readonly PrefixSectionDigest[] | undefined,
  current: readonly PrefixSectionDigest[],
): PrefixDivergence => {
  if (previous === undefined) {
    return {
      changed: [],
      added: [],
      removed: [],
      orderStable: true,
      diverged: false,
    };
  }

  const previousByKey = new Map(previous.map((entry) => [entry.key, entry.digest]));
  const currentByKey = new Map(current.map((entry) => [entry.key, entry.digest]));

  const changed: string[] = [];
  const added: string[] = [];
  for (const entry of current) {
    const before = previousByKey.get(entry.key);
    if (before === undefined) {
      added.push(entry.key);
    } else if (before !== entry.digest) {
      changed.push(entry.key);
    }
  }
  const removed = previous
    .filter((entry) => !currentByKey.has(entry.key))
    .map((entry) => entry.key);

  // Compare the relative order of the sections that appear in both. Reporting a reorder just
  // because a section was added would bury the actual cause under noise.
  const commonPrevious = previous.filter((entry) => currentByKey.has(entry.key)).map((entry) => entry.key);
  const commonCurrent = current.filter((entry) => previousByKey.has(entry.key)).map((entry) => entry.key);
  const orderStable = commonPrevious.length === commonCurrent.length
    && commonPrevious.every((key, index) => commonCurrent[index] === key);

  return {
    changed,
    added,
    removed,
    orderStable,
    diverged: changed.length > 0 || added.length > 0 || removed.length > 0 || !orderStable,
  };
};

/** One line an operator can act on, rather than a boolean they cannot. */
export const describePrefixDivergence = (divergence: PrefixDivergence): string => {
  if (!divergence.diverged) return 'the prefix is unchanged';
  const parts: string[] = [];
  if (divergence.changed.length > 0) parts.push(`changed: ${divergence.changed.join(', ')}`);
  if (divergence.added.length > 0) parts.push(`added: ${divergence.added.join(', ')}`);
  if (divergence.removed.length > 0) parts.push(`removed: ${divergence.removed.join(', ')}`);
  if (!divergence.orderStable) parts.push('section order moved');
  return parts.join('; ');
};
