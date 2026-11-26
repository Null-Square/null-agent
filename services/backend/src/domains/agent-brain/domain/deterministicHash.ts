/**
 * Stable, synchronous 64-bit FNV-1a digest for domain identities.
 *
 * Domain code cannot depend on Node runtime modules. This digest is used only
 * for deterministic fingerprints and synthetic recovery IDs; it is not a
 * security boundary or a signature.
 */
export const deterministicHash64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const deterministicHash128 = (value: string): string =>
  `${deterministicHash64(`a:${value}`)}${deterministicHash64(`b:${value}`)}`;
