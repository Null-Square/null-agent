import { describe, expect, it } from 'vitest';

import {
  buildContextMeasurement,
  measurementMatchesRoute,
} from '@/domains/agent-brain/domain/context/ContextMeasurement';

describe('ContextMeasurement', () => {
  const build = (model = 'large-model', capacity = 1_000_000) => buildContextMeasurement({
    measurementId: 'measurement-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    turn: 1,
    callOrdinal: 1,
    provider: 'deepseek',
    model,
    routedCapacity: capacity,
    capacitySource: 'model_config',
    reducerProfile: 'pentest',
    reducerReason: 'soft_threshold',
    createdAt: '2026-08-25T00:00:00.000Z',
    envelope: {
      model,
      messages: [
        { role: 'system', content: 'system instructions' },
        { role: 'user', content: 'inspect the target' },
      ],
      tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
      max_tokens: 8192,
    },
  });

  it('derives every threshold from the routed capacity', () => {
    const measurement = build();

    expect(measurement.routedCapacity).toBe(1_000_000);
    expect(measurement.thresholds).toEqual({
      softRatio: 0.7,
      hardRatio: 0.9,
      softTokens: 700_000,
      hardTokens: 900_000,
    });
    expect(measurement.countingMethod).toBe('conservative_json_chars_div_4_v1');
    expect(measurement.countingConfidence).toBe('conservative');
    expect(measurement.counts.totalWithReservedOutputTokens).toBeGreaterThan(8192);
  });

  it('invalidates a measurement when model route or capacity changes', () => {
    const measurement = build();

    expect(measurementMatchesRoute(measurement, {
      provider: 'deepseek',
      model: 'large-model',
      routedCapacity: 1_000_000,
      capacitySource: 'model_config',
    })).toBe(true);
    expect(measurementMatchesRoute(measurement, {
      provider: 'deepseek',
      model: 'smaller-model',
      routedCapacity: 128_000,
      capacitySource: 'model_config',
    })).toBe(false);
  });
});

