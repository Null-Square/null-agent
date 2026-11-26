import { useState } from 'react';
import { useAuditLogsQuery } from '@/modules/security-ops/api';
import SettingsLayout from './SettingsLayout';
import {
  Button,
  ErrorNotice,
  Input,
  ListEmptyState,
  ListSkeleton,
  NativeSelect,
  QueryBar,
  RecordTable,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@null-ai/design-tokens/ui';
import { FileText } from 'lucide-react';
import { format } from 'date-fns';
import type { AuditLog } from '@/modules/security-ops/types';

/**
 * The audit log, on the three bands.
 *
 * It was half-migrated: `QueryBar` above the legacy `DataTable`, inside a
 * bordered box. `RecordTable` is the one data table, and it draws its own
 * seams — the wrapping `border border-border` was a box around a table that
 * already knows where its edges are.
 *
 * **No `ListMetrics` here, deliberately.** The three-band rule wants a figure
 * strip, but the query returns one page of rows — 20 to 500, whatever `limit`
 * says — not an aggregate. "Events: 50" derived from that slice would be the
 * page size wearing a total's clothes, and a wrong number in a mini dashboard
 * is worse than no dashboard. It earns a strip when the endpoint returns counts.
 */
export default function SettingsAuditLogs() {
  const [limit, setLimit] = useState(50);
  const [actionFilter, setActionFilter] = useState('');
  const [resourceTypeFilter, setResourceTypeFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const fromIso = fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined;
  const toIso = toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined;

  const { data: logs, isLoading, error, refetch } = useAuditLogsQuery({
    limit,
    action: actionFilter || undefined,
    resourceType: resourceTypeFilter || undefined,
    from: fromIso,
    to: toIso,
  });

  const rows = logs ?? [];
  const narrowed = Boolean(actionFilter || resourceTypeFilter || fromDate || toDate);

  const clearFilters = () => {
    setActionFilter('');
    setResourceTypeFilter('');
    setFromDate('');
    setToDate('');
  };

  return (
    <SettingsLayout
      title="Audit log"
      description="Track and monitor sensitive actions performed within the organization."
    >
      {/* The one filter bar, not a boxed grid of mono micro-labels: a field
          label is chrome, and this page had six of them shouting. */}
      <QueryBar
        search={actionFilter}
        onSearchChange={setActionFilter}
        searchPlaceholder="Search actions — e.g. create_scope"
        aria-label="Filter audit log"
        facets={
          <>
            <Input
              aria-label="Resource type"
              placeholder="Resource type"
              value={resourceTypeFilter}
              onChange={(e) => setResourceTypeFilter(e.target.value)}
              className="h-[46px]"
            />
            <Input
              aria-label="From date"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-[46px]"
            />
            <Input
              aria-label="To date"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-[46px]"
            />
            <NativeSelect
              aria-label="Rows"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-[46px]"
            >
              <option value={20}>20 rows</option>
              <option value={50}>50 rows</option>
              <option value={100}>100 rows</option>
              <option value={500}>500 rows</option>
            </NativeSelect>
          </>
        }
      />

      {error ? (
        <ErrorNotice
          className="mt-10"
          label="Audit log"
          title="Could not load the audit log"
          description={(error as Error).message}
          actionLabel="Try again"
          onAction={() => void refetch()}
        />
      ) : isLoading ? (
        <ListSkeleton className="mt-10" label="Reading the audit log" />
      ) : rows.length === 0 ? (
        <ListEmptyState
          className="mt-10"
          variant={narrowed ? 'filtered' : 'empty'}
          icon="activity"
          title={narrowed ? 'No record matches this query' : 'No audited actions yet'}
          onClear={narrowed ? clearFilters : undefined}
        />
      ) : (
        <RecordTable<AuditLog>
          className="mt-10"
          rows={rows}
          getRowKey={(log) => log.id}
          onRowClick={setSelectedLog}
          rowActionLabel={(log) => `Open audit record ${log.action}`}
          titleHeader="Action"
          title={(log) => log.action}
          subtitle={(log) => log.resourceType}
          columns={[
            {
              key: 'createdAt',
              header: 'When',
              width: '180px',
              mono: true,
              showOnMobile: true,
              render: (log) => format(new Date(log.createdAt), 'MMM d, HH:mm:ss'),
            },
            {
              key: 'actor',
              header: 'Actor',
              width: '150px',
              mono: true,
              render: (log) => (log.actorType === 'system' ? 'system' : log.actorId.slice(0, 8)),
            },
            {
              key: 'resourceId',
              header: 'Resource',
              mono: true,
              render: (log) => log.resourceId,
            },
          ]}
          actions={() => (
            <Button variant="ghost" size="sm" aria-hidden tabIndex={-1}>
              <FileText className="h-3.5 w-3.5" />
            </Button>
          )}
        />
      )}

      <Sheet open={!!selectedLog} onOpenChange={() => setSelectedLog(null)}>
        <SheetContent className="flex w-full flex-col gap-0 border-l border-border bg-background p-0 sm:w-[600px] sm:max-w-none">
          <SheetHeader className="border-b border-border p-6">
            <SheetTitle className="text-xl font-bold tracking-tight text-foreground">
              Audit record
            </SheetTitle>
            <SheetDescription className="font-mono text-xs text-muted-foreground">
              ID: {selectedLog?.id}
            </SheetDescription>
          </SheetHeader>

          {selectedLog && (
            <div className="flex-1 space-y-8 overflow-y-auto p-6">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Recorded at
                  </span>
                  <p className="font-mono text-sm text-foreground">
                    {format(new Date(selectedLog.createdAt), 'yyyy-MM-dd HH:mm:ss.SSS')}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Action performed
                  </span>
                  <p className="font-mono text-sm text-foreground">{selectedLog.action}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Actor ({selectedLog.actorType})
                  </span>
                  <p className="break-all font-mono text-xs text-foreground">{selectedLog.actorId}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Resource ({selectedLog.resourceType})
                  </span>
                  <p className="break-all font-mono text-xs text-foreground" title={selectedLog.resourceId ?? undefined}>
                    {selectedLog.resourceId}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <span className="block w-full border-b border-border pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Change payload
                </span>
                {selectedLog.changes && Object.keys(selectedLog.changes).length > 0 ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap border border-border bg-surface-inset p-4 font-mono text-[10px] text-foreground">
                    {JSON.stringify(selectedLog.changes, null, 2)}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">No state changes recorded.</p>
                )}
              </div>

              <div className="space-y-2">
                <span className="block w-full border-b border-border pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Metadata
                </span>
                {selectedLog.metadata && Object.keys(selectedLog.metadata).length > 0 ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap border border-border bg-surface-inset p-4 font-mono text-[10px] text-foreground">
                    {JSON.stringify(selectedLog.metadata, null, 2)}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">No metadata available.</p>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </SettingsLayout>
  );
}
