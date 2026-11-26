export type PerformanceSummaryStatus = 'ready' | 'partial' | 'unavailable';

export type PerformanceSummarySource = 'prometheus' | 'docker_stats' | 'trace_only' | 'mixed';

export type MetricAvailability = 'available' | 'partial' | 'unavailable';

export type NumericStats = {
  samples: number;
  avg: number | null;
  max: number | null;
  p95: number | null;
  last: number | null;
};

export type SandboxLimitSnapshot = {
  cpuQuota?: number | null;
  memoryMb?: number | null;
  memoryBytes?: number | null;
  pidsLimit?: number | null;
  enforced?: boolean | null;
  source?: 'config' | 'docker' | null;
};

export type ContainerMetricCoverage = {
  cpu: boolean;
  memory: boolean;
  networkRx: boolean;
  networkTx: boolean;
  pids: boolean;
};

export type PerformanceCapacitySignals = {
  configuredMemoryBytes: number | null;
  peakMemoryBytes: number | null;
  memoryUtilizationRatio: number | null;
  configuredPidsLimit: number | null;
  peakPids: number | null;
  pidsUtilizationRatio: number | null;
  configuredCpuQuota: number | null;
  peakCpuCores: number | null;
  cpuQuotaUtilizationRatio: number | null;
};

export type ContainerPerformanceSummary = {
  containerId: string;
  name?: string | null;
  image?: string | null;
  profile?: string | null;
  kind: 'sandbox' | 'sidecar';
  scope?: 'run' | 'session' | null;
  sessionId: string;
  runId?: string | null;
  createdAt: string | null;
  destroyedAt: string | null;
  durationMs: number | null;
  limits?: SandboxLimitSnapshot | null;
  metricCoverage: ContainerMetricCoverage;
  capacity: PerformanceCapacitySignals;
  warnings: string[];
  networkRxBytesEstimatedTotal: number | null;
  networkTxBytesEstimatedTotal: number | null;
  cpuCores: NumericStats;
  memoryBytes: NumericStats;
  networkRxBytesPerSecond: NumericStats;
  networkTxBytesPerSecond: NumericStats;
  pids: NumericStats;
};

export type PerformanceTraceStats = {
  events: number;
  toolCalls: number;
  modelCalls: number;
  failures: number;
  totalTokens: number;
};

export type PerformanceWindow = {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

export type SessionPerformanceSummary = {
  schemaVersion: 1;
  subject: 'session';
  sessionId: string;
  runId?: string | null;
  generatedAt: string;
  status: PerformanceSummaryStatus;
  source: PerformanceSummarySource;
  metricStatus: MetricAvailability;
  metricUnavailableReason?: string | null;
  window: PerformanceWindow;
  trace: PerformanceTraceStats;
  containers: ContainerPerformanceSummary[];
  totals: PerformanceResourceTotals;
  capacity: PerformanceCapacitySignals;
  warnings: string[];
  missingSources: string[];
};

export type RunPerformanceSummary = {
  schemaVersion: 1;
  subject: 'run';
  runId: string;
  generatedAt: string;
  status: PerformanceSummaryStatus;
  source: PerformanceSummarySource;
  metricStatus: MetricAvailability;
  metricUnavailableReason?: string | null;
  window: PerformanceWindow;
  trace: PerformanceTraceStats & { sessions: number };
  containers: ContainerPerformanceSummary[];
  sessions: SessionPerformanceSummary[];
  totals: PerformanceResourceTotals;
  capacity: PerformanceCapacitySignals;
  warnings: string[];
  missingSources: string[];
};

export type PerformanceResourceTotals = {
  containerCount: number;
  avgCpuCores: number | null;
  maxCpuCores: number | null;
  p95CpuCores: number | null;
  maxMemoryBytes: number | null;
  p95MemoryBytes: number | null;
  maxPids: number | null;
  networkRxBytesPerSecondAvg: number | null;
  networkTxBytesPerSecondAvg: number | null;
  networkRxBytesPerSecondMax: number | null;
  networkTxBytesPerSecondMax: number | null;
  networkRxBytesEstimatedTotal: number | null;
  networkTxBytesEstimatedTotal: number | null;
};
