import { describe, expect, it } from 'vitest';

import type { ComponentVersionReadAttempts } from '@/db/schema';
import {
  ACTIVE_VERSION_READ_METHODS,
  buildVersionAcquisitionObjective,
  buildVersionReadAttempt,
  nextVersionReadMethod,
  versionReadMethodForSource,
} from '@/domains/security-ops/components/componentVersionAcquisition';

describe('component version acquisition', () => {
  it('keeps provenance separate from its concrete version-read method', () => {
    expect(versionReadMethodForSource('httpx')).toBe('http_banner');
    expect(versionReadMethodForSource('connected_site')).toBe('connected_manifest');
    expect(versionReadMethodForSource('lockfile')).toBe('dependency_manifest');
    expect(versionReadMethodForSource('scan_preview')).toBe('passive_fingerprint');
    expect(versionReadMethodForSource('agent')).toBe('agent_observation');
  });

  it('advances to the next untried active method and never retries a prior one', () => {
    const attempts: ComponentVersionReadAttempts = {
      http_banner: buildVersionReadAttempt({
        method: 'http_banner',
        source: 'agent',
        version: null,
        attemptedAt: new Date('2026-08-30T00:00:00.000Z'),
      }),
      connected_manifest: buildVersionReadAttempt({
        method: 'connected_manifest',
        source: 'connected_site',
        version: null,
        attemptedAt: new Date('2026-08-30T00:01:00.000Z'),
      }),
    };

    expect(nextVersionReadMethod(attempts)).toBe('service_probe');
    expect(
      buildVersionAcquisitionObjective({
        id: 'component-1',
        componentKey: 'cpe:nginx:nginx',
        displayName: 'nginx',
        ecosystem: 'cpe',
        versionReadAttempts: attempts,
      }),
    ).toMatchObject({
      status: 'needs_version',
      recommendedMethod: 'service_probe',
      attemptedMethods: ['http_banner'],
      remainingMethods: [
        'service_probe',
        'application_fingerprint',
        'error_behavior',
        'tls_fingerprint',
      ],
    });
  });

  it('marks the objective exhausted after every bounded method was tried', () => {
    const attempts = Object.fromEntries(
      ACTIVE_VERSION_READ_METHODS.map((method, index) => [
        method,
        buildVersionReadAttempt({
          method,
          source: 'agent',
          version: null,
          attemptedAt: new Date(Date.UTC(2026, 7, 30, 0, index)),
        }),
      ]),
    ) as ComponentVersionReadAttempts;

    expect(nextVersionReadMethod(attempts)).toBeNull();
    expect(
      buildVersionAcquisitionObjective({
        id: 'component-1',
        componentKey: 'cpe:nginx:nginx',
        displayName: 'nginx',
        ecosystem: 'cpe',
        versionReadAttempts: attempts,
      }),
    ).toMatchObject({
      status: 'exhausted',
      recommendedMethod: null,
      attemptedMethods: ACTIVE_VERSION_READ_METHODS,
      remainingMethods: [],
    });
  });
});
