import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Lock, Shield } from 'lucide-react';
import {
  cn,
  PhaseTimeline,
  StatBreakdownCard,
  type PhaseTimelineStepState,
  type StatBreakdownHighlight,
  type StatBreakdownItem,
  ListEmptyState,
  ListMeta,
  ListSkeleton,
  RecordTable,
} from '@null-ai/design-tokens/ui';
import { useRunActivityQuery } from '@/modules/security-ops/api';
import {
  formatLastSeenLabel,
  toRunActivityViewModel,
  type RunActivityDistributionItem,
  type RunActivityEndpoint,
  type RunActivityHost,
  type RunActivityViewModel,
} from '../../lib/runActivity';

const STOPPED_RUN_STATUSES = new Set(['cancelled', 'failed', 'aborted', 'timed_out']);

const normalizeTerminalPhaseStatuses = (
  phases: RunActivityViewModel['phases'],
  runStatus?: string | null,
): RunActivityViewModel['phases'] => {
  if (!STOPPED_RUN_STATUSES.has(runStatus ?? '')) {
    return phases;
  }

  return phases.map((phase) =>
    phase.status === 'completed'
      ? phase
      : {
          ...phase,
          status: 'failed',
        },
  );
};

function ActivityCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(className)}>
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}


const sumItems = (items: RunActivityDistributionItem[]): number =>
  items.reduce((sum, item) => sum + item.count, 0);

/**
 * Distribution -> breakdown rows. Colour is spent only where the bucket
 * genuinely carries severity: a status band (2xx cleared, 4xx warning, 5xx
 * critical) or a response-time bucket that is slow. Everything else is bone,
 * because a method or a content type has no inherent badness.
 */
const toBreakdown = (
  items: RunActivityDistributionItem[],
  isStatus = false,
  isDuration = false,
): StatBreakdownItem[] =>
  [...items]
    .sort((a, b) => b.count - a.count)
    .map((item) => {
      let highlight: StatBreakdownHighlight = 'none';
      if (isStatus) {
        const lead = item.key.trim().charAt(0);
        if (lead === '2') highlight = 'success';
        else if (lead === '4') highlight = 'medium';
        else if (lead === '5') highlight = 'critical';
      } else if (isDuration) {
        const key = item.key.toLowerCase();
        if (key.includes('<') || key.startsWith('0')) highlight = 'success';
        else if (key.includes('>')) highlight = 'critical';
        else if (key.includes('1s')) highlight = 'medium';
      }
      return { label: item.label, count: item.count, highlight };
    });

