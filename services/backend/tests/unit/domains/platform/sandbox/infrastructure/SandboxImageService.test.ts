import { describe, it, expect, beforeEach } from 'vitest';
import { SandboxImageService } from '@/domains/platform/sandbox/infrastructure/SandboxImageService';

describe('SandboxImageService', () => {
  const service = new SandboxImageService();

  beforeEach(() => {
    // Keep unit tests isolated from file-config bootstrap.
    (service as any).rows = new Map();
    (service as any).initialized = true;
  });

  it('sets default image and unsets previous default on create', async () => {
    await service.create({
      id: 'a',
      name: 'base',
      imageTag: 'base:tag',
      description: null,
      isDefault: true,
      dockerProfileId: null,
    });
    await service.create({
      id: 'b',
      name: 'net',
      imageTag: 'net:tag',
      description: null,
      isDefault: true,
      dockerProfileId: null,
    });

    const rows = await service.list();
    const defaults = rows.filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('net');
    expect(await service.getDefaultImageTag()).toBe('net:tag');
  });

  it('update with isDefault true unsets other defaults', async () => {
    await service.create({
      id: 'a',
      name: 'base',
      imageTag: 'base:tag',
      description: null,
      isDefault: true,
      dockerProfileId: null,
    });
    await service.create({
      id: 'b',
      name: 'net',
      imageTag: 'net:tag',
      description: null,
      isDefault: false,
      dockerProfileId: null,
    });

    await service.update('b', { isDefault: true });

    const rows = await service.list();
    const defaults = rows.filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('net');
  });

  it('upsertByName updates existing record instead of duplicating', async () => {
    await service.create({
      id: 'a',
      name: 'base',
      imageTag: 'base:tag',
      description: null,
      isDefault: false,
      dockerProfileId: null,
    });

    const updated = await service.upsertByName({
      name: 'base',
      imageTag: 'base:new',
      description: 'updated',
      isDefault: false,
      dockerProfileId: null,
    });

    const rows = await service.list();
    expect(rows).toHaveLength(1);
    expect(updated.imageTag).toBe('base:new');
    expect(updated.description).toBe('updated');
  });
});
