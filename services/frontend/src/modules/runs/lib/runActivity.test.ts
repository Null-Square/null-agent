import { describe, expect, it } from 'vitest';
import type { RunActivitySummary } from '@/modules/security-ops/types';
import { toRunActivityViewModel } from './runActivity';

function buildSummary(overrides: Partial<RunActivitySummary> = {}): RunActivitySummary {
  return {
    totals: {
      requests: 6,
      uniqueHosts: 2,
      uniqueEndpoints: 3,
      failures: 2,
      blockedActions: 0,
      averageDurationMs: 640,
      ...(overrides.totals ?? {}),
    },
    distributions: {
      statusCodes: [
        { key: '4xx', label: '4xx', count: 2, percentage: 0 },
        { key: '2xx', label: '2xx', count: 4, percentage: 0 },
      ],
      methods: [
        { key: 'POST', label: 'POST', count: 1, percentage: 0 },
        { key: 'GET', label: 'GET', count: 5, percentage: 0 },
      ],
      responseTimes: [
        { key: '500_1000ms', label: '500_1000ms', count: 3, percentage: 0 },
        { key: 'lt_100ms', label: 'lt_100ms', count: 3, percentage: 0 },
      ],
      contentTypes: [],
      ...(overrides.distributions ?? {}),
    },
    timeline: {
      buckets: [
        {
          ts: '2026-04-02T10:00:00.000Z',
          hosts: [{ host: 'api.example.com', count: 2 }],
        },
        {
          ts: '2026-04-02T10:05:00.000Z',
          hosts: [{ host: 'api.example.com', count: 4 }],
        },
      ],
      hosts: ['api.example.com'],
      ...(overrides.timeline ?? {}),
    },
    topEndpoints: [
      {
        id: 'ep-z',
        host: 'api.example.com',
        path: '/zeta',
        requestCount: 10,
        failureCount: 1,
        methods: [
          { method: 'POST', count: 1 },
          { method: 'GET', count: 9 },
        ],
        statusBand: '2xx',
      },
      {
        id: 'ep-a',
        host: 'api.example.com',
        path: '/alpha',
        requestCount: 10,
        failureCount: 2,
        methods: [{ method: 'GET', count: 10 }],
        statusBand: '4xx',
      },
      {
        id: 'ep-b',
        host: 'api.example.com',
        path: '/beta',
        requestCount: 12,
        failureCount: 0,
        methods: [{ method: 'GET', count: 12 }],
        statusBand: '2xx',
      },
      ...(overrides.topEndpoints ?? []),
    ],
    topHosts: [
      {
        host: 'z.example.com',
        requestCount: 8,
        failureCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
      },
      {
        host: 'a.example.com',
        requestCount: 8,
        failureCount: 1,
        firstSeenAt: null,
        lastSeenAt: null,
      },
      ...(overrides.topHosts ?? []),
    ],
    discoveries: [],
    authSurface: [],
    securityHeaders: { totalEndpoints: 0, missingHeaders: [] },
    coverage: {
      source: 'action.summary',
      limitations: [
        'Coverage combines action.summary telemetry with http_payload history and sandbox proxy capture when available.',
      ],
      ...(overrides.coverage ?? {}),
    },
    phases: [],
    generatedAt: '2026-04-02T10:10:00.000Z',
    ...overrides,
  };
}

describe('toRunActivityViewModel', () => {
  it('recomputes distribution percentages from counts', () => {
    const model = toRunActivityViewModel(buildSummary());

    expect(model.distributions.statusCodes).toEqual([
      expect.objectContaining({ key: '2xx', percentage: 66.7 }),
      expect.objectContaining({ key: '4xx', percentage: 33.3 }),
    ]);
  });

  it('maps response time keys to presentation labels', () => {
    const model = toRunActivityViewModel(buildSummary());

    expect(model.distributions.responseTimes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '500_1000ms', label: '0.5-1s' }),
      expect.objectContaining({ key: 'lt_100ms', label: '<100ms' }),
    ]));
  });

  it('sorts endpoints and hosts deterministically for rendering', () => {
    const model = toRunActivityViewModel(buildSummary());

    expect(model.topEndpoints.map((endpoint) => endpoint.path)).toEqual([
      '/beta',
      '/alpha',
      '/zeta',
    ]);
    expect(model.topEndpoints[2].methods.map((method) => method.method)).toEqual(['GET', 'POST']);
    expect(model.topHosts.map((host) => host.host)).toEqual(['a.example.com', 'z.example.com']);
  });
});
