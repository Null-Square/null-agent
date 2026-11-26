import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SandboxSelectionService } from '@/domains/agent-brain/application/services/SandboxSelectionService';
import { ERROR_CODES, getErrorMetadata } from '@null-ai/contracts';

const makePolicyEngine = (policyExists = true, defaultExists = true) => ({
  getResolver: () => ({
    getBySlug: vi.fn(async () => (policyExists ? {} : null)),
    getDefaultPolicy: vi.fn(async () => (defaultExists ? {} : null)),
  }),
});

const makeRegistry = () => ({
  resolveImage: vi.fn(() => undefined),
});

describe('SandboxSelectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects sandbox images that are not built/ready', async () => {
    const imagePort = { getImageBuildStatus: vi.fn(async () => 'pending') };
    const service = new SandboxSelectionService(
      makeRegistry() as any,
      makePolicyEngine() as any,
      undefined,
      imagePort as any,
    );

    const metadata = getErrorMetadata(ERROR_CODES.RESOURCE_NOT_FOUND);
    await expect(service.resolve({ sandboxProfile: 'hardened', sandboxImage: 'ghcr.io/app/image:dev' })).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      httpStatus: metadata.httpStatus,
    });
  });

  it('allows ready images and passes through selection', async () => {
    const imagePort = { getImageBuildStatus: vi.fn(async () => 'success') };
    const service = new SandboxSelectionService(
      makeRegistry() as any,
      makePolicyEngine() as any,
      undefined,
      imagePort as any,
    );

    const resolved = await service.resolve({ sandboxProfile: 'hardened', sandboxImage: 'ghcr.io/app/image:prod' });

    expect(resolved.sandboxImage).toBe('ghcr.io/app/image:prod');
    expect(resolved.sandboxProfile).toBe('hardened');
  });

  it('uses registry default image when none provided and a default policy exists', async () => {
    const registry: any = makeRegistry();
    registry.resolveImage = vi.fn(() => 'ghcr.io/app/image:default');
    const imagePort = { getImageBuildStatus: vi.fn(async () => null) };
    const service = new SandboxSelectionService(
      registry as any,
      makePolicyEngine(true, true) as any,
      undefined,
      imagePort as any,
    );

    const resolved = await service.resolve({});

    expect(resolved).toEqual({ sandboxProfile: undefined, sandboxImage: 'ghcr.io/app/image:default' });
    expect(registry.resolveImage).toHaveBeenCalledWith(undefined);
    expect(imagePort.getImageBuildStatus).toHaveBeenCalled();
  });
});
