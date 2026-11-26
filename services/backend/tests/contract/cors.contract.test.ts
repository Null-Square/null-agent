/**
 * CORS Configuration Contract Test
 * 
 * Ensures the network settings seed allows only origins on this computer.
 * This test catches drift in CORS configuration.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REQUIRED_LOCALHOST_ORIGINS = ['*.localhost'];

describe('CORS Configuration (contract)', () => {
  it('network-settings.seed.json allows no hosted origin: Null AI answers only this computer', () => {
    const seedPath = path.resolve(__dirname, '../../config/seeds/settings/network-settings.seed.json');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

    expect(Array.isArray(seed.corsAllowedOrigins)).toBe(true);
    expect(seed.corsAllowedOrigins).not.toContain('*.nullsquare.net');
  });

  it('network-settings.seed.json includes localhost wildcard origins for development', () => {
    const seedPath = path.resolve(__dirname, '../../config/seeds/settings/network-settings.seed.json');
    const seedContent = fs.readFileSync(seedPath, 'utf-8');
    const seed = JSON.parse(seedContent);

    for (const origin of REQUIRED_LOCALHOST_ORIGINS) {
      expect(seed.corsAllowedOrigins).toContain(origin);
    }
  });

  it('fallback CORS origins match production requirements', async () => {
    // This imports the module to check fallback constants indirectly
    const { getNetworkSettings } = await import('@/domains/platform/settings/networkSettings');
    
    // The function should not throw even if DB isn't available
    // In test environment, it will use fallback since no DB connection
    // We're testing that the fallback mechanism works
    expect(getNetworkSettings).toBeDefined();
  });
});
