/**
 * Assert Never - Exhaustive Switch/Case Helper
 * 
 * Use for exhaustive checks in switch statements to ensure TypeScript
 * catches missing cases at compile time.
 * 
 * @example
 * type Status = 'active' | 'paused' | 'completed';
 * 
 * function handleStatus(status: Status) {
 *   switch (status) {
 *     case 'active': return doActive();
 *     case 'paused': return doPaused();
 *     case 'completed': return doCompleted();
 *     default: assertNever(status); // TypeScript error if case missing
 *   }
 * }
 */

/**
 * Asserts that a value is of type `never`, meaning all cases have been handled.
 * If reached at runtime, throws an error with the unexpected value.
 * 
 * @param x - The value that should be unreachable (type `never`)
 * @param message - Optional custom error message
 * @throws Error if reached at runtime (indicates unhandled case)
 */
export function assertNever(x: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Type-safe exhaustive check that can be used inline.
 * Returns the value for cases where you need to return something.
 * 
 * @example
 * const label = status === 'active' ? 'Active' 
 *             : status === 'paused' ? 'Paused'
 *             : exhaustive(status);
 */
export function exhaustive<T>(x: never): T {
  throw new Error(`Exhaustive check failed: ${JSON.stringify(x)}`);
}
