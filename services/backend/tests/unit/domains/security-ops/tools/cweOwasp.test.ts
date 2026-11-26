import { describe, expect, it } from 'vitest';

import { deriveOwaspCategory, normalizeCveIds, normalizeCweIds } from '@/domains/security-ops/tools/cweOwasp';

describe('cweOwasp utilities', () => {
  it('normalizes and deduplicates CWE IDs', () => {
    const ids = normalizeCweIds(['79', 'CWE-79', 'Cwe_89', 'invalid']);
    expect(ids).toEqual(['CWE-79', 'CWE-89']);
  });

  it('normalizes and filters CVE IDs', () => {
    const ids = normalizeCveIds(['cve-2024-1234', 'CVE-2024-1234', 'bad-id', 'CVE-2023-77777']);
    expect(ids).toEqual(['CVE-2024-1234', 'CVE-2023-77777']);
  });

  it('derives OWASP category from known CWE IDs', () => {
    const category = deriveOwaspCategory(['CWE-79', 'CWE-89']);
    expect(category).toBe('A03:2021-Injection');
  });
});

