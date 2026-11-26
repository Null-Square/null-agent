import { describe, it, expect } from 'vitest';
import { toolManifestSchema } from '@/domains/agent-brain/domain/manifests';

describe('toolManifestSchema', () => {
  it('accepts minimal valid manifests', () => {
    const parsed = toolManifestSchema.safeParse({
      id: 'tool-1',
      summary: 'Summary',
      meta: { category: 'General' },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects missing summary or meta category', () => {
    const missingSummary = toolManifestSchema.safeParse({
      id: 'tool-2',
      meta: { category: 'General' },
    });
    const missingCategory = toolManifestSchema.safeParse({
      id: 'tool-3',
      summary: 'Summary',
      meta: {},
    });

    expect(missingSummary.success).toBe(false);
    expect(missingCategory.success).toBe(false);
  });
});
