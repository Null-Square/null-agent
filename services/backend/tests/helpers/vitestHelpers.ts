/**
 * Vitest-compatible module isolation helper
 * 
 * In Jest, vi.isolateModules() runs code with fresh module cache.
 * Vitest doesn't have this - we use vi.resetModules() + dynamic import instead.
 */
import { vi } from 'vitest';

/**
 * Run a callback with isolated module cache.
 * Call vi.resetModules() before this to ensure fresh imports.
 */
export async function withIsolatedModules<T>(callback: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return callback();
}

/**
 * Setup mocks and run isolated import.
 * This is the Vitest equivalent of Jest's isolateModules pattern.
 */
export async function isolatedImport<T>(
  setupMocks: () => void,
  importCallback: () => Promise<T>
): Promise<T> {
  // Clear module cache
  vi.resetModules();
  // Setup mocks
  setupMocks();
  // Dynamic import gets fresh module with mocks applied
  return importCallback();
}
