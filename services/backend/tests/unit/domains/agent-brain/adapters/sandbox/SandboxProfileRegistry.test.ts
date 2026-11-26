import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SandboxProfileRegistry, type SandboxProfilesConfig } from '@/domains/agent-brain/adapters/sandbox';

describe('SandboxProfileRegistry', () => {
    const mockConfig = {
        sandboxProfiles: {
            default: 'default-image',
            'test-profile': 'test-image',
        },
    } as SandboxProfilesConfig;

    let registry: SandboxProfileRegistry;

    beforeEach(() => {
        registry = new SandboxProfileRegistry(mockConfig);
    });

    it('should return default image when no profile key is provided', () => {
        expect(registry.resolveImage(undefined)).toBe('default-image');
    });

    it('should return correct image for existing profile', () => {
        expect(registry.resolveImage('test-profile')).toBe('test-image');
    });

    it('should return default image and warn for non-existent profile', () => {
        const warnSpy = vi.spyOn((registry as any).log, 'warn');
        expect(registry.resolveImage('unknown-profile')).toBe('default-image');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ profileKey: 'unknown-profile' }),
            expect.stringContaining('Profile not found'),
        );
    });

    it('should list all available profiles', () => {
        expect(registry.getProfiles()).toEqual(['default', 'test-profile']);
    });
});
vi.mock('@/shared/logger', () => ({
    logger: { child: vi.fn(() => ({ warn: vi.fn() })) },
}));

import { logger } from '@/shared/logger';







