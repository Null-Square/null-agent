import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAppContext: vi.fn(),
  createHttpApp: vi.fn(),
  listen: vi.fn(),
  whenReady: vi.fn(),
  dispose: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/app/createAppContext', () => ({
  createAppContext: mocks.createAppContext,
}));

vi.mock('@/interfaces/http/httpServer', () => ({
  default: mocks.createHttpApp,
}));

vi.mock('@/config/bootstrapConfig', () => ({
  __esModule: true,
  default: { port: 4321, nodeEnv: 'test' },
  config: { port: 4321, nodeEnv: 'test' },
}));

vi.mock('@/shared/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    child: () => ({
      info: mocks.loggerInfo,
      warn: mocks.loggerWarn,
      error: mocks.loggerError,
      debug: mocks.loggerDebug,
      child: () => ({
        info: mocks.loggerInfo,
        warn: mocks.loggerWarn,
        error: mocks.loggerError,
        debug: mocks.loggerDebug,
      }),
    }),
  },
}));

import { AppContainer } from '@/app/AppContainer';

describe('AppContainer runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.whenReady.mockResolvedValue(undefined);
    mocks.dispose.mockResolvedValue(undefined);
  });

  it('starts once and returns cached server/context', async () => {
    const server = {
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
    const context = {
      sessionStore: { whenReady: mocks.whenReady },
    };
    mocks.createAppContext.mockResolvedValue(context);
    mocks.listen.mockImplementation((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    });
    mocks.createHttpApp.mockReturnValue({ listen: mocks.listen, locals: { ownerKey: 'k'.repeat(43) } });

    const container = new AppContainer();
    const first = await container.start(1111);
    const second = await container.start(2222);

    expect(mocks.createAppContext).toHaveBeenCalledTimes(1);
    expect(mocks.createHttpApp).toHaveBeenCalledWith(context);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    // This computer only, by default.
    expect(mocks.listen).toHaveBeenCalledWith(1111, '127.0.0.1', expect.any(Function));
    expect(first.server).toBe(server);
    expect(second.server).toBe(server);
    expect(first.context).toBe(context);
    expect(second.context).toBe(context);
    expect(mocks.whenReady).toHaveBeenCalledTimes(1);
  });

  it('logs the effective local settings once at start, and never the owner key', async () => {
    const key = 'k'.repeat(43);
    const server = { on: vi.fn(), off: vi.fn(), close: vi.fn((cb?: (err?: Error) => void) => cb?.()) };
    mocks.createAppContext.mockResolvedValue({ sessionStore: { whenReady: mocks.whenReady } });
    mocks.listen.mockImplementation((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    });
    mocks.createHttpApp.mockReturnValue({ listen: mocks.listen, locals: { ownerKey: key } });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await new AppContainer().start(1111);
    } finally {
      write.mockRestore();
    }

    const settingsLogs = mocks.loggerInfo.mock.calls.filter(([fields]) => fields?.event === 'config.local');
    expect(settingsLogs).toHaveLength(1);
    expect(settingsLogs[0][0]).toMatchObject({
      bindHost: '127.0.0.1',
      allowedHosts: expect.arrayContaining(['localhost', '127.0.0.1']),
      appUrl: expect.any(String),
      ownerKeyFile: expect.any(String),
      labTargets: expect.any(Array),
      codeSourcesRoot: expect.stringMatching(/code-sources$/),
    });
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain(key);
  });

  it('stops server and disposes context resources', async () => {
    const server = {
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
    const context = {
      sessionStore: { whenReady: mocks.whenReady },
      dispose: mocks.dispose,
    };
    mocks.createAppContext.mockResolvedValue(context);
    mocks.listen.mockImplementation((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    });
    mocks.createHttpApp.mockReturnValue({ listen: mocks.listen, locals: { ownerKey: 'k'.repeat(43) } });

    const container = new AppContainer();
    await container.start(3333);
    await container.stop();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
