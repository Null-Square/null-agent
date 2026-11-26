import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyService, type PolicyRepositoryPort, type PolicyWithSpec } from '@/domains/agent-brain/domain/policy';

/**
 * Mock repository for testing PolicyService.
 * Since PolicyService now uses dependency injection, we mock the port instead of the DB.
 */
const createMockRepository = (): PolicyRepositoryPort => ({
  getBySlug: vi.fn(),
  getById: vi.fn(),
  getDefaultPolicy: vi.fn(),
});

describe('PolicyService', () => {
  let mockRepo: ReturnType<typeof createMockRepository>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo = createMockRepository();
    service = new PolicyService(mockRepo);
  });

  it('parses sandbox and tool spec from policy rows', async () => {
    const mockPolicy: PolicyWithSpec = {
      id: 'policy-1',
      slug: 'default',
      name: 'Default Policy',
      spec: {
        sandbox: { network: 'bridge' },
        tools: { allow: ['read'] },
      },
      isDefaultSandbox: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      parsedSpec: {
        sandbox: { network: 'bridge' },
        tools: { allow: ['read'] },
      },
      sandboxImage: 'ghcr.io/null/sandbox:base',
    };
    vi.mocked(mockRepo.getBySlug).mockResolvedValue(mockPolicy);

    const result = await service.getBySlug('default');

    expect(result?.parsedSpec.sandbox).toEqual({ network: 'bridge' });
    expect(result?.parsedSpec.tools).toEqual({ allow: ['read'] });
    expect(result?.sandboxImage).toBe('ghcr.io/null/sandbox:base');
    expect(mockRepo.getBySlug).toHaveBeenCalledWith('default');
  });

  it('uses toolPolicy as a fallback for tool rules', async () => {
    const mockPolicy: PolicyWithSpec = {
      id: 'policy-2',
      slug: 'fallback',
      name: 'Fallback Policy',
      spec: {
        sandbox: { network: 'none' },
        toolPolicy: { deny: ['exec'] },
      },
      isDefaultSandbox: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      parsedSpec: {
        sandbox: { network: 'none' },
        tools: { deny: ['exec'] },
      },
    };
    vi.mocked(mockRepo.getDefaultPolicy).mockResolvedValue(mockPolicy);

    const result = await service.getDefaultPolicy();

    expect(result?.parsedSpec.tools).toEqual({ deny: ['exec'] });
    expect(result?.sandboxImage).toBeUndefined();
    expect(mockRepo.getDefaultPolicy).toHaveBeenCalledOnce();
  });

  it('delegates getById to repository', async () => {
    const mockPolicy: PolicyWithSpec = {
      id: 'policy-3',
      slug: 'by-id',
      name: 'By ID Policy',
      spec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      parsedSpec: {},
    };
    vi.mocked(mockRepo.getById).mockResolvedValue(mockPolicy);

    const result = await service.getById('policy-3');

    expect(result?.slug).toBe('by-id');
    expect(mockRepo.getById).toHaveBeenCalledWith('policy-3');
  });

  it('returns null when policy not found', async () => {
    vi.mocked(mockRepo.getBySlug).mockResolvedValue(null);
    vi.mocked(mockRepo.getById).mockResolvedValue(null);
    vi.mocked(mockRepo.getDefaultPolicy).mockResolvedValue(null);

    const bySlug = await service.getBySlug('missing');
    const byId = await service.getById('missing');
    const defaultPolicy = await service.getDefaultPolicy();

    expect(bySlug).toBeNull();
    expect(byId).toBeNull();
    expect(defaultPolicy).toBeNull();
  });
});
