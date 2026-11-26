import { describe, expect, it } from 'vitest';

import {
  extractHttpxTechFingerprints,
  splitProductVersion,
} from '@/domains/security-ops/tools/ingestion/ScannerRuntimeHelpers';

/**
 * These cases are the real output shapes of the tools we ingest, not invented
 * strings. The ingestor tests stub `splitProductVersion` out, so this file is
 * the only place the parser itself is exercised — and the colon form below is
 * exactly what httpx `-tech-detect` emits in its JSON `tech` array.
 */
describe('splitProductVersion', () => {
  it('splits slash-delimited server banners', () => {
    expect(splitProductVersion('nginx/1.18.0')).toEqual({ product: 'nginx', version: '1.18.0' });
    expect(splitProductVersion('Apache/2.4.52')).toEqual({ product: 'Apache', version: '2.4.52' });
  });

  it('splits space-delimited generator values', () => {
    expect(splitProductVersion('WordPress 6.4.2')).toEqual({
      product: 'WordPress',
      version: '6.4.2',
    });
  });

  it('splits colon-delimited httpx tech-detect values', () => {
    expect(splitProductVersion('WordPress:6.4.2')).toEqual({
      product: 'WordPress',
      version: '6.4.2',
    });
    expect(splitProductVersion('Elementor:3.21.5')).toEqual({
      product: 'Elementor',
      version: '3.21.5',
    });
    expect(splitProductVersion('PHP:8.1.2')).toEqual({ product: 'PHP', version: '8.1.2' });
    expect(splitProductVersion('jQuery:3.6.0')).toEqual({ product: 'jQuery', version: '3.6.0' });
  });

  it('tolerates a v prefix on the version', () => {
    expect(splitProductVersion('caddy/v2.7.6')).toEqual({ product: 'caddy', version: '2.7.6' });
  });

  it('returns the product alone when no version is advertised', () => {
    expect(splitProductVersion('Nginx')).toEqual({ product: 'Nginx' });
    expect(splitProductVersion('Cloudflare')).toEqual({ product: 'Cloudflare' });
  });

  it('does not split a separator inside the product half', () => {
    // "apache/2.4" must never be read as a product with version "52".
    expect(splitProductVersion('apache/2.4/52')).toEqual({ product: 'apache/2.4/52' });
  });

  it('returns an empty product for blank input', () => {
    expect(splitProductVersion('')).toEqual({ product: '' });
    expect(splitProductVersion('   ')).toEqual({ product: '' });
  });
});

describe('extractHttpxTechFingerprints', () => {
  it('extracts versions from a real httpx tech array', () => {
    const fingerprints = extractHttpxTechFingerprints({
      tech: ['WordPress:6.4.2', 'PHP:8.1.2', 'Nginx'],
      webserver: 'nginx/1.18.0',
    });

    const byProduct = new Map(fingerprints.map((entry) => [entry.product.toLowerCase(), entry]));

    expect(byProduct.get('wordpress')?.version).toBe('6.4.2');
    expect(byProduct.get('php')?.version).toBe('8.1.2');
    expect(byProduct.get('nginx')?.version).toBeUndefined();
  });

  it('prefers an explicit version field over the parsed token', () => {
    const [fingerprint] = extractHttpxTechFingerprints({
      technologies: [{ name: 'Elementor:3.21.5', version: '3.21.6' }],
    });

    expect(fingerprint).toMatchObject({ product: 'Elementor', version: '3.21.6' });
  });

  it('deduplicates by product', () => {
    const fingerprints = extractHttpxTechFingerprints({
      tech: ['WordPress:6.4.2', 'wordpress:6.4.2'],
    });

    expect(fingerprints).toHaveLength(1);
  });
});
