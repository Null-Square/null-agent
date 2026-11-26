import { useAuth } from '@/modules/auth';
import {
  useAutomationsQuery,
  useDeleteAutomationMutation,
  useOrganizationMembersQuery,
  useRunAutomationNowMutation,
  useToggleAutomationMutation,
} from '@/modules/security-ops/api';
import type { Automation } from '@/modules/security-ops/types';
import { COMPLIANCE_FRAMEWORK_SHORT_LABELS } from '@/modules/security-ops/complianceFrameworks';
import SettingsLayout from '@/modules/settings/ui/SettingsLayout';
import {
  AlertDialog,
  Button,
  FacetSelect,
  IconButton,
  ListEmptyState,
  ListMeta,
  ListMetrics,
  QueryBar,
  RecordTable,
  StatusPill,
} from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import { toApiError } from '@shared/lib/apiError';
import { TimeAgo } from '@shared/ui/TimeAgo';
import { Edit2, Pause, Play, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toastService } from '@shared/services/toastService';
import AutomationFormModal from './components/AutomationFormModal';

type StateFilter = 'all' | 'active' | 'paused';
type TriggerFilter = 'all' | 'scheduled' | 'event';

/**
 * AutomationsPage — Operationalize continuous coverage with scheduled and event-driven autonomous runs.
 */
