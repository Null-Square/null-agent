/**
 * SessionUtils
 *
 * Pure utility functions for session operations.
 * These are stateless helpers used by SessionStore.
 */

import type { SessionState, SessionFlags } from '../types';

/**
 * Deep clone a session state object.
 */
export function cloneSession(session: SessionState): SessionState {
  return JSON.parse(JSON.stringify(session));
}

/**
 * Deep clone session flags.
 */
export function cloneFlags(flags: SessionFlags | undefined): SessionFlags {
  if (!flags) {
    return {};
  }
  return JSON.parse(JSON.stringify(flags));
}

/**
 * Parse a flag path into namespace and key.
 * @param path - Flag path in format "namespace.key" or "namespace.nested.key"
 * @returns Tuple of [namespace, key]
 */
export function parseFlagPath(path: string): [string, string] {
  if (!path || typeof path !== 'string') {
    return ['', ''];
  }
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return ['', ''];
  }
  const namespace = parts[0];
  const key = parts.slice(1).join('.');
  return [namespace, key];
}

