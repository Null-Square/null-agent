import { logger } from '@/shared/logger';

export type PrometheusRangePoint = [number, string];

export type PrometheusRangeSeries = {
  metric: Record<string, string>;
  values: PrometheusRangePoint[];
};

export interface PrometheusRangeQueryClient {
  queryRange(params: {
    query: string;
    start: Date;
    end: Date;
    stepSeconds: number;
  }): Promise<PrometheusRangeSeries[]>;
}

type PrometheusQueryResponse = {
  status?: string;
  error?: string;
  data?: {
    resultType?: string;
    result?: Array<{
      metric?: Record<string, string>;
      values?: Array<[number, string]>;
    }>;
  };
};

export class PrometheusQueryClient implements PrometheusRangeQueryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly log = logger.child({ scope: 'PrometheusQueryClient' });

  constructor(params: { baseUrl: string; timeoutMs: number }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = params.timeoutMs;
  }

  async queryRange(params: {
    query: string;
    start: Date;
    end: Date;
    stepSeconds: number;
  }): Promise<PrometheusRangeSeries[]> {
    const url = new URL(`${this.baseUrl}/api/v1/query_range`);
    url.searchParams.set('query', params.query);
    url.searchParams.set('start', String(Math.floor(params.start.getTime() / 1000)));
    url.searchParams.set('end', String(Math.floor(params.end.getTime() / 1000)));
    url.searchParams.set('step', `${params.stepSeconds}s`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const body = await response.json().catch(() => ({})) as PrometheusQueryResponse;
      if (!response.ok || body.status === 'error') {
        throw new Error(body.error || `prometheus_query_failed_${response.status}`);
      }
      return (body.data?.result ?? [])
        .filter((series) => Array.isArray(series.values))
        .map((series) => ({
          metric: series.metric ?? {},
          values: series.values ?? [],
        }));
    } catch (error) {
      this.log.debug({ err: error }, 'Prometheus range query failed');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
