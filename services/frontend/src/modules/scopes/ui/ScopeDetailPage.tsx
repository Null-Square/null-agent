import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DisclosurePanel,
  ListMetrics,
  ListSkeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
} from '@null-ai/design-tokens/ui';
import {
  useScopeDetailQuery,
  useScopeTargetsQuery,
  useRunsQuery,
  useRunnersQuery,
  useAssetsQuery,
  useUpdateRunnerScopesMutation,
  useUpdateScopeMutation,
  type Runner,
} from '@/modules/security-ops/api';
import { scopeImpactLabel, useScopeDraft } from '@/modules/scopes/model/scopeDraft';
import ScopeSaveBar from './components/ScopeSaveBar';
import TargetsList from './components/TargetsList';
import ScopeTestingBrief from './components/ScopeTestingBrief';
import ScopeComplianceFrameworks from './components/ScopeComplianceFrameworks';
import ScopeCodeSourcePanel from './components/ScopeCodeSource';
import ScopeExclusionsPanel from './components/ScopeExclusionsPanel';
import { TimeAgo } from '@shared/ui/TimeAgo';
import { toastService } from '@shared/services/toastService';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useOrgPermissions } from '@modules/permissions';

/**
 * ScopeDetailPage — four sections, no rail, one Save for the boundary.
 *
 * The detail rail is a *workflow* (a state, an owner, one primary verb), which
 * is right for a finding you validate and wrong here: a scope has no lifecycle
 * verb, only configuration. So the page is four folded sections — Targets &
 * execution, Rules of engagement, Code, Compliance — and execution binding
 * sits with the targets it governs rather than floating in a sidebar.
 *
 * Every control that changes the testing boundary edits a draft rather than
 * writing on click, and the save bar commits the whole draft in one request.
 * That is what makes a single authorization statement possible: one revision of
 * the contract, one thing to confirm, one statement recorded beside it. The
 * page used to write per click, which forced a consent control onto each panel.
 *
 * Runner binding stays immediate. It does not change what may be tested — it
 * picks where tests run from — so it does not belong in the boundary draft or
 * under its statement.
 */
