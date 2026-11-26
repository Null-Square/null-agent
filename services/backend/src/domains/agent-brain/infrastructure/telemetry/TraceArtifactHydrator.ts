import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import type { TimelineEvent } from './TimelineService';
import type { TraceHydrationMode } from './types';

export type TraceArtifactHydrationStatus =
  | 'inline'
  | 'artifact_unhydrated'
  | 'hydrated'
  | 'missing'
  | 'digest_missing'
  | 'digest_mismatch'
  | 'invalid_json';

export interface TraceArtifactHydration {
  mode: TraceHydrationMode;
  status: TraceArtifactHydrationStatus;
  artifactRef?: string;
  expectedSha256?: string;
  actualSha256?: string;
}

export interface TraceArtifactLoader {
  load(sessionId: string, artifactRef: string): Promise<Buffer>;
}

export class TraceArtifactIntegrityError extends Error {
  readonly code = 'trace_artifact_integrity_failed';

  constructor(
    public readonly eventId: string,
    public readonly status: Exclude<TraceArtifactHydrationStatus, 'inline' | 'artifact_unhydrated' | 'hydrated'>,
    public readonly artifactRef: string,
  ) {
    super(`Trace artifact ${artifactRef} for event ${eventId} failed strict hydration: ${status}`);
    this.name = 'TraceArtifactIntegrityError';
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const artifactReference = (event: TimelineEvent): string | undefined => {
  if (event.artifactRef) return event.artifactRef;
  if (typeof event.links?.artifact === 'string') return event.links.artifact;
  const payload = asRecord(event.payload);
  return typeof payload.artifact === 'string' ? payload.artifact : undefined;
};

const failure = (
  event: TimelineEvent,
  mode: TraceHydrationMode,
  status: Exclude<TraceArtifactHydrationStatus, 'inline' | 'artifact_unhydrated' | 'hydrated'>,
  artifactRef: string,
  actualSha256?: string,
): TimelineEvent => {
  if (mode === 'strict') {
    throw new TraceArtifactIntegrityError(event.id, status, artifactRef);
  }
  return {
    ...event,
    hydration: {
      mode,
      status,
      artifactRef,
      expectedSha256: event.artifactSha256,
      actualSha256,
    },
  };
};

/** Shared artifact reader for Timeline, run bundles, admin logs, and Behavior Lab. */
export const hydrateTraceEvent = async (
  event: TimelineEvent,
  mode: TraceHydrationMode,
  loader: TraceArtifactLoader,
): Promise<TimelineEvent> => {
  const artifactRef = artifactReference(event);
  if (!artifactRef) {
    return { ...event, hydration: { mode, status: 'inline' } };
  }
  if (mode === 'inline') {
    return {
      ...event,
      hydration: {
        mode,
        status: 'artifact_unhydrated',
        artifactRef,
        expectedSha256: event.artifactSha256,
      },
    };
  }

  let stored: Buffer;
  try {
    stored = await loader.load(event.sessionId, artifactRef);
  } catch {
    return failure(event, mode, 'missing', artifactRef);
  }

  const actualSha256 = createHash('sha256').update(stored).digest('hex');
  if (!event.artifactSha256) {
    if (mode === 'strict') return failure(event, mode, 'digest_missing', artifactRef, actualSha256);
  } else if (actualSha256 !== event.artifactSha256) {
    return failure(event, mode, 'digest_mismatch', artifactRef, actualSha256);
  }

  try {
    const content = artifactRef.endsWith('.gz') ? gunzipSync(stored) : stored;
    const hydratedPayload = JSON.parse(content.toString('utf8')) as unknown;
    return {
      ...event,
      inlinePayload: event.payload,
      payload: hydratedPayload,
      hydration: {
        mode,
        status: 'hydrated',
        artifactRef,
        expectedSha256: event.artifactSha256,
        actualSha256,
      },
    };
  } catch {
    return failure(event, mode, 'invalid_json', artifactRef, actualSha256);
  }
};

export const hydrateTraceEvents = async (
  events: TimelineEvent[],
  mode: TraceHydrationMode,
  loader: TraceArtifactLoader,
): Promise<TimelineEvent[]> => Promise.all(events.map((event) => hydrateTraceEvent(event, mode, loader)));
