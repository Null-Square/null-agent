import { describe, it, expect } from 'vitest';
import { ImageResolver } from '@/domains/agent-brain/adapters/sandbox';

describe('ImageResolver', () => {
  it('returns the requested image when provided', () => {
    const resolver = new ImageResolver({ image: 'default-image' } as any);

    const result = resolver.resolve({ image: 'custom-image' });

    expect(result).toBe('custom-image');
  });

  it('falls back to the configured image', () => {
    const resolver = new ImageResolver({ image: 'default-image' } as any);

    const result = resolver.resolve({ toolpack: 'builtin' });

    expect(result).toBe('default-image');
  });
});
