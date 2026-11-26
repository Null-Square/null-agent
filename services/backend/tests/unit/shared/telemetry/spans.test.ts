import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  withSpan,
  spanToolExec,
  spanLLMCall,
  addSpanEvent,
  setSpanAttributes,
  getCurrentTraceId,
  getCurrentSpanId,
} from '@/shared/telemetry/spans';

const mocks = vi.hoisted(() => {
  const makeSpan = () => ({
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
    addEvent: vi.fn(),
    setAttributes: vi.fn(),
    spanContext: vi.fn(() => ({ traceId: 'trace-123', spanId: 'span-456' })),
  });

  return {
    lastSpan: null as ReturnType<typeof makeSpan> | null,
    makeSpan,
    startActiveSpan: vi.fn((name: string, options: any, fn: any) => {
      const span = makeSpan();
      mocks.lastSpan = span;
      return fn(span);
    }),
  };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (name: string, options: any, fn: any) =>
        mocks.startActiveSpan(name, options, fn),
    }),
    getActiveSpan: () => mocks.lastSpan,
  },
  context: {},
  SpanStatusCode: { OK: 'OK', ERROR: 'ERROR' },
  SpanKind: { CLIENT: 'CLIENT' },
}));

describe('telemetry spans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lastSpan = null;
    mocks.startActiveSpan.mockImplementation((name: string, options: any, fn: any) => {
      const span = mocks.makeSpan();
      mocks.lastSpan = span;
      return fn(span);
    });
  });

  it('wraps an async function and marks span status OK', async () => {
    const result = await withSpan('unit.test', { ok: true }, async () => 'done');

    expect(result).toBe('done');
    expect(mocks.startActiveSpan).toHaveBeenCalledWith(
      'unit.test',
      { attributes: { ok: true } },
      expect.any(Function),
    );
    expect(mocks.lastSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mocks.lastSpan?.end).toHaveBeenCalledTimes(1);
  });

  it('records errors and rethrows when the wrapped function fails', async () => {
    await expect(
      withSpan('unit.fail', { ok: false }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mocks.lastSpan?.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'boom',
    });
    expect(mocks.lastSpan?.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.lastSpan?.end).toHaveBeenCalledTimes(1);
  });

  it('adds tool span attributes with args count', async () => {
    mocks.startActiveSpan.mockClear();

    await spanToolExec('shell', 'session-1', { a: 1, b: 2 }, async () => 'ok');

    const [name, options] = mocks.startActiveSpan.mock.calls[0];
    expect(name).toBe('tool.execute');
    expect(options.attributes).toEqual(
      expect.objectContaining({
        'tool.name': 'shell',
        'session.id': 'session-1',
        'tool.args.count': 2,
      }),
    );
  });

  it('marks LLM spans as client calls', async () => {
    mocks.startActiveSpan.mockClear();

    await spanLLMCall('openai', 'gpt-4', 'session-9', async () => 'ok');

    const [name, options] = mocks.startActiveSpan.mock.calls[0];
    expect(name).toBe('llm.call');
    expect(options.kind).toBe(SpanKind.CLIENT);
    expect(options.attributes).toEqual(
      expect.objectContaining({
        'llm.provider': 'openai',
        'llm.model': 'gpt-4',
        'session.id': 'session-9',
      }),
    );
  });

  it('adds events and attributes to the active span when present', () => {
    mocks.lastSpan = mocks.makeSpan();

    addSpanEvent('event.hit', { count: 2 });
    setSpanAttributes({ status: 'ok' });

    expect(mocks.lastSpan.addEvent).toHaveBeenCalledWith('event.hit', { count: 2 });
    expect(mocks.lastSpan.setAttributes).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('returns trace and span ids when a span is active', () => {
    mocks.lastSpan = mocks.makeSpan();

    expect(getCurrentTraceId()).toBe('trace-123');
    expect(getCurrentSpanId()).toBe('span-456');
  });

  it('returns undefined when no active span exists', () => {
    mocks.lastSpan = null;

    expect(getCurrentTraceId()).toBeUndefined();
    expect(getCurrentSpanId()).toBeUndefined();
  });
});
