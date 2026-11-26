/**
 * SessionFlagManager - Manages session flag operations.
 * 
 * Extracted from SessionStore to reduce god class complexity.
 * Flags are key-value pairs organized in namespaces for session state tracking.
 * 
 * Usage:
 * - SessionStore delegates flag methods to this manager
 * - Keeps public API unchanged (backward compatible)
 */

import type { SessionState, SessionFlags } from '../../domain/types';
import { logger as appLogger } from '@/shared/logger';
import { cloneFlags, parseFlagPath } from '../../domain/helpers/SessionUtils';

/**
 * Port interface for SessionStore operations needed by flag manager.
 */
export interface FlagManagerDeps {
  /** Get session by ID */
  getSession: (sessionId: string) => SessionState | undefined;
  /** Update session atomically */
  updateSessionAsync: <T>(
    sessionId: string,
    mutator: (session: SessionState) => Promise<T> | T
  ) => Promise<T | undefined>;
  /** Queue metadata persistence */
  queuePersistMetadata: (session: SessionState) => void;
}

/**
 * Manager for session flag operations.
 */
export class SessionFlagManager {
  private readonly log = appLogger.child({ scope: 'SessionFlagManager' });

  constructor(private readonly deps: FlagManagerDeps) {}

  /**
   * Get all flags for a session (cloned to prevent mutation).
   */
  getFlags(sessionId: string): SessionFlags {
    const session = this.deps.getSession(sessionId);
    return session ? cloneFlags(session.flags) : {};
  }

  /**
   * Get a specific flag value.
   */
  getFlag(sessionId: string, flagPath: string): unknown {
    const [namespace, key] = parseFlagPath(flagPath);
    if (!namespace || !key) return undefined;
    
    const session = this.deps.getSession(sessionId);
    if (!session) return undefined;
    
    const ns = session.flags[namespace] as Record<string, unknown> | undefined;
    return ns?.[key];
  }

  /**
   * Set a flag value asynchronously.
   */
  async setFlagAsync(sessionId: string, flagPath: string, value: unknown): Promise<boolean> {
    const [namespace, key] = parseFlagPath(flagPath);
    if (!namespace || !key) {
      return false;
    }
    
    const updated = await this.deps.updateSessionAsync(sessionId, async (session) => {
      const nextFlags: SessionFlags = { ...session.flags };
      const namespaceState: Record<string, unknown> = {
        ...(nextFlags[namespace] as Record<string, unknown> | undefined),
      };

      if (typeof value === 'undefined') {
        delete namespaceState[key];
      } else {
        namespaceState[key] = value;
      }

      if (Object.keys(namespaceState).length === 0) {
        delete nextFlags[namespace];
      } else {
        nextFlags[namespace] = namespaceState;
      }

      session.flags = nextFlags;
      this.deps.queuePersistMetadata(session);
      return true;
    });
    
    return Boolean(updated);
  }

  /**
   * Merge values into a flag namespace.
   */
  async mergeFlagNamespaceAsync(
    sessionId: string,
    namespace: string,
    values: Record<string, unknown>
  ): Promise<boolean> {
    if (!namespace || !values || typeof values !== 'object') {
      return false;
    }
    
    const updated = await this.deps.updateSessionAsync(sessionId, async (session) => {
      const nextFlags: SessionFlags = { ...session.flags };
      const namespaceState: Record<string, unknown> = {
        ...(nextFlags[namespace] as Record<string, unknown> | undefined),
      };

      for (const [key, val] of Object.entries(values)) {
        if (typeof val === 'undefined') {
          delete namespaceState[key];
        } else {
          namespaceState[key] = val;
        }
      }

      if (Object.keys(namespaceState).length === 0) {
        delete nextFlags[namespace];
      } else {
        nextFlags[namespace] = namespaceState;
      }

      session.flags = nextFlags;
      this.deps.queuePersistMetadata(session);
      return true;
    });
    
    return Boolean(updated);
  }

  /**
   * Clear all flags for a session.
   */
  async clearFlagsAsync(sessionId: string): Promise<boolean> {
    const updated = await this.deps.updateSessionAsync(sessionId, async (session) => {
      if (Object.keys(session.flags).length === 0) {
        return true;
      }
      session.flags = {};
      this.deps.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }
}

/**
 * Factory function for creating flag manager.
 */
export function createFlagManager(deps: FlagManagerDeps): SessionFlagManager {
  return new SessionFlagManager(deps);
}
