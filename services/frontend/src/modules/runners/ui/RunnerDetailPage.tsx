import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import {
  Button,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailRailField,
  DetailRailNote,
  DetailSection,
  IconButton,
  ListEmptyState,
  ListSkeleton,
  RecordTable,
  RunStatusBadge,
} from '@null-ai/design-tokens/ui';
import {
  useDeleteRunnerMutation,
  useRunnerDetailQuery,
  useRotateRunnerTokenMutation,
  type Run,
} from '@/modules/security-ops/api';
import { RunnerStatusBadge } from './components/RunnerStatusBadge';
import { TimeAgo } from '@shared/ui/TimeAgo';
import { toastService } from '@shared/services/toastService';
import { useAppPaths } from '@shared/contexts/AppPathContext';

export default function RunnerDetailPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { id } = useParams<{ id: string }>();
  const { data: runner } = useRunnerDetailQuery(id ?? '');
  const rotateToken = useRotateRunnerTokenMutation();
  const deleteRunner = useDeleteRunnerMutation();

  const [rotatedCredentials, setRotatedCredentials] = useState<{ token: string; installCommand: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const handleCopyToken = async () => {
    if (rotatedCredentials?.token) {
      await navigator.clipboard.writeText(rotatedCredentials.token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
      toastService.success('Token copied', 'Connection key stored in clipboard.');
    }
  };

  const handleCopyCommand = async () => {
    if (rotatedCredentials?.installCommand) {
      await navigator.clipboard.writeText(rotatedCredentials.installCommand);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
      toastService.success('Command copied', 'Installation logic stored in clipboard.');
    }
  };

  if (!runner) {
    return (
      <DetailPageShell backLink={<DetailBackLink label="Private fleet" onClick={() => navigate(paths.runnersList)} />}>
        <ListSkeleton label="Locating runner node" rows={3} />
      </DetailPageShell>
    );
  }

  const assignedScopes = runner.scopes ?? [];
  const recentRuns: Run[] = (runner.recentRuns ?? []).map((r) => ({
    ...r,
    displayId: typeof r.displayId === 'number' ? `#r${r.displayId}` : `#r${r.id.slice(0, 4)}`,
  }));

  const healthState = runner.metadata?.healthState ?? (runner.status === 'online' ? 'healthy' : 'offline');
  const healthMessage =
    runner.metadata?.healthMessage ??
    (runner.status === 'online'
      ? 'Runner is connected and ready for scope-runner execution.'
      : 'Runner is currently offline.');
  const needsAttention = runner.status !== 'online' || healthState === 'upgrade_required';

  const handleRotate = () => {
    if (!id) return;
    if (!window.confirm('Rotating credentials generates a new secure context. Old key expires in ~30s. Proceed?')) return;
    rotateToken.mutate(id, {
      onSuccess: (data) => {
        setRotatedCredentials(data);
        toastService.success('Protocol rotated', 'New operational handshake ready.');
      },
      onError: (error) => toastService.error('Rotation refused', error instanceof Error ? error.message : 'System sync error.'),
    });
  };

  const handleDecommission = () => {
    if (!id) return;
    if (!window.confirm('Terminate this runner node? Immediate operational impact expected.')) return;
    deleteRunner.mutate(id, {
      onSuccess: () => {
        toastService.success('Node decommissioned', 'Runner successfully removed from fleet.');
        navigate(paths.runnersList);
      },
      onError: (error) => {
        toastService.error('Termination failed', error instanceof Error ? error.message : 'Fleet registry error.');
      },
    });
  };

  return (
    <DetailPageShell
      backLink={<DetailBackLink label="Private fleet" onClick={() => navigate(paths.runnersList)} />}
      displayId={`Node ${runner.id.slice(0, 8)}`}
      rail={
        <>
          {/* Conditional in-flight/attention block, driven by state the page
              already holds — the rail's first zone in the skeleton. */}
          {needsAttention ? (
            <DetailRailNote
              tone="warning"
              title={healthState === 'upgrade_required' ? 'Upgrade required' : 'Runner offline'}
            >
              {healthMessage}
            </DetailRailNote>
          ) : null}

          <DetailRailBlock label="Workflow">
            <DetailRailField label="State">
              <RunnerStatusBadge status={runner.status} healthState={runner.metadata?.healthState} />
            </DetailRailField>
            <DetailRailField label="Last heartbeat">
              <span className="font-mono text-[13px] text-foreground">
                <TimeAgo date={runner.lastHeartbeatAt} />
              </span>
            </DetailRailField>

            <Button className="w-full" onClick={handleRotate} loading={rotateToken.isPending}>
              {rotateToken.isPending ? 'Renewing…' : 'Rotate protocol'}
            </Button>
            <Button
              variant="outline"
              className="w-full text-destructive hover:border-destructive/50"
              onClick={handleDecommission}
              disabled={!id}
              loading={deleteRunner.isPending}
            >
              Decommission
            </Button>

            <DetailRailNote title="Rotation guidance">
              Rotating issues a new runner token and expires the old one after roughly 30 seconds. The node must be
              restarted with the new credentials.
            </DetailRailNote>
          </DetailRailBlock>
        </>
      }
    >
      <DetailHeader
        title={runner.name}
        badges={<RunnerStatusBadge status={runner.status} healthState={runner.metadata?.healthState} />}
        subline={[
          <span key="ip" className="font-mono">{runner.ipAddress || 'Unresolved'}</span>,
          <span key="platform">{runner.platform || 'Unknown platform'}</span>,
          <span key="scopes">{assignedScopes.length} scopes assigned</span>,
        ]}
      />

      <div className="mt-10 flex flex-col gap-10">
        {rotatedCredentials ? (
          <DetailSection
            label="New credentials"
            action={
              <Button variant="ghost" size="sm" onClick={() => setRotatedCredentials(null)}>
                Dismiss
              </Button>
            }
          >
            <p className="mb-5 text-sm text-muted-foreground">
              Credentials initialised. Treat this securely — the token is shown once and redacted when you leave.
            </p>
            <div className="flex flex-col gap-4">
              <CredentialLine
                label="Runner token"
                value={rotatedCredentials.token}
                copied={copiedToken}
                onCopy={handleCopyToken}
              />
              <CredentialLine
                label="Docker bootstrap"
                value={rotatedCredentials.installCommand}
                copied={copiedCommand}
                onCopy={handleCopyCommand}
              />
            </div>
          </DetailSection>
        ) : null}

        <DetailSection label="Infrastructure allocation">
          {assignedScopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scopes allocated to this node.</p>
          ) : (
            <RecordTable
              rows={assignedScopes}
              getRowKey={(scope) => scope.id}
              titleHeader="Scope"
              title={(scope) => scope.name}
              rowActionLabel={(scope) => `Open scope: ${scope.name}`}
              onRowClick={(scope) => navigate(paths.scopeDetail(scope.id))}
              columns={[]}
            />
          )}
        </DetailSection>

        <DetailSection label="Operational history">
          {recentRuns.length === 0 ? (
            <ListEmptyState icon="runs" title="No operational history" description="This node has not executed an assessment yet." />
          ) : (
            <RecordTable
              rows={recentRuns.slice(0, 10)}
              getRowKey={(run) => run.id}
              titleHeader="Assessment"
              title={(run) => run.title ?? 'Ad-hoc assessment'}
              subtitle={(run) => run.goal}
              rowActionLabel={(run) => `Open assessment ${run.displayId}`}
              onRowClick={(run) => navigate(paths.runDetail(run.id))}
              columns={[
                {
                  key: 'id',
                  header: 'ID',
                  width: '120px',
                  mono: true,
                  render: (run) => run.displayId,
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '150px',
                  render: (run) => <RunStatusBadge status={run.status} />,
                  showOnMobile: true,
                },
                {
                  key: 'started',
                  header: 'Started',
                  width: '140px',
                  mono: true,
                  align: 'end',
                  render: (run) => <TimeAgo date={run.startedAt} />,
                },
              ]}
            />
          )}
        </DetailSection>
      </div>
    </DetailPageShell>
  );
}

function CredentialLine({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 truncate border border-border bg-background px-4 py-3 font-mono text-xs text-foreground">
          {value}
        </code>
        <IconButton aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy}>
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
}
