import {
  useAutomationDetailQuery,
  useDeleteAutomationMutation,
  useRunAutomationNowMutation,
  useToggleAutomationMutation
} from '@/modules/security-ops/api';
import { COMPLIANCE_FRAMEWORK_SHORT_LABELS } from '@/modules/security-ops/complianceFrameworks';
import { getModelEffortLabel, useAvailableModelsQuery } from '@/modules/sessions/api';
import {
  Button,
  cn,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailRailField,
  DetailRailNote,
  DetailSection,
  ListEmptyState,
  ListSkeleton,
  RecordTable,
  StatusPill,
  RunStatusBadge,
} from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { toApiError } from '@shared/lib/apiError';
import { ExecutionTargetIndicator } from '@shared/ui/ExecutionTargetIndicator';
import { TimeAgo } from '@shared/ui/TimeAgo';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toastService } from '@shared/services/toastService';
import AutomationFormModal from './components/AutomationFormModal';

/**
 * AutomationDetailPage — Detailed configuration manifest and historical execution data.
 */
export default function AutomationDetailPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { id } = useParams<{ id: string }>();
  const { data: automation, isLoading } = useAutomationDetailQuery(id ?? '');
  const { data: availableModels = [] } = useAvailableModelsQuery();

  const runNow = useRunAutomationNowMutation();
  const toggleAutomation = useToggleAutomationMutation();
  const deleteAutomation = useDeleteAutomationMutation();
  
  const [showEdit, setShowEdit] = useState(false);

  const modelLabel = useMemo(() => {
    if (!automation?.modelCategory) return 'Default';
    const selectedModel = availableModels.find((model) => model.id === automation.modelCategory);
    return selectedModel ? getModelEffortLabel(selectedModel) : 'Unavailable';
  }, [automation?.modelCategory, availableModels]);
  const agentPathLabel = useMemo(() => {
    if (automation?.workflowDiscipline !== 'compliance') return 'Pentest';
    const frameworkLabel = automation.complianceFrameworkKey
      ? COMPLIANCE_FRAMEWORK_SHORT_LABELS[automation.complianceFrameworkKey]
      : null;
    return frameworkLabel ? `Compliance - ${frameworkLabel}` : 'Compliance';
  }, [automation?.complianceFrameworkKey, automation?.workflowDiscipline]);

  const backLink = <DetailBackLink label="Automations" onClick={() => navigate(paths.automationsList)} />;

  if (isLoading) {
    return (
      <DetailPageShell backLink={backLink}>
        <ListSkeleton label="Reading this automation" rows={3} />
      </DetailPageShell>
    );
  }

  if (!automation) {
    return (
      <DetailPageShell backLink={backLink}>
        <ListEmptyState icon="automations" title="Automation not found" description="It may have been decommissioned." />
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell
      backLink={backLink}
      displayId={automation.id.slice(0, 8)}
      rail={
        <>
          <DetailRailBlock label="Workflow">
            <DetailRailField label="State">
              <StatusPill tone={automation.isActive ? 'signal' : 'neutral'} pulse={automation.isActive}>
                {automation.isActive ? 'Active' : 'Paused'}
              </StatusPill>
            </DetailRailField>
            <DetailRailField label="Next run">
              <span className="font-mono text-[13px] text-foreground">
                {automation.deferredAt ? 'Deferred' : automation.nextRunAt ? <TimeAgo date={automation.nextRunAt} /> : 'Event managed'}
              </span>
            </DetailRailField>

            <Button
              className="w-full"
              onClick={() => {
                runNow.mutate(automation.id, {
                  onSuccess: () => toastService.success('Execution triggered successfully'),
                  onError: (error) => {
                    const apiError = toApiError(error);
                    toastService.error(apiError.userMessage ?? apiError.message ?? 'Trigger failed');
                  },
                });
              }}
            >
              Run now
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                toggleAutomation.mutate(automation.id, {
                  onSuccess: () => toastService.success(automation.isActive ? 'Automation paused' : 'Automation resumed'),
                  onError: () => toastService.error('Toggle failed'),
                });
              }}
            >
              {automation.isActive ? 'Pause' : 'Resume'}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setShowEdit(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              className="w-full text-destructive"
              onClick={() => {
                deleteAutomation.mutate(automation.id, {
                  onSuccess: () => {
                    toastService.success('Automation decommissioned');
                    navigate(paths.automationsList);
                  },
                  onError: () => toastService.error('Termination failed'),
                });
              }}
            >
              Delete
            </Button>
          </DetailRailBlock>

          <DetailRailBlock label="Trigger">
            <div data-tour="automation-schedule" className="flex flex-col gap-3">
              <RailFact label="Type" value={automation.triggerType} mono />
              {automation.triggerConfig.type === 'scheduled' && 'cron' in automation.triggerConfig ? (
                <RailFact label="Cron pattern" value={automation.triggerConfig.cron} mono />
              ) : null}
              {automation.triggerConfig.type === 'continuous' ? (
                <RailFact label="Interval" value={`${automation.triggerConfig.intervalMinutes}m`} mono />
              ) : null}
              <RailFact label="Last run" value={<TimeAgo date={automation.lastRunAt} />} mono />
              {automation.deferredAt ? (
                <RailFact label="Deferred since" value={<TimeAgo date={automation.deferredAt} />} mono />
              ) : null}
            </div>
          </DetailRailBlock>

          <DetailRailNote title="Reliability">
            Automated triggers are managed by the resilient task scheduler. Runner-targeted automations defer
            automatically while their pinned runner is offline.
          </DetailRailNote>
        </>
      }
    >
      <DetailHeader
        title={automation.name}
        badges={
          <StatusPill tone={automation.isActive ? 'signal' : 'neutral'} pulse={automation.isActive}>
            {automation.isActive ? 'Active' : 'Paused'}
          </StatusPill>
        }
        subline={[
          <Link key="scope" to={paths.scopeDetail(automation.scopeId)} className="underline decoration-border underline-offset-4 hover:decoration-foreground">
            {automation.scopeName}
          </Link>,
          <span key="path">{agentPathLabel}</span>,
          <span key="model">{modelLabel}</span>,
        ]}
      />

      <div className="mt-10 flex flex-col gap-10">
        <DetailSection label="Strategic goal">{automation.goal}</DetailSection>

        <DetailSection label="Execution">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Target</span>
              <ExecutionTargetIndicator target={automation.executionTarget} size="md" />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Deferred state</span>
              <span className="text-[15px] text-foreground">
                {automation.deferredReason ? automation.deferredReason.replace(/_/g, ' ') : 'Ready'}
              </span>
            </div>
          </div>
        </DetailSection>

        <DetailSection label="Execution history">
          <div data-tour="automation-history">
            {automation.runs.length === 0 ? (
              <ListEmptyState
                className="border-0"
                icon="runs"
                title="No executions yet"
                description="This automation has not triggered a run."
              />
            ) : (
              <RecordTable
                rows={automation.runs}
                getRowKey={(run) => run.runId}
                titleHeader="Execution"
                title={(run) =>
                  typeof run.runDisplayId === 'number' ? `#r${run.runDisplayId}` : run.runId.slice(0, 8).toUpperCase()
                }
                subtitle={(run) => run.triggerReason ?? 'System trigger'}
                rowActionLabel={(run) => `Open execution ${run.runId.slice(0, 8)}`}
                onRowClick={(run) => navigate(paths.runDetail(run.runId))}
                columns={[
                  {
                    key: 'status',
                    header: 'Status',
                    width: '150px',
                    render: (run) => <RunStatusBadge status={run.runStatus} />,
                    showOnMobile: true,
                  },
                  {
                    key: 'triggered',
                    header: 'Triggered',
                    width: '150px',
                    mono: true,
                    align: 'end',
                    render: (run) => <TimeAgo date={run.triggeredAt} />,
                  },
                ]}
              />
            )}
          </div>
        </DetailSection>
      </div>

      <AutomationFormModal open={showEdit} automation={automation} onClose={() => setShowEdit(false)} />
    </DetailPageShell>
  );
}

function RailFact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 pb-3 last:border-b-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-[13px] text-foreground', mono && 'font-mono')}>{value}</span>
    </div>
  );
}
