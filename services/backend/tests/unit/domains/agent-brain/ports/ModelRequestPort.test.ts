import { describe, expect, it } from 'vitest';

import {
  reconstructLegacyModelRequest,
  type ModelRequestRecord,
} from '@/domains/agent-brain/ports/ModelRequestPort';

describe('ModelRequestPort legacy compatibility', () => {
  it('labels reconstructed requests without presenting them as atomically recorded', () => {
    const legacy: Omit<ModelRequestRecord, 'provenance'> = {
      requestId: 'legacy-request-1',
      schemaVersion: 1,
      sessionId: 'session-1',
      turn: 1,
      callOrdinal: 1,
      routeReason: 'legacy_trace_reconstruction',
      provider: 'openai',
      model: 'legacy-model',
      routedContextCapacity: 128_000,
      messages: [{ role: 'user', content: 'inspect this' }],
      systemContent: [],
      tools: [],
      generationSettings: {},
      contextMeasurementRefs: [],
      transformationRefs: ['legacy:session-trace'],
      envelope: {
        model: 'legacy-model',
        messages: [{ role: 'user', content: 'inspect this' }],
      },
      digest: 'sha256:legacy-reconstruction',
      createdAt: new Date('2026-08-24T00:00:00.000Z'),
    };

    const reconstructed = reconstructLegacyModelRequest(legacy);

    expect(reconstructed).toEqual({
      ...legacy,
      provenance: 'reconstructed_legacy',
    });
  });
});
