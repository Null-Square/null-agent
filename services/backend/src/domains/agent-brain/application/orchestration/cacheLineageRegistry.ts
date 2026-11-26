import { logger } from '@/shared/logger';
import { digestOf, type CacheIdentity } from '../../domain/cache';
import { CacheLineageObserver } from './CacheLineageObserver';

/**
 * E12 Slice A — the process-wide cache lineage observer.
 *
 * Slice A is observe-only: it changes no dispatched request. It records what relationship
 * each model request has to its cache ancestor and, once the provider replies, whether the
 * outcome matched. Everything it emits goes to the structured log under one event name so a
 * production run can be queried without a schema change.
 *
 * The observer holds one entry per live session. `releaseCacheLineageSession` is the normal
 * way an entry is freed; the cap below is the backstop for a session that never settles.
 */

const MAX_TRACKED_SESSIONS = 500;

/**
 * Credential-level namespacing is not observable at the dispatch seam: `ModelStream` does
 * not expose the resolved API key, and inventing a tenant identity here would be worse than
 * declaring the gap. Slice A compares requests inside one session, where the credential is
 * constant, so a fixed namespace is correct for what it actually measures. A credential
 * rotation inside a live session is therefore not detected as an identity change.
 */
const RUNTIME_TENANT_DIGEST = digestOf('agent-brain-runtime-unscoped');

const log = logger.child({ scope: 'CacheLineage' });

const trackedSessions = new Set<string>();

let observer: CacheLineageObserver | undefined;

const getObserver = (): CacheLineageObserver => {
  observer ??= new CacheLineageObserver((event, payload) => {
    log.debug({ cacheLineageEvent: event, ...payload }, event);
  });
  return observer;
};

/** Frees the oldest tracked session once the cap is reached. */
const trackSession = (sessionId: string): void => {
  if (trackedSessions.has(sessionId)) return;
  if (trackedSessions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = trackedSessions.values().next().value;
    if (typeof oldest === 'string') {
      trackedSessions.delete(oldest);
      getObserver().forgetSession(oldest);
    }
  }
  trackedSessions.add(sessionId);
};

export const cacheLineage = {
  observe: (): CacheLineageObserver => getObserver(),
  track: trackSession,
};

export const buildRuntimeCacheIdentity = (input: {
  provider: string;
  model: string;
  reasoningConfig?: string;
  translationVersion?: string;
}): CacheIdentity => ({
  provider: input.provider,
  model: input.model,
  tenantDigest: RUNTIME_TENANT_DIGEST,
  ...(input.reasoningConfig ? { reasoningConfig: input.reasoningConfig } : {}),
  // The provider adapter overwrites this with its own translation version when it owns a
  // real translation step; this value is the OpenAI-compatible default.
  translationVersion: input.translationVersion ?? 'openai-compatible/v1',
});

export const releaseCacheLineageSession = (sessionId: string): void => {
  trackedSessions.delete(sessionId);
  observer?.forgetSession(sessionId);
};

/** Test seam: drops all lineage state so one test cannot observe another's ancestors. */
export const resetCacheLineageForTests = (): void => {
  trackedSessions.clear();
  observer = undefined;
};