export default function AutomationsPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { data: automations } = useAutomationsQuery();
  const { activeScopeId } = useScope();
  const { user } = useAuth();
  const { data: members } = useOrganizationMembersQuery({ enabled: true });
  const currentMember = members?.find((member) => member.userId === user?.id);
  const currentRole = currentMember?.role ?? user?.role;
  const canManageAutomations = currentRole === 'admin' || currentRole === 'lead' || currentRole === 'owner';

  const visibleAutomations = useMemo(
    () =>
      activeScopeId
        ? (automations ?? []).filter((automation) => automation.scopeId === activeScopeId)
        : [],
    [activeScopeId, automations],
  );

  const toggleAutomation = useToggleAutomationMutation();
  const runNow = useRunAutomationNowMutation();
  const deleteAutomation = useDeleteAutomationMutation();
  const [showCreate, setShowCreate] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  const [automationToDelete, setAutomationToDelete] = useState<Automation | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');

  const activeCount = visibleAutomations.filter((automation) => automation.isActive).length;
  const scheduledCount = visibleAutomations.filter((automation) => automation.triggerType === 'scheduled').length;

  const filteredAutomations = useMemo(() => visibleAutomations.filter((automation) => {
    if (stateFilter === 'active' && !automation.isActive) return false;
    if (stateFilter === 'paused' && automation.isActive) return false;
    if (triggerFilter !== 'all' && automation.triggerType !== triggerFilter) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [automation.name, automation.scopeName].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  }), [search, stateFilter, triggerFilter, visibleAutomations]);

  const hasQuery = Boolean(search.trim()) || stateFilter !== 'all' || triggerFilter !== 'all';

  return (
    <SettingsLayout
      title="Automations"
      description="Operationalize continuous coverage with scheduled and event-driven autonomous runs."
      actions={
        canManageAutomations ? (
          <Button
            data-tour="automation-new"
            onClick={() => {
              setShowCreate(true);
            }}
          >
            New automation
          </Button>
        ) : null
      }
    >
      <div className="space-y-6">
        <ListMetrics
          label="Automation coverage"
          items={[
            { label: 'Automations', value: visibleAutomations.length },
            { label: 'Active', value: activeCount, severity: 'signal' },
            { label: 'Paused', value: visibleAutomations.length - activeCount },
            { label: 'Scheduled', value: scheduledCount },
          ]}
        />

        <QueryBar
          aria-label="Filter automations"
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search automations"
          facets={
            <>
              <FacetSelect
                aria-label="Filter by state"
                label="All states"
                value={stateFilter}
                onChange={(value) => setStateFilter(value as StateFilter)}
                options={[
                  { value: 'all', label: 'All states', count: visibleAutomations.length },
                  { value: 'active', label: 'Active', count: activeCount, swatchClass: 'bg-primary' },
                  { value: 'paused', label: 'Paused', count: visibleAutomations.length - activeCount },
                ]}
              />
              <FacetSelect
                aria-label="Filter by trigger"
                label="All triggers"
                value={triggerFilter}
                onChange={(value) => setTriggerFilter(value as TriggerFilter)}
                options={[
                  { value: 'all', label: 'All triggers', count: visibleAutomations.length },
                  { value: 'scheduled', label: 'Scheduled', count: scheduledCount },
                  { value: 'event', label: 'Event', count: visibleAutomations.length - scheduledCount },
                ]}
              />
            </>
          }
        />

        {filteredAutomations.length === 0 ? (
          <ListEmptyState
            variant={hasQuery ? 'filtered' : 'empty'}
            icon={hasQuery ? 'search' : 'automations'}
            title={hasQuery ? 'No automations match this query' : 'No automations for this scope'}
            description={
              hasQuery
                ? `Your filters narrow ${visibleAutomations.length} automations down to none.`
                : 'An automation runs an assessment on a schedule or when something changes.'
            }
            onClear={
              hasQuery
                ? () => {
                    setSearch('');
                    setStateFilter('all');
                    setTriggerFilter('all');
                  }
                : undefined
            }
          />
        ) : (
          <RecordTable
            rows={filteredAutomations}
            getRowKey={(automation) => automation.id}
            titleHeader="Automation"
            titleWidth="minmax(0,1.6fr)"
            title={(automation) => automation.name}
            subtitle={(automation) => (
              <ListMeta
                items={[
                  automation.scopeName,
                  automation.workflowDiscipline === 'compliance'
                    ? `Compliance ${automation.complianceFrameworkKey ? COMPLIANCE_FRAMEWORK_SHORT_LABELS[automation.complianceFrameworkKey] : ''}`.trim()
                    : 'Pentest',
                  automation.triggerType,
                ]}
              />
            )}
            rowActionLabel={(automation) => `Open automation: ${automation.name}`}
            rowAttributes={(automation) => ({ 'data-tour': `automation-row-${automation.id}` })}
            onRowClick={(automation) => navigate(paths.automationDetail(automation.id))}
            columns={[
              {
                key: 'state',
                header: 'State',
                width: '130px',
                render: (automation) => (
                  <StatusPill tone={automation.isActive ? 'signal' : 'neutral'} pulse={automation.isActive}>
                    {automation.isActive ? 'Active' : 'Paused'}
                  </StatusPill>
                ),
                showOnMobile: true,
              },
              {
                key: 'last-run',
                header: 'Last run',
                width: '150px',
                mono: true,
                align: 'end',
                render: (automation) => <TimeAgo date={automation.lastRunAt} />,
              },
            ]}
            actions={(automation) =>
              !canManageAutomations ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Read only</span>
              ) : (
                <>
                  <IconButton
                    aria-label={`Trigger ${automation.name}`}
                    title="Trigger manually"
                    onClick={() => {
                      runNow.mutate(automation.id, {
                        onSuccess: () => toastService.success('Automation run triggered'),
                        onError: (error) => {
                          const apiError = toApiError(error);
                          toastService.error(apiError.userMessage ?? apiError.message ?? 'Trigger failed');
                        },
                      });
                    }}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    aria-label={automation.isActive ? `Pause ${automation.name}` : `Resume ${automation.name}`}
                    title={automation.isActive ? 'Pause' : 'Resume'}
                    onClick={() => {
                      toggleAutomation.mutate(automation.id, {
                        onError: () => toastService.error('Toggle failed'),
                      });
                    }}
                  >
                    {automation.isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton
                    aria-label={`Edit ${automation.name}`}
                    title="Edit configuration"
                    onClick={() => {
                      setEditingAutomation(automation);
                    }}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    aria-label={`Decommission ${automation.name}`}
                    title="Decommission"
                    onClick={() => {
                      setAutomationToDelete(automation);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </>
              )
            }
          />
        )}
      </div>

      <AutomationFormModal open={showCreate} onClose={() => setShowCreate(false)} />
      <AutomationFormModal open={Boolean(editingAutomation)} automation={editingAutomation} onClose={() => setEditingAutomation(null)} />
      
      <AlertDialog
        isOpen={Boolean(automationToDelete)}
        title="DECOMMISSION AUTOMATION"
        description={`Are you sure you want to permanently remove "${automationToDelete?.name}"? Scheduled actions will cease immediately.`}
        confirmLabel="DECOMMISSION"
        variant="danger"
        onConfirm={() => {
            if (automationToDelete) {
                deleteAutomation.mutate(automationToDelete.id, {
                    onSuccess: () => {
                        toastService.success('Automation decommissioned');
                        setAutomationToDelete(null);
                    },
                    onError: () => toastService.error('Failed to delete automation'),
                });
            }
        }}
        onCancel={() => setAutomationToDelete(null)}
      />
    </SettingsLayout>
  );
}