function ActivityTimelineChart({
  timeline,
  discoveries,
}: {
  timeline: {
    buckets: Array<{ ts: string; hosts: Array<{ host: string; count: number }> }>;
    hosts: string[];
  };
  discoveries: RunActivityViewModel['discoveries'];
}) {
  const [hoveredItem, setHoveredItem] = useState<
    | { kind: 'point'; x: number; y: number; host: string; count: number; ts: string; color: string }
    | { kind: 'discovery'; x: number; y: number; discovery: RunActivityViewModel['discoveries'][number] }
    | null
  >(null);

  const width = 1000;
  const height = 240;
  const paddingTop = 34;
  const paddingRight = 16;
  const paddingBottom = 28;
  const paddingLeft = 16;
  const chartHeight = height - paddingTop - paddingBottom;
  const chartWidth = width - paddingLeft - paddingRight;

  // The validated categorical chart palette — genuinely multi-series (each host
  // is its own line, overlaid), so colour is the only thing telling them apart.
  // Fixed order, never cycled: the first four hosts take the four slots,
  // everything past that folds to bone (the dataviz series cap on black).
  const palette = ['var(--ns-series-1)', 'var(--ns-series-2)', 'var(--ns-series-3)', 'var(--ns-series-4)'];
  const foldedColor = 'rgba(245,245,247,0.5)';
  const hostColors = new Map<string, string>();
  timeline.hosts.forEach((host, index) => {
    hostColors.set(host, index < palette.length ? palette[index] : foldedColor);
  });

  const maxCount = Math.max(1, ...timeline.buckets.flatMap((bucket) => bucket.hosts.map((h) => h.count)));

  const scaleX = (index: number) =>
    timeline.buckets.length === 1
      ? paddingLeft + chartWidth / 2
      : paddingLeft + (index / (timeline.buckets.length - 1)) * chartWidth;
  const scaleY = (value: number) => paddingTop + chartHeight - (value / maxCount) * chartHeight;

  // Straight segments on the lattice — the brand draws lines this way (the
  // dashboard trajectory sparkline is a plain polyline), not smooth beziers.
  const linePoints = (host: string) =>
    timeline.buckets
      .map((bucket, index) => `${scaleX(index)},${scaleY(bucket.hosts.find((e) => e.host === host)?.count ?? 0)}`)
      .join(' ');

  const startTime = new Date(timeline.buckets[0].ts).getTime();
  const endTime = new Date(timeline.buckets[timeline.buckets.length - 1].ts).getTime();
  const totalDuration = endTime - startTime;
  const hasValidTimelineRange = Number.isFinite(startTime) && Number.isFinite(endTime);

  const discoveryMarkers = (discoveries ?? [])
    .map((discovery, index) => {
      const t = new Date(discovery.ts).getTime();
      if (!hasValidTimelineRange || !Number.isFinite(t) || t < startTime || t > endTime) return null;
      const x = paddingLeft + ((t - startTime) / Math.max(1, totalDuration)) * chartWidth;
      return { index, x, discovery };
    })
    .filter((m): m is { index: number; x: number; discovery: RunActivityViewModel['discoveries'][number] } => m !== null);

  const hoveredAlign =
    hoveredItem == null ? 'center' : hoveredItem.x <= width * 0.18 ? 'left' : hoveredItem.x >= width * 0.82 ? 'right' : 'center';
  const hTranslate = hoveredAlign === 'left' ? '0' : hoveredAlign === 'right' ? '-100%' : '-50%';
  const vTranslate =
    hoveredItem == null ? '12px' : hoveredItem.kind === 'discovery' || hoveredItem.y <= paddingTop + 24 ? '12px' : 'calc(-100% - 12px)';

  const formatClock = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <ActivityCard title="Testing Timeline" subtitle="Requests by host over time">
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[240px] w-full overflow-visible" preserveAspectRatio="none">
          {/* No gridlines. The brand's trajectory sparkline is a bare polyline
              and the playground reference omits them explicitly — a chart with
              three reference lines is a grid box drawn one line at a time. */}

          {/* Discovery markers — a thin vertical hairline with a square cap up top. */}
          {discoveryMarkers.map((m) => {
            const isVuln = m.discovery.category === 'vulnerability';
            return (
              <g key={`marker-${m.index}`}>
                <line
                  x1={m.x}
                  y1={paddingTop - 6}
                  x2={m.x}
                  y2={paddingTop + chartHeight}
                  stroke="currentColor"
                  className={isVuln ? 'text-destructive' : 'text-primary'}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.4"
                />
                <rect
                  data-testid={`run-activity-discovery-marker-${m.index}`}
                  x={m.x - 4}
                  y={paddingTop - 12}
                  width="8"
                  height="8"
                  className={cn('cursor-help', isVuln ? 'fill-destructive' : 'fill-primary')}
                  onMouseEnter={() => setHoveredItem({ kind: 'discovery', x: m.x, y: paddingTop - 10, discovery: m.discovery })}
                  onMouseLeave={() => setHoveredItem(null)}
                />
              </g>
            );
          })}

          {/* One polyline per host, plus square hover points. */}
          {timeline.hosts.map((host) => {
            const color = hostColors.get(host) ?? palette[0];
            return (
              <g key={host} className="transition-opacity">
                <polyline points={linePoints(host)} fill="none" stroke={color} strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
                {timeline.buckets.map((bucket, idx) => {
                  const entry = bucket.hosts.find((e) => e.host === host);
                  if (!entry) return null;
                  const px = scaleX(idx);
                  const py = scaleY(entry.count);
                  return (
                    <g key={`${host}-${idx}`} className="group/point">
                      <rect x={px - 3} y={py - 3} width="6" height="6" fill={color} className="opacity-0 transition-opacity group-hover/point:opacity-100" />
                      <rect
                        data-testid={`run-activity-point-${host}-${idx}`}
                        x={px - 10}
                        y={py - 10}
                        width="20"
                        height="20"
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoveredItem({ kind: 'point', x: px, y: py, host, count: entry.count, ts: bucket.ts, color })}
                        onMouseLeave={() => setHoveredItem(null)}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* Time axis + legend. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[11px] text-muted-foreground/70">
          <span className="font-mono tabular-nums">{formatClock(timeline.buckets[0].ts)}</span>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
            {timeline.hosts.slice(0, 6).map((host) => (
              <span key={host} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5" style={{ backgroundColor: hostColors.get(host) }} />
                <span className="truncate text-muted-foreground">{host}</span>
              </span>
            ))}
          </div>
          <span className="font-mono tabular-nums">{formatClock(timeline.buckets[timeline.buckets.length - 1].ts)}</span>
        </div>

        {hoveredItem ? (
          <div
            data-testid="run-activity-tooltip"
            role="tooltip"
            className="pointer-events-none absolute z-50 flex flex-col gap-1 border border-border bg-popover p-3 text-popover-foreground"
            style={{
              left: `${(hoveredItem.x / width) * 100}%`,
              top: `${(hoveredItem.y / height) * 100}%`,
              transform: `translate(${hTranslate}, ${vTranslate})`,
            }}
          >
            {hoveredItem.kind === 'discovery' ? (
              <>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'border px-1.5 py-0.5 text-xs font-medium',
                      hoveredItem.discovery.category === 'vulnerability'
                        ? 'border-destructive/30 bg-destructive/15 text-destructive'
                        : 'border-primary/30 bg-primary/15 text-primary',
                    )}
                  >
                    {hoveredItem.discovery.category}
                  </span>
                  {hoveredItem.discovery.ts ? (
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{formatClock(hoveredItem.discovery.ts)}</span>
                  ) : null}
                </div>
                <p className="max-w-[220px] text-sm leading-tight text-popover-foreground line-clamp-2">{hoveredItem.discovery.summary}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2" style={{ backgroundColor: hoveredItem.color }} />
                  <span className="max-w-[180px] truncate text-sm font-semibold text-popover-foreground">{hoveredItem.host}</span>
                </div>
                <p className="text-sm font-semibold text-popover-foreground">
                  {hoveredItem.count} request{hoveredItem.count === 1 ? '' : 's'}
                </p>
                <p className="font-mono text-xs tabular-nums text-muted-foreground">{formatClock(hoveredItem.ts)}</p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </ActivityCard>
  );
}

// Status band → the brand's outline status tag. Colour is real severity: 2xx
// cleared, 4xx a warning, 5xx critical; 3xx / mixed / none stay neutral bone.
const STATUS_BAND_TAG: Record<string, string> = {
  '2xx': 'border-success/45 text-success',
  '3xx': 'border-border text-muted-foreground',
  '4xx': 'border-medium/50 text-medium',
  '5xx': 'border-critical/50 text-critical',
  mixed: 'border-border text-muted-foreground',
  none: 'border-border text-muted-foreground',
};
const statusCodeTag = (code: number): string => {
  if (code >= 200 && code < 300) return STATUS_BAND_TAG['2xx'];
  if (code >= 500) return STATUS_BAND_TAG['5xx'];
  if (code >= 400) return STATUS_BAND_TAG['4xx'];
  return STATUS_BAND_TAG['3xx'];
};

// A method is a label, not an action — neutral mono chip, never signal yellow.
const METHOD_CHIP = 'inline-flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground';
const STATE_TAG = 'inline-flex items-center border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em]';

function TopEndpointsTable({ endpoints }: { endpoints: RunActivityEndpoint[] }) {
  return (
    <ActivityCard title="Top Endpoints">
      {endpoints.length === 0 ? (
        <ListEmptyState
          className="border-0"
          title="No endpoints recorded"
          description="Endpoint summaries will appear here as the run exercises HTTP targets."
        />
      ) : (
        <div data-testid="run-activity-endpoints">
        <RecordTable
          rows={endpoints}
          getRowKey={(endpoint) => endpoint.id}
          titleHeader="Endpoint"
          title={(endpoint) => endpoint.path}
          subtitle={(endpoint) => <span className="font-mono">{endpoint.host}</span>}
          columns={[
            {
              key: 'methods',
              header: 'Methods',
              width: 'minmax(0,0.9fr)',
              render: (endpoint) => (
                <span className="flex flex-wrap gap-1.5">
                  {endpoint.methods.map((method) => (
                    <span key={method.method} className={METHOD_CHIP}>
                      <span>{method.method}</span>
                      <span className="text-foreground">{method.count}</span>
                    </span>
                  ))}
                </span>
              ),
              showOnMobile: true,
            },
            {
              key: 'requests',
              header: 'Requests',
              width: '100px',
              mono: true,
              align: 'end',
              render: (endpoint) => endpoint.requestCount,
            },
            {
              key: 'failures',
              header: 'Failures',
              width: '100px',
              mono: true,
              align: 'end',
              render: (endpoint) => (
                <span className={endpoint.failureCount > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                  {endpoint.failureCount}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: '90px',
              align: 'end',
              render: (endpoint) => (
                <span className={cn(STATE_TAG, STATUS_BAND_TAG[endpoint.statusBand])}>{endpoint.statusBand}</span>
              ),
            },
          ]}
        />
        </div>
      )}
    </ActivityCard>
  );
}

function TopHostsPanel({ hosts }: { hosts: RunActivityHost[] }) {
  return (
    <ActivityCard title="Top Hosts">
      {hosts.length === 0 ? (
        <ListEmptyState
          className="border-0"
          title="No hosts recorded"
          description="Host summaries will appear here as the run interacts with domains or APIs."
        />
      ) : (
        <RecordTable
          rows={hosts}
          getRowKey={(host) => host.host}
          titleHeader="Host"
          title={(host) => host.host}
          subtitle={(host) => (
            <ListMeta
              items={[
                `${host.requestCount} requests`,
                host.failureCount > 0 ? `${host.failureCount} failures` : null,
              ]}
            />
          )}
          columns={[
            {
              key: 'first-seen',
              header: 'First',
              width: '130px',
              mono: true,
              align: 'end',
              render: (host) => formatLastSeenLabel(host.firstSeenAt),
            },
            {
              key: 'last-seen',
              header: 'Last',
              width: '130px',
              mono: true,
              align: 'end',
              render: (host) => formatLastSeenLabel(host.lastSeenAt),
            },
          ]}
        />
      )}
    </ActivityCard>
  );
}


// Discovery category is identity (the label carries it), so no rainbow of hues.
// A left stripe marks genuine risk — credentials and vulnerabilities red, a
// captured flag signal — everything else a neutral hairline.
const DISCOVERY_STRIPE: Record<string, string> = {
  vulnerability: 'border-l-critical',
  credential: 'border-l-critical',
  flag: 'border-l-primary',
};

function DiscoveryFeedPanel({ discoveries }: { discoveries: RunActivityViewModel['discoveries'] }) {
  return (
    <ActivityCard title="Discoveries" subtitle={`${discoveries.length} risks`}>
      {discoveries.length === 0 ? (
        <ListEmptyState
          className="border-0"
          title="No discoveries yet"
          description="When the agent identifies credentials, flags, endpoints or vulnerabilities they will appear here."
        />
      ) : (
        <div className="space-y-px">
          {discoveries.map((d) => (
            <div
              key={d.key}
              className={cn('border-l-2 bg-black py-2.5 pl-3 pr-2', DISCOVERY_STRIPE[d.category] ?? 'border-l-border')}
            >
              <p className="text-sm leading-snug text-foreground">{d.summary}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{d.category}</span>
                {d.confidence >= 0.8 ? (
                  <span className="font-mono text-[11px] tabular-nums text-success">{Math.round(d.confidence * 100)}%</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </ActivityCard>
  );
}

function AuthSurfacePanel({ authSurface }: { authSurface: RunActivityViewModel['authSurface'] }) {
  return (
    <ActivityCard title="Auth Surface" subtitle={`${authSurface.length} endpoints`}>
      {authSurface.length === 0 ? (
        <ListEmptyState
          className="border-0"
          title="No protected endpoints detected"
          description="Endpoints returning 401 or 403 responses will be tracked here."
        />
      ) : (
        <div className="divide-y divide-border/40">
          {authSurface.map((ep) => (
            <div key={`${ep.host}${ep.path}`} className="flex items-start justify-between gap-4 py-3 transition-colors hover:bg-elevated/20">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <code className="truncate font-mono text-sm text-foreground">{ep.path}</code>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{ep.host}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {ep.methods.map((m) => (
                  <span key={m} className={METHOD_CHIP}>{m}</span>
                ))}
                {ep.statusCodes.map((sc) => (
                  <span key={sc} className={cn(STATE_TAG, statusCodeTag(sc))}>{sc}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </ActivityCard>
  );
}

function SecurityHeadersPanel({ securityHeaders }: { securityHeaders: RunActivityViewModel['securityHeaders'] }) {
  const { missingHeaders, totalEndpoints } = securityHeaders;
  if (totalEndpoints === 0) {
    return (
      <ActivityCard title="Security Headers" subtitle="Header audit">
        <ListEmptyState
          className="border-0"
          title="No captured headers"
          description="Security header analysis requires captured response headers from http_payload history or proxy capture; summarized request telemetry is not counted as missing."
        />
      </ActivityCard>
    );
  }
  return (
    <ActivityCard title="Security Headers" subtitle={`${totalEndpoints} endpoints audited`}>
      <div className="divide-y divide-border/40">
        {missingHeaders.map((h) => {
          // More endpoints missing a header = worse: real severity.
          const tag =
            h.percentage >= 80 ? 'border-critical/50 text-critical'
            : h.percentage >= 40 ? 'border-medium/50 text-medium'
            : 'border-success/45 text-success';
          return (
            <div key={h.header} className="flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium text-foreground">{h.header}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className={cn(STATE_TAG, tag)}>
                  {h.missingCount}/{totalEndpoints} missing
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{h.percentage}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </ActivityCard>
  );
}

function PhaseTimelinePanel({ phases }: { phases: RunActivityViewModel['phases'] }) {
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);
  const selectedPhase = phases.find((phase) => phase.ordinal === selectedOrdinal) ?? null;

  if (phases.length === 0) {
    return (
      <ActivityCard title="Mission Progression">
        <ListEmptyState
          className="border-0"
          title="No phases yet"
          description="Phase rows are created when the planner submits an approved mission graph."
        />
      </ActivityCard>
    );
  }

  const formatDuration = (durationMs: number | null): string => {
    if (durationMs == null || durationMs < 0) return '';
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  };

  type PhaseStatus = typeof phases[number]['status'];

  // The timeline segment fill — green passed, signal running (blinks), red
  // failed, hairline still to come. Width encodes duration, so the bar is the run.
  const SEG_STYLES: Record<PhaseStatus, string> = {
    completed: 'bg-success',
    running: 'bg-primary',
    failed: 'bg-destructive',
    skipped: 'bg-border',
    pending: 'bg-border',
  };

  const LABEL_STYLES: Record<PhaseStatus, string> = {
    completed: 'text-foreground',
    running: 'text-foreground font-semibold',
    failed: 'text-foreground',
    skipped: 'text-muted-foreground/60',
    pending: 'text-muted-foreground',
  };

  // Duration is no longer encoded in width, so it moves to the drawer.
  const PHASE_STEP_STATE: Record<PhaseStatus, PhaseTimelineStepState> = {
    completed: 'pass',
    running: 'active',
    failed: 'fail',
    skipped: 'pending',
    pending: 'pending',
  };

  const STATUS_LABEL: Record<PhaseStatus, string> = {
    pending: 'Pending',
    running: 'In progress',
    completed: 'Done',
    failed: 'Stopped',
    skipped: 'Skipped',
  };

  const formatTimestamp = (value: string | null): string => {
    if (!value) return '-';
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <ActivityCard title="Mission Progression" subtitle="Select a phase for its timing and detail">
      {/* The playground's Mission Progression: equal-spaced discrete steps with
          square marks — pass green, fail red, active the blinking signal,
          pending a hollow square — joined by one flat progress rule. Chosen over
          the previous duration-weighted bar: this reads as "where the run is",
          and the per-phase duration is still one click away in the drawer. */}
      <div className="hidden lg:block">
        <PhaseTimeline
          bare
          steps={phases.map((phase) => ({
            id: String(phase.ordinal),
            label: phase.label,
            state: PHASE_STEP_STATE[phase.status],
            ariaLabel: `${phase.label} ${STATUS_LABEL[phase.status]}`,
          }))}
          activeStepId={selectedPhase ? String(selectedPhase.ordinal) : null}
          onStepClick={(step) =>
            setSelectedOrdinal((current) => (current === Number(step.id) ? null : Number(step.id)))
          }
        />
      </div>

      {/* Mobile: the same timeline turned vertical — a left rail of segments,
          labels to the right. Still one bar, no boxes. */}
      <div className="lg:hidden">
        {phases.map((phase) => (
          <button
            key={`m-phase-${phase.ordinal}`}
            type="button"
            onClick={() => setSelectedOrdinal((current) => (current === phase.ordinal ? null : phase.ordinal))}
            className="flex w-full items-stretch gap-3 py-2 text-left focus:outline-none"
          >
            <span
              className={cn('w-1 shrink-0', SEG_STYLES[phase.status])}
              style={phase.status === 'running' ? { animation: 'ns-blink 1.1s steps(1) infinite' } : undefined}
            />
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-sm', LABEL_STYLES[phase.status])}>{phase.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground/70">
                {STATUS_LABEL[phase.status]}
                {formatDuration(phase.durationMs) ? ` · ${formatDuration(phase.durationMs)}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>

      {selectedPhase ? (
        <div
          role="dialog"
          aria-label={`${selectedPhase.label} phase details`}
          className="mt-6 border border-border bg-black p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-border/40 pb-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Phase details</div>
              <div className="mt-1 text-sm font-semibold text-foreground">{selectedPhase.label}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedOrdinal(null)}
              className="border border-border/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              Close
            </button>
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Status</div>
              <div className={cn('mt-1 font-semibold', LABEL_STYLES[selectedPhase.status])}>
                {STATUS_LABEL[selectedPhase.status]}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Started</div>
              <div className="mt-1 text-foreground">{formatTimestamp(selectedPhase.startedAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Completed</div>
              <div className="mt-1 text-foreground">{formatTimestamp(selectedPhase.completedAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Duration</div>
              <div className="mt-1 font-mono tabular-nums text-foreground">{formatDuration(selectedPhase.durationMs) || '-'}</div>
            </div>
          </div>

          {selectedPhase.validationProgress ? (
            <div className="mt-3 border-l-2 border-success pl-3 text-sm text-success">
              Validation queue: {selectedPhase.validationProgress.completed}/{selectedPhase.validationProgress.total} completed, {selectedPhase.validationProgress.pending} pending
            </div>
          ) : null}
          {selectedPhase.reason ? (
            <div className="mt-3 border-l-2 border-medium pl-3 text-sm text-muted-foreground">
              Reason: {selectedPhase.reason.replaceAll('_', ' ')}
            </div>
          ) : null}
        </div>
      ) : null}
    </ActivityCard>
  );
}

function RunActivitySkeleton() {
  return (
    <div data-testid="run-activity-skeleton">
      <ListSkeleton label="Reading run activity" rows={4} />
    </div>
  );
}

function RunActivityEmptyState() {
  return (
    <div data-testid="run-activity-empty">
      <ListEmptyState
        title="No HTTP activity recorded for this run yet"
        description="Some runs may produce limited activity when only summarized request telemetry is available and sandbox proxy capture was not recorded."
      />
    </div>
  );
}

function RunActivityErrorState() {
  return (
    <ListEmptyState
      title="Activity could not be loaded"
      description="Nothing about the run was changed. Try again shortly."
    />
  );
}


export default function RunActivityDashboard({
  runId,
  isTerminal = false,
  runStatus = null,
}: {
  runId: string;
  isTerminal?: boolean;
  runStatus?: string | null;
}) {
  const { data, isLoading, isError, refetch } = useRunActivityQuery(runId, {
    refetchInterval: isTerminal ? false : 5_000,
  });

  const activity = useMemo(() => (data ? toRunActivityViewModel(data) : null), [data]);
  const phases = useMemo(
    () => normalizeTerminalPhaseStatuses(activity?.phases ?? [], runStatus),
    [activity?.phases, runStatus],
  );

  useEffect(() => {
    if (!isTerminal) return;
    if (typeof refetch !== 'function') return;
    void refetch();
  }, [isTerminal, refetch]);

  if (isLoading && !activity) {
    return <RunActivitySkeleton />;
  }

  if (isError && !activity) {
    return <RunActivityErrorState />;
  }

  if (!activity) {
    return <RunActivityEmptyState />;
  }

  if (activity.ui.isEmpty) {
    return (
      <div className="space-y-6">
        <RunActivityEmptyState />
      </div>
    );
  }

  return (
    <div data-testid="run-activity-dashboard" className="space-y-6">
      <PhaseTimelinePanel phases={phases} />

      {/* One section, not two. Each breakdown carries its own total, so the old
          metric strip's "Requests" was the same number printed a fifth time.
          Each row is a label, a track with a proportional fill, and its count. */}
      <section>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 [&>*]:border-t [&>*]:border-border md:[&>*:nth-child(-n+2)]:border-t-0 xl:[&>*]:border-t-0 xl:[&>*]:border-l xl:[&>*:first-child]:border-l-0">
          <StatBreakdownCard
            title="Status codes"
            total={sumItems(activity.distributions.statusCodes)}
            items={toBreakdown(activity.distributions.statusCodes, true)}
            className="border-0"
          />
          <StatBreakdownCard
            title="HTTP methods"
            total={sumItems(activity.distributions.methods)}
            items={toBreakdown(activity.distributions.methods)}
            className="border-0"
          />
          <StatBreakdownCard
            title="Response times"
            total={sumItems(activity.distributions.responseTimes)}
            items={toBreakdown(activity.distributions.responseTimes, false, true)}
            className="border-0"
          />
          <StatBreakdownCard
            title="Content types"
            total={sumItems(activity.distributions.contentTypes)}
            items={toBreakdown(activity.distributions.contentTypes)}
            className="border-0"
          />
        </div>
      </section>

      {/* Deep analytics — wide charts, tables and panels. Hidden on the mobile
          demo (<lg) to keep the activity tab digestible; the phase timeline,
          metric strip and distributions above remain. Full set shows from lg up. */}
      <div className="hidden space-y-6 lg:block">
        {activity.ui.hasTimeline ? (
          <ActivityTimelineChart timeline={activity.timeline} discoveries={activity.discoveries} />
        ) : (
          <ActivityCard title="Testing Timeline" subtitle="Requests by host over time">
            <ListEmptyState
          className="border-0"
              title="Not enough telemetry yet"
              description="Timeline analytics need activity across at least two buckets before a host-over-time chart can be rendered."
            />
          </ActivityCard>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <TopEndpointsTable endpoints={activity.topEndpoints} />
          <TopHostsPanel hosts={activity.topHosts} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <DiscoveryFeedPanel discoveries={activity.discoveries} />
          <AuthSurfacePanel authSurface={activity.authSurface} />
        </div>

        <SecurityHeadersPanel securityHeaders={activity.securityHeaders} />
      </div>
    </div>
  );
}


