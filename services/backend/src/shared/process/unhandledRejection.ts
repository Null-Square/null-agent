type RejectionRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is RejectionRecord =>
  typeof value === 'object' && value !== null;

const stringField = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
};

/**
 * Cancellation is an expected control outcome, including when a third-party provider SDK emits
 * its AbortError from a detached internal promise. Contain only typed aborts here: matching an
 * arbitrary message containing "abort" would hide real unhandled application failures.
 */
export const isExpectedCancellationRejection = (reason: unknown): boolean => {
  const name = reason instanceof Error ? reason.name : stringField(reason, 'name');
  // Claude Agent SDK 2.1.198 exports an AbortError subclass whose inherited `name` remains
  // "Error" and whose code is unset. Its constructor identity is the only typed cancellation
  // marker left on the rejection (`ProcessTransport.write -> Query.handleControlRequest`).
  const constructorName = reason instanceof Error ? reason.constructor.name : undefined;
  const code = stringField(reason, 'code');
  return name === 'AbortError' || constructorName === 'AbortError' || code === 'ABORT_ERR';
};

/** Pino serializes an Error stored under an arbitrary key as `{}`; retain useful diagnostics. */
export const describeUnhandledRejection = (reason: unknown): RejectionRecord => ({
  type: reason instanceof Error ? reason.constructor.name : typeof reason,
  name: reason instanceof Error ? reason.name : stringField(reason, 'name'),
  code: stringField(reason, 'code'),
  message: reason instanceof Error
    ? reason.message
    : stringField(reason, 'message') ?? String(reason),
});
