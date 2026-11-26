import { describe, expect, it, vi } from 'vitest';

import { ScannerIngestorRegistry } from '@/domains/security-ops/tools/ingestion/ScannerIngestorRegistry';

describe('ScannerIngestorRegistry', () => {
  it('returns registered scanner ingestors by parser key', async () => {
    const subfinder = vi.fn().mockResolvedValue({ parser: 'subfinder' });
    const registry = new ScannerIngestorRegistry<string, { parser: string }, { parser: string }>({
      subfinder,
    });

    expect(registry.has('subfinder')).toBe(true);
    expect(registry.has('naabu')).toBe(false);

    const ingestor = registry.get('subfinder');
    await expect(ingestor?.({
      userId: 'user-1',
      workspaceDir: '/workspace',
      parsed: { parser: 'subfinder' },
    })).resolves.toEqual({ parser: 'subfinder' });
  });
});
