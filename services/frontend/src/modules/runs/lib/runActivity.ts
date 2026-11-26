import type { RunActivitySummary, RunPhaseTimelineEntry } from '@/modules/security-ops/types';

type RunActivityDistributionKey = string;

export interface RunActivityDistributionItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface RunActivityEndpoint {
  id: string;
  host: string;
  path: string;
  requestCount: number;
  failureCount: number;
  methods: Array<{ method: string; count: number }>;
  statusBand: '2xx' | '3xx' | '4xx' | '5xx' | 'mixed' | 'none';
}

export interface RunActivityHost {
  host: string;
  requestCount: number;
  failureCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface RunActivityViewModel {
  totals: RunActivitySummary['totals'];
  distributions: {
    statusCodes: RunActivityDistributionItem[];
    methods: RunActivityDistributionItem[];
    responseTimes: RunActivityDistributionItem[];
    contentTypes: RunActivityDistributionItem[];
  };
  timeline: RunActivitySummary['timeline'];
  topEndpoints: RunActivityEndpoint[];
  topHosts: RunActivityHost[];
  coverage: RunActivitySummary['coverage'];
  generatedAt: string;
  ui: {
    isEmpty: boolean;
    hasTimeline: boolean;
    hasEndpoints: boolean;
    hasHosts: boolean;
    hasDiscoveries: boolean;
    hasAuthSurface: boolean;
    hasPhases: boolean;
  };
  discoveries: RunActivitySummary['discoveries'];
  authSurface: RunActivitySummary['authSurface'];
  securityHeaders: RunActivitySummary['securityHeaders'];
  phases: RunPhaseTimelineEntry[];
}

const RESPONSE_TIME_LABELS: Record<RunActivityDistributionKey, string> = {
  '<100ms': '<100ms',
  lt_100ms: '<100ms',
  under_100ms: '<100ms',
  '100-500ms': '100-500ms',
  '100_500ms': '100-500ms',
  '500ms-1s': '0.5-1s',
  '500_1000ms': '0.5-1s',
  '0.5-1s': '0.5-1s',
  '1-3s': '1-3s',
  '1_3s': '1-3s',
  '3s+': '3s+',
  '3s_plus': '3s+',
  gt_3s: '3s+',
};

function roundPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizePercentage(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  return roundPercentage((count / total) * 100);
}

function normalizeDistribution(
  items: Array<{ key: string; label: string; count: number; percentage: number }>,
  options?: { labelMap?: Record<string, string> },
): RunActivityDistributionItem[] {
  const normalizedItems = items.map((item) => ({
    key: item.key,
    label: options?.labelMap?.[item.key] ?? item.label ?? item.key,
    count: Math.max(0, Number(item.count ?? 0)),
  }));
  const total = normalizedItems.reduce((sum, item) => sum + item.count, 0);

  return normalizedItems
    .map((item) => ({
      ...item,
      percentage: normalizePercentage(item.count, total),
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function compareEndpointMethods(
  left: { method: string; count: number },
  right: { method: string; count: number },
): number {
  return right.count - left.count || left.method.localeCompare(right.method);
}

function compareEndpoints(left: RunActivityEndpoint, right: RunActivityEndpoint): number {
  return (
    right.requestCount - left.requestCount ||
    right.failureCount - left.failureCount ||
    left.path.localeCompare(right.path) ||
    left.host.localeCompare(right.host)
  );
}

function compareHosts(left: RunActivityHost, right: RunActivityHost): number {
  return right.requestCount - left.requestCount || left.host.localeCompare(right.host);
}

function hasTimelineData(timeline: RunActivitySummary['timeline']): boolean {
  if (timeline.buckets.length < 2 || timeline.hosts.length === 0) {
    return false;
  }

  return timeline.buckets.some((bucket) => bucket.hosts.some((host) => host.count > 0));
}

export function toRunActivityViewModel(summary: RunActivitySummary): RunActivityViewModel {
  const topEndpoints = [...summary.topEndpoints]
    .map((endpoint) => ({
      ...endpoint,
      methods: [...endpoint.methods].sort(compareEndpointMethods),
    }))
    .sort(compareEndpoints);

  const topHosts = [...summary.topHosts].sort(compareHosts);
  const phases = summary.phases ?? [];

  return {
    totals: summary.totals,
    distributions: {
      statusCodes: normalizeDistribution(summary.distributions.statusCodes),
      methods: normalizeDistribution(summary.distributions.methods),
      responseTimes: normalizeDistribution(summary.distributions.responseTimes, {
        labelMap: RESPONSE_TIME_LABELS,
      }),
      contentTypes: normalizeDistribution(summary.distributions.contentTypes ?? []),
    },
    timeline: summary.timeline,
    topEndpoints,
    topHosts,
    coverage: summary.coverage,
    generatedAt: summary.generatedAt,
    ui: {
      isEmpty: summary.totals.requests <= 0 && phases.length === 0,
      hasTimeline: hasTimelineData(summary.timeline),
      hasEndpoints: topEndpoints.length > 0,
      hasHosts: topHosts.length > 0,
      hasDiscoveries: (summary.discoveries ?? []).length > 0,
      hasAuthSurface: (summary.authSurface ?? []).length > 0,
      hasPhases: phases.length > 0,
    },
    discoveries: summary.discoveries ?? [],
    authSurface: summary.authSurface ?? [],
    securityHeaders: summary.securityHeaders ?? { totalEndpoints: 0, missingHeaders: [] },
    phases,
  };
}

export function formatAverageDuration(durationMs: number | null): string {
  if (durationMs == null || Number.isNaN(durationMs)) {
    return '-';
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  return `${Math.round(durationMs / 1_000)}s`;
}

export function formatLastSeenLabel(iso: string | null): string {
  if (!iso) return '-';

  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
