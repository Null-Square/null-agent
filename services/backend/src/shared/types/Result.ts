/**
 * Result Type - Typed Error Handling
 * 
 * Replaces `{ data: T | null; error: any }` patterns with type-safe alternatives.
 * Inspired by Rust's Result<T, E> and TypeScript community best practices.
 * 
 * @example
 * // Returning a result
 * function divide(a: number, b: number): Result<number, 'DivisionByZero'> {
 *   if (b === 0) return err('DivisionByZero');
 *   return ok(a / b);
 * }
 * 
 * // Using a result
 * const result = divide(10, 2);
 * if (isOk(result)) {
 *   console.log(result.data); // 5
 * } else {
 *   console.error(result.error); // type-safe error
 * }
 */

/**
 * Success result - contains data of type T
 */
export interface Ok<T> {
  readonly success: true;
  readonly data: T;
}

/**
 * Failure result - contains error of type E
 */
export interface Err<E> {
  readonly success: false;
  readonly error: E;
}

/**
 * Result type - either success with data or failure with error
 */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/**
 * Create a success result
 */
export function ok<T>(data: T): Ok<T> {
  return { success: true, data };
}

/**
 * Create a failure result
 */
export function err<E>(error: E): Err<E> {
  return { success: false, error };
}

/**
 * Type guard for success result
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.success === true;
}

/**
 * Type guard for failure result
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.success === false;
}

/**
 * Unwrap a result, throwing if it's an error.
 * Use only when you're certain the result is Ok.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.data;
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

/**
 * Unwrap a result or return a default value if it's an error.
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return isOk(result) ? result.data : defaultValue;
}

/**
 * Map the success value of a result.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (data: T) => U): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.data));
  }
  return result;
}

/**
 * Map the error value of a result.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (isErr(result)) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Convert a Promise that might throw to a Promise<Result<T, Error>>
 */
export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    const data = await fn();
    return ok(data);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Convert a function that might throw to a Result<T, Error>
 */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    const data = fn();
    return ok(data);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