export default function ScopeDetailPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const [selectedRunnerId, setSelectedRunnerId] = useState('');
  const { id } = useParams<{ id: string }>();
  const { data: scope, isLoading } = useScopeDetailQuery(id ?? '');
  const { data: targets } = useScopeTargetsQuery(id ?? '');
  const { data: runs } = useRunsQuery({ scopeId: id });
  const { data: assets } = useAssetsQuery({ scopeId: id });
  const { data: allRunners } = useRunnersQuery();
  const updateRunnerScopes = useUpdateRunnerScopesMutation();
  const updateScope = useUpdateScopeMutation();
  const boundary = useScopeDraft(scope, targets ?? [], scope?.exclusions ?? []);
  // Capability-driven gating. `org.scope.write` covers create/edit/delete scope
  // + add/remove targets; `org.settings.write` is admin-only and gates Danger
  // Zone actions like "Delete scope". Falls back to deny while the snapshot
  // loads, then resolves to the real value (sidebar already hid this route for
  // users without `org.scope.read`).
  const permissions = useOrgPermissions();
  const canManageScope = permissions.has('org.scope.write');
  const isAdmin = permissions.has('org.settings.write');
  const canManageRunnerBinding = canManageScope;

  const backLink = <DetailBackLink label="Scopes" onClick={() => navigate(paths.scopesList)} />;

  if (isLoading || !scope) {
    return (
      <DetailPageShell backLink={backLink}>
        <ListSkeleton label="Reading this scope" rows={3} />
      </DetailPageShell>
    );
  }

  const scopeId = id ?? '';
  const privateRunners = (allRunners ?? []).filter((runner) => runner.type === 'private');
  const attachedRunnerId = scope.attachedRunner?.id ?? '';
  const attachedRunnerRecord = privateRunners.find((runner) => runner.id === attachedRunnerId) ?? null;
  const attachedRunner = attachedRunnerRecord ?? scope.attachedRunner ?? null;
  const availableRunners = privateRunners.filter((runner) => runner.id !== attachedRunnerId);
  const scopeTarget = targets?.[0] ?? null;
  const targetStatus = !scopeTarget ? 'Missing' : scopeTarget.verified ? 'Verified' : 'Pending';
  const hasOnlineRunner = attachedRunner ? ['online', 'busy'].includes(attachedRunner.status) : false;
  const runnerOffline = Boolean(attachedRunner && !hasOnlineRunner);
  const showRunnerBindingControls = !attachedRunner;

  /* One request: the brief, the targets and the exclusions the customer staged,
     with the statement when the change widens the boundary. The API applies it
     all in one transaction, so a half-saved boundary cannot exist. */
  const saveDraft = (authorization: { accepted: true } | undefined) => {
    if (!scopeId) return;
    const draft = boundary.draft;
    updateScope.mutate(
      {
        id: scopeId,
        ...(draft.mission !== undefined ? { mission: draft.mission } : {}),
        ...(draft.impactTolerance !== null ? { impactTolerance: draft.impactTolerance } : {}),
        ...(draft.complianceFrameworks !== null
          ? { complianceFrameworks: draft.complianceFrameworks }
          : {}),
        ...(draft.targetsToAdd.length > 0 || draft.targetIdsToRemove.length > 0
          ? {
              targets: {
                add: draft.targetsToAdd.map((target) => ({
                  type: target.type,
                  value: target.value,
                  ...(target.verificationMethod
                    ? { verificationMethod: target.verificationMethod }
                    : {}),
                })),
                remove: draft.targetIdsToRemove,
              },
            }
          : {}),
        ...(draft.exclusionsToAdd.length > 0 || draft.exclusionIdsToRemove.length > 0
          ? {
              exclusions: {
                add: draft.exclusionsToAdd.map((exclusion) => ({
                  type: exclusion.type,
                  value: exclusion.value,
                })),
                remove: draft.exclusionIdsToRemove,
              },
            }
          : {}),
        ...(authorization ? { authorization } : {}),
      },
      {
        onSuccess: () => {
          boundary.actions.discard();
          toastService.success('Scope saved', 'The testing boundary is updated.');
        },
        onError: (error) => toastService.error('Could not save this scope', error.message),
      },
    );
  };

  const assignRunner = (runnerId: string) => {
    if (!scopeId || !runnerId) return;
    const runner = (allRunners ?? []).find((item) => item.id === runnerId);
    if (!runner) return;

    updateRunnerScopes.mutate(
      { runnerId, scopeIds: [...runner.assignedScopes, scopeId] },
      {
        onSuccess: () => {
          setSelectedRunnerId('');
          toastService.success('Runner assigned', `Runner ${runner.name} is now handling this scope.`);
        },
        onError: (error) => {
          toastService.error('Assignment failed', error.message);
        },
      },
    );
  };

  const removeRunner = (runner: Runner) => {
    if (!scopeId) return;
    updateRunnerScopes.mutate(
      { runnerId: runner.id, scopeIds: runner.assignedScopes.filter((item) => item !== scopeId) },
      {
        onSuccess: () => toastService.success('Runner unassigned', `Runner ${runner.name} removed from scope.`),
        onError: (error) => toastService.error('Unassignment failed', error.message),
      },
    );
  };

  return (
    <DetailPageShell backLink={backLink} displayId={scope.id.split('-')[0]}>
      <DetailHeader
        title={scope.name}
        badges={
          <>
            <StatusPill tone={scopeTarget?.verified ? 'success' : 'warning'}>{targetStatus}</StatusPill>
            <StatusPill tone={scope.whiteboxEnabled ? 'signal' : 'neutral'} showDot={false}>
              {scope.whiteboxEnabled ? 'Whitebox' : 'Blackbox'}
            </StatusPill>
          </>
        }
        subline={[
          <span key="runner">{attachedRunner ? `this computer + ${attachedRunner.name}` : 'this computer'}</span>,
        ]}
      />

      <ListMetrics
        className="mt-8"
        label="Scope coverage"
        items={[
          { label: 'Assets discovered', value: assets?.length ?? 0 },
          { label: 'Total runs', value: (runs ?? []).length },
        ]}
      />

      {/* Setup reads as a list of decisions: each panel says what it governs
          and what state it is in, folded until you need it. */}
      <div className="mt-8 flex flex-col gap-3">
        {/* Execution lives with the targets it governs — one decision about
            what gets tested and from where, not a target list plus a sidebar. */}
        <DisclosurePanel
          title="Targets & execution"
          description="What this scope authorises testing against, and where those tests run from."
          defaultOpen={!scopeTarget}
          state={
            <StatusPill tone={runnerOffline || !scopeTarget?.verified ? 'warning' : 'success'}>
              {runnerOffline ? 'Runner offline' : targetStatus}
            </StatusPill>
          }
        >
          <div className="flex flex-col gap-8">
            <TargetsList
              targets={boundary.effectiveTargets}
              removedTargets={(targets ?? []).filter((target) =>
                boundary.draft.targetIdsToRemove.includes(target.id),
              )}
              scopeId={scopeId}
              canManage={canManageScope}
              onAdd={boundary.actions.addTarget}
              onRemove={boundary.actions.removeTarget}
              onRestore={boundary.actions.restoreTarget}
            />

            <div className="flex flex-col gap-4 border-t border-border pt-6">
              <p className="text-sm text-muted-foreground">
                Runs execute on this computer. Bind a private node for internal operations.
              </p>

              {attachedRunner ? (
                <div className="flex flex-col gap-4 border border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
                        {attachedRunner.name}
                      </span>
                      <StatusPill tone={hasOnlineRunner ? 'success' : 'warning'}>
                        {hasOnlineRunner ? 'Online' : 'Offline'}
                      </StatusPill>
                    </div>
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {attachedRunnerRecord?.platform ?? 'Unknown'} · last heartbeat{' '}
                      <TimeAgo date={attachedRunnerRecord?.lastHeartbeatAt ?? null} />
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={!canManageRunnerBinding || !attachedRunnerRecord}
                    onClick={() => (attachedRunnerRecord ? removeRunner(attachedRunnerRecord) : undefined)}
                  >
                    Unbind
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4 border border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-[14px] text-foreground">This computer</span>
                  {showRunnerBindingControls ? (
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <Select
                        value={selectedRunnerId}
                        onValueChange={setSelectedRunnerId}
                        disabled={!canManageRunnerBinding || availableRunners.length === 0}
                      >
                        <SelectTrigger className="w-full sm:w-[240px]">
                          <SelectValue
                            placeholder={availableRunners.length === 0 ? 'No private nodes' : 'Select a node'}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {availableRunners.map((runner) => (
                            <SelectItem key={runner.id} value={runner.id}>
                              {runner.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        className="shrink-0"
                        disabled={!canManageRunnerBinding || !selectedRunnerId}
                        loading={updateRunnerScopes.isPending}
                        onClick={() => assignRunner(selectedRunnerId)}
                      >
                        Bind
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}

              {runnerOffline ? (
                <p className="border-l-2 border-warning pl-4 text-sm leading-relaxed text-muted-foreground">
                  Runner-targeted runs and automations will queue until the attached runner reconnects.
                </p>
              ) : null}
            </div>
          </div>
        </DisclosurePanel>

        {/* Rules of engagement: what must not be tested, how far testing may go,
            and anything specific to aim at. Three decisions, one card. */}
        <DisclosurePanel
          title="Rules of engagement"
          description="What must not be tested, how far testing may go, and anything specific to aim at."
          state={
            <StatusPill tone={boundary.impactTolerance === 'full' ? 'warning' : 'neutral'} showDot={false}>
              {scopeImpactLabel(boundary.impactTolerance)}
            </StatusPill>
          }
        >
          <div className="flex flex-col gap-8">
            <ScopeExclusionsPanel
              exclusions={boundary.effectiveExclusions}
              removedExclusions={(scope.exclusions ?? []).filter((exclusion) =>
                boundary.draft.exclusionIdsToRemove.includes(exclusion.id),
              )}
              canManage={canManageScope}
              onAdd={boundary.actions.addExclusion}
              onRemove={boundary.actions.removeExclusion}
              onRestore={boundary.actions.restoreExclusion}
            />

            <div className="border-t border-border pt-6">
              <ScopeTestingBrief
                mission={boundary.mission}
                impactTolerance={boundary.impactTolerance}
                canManage={canManageScope}
                onChange={boundary.actions.setBrief}
              />
            </div>
          </div>
        </DisclosurePanel>

        {/* The code Code Review reads. It is not part of the testing boundary,
            so it saves on its own rather than through the draft. */}
        <ScopeCodeSourcePanel scopeId={scopeId} canManage={canManageScope} />

        {/* Compliance is reporting, not rules: it maps findings to a framework
            and narrows nothing, so it does not belong under the RoE. */}
        <DisclosurePanel
          title="Compliance"
          description="Optional reporting mappings for this scope."
          state={
            <StatusPill
              tone={boundary.complianceFrameworks.length > 0 ? 'success' : 'neutral'}
              showDot={boundary.complianceFrameworks.length > 0}
            >
              {boundary.complianceFrameworks.length > 0
                ? `${boundary.complianceFrameworks.length} mapped`
                : 'None'}
            </StatusPill>
          }
        >
          <ScopeComplianceFrameworks
            selected={boundary.complianceFrameworks}
            canManage={canManageScope}
            onChange={boundary.actions.setComplianceFrameworks}
          />
        </DisclosurePanel>
      </div>

      {canManageScope && boundary.dirty ? (
        <ScopeSaveBar
          changes={boundary.changes}
          wideningReasons={boundary.wideningReasons}
          impactTolerance={boundary.impactTolerance}
          isSaving={updateScope.isPending}
          onDiscard={boundary.actions.discard}
          onSave={saveDraft}
        />
      ) : null}

      {isAdmin ? (
        <div className="mt-10 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">Danger zone</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Permanently removes this scope and all associated data.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0 text-destructive hover:border-destructive/50"
            disabled={!canManageScope}
          >
            {canManageScope ? 'Delete scope' : 'Read only'}
          </Button>
        </div>
      ) : null}

    </DetailPageShell>
  );
}
