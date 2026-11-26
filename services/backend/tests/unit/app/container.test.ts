import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { DIContainer } from '@/app/container';
import { LifecycleManager } from '@/app/lifecycle';

describe('DIContainer', () => {
  it('resolves singletons lazily and caches results', async () => {
    const container = new DIContainer();
    const factory = vi.fn(() => ({ value: Math.random() }));
    container.register('foo', factory);

    const first = await container.resolve<{ value: number }>('foo');
    const second = await container.resolve<{ value: number }>('foo');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.value).toBe(second.value);
  });

  it('allows overriding providers and clears cached singletons', async () => {
    const container = new DIContainer();
    container.register('foo', () => ({ value: 1 }));
    const first = await container.resolve<{ value: number }>('foo');
    expect(first.value).toBe(1);

    container.override('foo', () => ({ value: 2 }));
    const second = await container.resolve<{ value: number }>('foo');
    expect(second.value).toBe(2);
  });

  it('throws for missing provider', async () => {
    const container = new DIContainer();
    await expect(container.resolve('missing')).rejects.toThrow('Provider not registered');
  });
});

describe('LifecycleManager', () => {
  it('tracks cleanup and intervals', async () => {
    const lifecycle = new LifecycleManager();
    const cleanup = vi.fn();
    lifecycle.track(cleanup);

    const timer = setInterval(() => undefined, 10);
    lifecycle.trackInterval(timer);

    await lifecycle.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(() => clearInterval(timer)).not.toThrow();
  });
});







