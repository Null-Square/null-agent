import { sha256Hex } from '../workers/sha256';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  [key: string]: CanonicalJson;
};

export class ModelRequestDigestMismatchError extends Error {
  readonly code = 'model_request_digest_mismatch';

  constructor(
    public readonly expectedDigest: string,
    public readonly actualDigest: string,
  ) {
    super(`Model request digest mismatch: expected=${expectedDigest} actual=${actualDigest}`);
    this.name = 'ModelRequestDigestMismatchError';
  }
}

const normalizeJson = (
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  arrayItem = false,
): CanonicalJson | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Model request contains a non-finite number at ${path}`);
    return value;
  }
  if (value === undefined) return arrayItem ? null : undefined;
  if (typeof value !== 'object') {
    throw new Error(`Model request contains a non-JSON value at ${path}`);
  }
  if (seen.has(value)) throw new Error(`Model request contains a cycle at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        normalizeJson(entry, `${path}[${index}]`, seen, true) ?? null);
    }
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        seen,
      );
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

export const canonicalizeModelRequestEnvelope = (
  envelope: Record<string, unknown>,
): { envelope: Record<string, unknown>; canonicalJson: string; digest: string } => {
  const normalized = normalizeJson(envelope, '$', new WeakSet());
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new Error('Model request envelope must be a JSON object');
  }
  const canonicalJson = JSON.stringify(normalized);
  return {
    envelope: normalized as Record<string, unknown>,
    canonicalJson,
    digest: `sha256:${sha256Hex(canonicalJson)}`,
  };
};

export const assertModelRequestDigest = (
  envelope: Record<string, unknown>,
  expectedDigest: string,
): void => {
  const actualDigest = canonicalizeModelRequestEnvelope(envelope).digest;
  if (actualDigest !== expectedDigest) {
    throw new ModelRequestDigestMismatchError(expectedDigest, actualDigest);
  }
};
