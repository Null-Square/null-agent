import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SandboxSelectionService } from '@/domains/agent-brain/application/services/SandboxSelectionService';
import { AppError } from '@/domains/agent-brain/domain/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const policyResolver = {
  getBySlug: vi.fn(),
  getDefaultPolicy: vi.fn(),
};

const policyFacade = {
  getResolver: () => policyResolver,
} as any;

const registry = {
  resolveImage: vi.fn(() => 'default:image'),
} as any;

describe('SandboxSelectionService', () => {
  let sandboxImagePort: { getImageBuildStatus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    policyResolver.getBySlug.mockReset();
    policyResolver.getDefaultPolicy.mockReset();
    sandboxImagePort = { getImageBuildStatus: vi.fn() };
  });

  it('throws when explicit sandbox profile is missing', async () => {
    policyResolver.getBySlug.mockResolvedValue(null);
    const service = new SandboxSelectionService(registry as any, policyFacade as any);

    await expect(service.resolve({ sandboxProfile: 'nonexistent' })).rejects.toThrow(AppError);
    await expect(service.resolve({ sandboxProfile: 'nonexistent' })).rejects.toMatchObject({
      httpStatus: 404,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
    });
  });

  it('throws when no default policy exists and none provided', async () => {
    policyResolver.getDefaultPolicy.mockResolvedValue(null);
    const service = new SandboxSelectionService(registry as any, policyFacade as any);

    await expect(service.resolve({})).rejects.toMatchObject({
      httpStatus: 500,
      code: ERROR_CODES.INTERNAL_CONFIGURATION,
    });
  });

  it('rejects sandbox images whose docker profile build status is not success', async () => {
    policyResolver.getDefaultPolicy.mockResolvedValue({ slug: 'default' });
    sandboxImagePort.getImageBuildStatus.mockResolvedValue('failed');
    const service = new SandboxSelectionService(registry as any, policyFacade as any, undefined, sandboxImagePort as any);

    await expect(service.resolve({ sandboxImage: 'img:tag' })).rejects.toMatchObject({
      httpStatus: 404,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
    });
    expect(sandboxImagePort.getImageBuildStatus).toHaveBeenCalledWith('img:tag');
  });

  it('returns resolved selection when policy and image are valid', async () => {
    policyResolver.getBySlug.mockResolvedValue({ slug: 'p1' });
    sandboxImagePort.getImageBuildStatus.mockResolvedValue('success');
    const service = new SandboxSelectionService(registry as any, policyFacade as any, undefined, sandboxImagePort as any);

    const result = await service.resolve({ sandboxProfile: 'p1', sandboxImage: 'img:ok' });

    expect(result).toEqual({ sandboxProfile: 'p1', sandboxImage: 'img:ok' });
    expect(policyResolver.getBySlug).toHaveBeenCalledWith('p1');
    expect(sandboxImagePort.getImageBuildStatus).toHaveBeenCalledWith('img:ok');
  });
});







