import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
import { SandboxImageRegistry, getSandboxImageRegistry, getSandboxImageRegistrySync } from '@/domains/platform/sandbox/infrastructure/SandboxImageRegistry';
import { sandboxImageService } from '@/domains/platform/sandbox/infrastructure/SandboxImageService';

vi.mock('@/domains/platform/sandbox/infrastructure/SandboxImageService', () => ({
  sandboxImageService: {
    list: vi.fn(),
  },
}));

const asRow = (overrides: Partial<any> = {}) => ({
  id: overrides.id ?? 'id',
  name: overrides.name ?? 'base',
  imageTag: overrides.imageTag ?? 'img:latest',
  description: overrides.description ?? null,
  isDefault: overrides.isDefault ?? false,
  dockerProfileId: overrides.dockerProfileId ?? null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('SandboxImageRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset singleton
    (global as any)._instance = null;
  });

  it('initializes and selects explicit default', async () => {
    (sandboxImageService.list as Mock).mockResolvedValue([
      asRow({ name: 'base', imageTag: 'base:tag', isDefault: false }),
      asRow({ name: 'net', imageTag: 'net:tag', isDefault: true }),
    ]);

    const registry = new SandboxImageRegistry();
    await registry.init();

    expect(registry.isReady()).toBe(true);
    expect(registry.getDefaultImageTag()).toBe('net:tag');
    expect(registry.getImageTag('base')).toBe('base:tag');
    expect(registry.listNames().sort()).toEqual(['base', 'net']);
  });

  it('returns undefined when no default is flagged', async () => {
    (sandboxImageService.list as Mock).mockResolvedValue([
      asRow({ name: 'base', imageTag: 'base:tag', isDefault: false }),
      asRow({ name: 'tools', imageTag: 'tools:tag', isDefault: false }),
    ]);

    const registry = new SandboxImageRegistry();
    await registry.init();

    expect(registry.getDefaultImageTag()).toBeUndefined();
  });

  it('refresh updates images and default cache', async () => {
    const listMock = sandboxImageService.list as Mock;
    listMock.mockResolvedValue([asRow({ name: 'base', imageTag: 'old:tag', isDefault: true })]);
    const registry = new SandboxImageRegistry();
    await registry.init();
    expect(registry.getDefaultImageTag()).toBe('old:tag');

    listMock.mockResolvedValue([asRow({ name: 'new', imageTag: 'new:tag', isDefault: true })]);
    await registry.refresh();

    expect(registry.getDefaultImageTag()).toBe('new:tag');
    expect(registry.listNames()).toEqual(['new']);
  });

  it('singleton helpers return the same instance after init', async () => {
    (sandboxImageService.list as Mock).mockResolvedValue([asRow({ name: 'base', isDefault: true })]);
    const inst1 = await getSandboxImageRegistry();
    const inst2 = getSandboxImageRegistrySync();

    expect(inst1).toBe(inst2);
    expect(inst2?.isReady()).toBe(true);
  });
});







