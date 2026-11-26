import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScope, type Scope } from '@shared/contexts/ScopeContext';
import { toastService } from '@shared/services/toastService';
import { toApiError } from '@shared/lib/apiError';
import {
  useCreateRunMutation,
  useDashboardSummary,
  useRiskSummaryQuery,
  useScopeTargetsQuery,
} from '@/modules/security-ops/api';

type UseContextualRunActionsResult = {
  scopeId: string | null;
  scope: Scope | null;
  hasScope: boolean;
  targetCount: number;
  verifiedTargetCount: number;
  hasTarget: boolean;
  hasVerifiedTarget: boolean;
  targetVerificationState: 'missing' | 'pending' | 'verified';
  targetVerificationMessage: string | null;
  assetsCount: number;
  openRisksCount: number;
  resolvedRisksCount: number;
  criticalCount: number;
  highCount: number;
  activeAutomationsCount: number;
  runnersTotal: number;
  runnersOnline: number;
  loadingSignals: boolean;
  launching: boolean;
  startDiscovery: () => void;
  startWebAppScan: () => void;
  startVulnerabilityScan: () => void;
};

/**
 * Shared contextual run launcher used by Home, Dashboard, and Assets surfaces.
 * Keeps prerequisite checks and run-start behavior identical everywhere.
 */
export function useContextualRunActions(
  scopeIdOverride?: string | null,
  options?: { enabled?: boolean },
): UseContextualRunActionsResult {
  const navigate = useNavigate();
  const { activeScopeId, setActiveScopeId, scopes } = useScope();
  const enabled = options?.enabled ?? true;
  const scopeId = scopeIdOverride ?? activeScopeId ?? null;
  const scope = useMemo(
    () => scopes.find((item) => item.id === scopeId) ?? null,
    [scopeId, scopes],
  );

  const createRun = useCreateRunMutation();
  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(scopeId ?? undefined, { enabled });
  const { data: riskSummary, isLoading: riskSummaryLoading } = useRiskSummaryQuery(scopeId, { enabled });
  const { data: scopeTargets = [], isLoading: targetsLoading } = useScopeTargetsQuery(scopeId ?? '', { enabled });

  const targetCount = scopeTargets.length;
  const verifiedTargetCount = useMemo(
    () => scopeTargets.filter((target) => target.verified).length,
    [scopeTargets],
  );
  const hasTarget = targetCount > 0;
  const hasVerifiedTarget = verifiedTargetCount > 0;
  const targetVerificationState: 'missing' | 'pending' | 'verified' = !hasTarget
    ? 'missing'
    : hasVerifiedTarget
      ? 'verified'
      : 'pending';
  const targetVerificationMessage =
    targetVerificationState === 'missing'
      ? 'Set the scope target and verify ownership before starting a run.'
      : targetVerificationState === 'pending'
        ? 'Target ownership must be verified before starting a run.'
        : null;
  const assetsCount = summary?.totalAssets ?? 0;
  const openRisksCount = riskSummary?.open ?? 0;
  const resolvedRisksCount = riskSummary?.byState.resolved ?? 0;
  const criticalCount = riskSummary?.openBySeverity.critical ?? 0;
  const highCount = riskSummary?.openBySeverity.high ?? 0;
  const activeAutomationsCount = summary?.activeAutomations ?? 0;
  const runnersTotal = summary?.runnersTotal ?? 0;
  const runnersOnline = summary?.runnersOnline ?? 0;
  const loadingSignals = enabled && (summaryLoading || riskSummaryLoading || targetsLoading);

  const launchAssessment = (
    goalTemplate: string,
    label: string,
    options?: { requireAssets?: boolean },
  ) => {
    if (!scopeId) {
      toastService.warning('Scope required', 'Select a scope before starting this action.');
      return;
    }

    if (!hasVerifiedTarget) {
      toastService.warning('Verification required', targetVerificationMessage ?? 'Verification is required before starting a run.');
      return;
    }

    if (options?.requireAssets && assetsCount === 0) {
      const proceed = window.confirm('No assets discovered yet. Run vulnerability scan anyway?');
      if (!proceed) {
        return;
      }
    }

    const goal = `Scope: ${scope?.name ?? scopeId}\n${goalTemplate}`;

    createRun.mutate(
      { scopeId, goal, trigger: 'manual' },
      {
        onSuccess: (data) => {
          setActiveScopeId(scopeId);
          const suffix =
            data.run.status === 'queued'
              ? 'Run queued on private runner.'
              : 'Run started and is now executing.';
          toastService.success(`${label} launched`, suffix);
          navigate(`/runs/${data.run.id}`);
        },
        onError: (error) => {
          const apiError = toApiError(error);
          toastService.error('Run launch failed', apiError.message);
        },
      },
    );
  };

  return {
    scopeId,
    scope,
    hasScope: Boolean(scopeId),
    targetCount,
    verifiedTargetCount,
    hasTarget,
    hasVerifiedTarget,
    targetVerificationState,
    targetVerificationMessage,
    assetsCount,
    openRisksCount,
    resolvedRisksCount,
    criticalCount,
    highCount,
    activeAutomationsCount,
    runnersTotal,
    runnersOnline,
    loadingSignals,
    launching: createRun.isPending,
    startDiscovery: () =>
      launchAssessment(
        'Discover and map the attack surface for this scope, starting from the verified target and expanding into related subdomains, services, endpoints, and tech stack.',
        'Discovery',
      ),
    startWebAppScan: () =>
      launchAssessment(
        'Perform a focused web application security assessment. Prioritize authentication, session management, input validation, and access control.',
        'Web App Scan',
      ),
    startVulnerabilityScan: () =>
      launchAssessment(
        'Assess discovered assets for exploitable vulnerabilities and produce validated risks with evidence and remediation guidance.',
        'Vulnerability Scan',
        { requireAssets: true },
      ),
  };
}
