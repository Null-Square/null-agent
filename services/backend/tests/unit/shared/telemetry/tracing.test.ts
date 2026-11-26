import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sdkStart: vi.fn().mockResolvedValue(undefined),
  sdkShutdown: vi.fn().mockResolvedValue(undefined),
  sdkOptions: [] as any[],
  exporterOptions: [] as any[],
  autoInstrumentations: vi.fn<(options?: any) => any>(() => ['auto']),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/shared/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start = mocks.sdkStart;
    shutdown = mocks.sdkShutdown;
    constructor(options: any) {
      mocks.sdkOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/exporter-trace-otlp-grpc', () => ({
  OTLPTraceExporter: class {
    constructor(options: any) {
      mocks.exporterOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: (options: any) => mocks.autoInstrumentations(options),
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attributes: Record<string, unknown>) => ({ attributes }),
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  SEMRESATTRS_SERVICE_NAME: 'service.name',
  SEMRESATTRS_SERVICE_VERSION: 'service.version',
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: 'deployment.environment',
}));

describe('tracing', () => {
  const originalEnv = {
    enabled: process.env.OTEL_TRACES_ENABLED,
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: process.env.OTEL_SERVICE_NAME,
    version: process.env.npm_package_version,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.sdkOptions.length = 0;
    mocks.exporterOptions.length = 0;
  });

  afterEach(() => {
    if (originalEnv.enabled === undefined) {
      delete process.env.OTEL_TRACES_ENABLED;
    } else {
      process.env.OTEL_TRACES_ENABLED = originalEnv.enabled;
    }

    if (originalEnv.endpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEnv.endpoint;
    }

    if (originalEnv.serviceName === undefined) {
      delete process.env.OTEL_SERVICE_NAME;
    } else {
      process.env.OTEL_SERVICE_NAME = originalEnv.serviceName;
    }

    if (originalEnv.version === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = originalEnv.version;
    }

    if (originalEnv.nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.nodeEnv;
    }
  });

  it('reports whether tracing is enabled', async () => {
    process.env.OTEL_TRACES_ENABLED = 'true';
    const { isTracingEnabled } = await import('@/shared/telemetry/tracing');
    expect(isTracingEnabled()).toBe(true);

    process.env.OTEL_TRACES_ENABLED = 'false';
    expect(isTracingEnabled()).toBe(false);
  });

  it('skips initialization when tracing is disabled', async () => {
    process.env.OTEL_TRACES_ENABLED = 'false';
    const { startTracing } = await import('@/shared/telemetry/tracing');

    await startTracing();

    expect(mocks.sdkOptions).toHaveLength(0);
    expect(mocks.logger.info).toHaveBeenCalled();
  });

  it('initializes and starts the OpenTelemetry SDK when enabled', async () => {
    process.env.OTEL_TRACES_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4317';
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const { startTracing } = await import('@/shared/telemetry/tracing');

    await startTracing();

    expect(mocks.exporterOptions[0]).toEqual({ url: 'http://otel:4317' });
    expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    onSpy.mockRestore();
  });

  it('warns when startTracing is called more than once', async () => {
    process.env.OTEL_TRACES_ENABLED = 'true';
    const { startTracing } = await import('@/shared/telemetry/tracing');

    await startTracing();
    await startTracing();

    expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith('OpenTelemetry SDK already started');
  });

  it('logs errors when startup fails without throwing', async () => {
    process.env.OTEL_TRACES_ENABLED = 'true';
    mocks.sdkStart.mockRejectedValueOnce(new Error('startup failed'));
    const { startTracing } = await import('@/shared/telemetry/tracing');

    await expect(startTracing()).resolves.toBeUndefined();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Failed to initialize OpenTelemetry SDK',
    );
  });

  it('shuts down the SDK when requested', async () => {
    process.env.OTEL_TRACES_ENABLED = 'true';
    const { startTracing, stopTracing } = await import('@/shared/telemetry/tracing');

    await startTracing();
    await stopTracing();

    expect(mocks.sdkShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith('OpenTelemetry SDK stopped');
  });
});
