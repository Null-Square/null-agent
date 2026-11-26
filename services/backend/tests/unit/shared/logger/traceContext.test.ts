import { describe, it, expect, vi, beforeEach } from 'vitest';
import { traceContextMixin } from '@/shared/logger/traceContext';

const mocks = vi.hoisted(() => ({
  activeSpan: null as { spanContext: () => { traceId: string; spanId: string } } | null,
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => mocks.activeSpan,
  },
}));

describe('traceContextMixin', () => {
  beforeEach(() => {
    mocks.activeSpan = null;
  });

  it('returns empty context when no span is active', () => {
    expect(traceContextMixin()).toEqual({});
  });

  it('returns empty context when trace id is invalid', () => {
    mocks.activeSpan = {
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: 'span-1',
      }),
    };

    expect(traceContextMixin()).toEqual({});
  });

  it('returns trace and span ids when span is active', () => {
    mocks.activeSpan = {
      spanContext: () => ({
        traceId: 'trace-123',
        spanId: 'span-456',
      }),
    };

    expect(traceContextMixin()).toEqual({
      traceId: 'trace-123',
      spanId: 'span-456',
    });
  });
});
