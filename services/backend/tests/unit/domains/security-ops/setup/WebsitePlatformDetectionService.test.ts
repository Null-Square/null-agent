import { describe, expect, it, vi } from 'vitest';

import { WebsitePlatformDetectionService } from '@/domains/security-ops/setup/WebsitePlatformDetectionService';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const noCname = async () => [];

describe('WebsitePlatformDetectionService', () => {
  it('names Shopify from response markers and still recommends DNS or HTTP verification', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><script src="https://cdn.shopify.com/theme.js"></script></html>', {
        status: 200,
        headers: {
          'x-shopify-stage': 'production',
        },
      }),
    ) as unknown as typeof fetch;

    const service = new WebsitePlatformDetectionService({
      fetchImpl,
      lookupHost: publicLookup,
      resolveCname: noCname,
    });

    const result = await service.detect('store.example.com');

    expect(result.detectedProvider).toBe('shopify');
    expect(result.recommendation.method).toBe('manual');
    expect(result.recommendation.provider).toBe('shopify');
    expect(result.recommendation.confidence).toBe('high');
    expect(result.recommendation.fallbackMethods).toEqual(['dns_txt', 'http_well_known']);
  });

  it('names WordPress from page markers without offering a plugin connection', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><meta name="generator" content="WordPress"><link href="/wp-content/theme.css"></html>', {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const service = new WebsitePlatformDetectionService({
      fetchImpl,
      lookupHost: publicLookup,
      resolveCname: noCname,
    });

    const result = await service.detect('https://www.example.com/blog');

    expect(result.domain).toBe('example.com');
    expect(result.detectedProvider).toBe('wordpress');
    expect(result.recommendation.label).toBe('Manual verification');
    expect(result.recommendation.description).toContain('WordPress');
  });

  it('uses CNAME evidence when the page cannot be fetched', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('timeout');
    }) as unknown as typeof fetch;

    const service = new WebsitePlatformDetectionService({
      fetchImpl,
      lookupHost: publicLookup,
      resolveCname: async () => ['demo.wixdns.net'],
    });

    const result = await service.detect('www.example.com');

    expect(result.detectedProvider).toBe('wix');
    expect(result.recommendation.method).toBe('manual');
    expect(result.signals.cnameRecords).toEqual(['demo.wixdns.net']);
  });

  it('falls back to manual verification when signals are ambiguous', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html>cdn.shopify.com wixstatic.com</html>', {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const service = new WebsitePlatformDetectionService({
      fetchImpl,
      lookupHost: publicLookup,
      resolveCname: noCname,
    });

    const result = await service.detect('example.com');

    expect(result.detectedProvider).toBeNull();
    expect(result.recommendation.method).toBe('manual');
  });

  it('does not fetch domains that resolve to private addresses', async () => {
    const fetchImpl = vi.fn(async () => new Response('never')) as unknown as typeof fetch;
    const service = new WebsitePlatformDetectionService({
      fetchImpl,
      lookupHost: async () => [{ address: '127.0.0.1', family: 4 }],
      resolveCname: noCname,
    });

    const result = await service.detect('example.com');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.recommendation.method).toBe('manual');
    expect(result.recommendation.evidence[0]).toContain('private or reserved');
  });
});
