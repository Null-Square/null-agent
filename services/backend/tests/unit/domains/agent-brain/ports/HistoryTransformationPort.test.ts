import { describe, expect, it } from 'vitest';

import {
  createHistoryTransformationId,
  reconstructLegacyHistoryTransformation,
} from '@/domains/agent-brain/ports/HistoryTransformationPort';
import { buildContextMeasurement, toContextMeasurementSnapshot } from '@/domains/agent-brain/domain/context';

const measurement = toContextMeasurementSnapshot(buildContextMeasurement({
  measurementId: 'measurement-1',
  requestId: 'legacy-request',
  sessionId: 'session-1',
  turn: 1,
  callOrdinal: 1,
  provider: 'openai',
  model: 'model-1',
  routedCapacity: 128_000,
  capacitySource: 'model_config',
  envelope: { model: 'model-1', messages: [] },
  createdAt: '2026-08-25T00:00:00.000Z',
}));

describe('HistoryTransformationPort', () => {
  it('derives the same transaction identity from the same stable message range', () => {
    const input = {
      sessionId: 'session-1',
      inputHistoryVersion: 0,
      inputMessageIds: ['message-a', 'message-b'],
      reducerProfile: 'pentest',
      reason: 'soft_threshold',
      configurationDigest: 'sha256:config',
    };

    expect(createHistoryTransformationId(input)).toBe(createHistoryTransformationId({ ...input }));
    expect(createHistoryTransformationId({
      ...input,
      inputMessageIds: ['message-a', 'message-c'],
    })).not.toBe(createHistoryTransformationId(input));
  });

  it('labels legacy compaction fields as reconstructed evidence', () => {
    const record = reconstructLegacyHistoryTransformation({
      sessionId: 'session-1',
      turn: 4,
      summary: 'legacy summary',
      cutoffMessageId: 'message-b',
      inputMessageIds: ['message-a', 'message-b'],
      version: 1,
      measurement,
    });

    expect(record).toMatchObject({
      provenance: 'reconstructed_legacy',
      status: 'activated',
      inputEndMessageId: 'message-b',
      outputHistoryVersion: 1,
    });
  });
});
