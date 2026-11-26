import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { ArtifactObservation, HydratedTraceObservation } from './types';

type TraceRecord = {
  id?: unknown;
  event?: unknown;
  turn?: unknown;
  severity?: unknown;
  payload?: unknown;
  links?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readArtifact = (filePath: string): { raw: Buffer; payload: unknown } => {
  const stored = readFileSync(filePath);
  const raw = filePath.endsWith('.gz') ? gunzipSync(stored) : stored;
  return {
    raw: stored,
    payload: JSON.parse(raw.toString('utf8')) as unknown,
  };
};

export const hydrateTrace = (
  traceRoot: string,
  sessionId: string,
): { trace: HydratedTraceObservation[]; artifacts: ArtifactObservation[] } => {
  const tracePath = path.join(traceRoot, sessionId, 'trace.ndjson');
  if (!existsSync(tracePath)) return { trace: [], artifacts: [] };

  const artifactByPath = new Map<string, ArtifactObservation>();
  const records = readFileSync(tracePath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRecord);

  const trace = records.map((record): HydratedTraceObservation => {
    const inlinePayload = record.payload;
    const inlineRecord = asRecord(inlinePayload);
    const links = asRecord(record.links);
    const artifactPath = typeof links.artifact === 'string'
      ? links.artifact
      : typeof inlineRecord.artifact === 'string'
        ? inlineRecord.artifact
        : undefined;
    const id = typeof record.id === 'string' ? record.id : 'unknown-event';
    let hydratedPayload: unknown;

    if (artifactPath) {
      const absoluteArtifactPath = path.join(traceRoot, sessionId, artifactPath);
      const artifact = readArtifact(absoluteArtifactPath);
      hydratedPayload = artifact.payload;
      const existing = artifactByPath.get(artifactPath);
      if (existing) {
        existing.hydratedForEventIds.push(id);
      } else {
        artifactByPath.set(artifactPath, {
          path: artifactPath.replace(/\\/gu, '/'),
          bytes: artifact.raw.byteLength,
          sha256: createHash('sha256').update(artifact.raw).digest('hex'),
          compressed: absoluteArtifactPath.endsWith('.gz'),
          hydratedForEventIds: [id],
        });
      }
    }

    const effectivePayload = asRecord(hydratedPayload ?? inlinePayload);
    return {
      id,
      event: typeof record.event === 'string' ? record.event : 'unknown',
      turn: typeof record.turn === 'number' ? record.turn : 0,
      severity: typeof record.severity === 'string' ? record.severity : 'info',
      toolCallId: typeof effectivePayload.toolCallId === 'string'
        ? effectivePayload.toolCallId
        : undefined,
      payloadMode: artifactPath ? 'artifact' : 'inline',
      inlinePayload,
      hydratedPayload,
      artifactPath: artifactPath?.replace(/\\/gu, '/'),
    };
  });

  return { trace, artifacts: [...artifactByPath.values()] };
};
