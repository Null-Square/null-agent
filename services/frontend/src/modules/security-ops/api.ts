/**
 * Phase 3: Real API hooks replacing @/mocks/hooks.
 *
 * Each hook calls the real backend REST API via fetchClient.
 * When the backend is unreachable, the query returns an empty
 * array/object so the UI stays functional (empty-state pages).
 *
 * Hook signatures match the mock hooks 1:1 so page imports only
 * need the path changed.
 */
import { useQuery, useMutation, useQueryClient, type Query } from '@tanstack/react-query';
import { fetchApi } from '@shared/api';
import { toApiError } from '@shared/lib/apiError';
import type {
  DashboardSummary,
  Finding,
  FindingEvent,
  FindingEvidence,
  FindingDispositionVerification,
  FindingDispositionVerificationHistory,
  Asset,
  AssetScanCoverage,
  AssetEndpoint,
  Automation,
  AutomationDetail,
  AutomationHistoryEntry,
  AssetSubdomain,
  AssetTechFingerprint,
  InventoryService,
  Run,
  RunInventoryDiff,
  Scope,
  CodeSource,
  ScopeTarget,
  ScopeExclusion,
  Organization,
  OrganizationMember,
  Runner,
  RunnerDetail,
  DeployRunnerResponse,
  RunActivitySummary,
  RunPhaseSessionEntry,
  ScopeAccessMaterial,
  CreateAccessMaterialPayload,
  UpdateAccessMaterialPayload,
  DashboardOverviewV2,
  ExecutionTarget,
  RunWorkflowDiscipline,
  ComplianceFrameworkKey,
  ComplianceEvidenceItem,
  ComplianceEvidenceReviewStatus,
  ComplianceEvidenceSourceType,
  ComplianceEvidenceType,
  ComplianceControlMonitoringState,
  ComplianceControlHistoryEvent,
  ComplianceMissingEvidenceItem,
  ComplianceReadinessResponse,
  ComplianceReportHistoryItem,
  CodeReviewRunBundle,
  CodeReviewFixRequest,
  ExposureMatch,
  ExposureMatchState,
  ExposureMatchDetail,
  ExposureMatchEvent,
  ExposureMatchListResponse,
  ExposureMatchDetailResponse,
  StartExposureVerificationResponse,
  CanonicalRiskDetail,
  RiskListItem,
  RiskState,
  RiskSummary,
} from './types';

export type {
  DashboardSummary,
  Finding,
  FindingEvent,
  FindingEvidence,
  Asset,
  Automation,
  AutomationDetail,
  AutomationHistoryEntry,
  InventoryService,
  Run,
  RunInventoryDiff,
  Scope,
  CodeSource,
  ScopeTarget,
  Organization,
  OrganizationMember,
  Runner,
  RunnerDetail,
  DeployRunnerResponse,
  RunActivitySummary,
  RunPhaseSessionEntry,
  RiskListItem,
  RiskSummary,
  ScopeAccessMaterial,
  CreateAccessMaterialPayload,
  UpdateAccessMaterialPayload,
  DashboardOverviewV2,
  ComplianceEvidenceItem,
  ComplianceMissingEvidenceItem,
  ComplianceReadinessResponse,
  ComplianceReportHistoryItem,
  CodeReviewRunBundle,
  CodeReviewFixRequest,
  ExposureMatch,
  ExposureMatchState,
  ExposureMatchDetail,
  ExposureMatchEvent,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await fetchApi.get<T>(`/app${path}`, { params });
  return res.data;
}

type ApiRequestBody = object | FormData;

async function apiPost<T>(path: string, body?: ApiRequestBody): Promise<T> {
  const res = await fetchApi.post<T>(`/app${path}`, body);
  return res.data;
}

async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetchApi.delete<T>(`/app${path}`);
  return res.data;
}

async function apiPut<T>(path: string, body?: ApiRequestBody): Promise<T> {
  const res = await fetchApi.put<T>(`/app${path}`, body);
  return res.data;
}

async function apiPatch<T>(path: string, body?: ApiRequestBody): Promise<T> {
  const res = await fetchApi.patch<T>(`/app${path}`, body);
  return res.data;
}

const invalidateSetupReadinessQueries = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: ['chat-setup-readiness'] });
};

type FindingLifecycleRunResponse = {
  run: Run;
  sessionId: string | null;
  policySlug: string;
  runner: {
    id: string;
    name: string;
    type: string;
    status: string;
  } | null;
  scheduling: {
    state: 'queued' | 'preparing' | 'started';
    reason: string | null;
    submittedAt: string | null;
    estimatedStart: null;
  };
};

type PlanFeedbackResponse = {
  success: boolean;
  run: Run;
  plannerSessionId: string;
};

const applyRunToCaches = (qc: ReturnType<typeof useQueryClient>, run: Run) => {
  qc.setQueryData(['run', run.id], run);
  qc.setQueriesData<Run[]>(
    { queryKey: ['runs'] },
    (old) => old?.map((item) => (item.id === run.id ? { ...item, ...run } : item)) ?? old,
  );
};

const toPlanRevisionRun = (run: Run): Run => ({
  ...run,
  activeSessionId: run.plannerSessionId ?? run.sessionId ?? run.activeSessionId ?? null,
  status: 'running',
  pauseReason: null,
  interactionType: 'none',
  awaitingPlanApproval: false,
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const useDashboardSummary = (scopeId?: string | null, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['dashboard-summary', scopeId],
    queryFn: () => apiGet<DashboardSummary>('/dashboard/summary', scopeId ? { scopeId } : undefined),
    enabled: options?.enabled ?? true,
  });
};

export const useDashboardOverviewV2 = (scopeId?: string | null, days: number = 30) => {
  return useQuery({
    queryKey: ['dashboard-overview-v2', scopeId, days],
    queryFn: () =>
      apiGet<DashboardOverviewV2>('/dashboard/overview-v2', {
        days,
        ...(scopeId ? { scopeId } : {}),
      }),
  });
};

export const useComplianceReadinessQuery = (scopeId?: string | null, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['compliance-readiness', scopeId ?? null],
    queryFn: () =>
      apiGet<ComplianceReadinessResponse>('/dashboard/compliance-readiness', scopeId ? { scopeId } : undefined),
    enabled: options?.enabled ?? true,
  });
};

export interface UpdateComplianceControlStateInput {
  scopeId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlId: string;
  state: ComplianceControlMonitoringState;
  exclusionReason?: string | null;
  assignedToUserId?: string | null;
}

export interface BulkUpdateComplianceControlStateInput {
  scopeId: string;
  frameworkKey: ComplianceFrameworkKey;
  controlIds: string[];
  state: ComplianceControlMonitoringState;
  exclusionReason?: string | null;
}

export const useUpdateComplianceControlStateMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ frameworkKey, controlId, ...body }: UpdateComplianceControlStateInput) =>
      apiPut<{ state: unknown }>(`/compliance/control-states/${frameworkKey}/${encodeURIComponent(controlId)}`, body),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({
        queryKey: ['compliance-readiness', variables.scopeId],
      });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness', null] });
      void qc.invalidateQueries({
        queryKey: ['compliance-control-states', variables.scopeId],
      });
    },
  });
};

export const useBulkUpdateComplianceControlStateMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ frameworkKey, ...body }: BulkUpdateComplianceControlStateInput) =>
      apiPut<{ states: unknown[]; updatedCount: number }>(`/compliance/control-states-bulk/${frameworkKey}`, body),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({
        queryKey: ['compliance-readiness', variables.scopeId],
      });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness', null] });
      void qc.invalidateQueries({
        queryKey: ['compliance-control-states', variables.scopeId],
      });
    },
  });
};

export const useComplianceControlHistoryQuery = (
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
  options?: { enabled?: boolean },
) =>
  useQuery({
    queryKey: ['compliance-control-history', frameworkKey, controlId],
    queryFn: () =>
      apiGet<{ events: ComplianceControlHistoryEvent[] }>(
        `/compliance/control-states/${frameworkKey}/${encodeURIComponent(controlId)}/history`,
      ),
    enabled: options?.enabled ?? true,
  });

export const useComplianceReportHistoryQuery = (
  scopeId?: string | null,
  framework?: ComplianceFrameworkKey | null,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['compliance-report-history', scopeId ?? null, framework ?? null],
    queryFn: () =>
      apiGet<{ reports: ComplianceReportHistoryItem[] }>('/compliance/reports', {
        ...(scopeId ? { scopeId } : {}),
        ...(framework ? { framework } : {}),
      }).then((response) => response.reports),
    enabled: options?.enabled ?? Boolean(scopeId),
  });
};

export const useComplianceEvidenceQuery = (
  scopeId?: string | null,
  framework?: ComplianceFrameworkKey | null,
  status?: ComplianceEvidenceReviewStatus | null,
  sourceType?: ComplianceEvidenceSourceType | null,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['compliance-evidence', scopeId ?? null, framework ?? null, status ?? null, sourceType ?? null],
    queryFn: () =>
      apiGet<{ evidence: ComplianceEvidenceItem[] }>('/compliance/evidence', {
        ...(scopeId ? { scopeId } : {}),
        ...(framework ? { framework } : {}),
        ...(status ? { status } : {}),
        ...(sourceType ? { sourceType } : {}),
      }).then((response) => response.evidence),
    // framework is an optional filter, not a requirement — the library passes a null
    // framework to list all evidence for the scope.
    enabled: options?.enabled ?? Boolean(scopeId),
  });
};

export const useComplianceMissingEvidenceQuery = (
  scopeId?: string | null,
  framework?: ComplianceFrameworkKey | null,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['compliance-missing-evidence', scopeId ?? null, framework ?? null],
    queryFn: () =>
      apiGet<{ missing: ComplianceMissingEvidenceItem[] }>('/compliance/missing-evidence', {
        ...(scopeId ? { scopeId } : {}),
        ...(framework ? { framework } : {}),
      }).then((response) => response.missing),
    enabled: options?.enabled ?? Boolean(scopeId && framework),
  });
};

export const useCreateComplianceEvidenceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body:
        | FormData
        | {
            scopeId?: string | null;
            title: string;
            description?: string | null;
            sourceType?: ComplianceEvidenceSourceType;
            evidenceType?: ComplianceEvidenceType;
            owner?: string | null;
            artifact?: {
              fileName?: string | null;
              mimeType?: string | null;
              sizeBytes?: number | null;
              sha256?: string | null;
              storageRef?: string | null;
              sourceRef?: string | null;
            };
            observationStartedAt?: string | null;
            observationEndedAt?: string | null;
            validUntil?: string | null;
            mappings: Array<{
              frameworkKey: ComplianceFrameworkKey;
              controlId: string;
              rationale?: string | null;
            }>;
          },
    ) => apiPost<{ evidence: ComplianceEvidenceItem }>('/compliance/evidence', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export const useDeleteComplianceEvidenceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (evidenceItemId: string) => apiDelete<{ deleted: boolean }>(`/compliance/evidence/${evidenceItemId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export const useUpdateComplianceEvidenceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      evidenceItemId: string;
      title: string;
      description?: string | null;
      evidenceType: ComplianceEvidenceType;
      owner?: string | null;
      observationStartedAt?: string | null;
      observationEndedAt?: string | null;
      validUntil?: string | null;
      mappings: Array<{
        frameworkKey: ComplianceFrameworkKey;
        controlId: string;
        mappingSource?: 'user_declared' | 'system_suggested';
        confidence?: 'high' | 'medium' | 'low';
        rationale?: string | null;
      }>;
    }) =>
      apiPut<{ evidence: ComplianceEvidenceItem }>(`/compliance/evidence/${input.evidenceItemId}`, {
        title: input.title,
        description: input.description ?? null,
        evidenceType: input.evidenceType,
        owner: input.owner ?? null,
        observationStartedAt: input.observationStartedAt ?? null,
        observationEndedAt: input.observationEndedAt ?? null,
        validUntil: input.validUntil ?? null,
        mappings: input.mappings,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export const useFulfillComplianceControlRequestMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; evidenceItemId: string; note?: string | null }) =>
      apiPost<{
        requestId: string;
        status: 'fulfilled';
        evidenceItemId: string;
      }>(`/compliance/control-requests/${input.requestId}/fulfill`, {
        evidenceItemId: input.evidenceItemId,
        note: input.note ?? null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export const useReviewComplianceControlRequestMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      requestId: string;
      outcome: 'reviewed' | 'insufficient' | 'contradicted';
      controlCheckId: string;
      note: string;
      nextReverificationAt?: string | null;
    }) =>
      apiPost<{
        requestId: string;
        status: 'reviewed' | 'insufficient' | 'contradicted';
        controlCheckId: string;
        nextReverificationAt: string | null;
      }>(`/compliance/control-requests/${input.requestId}/review`, {
        outcome: input.outcome,
        controlCheckId: input.controlCheckId,
        note: input.note,
        nextReverificationAt: input.nextReverificationAt ?? null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export const useUpdateComplianceEvidenceMappingsMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      evidenceItemId: string;
      mappings: Array<{
        frameworkKey: ComplianceFrameworkKey;
        controlId: string;
        mappingSource?: 'user_declared' | 'system_suggested';
        confidence?: 'high' | 'medium' | 'low';
        rationale?: string | null;
      }>;
    }) =>
      apiPut<{ evidence: ComplianceEvidenceItem }>(`/compliance/evidence/${input.evidenceItemId}/mappings`, {
        mappings: input.mappings,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

export async function downloadComplianceEvidenceFile(evidenceItemId: string, fileName: string): Promise<void> {
  const response = await fetchApi.get<Blob>(`/app/compliance/evidence/${evidenceItemId}/file`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const useCreateComplianceEvidenceFromFindingMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scopeId?: string | null;
      findingId: string;
      mappings: Array<{
        frameworkKey: ComplianceFrameworkKey;
        controlId: string;
        rationale?: string | null;
      }>;
    }) => apiPost<{ evidence: ComplianceEvidenceItem }>('/compliance/evidence/from-finding', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
      void qc.invalidateQueries({ queryKey: ['compliance-missing-evidence'] });
    },
  });
};

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

type RiskReadModelResponse = { risks: RiskListItem[]; summary: RiskSummary };

const useRiskReadModelQuery = <T>(
  scopeId: string | null | undefined,
  select: (data: RiskReadModelResponse) => T,
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['risks', scopeId],
    enabled: options?.enabled ?? true,
    queryFn: () =>
      apiGet<RiskReadModelResponse>('/risks', {
        ...(scopeId ? { scopeId } : {}),
      }),
    select,
  });
};

export const useRisksQuery = (scopeId?: string | null) => useRiskReadModelQuery(scopeId, (data) => data.risks);

/**
 * The one Risk detail. `sourceKind` decides which source panels render —
 * the lifecycle above them is the same whichever way the Risk was proved.
 */
/**
 * An unpublished code occurrence, in the same anatomy as a Risk. Separate
 * endpoint because it is not a Risk yet — no canonical record exists — but the
 * response is the same shape so it renders through the same shell.
 */
export const useCodeOccurrenceDetailQuery = (occurrenceId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['risk-code-occurrence', occurrenceId],
    enabled: Boolean(occurrenceId) && (options?.enabled ?? true),
    queryFn: () => apiGet<CanonicalRiskDetail>(`/risks/code-occurrences/${occurrenceId}`),
  });
};

export const useRiskDetailQuery = (riskId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['risk-detail', riskId],
    enabled: Boolean(riskId) && (options?.enabled ?? true),
    queryFn: () => apiGet<CanonicalRiskDetail>(`/risks/${riskId}`),
  });
};

export const useRiskSummaryQuery = (scopeId?: string | null, options?: { enabled?: boolean }) =>
  useRiskReadModelQuery(scopeId, (data) => data.summary, options);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const useFindingDetailQuery = (id: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['finding', id],
    queryFn: () => apiGet<Finding>(`/findings/${id}`),
    enabled: !!id && (options?.enabled ?? true),
  });
};

export const useFindingEventsQuery = (findingId: string) => {
  return useQuery({
    queryKey: ['finding-events', findingId],
    queryFn: () => apiGet<FindingEvent[]>(`/findings/${findingId}/events`),
    enabled: !!findingId,
  });
};

export const useFindingEvidenceQuery = (findingId: string) => {
  return useQuery({
    queryKey: ['finding-evidence', findingId],
    queryFn: () => apiGet<FindingEvidence[]>(`/findings/${findingId}/evidence`),
    enabled: !!findingId,
  });
};

const isActiveFindingDispositionStatus = (status: string | undefined): boolean =>
  status === 'queued' || status === 'waiting' || status === 'launching' || status === 'running';

export const useFindingDispositionVerificationsQuery = (findingId: string) =>
  useQuery({
    queryKey: ['finding-disposition-verifications', findingId],
    queryFn: () => apiGet<FindingDispositionVerificationHistory>(`/findings/${findingId}/disposition-verifications`),
    enabled: !!findingId,
    refetchInterval: (query) => (isActiveFindingDispositionStatus(query.state.data?.active?.status) ? 3_000 : false),
  });

const invalidateFindingDispositionQueries = (qc: ReturnType<typeof useQueryClient>, findingId: string) => {
  void qc.invalidateQueries({ queryKey: ['finding', findingId] });
  void qc.invalidateQueries({ queryKey: ['finding-events', findingId] });
  void qc.invalidateQueries({
    queryKey: ['finding-disposition-verifications', findingId],
  });
  void qc.invalidateQueries({ queryKey: ['risks'] });
  void qc.invalidateQueries({ queryKey: ['runs'] });
  void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
};

export const useRequestFindingDispositionVerificationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      findingId,
      requestedState,
      reason,
      requestKey = crypto.randomUUID(),
    }: {
      findingId: string;
      requestedState: 'resolved' | 'dismissed';
      reason?: string;
      requestKey?: string;
    }) =>
      apiPost<{
        verification: FindingDispositionVerification;
        idempotentReplay: boolean;
        active: FindingDispositionVerification | null;
        latest: FindingDispositionVerification | null;
      }>(`/findings/${findingId}/disposition-verifications`, {
        requestedState,
        requestKey,
        ...(reason ? { reason } : {}),
      }),
    onSuccess: (_data, vars) => invalidateFindingDispositionQueries(qc, vars.findingId),
  });
};

export const useRetryFindingDispositionVerificationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      findingId,
      verificationId,
      requestKey = crypto.randomUUID(),
    }: {
      findingId: string;
      verificationId: string;
      requestKey?: string;
    }) =>
      apiPost<{ verification: FindingDispositionVerification }>(
        `/findings/${findingId}/disposition-verifications/${verificationId}/retry`,
        { requestKey },
      ),
    onSuccess: (_data, vars) => invalidateFindingDispositionQueries(qc, vars.findingId),
  });
};

export const useCancelFindingDispositionVerificationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ findingId, verificationId }: { findingId: string; verificationId: string }) =>
      apiPost<{ verification: FindingDispositionVerification }>(
        `/findings/${findingId}/disposition-verifications/${verificationId}/cancel`,
      ),
    onSuccess: (_data, vars) => invalidateFindingDispositionQueries(qc, vars.findingId),
  });
};

export const useUpdateFindingMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      businessImpact?: string | null;
      technicalAnalysis?: string | null;
      pocDescription?: string | null;
      pocScriptCode?: string | null;
      remediation?: string | null;
      assumptions?: string | null;
      fixEffort?: 'trivial' | 'low' | 'medium' | 'high' | null;
      cweId?: string | null;
      cveId?: string | null;
      state?: RiskState;
    }) => apiPatch<Finding>(`/findings/${id}`, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['finding', vars.id] });
      void qc.invalidateQueries({ queryKey: ['finding-events', vars.id] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
};

export const useAssignFindingMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) =>
      apiPut<Finding>(`/findings/${id}/assign`, { userId }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['finding', vars.id] });
      void qc.invalidateQueries({ queryKey: ['finding-events', vars.id] });
    },
  });
};

export const useBulkFindingsMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { findingIds: string[]; action: 'assign' | 'set_state'; params?: Record<string, unknown> }) =>
      apiPost<{ updatedCount: number }>('/findings/bulk', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({ queryKey: ['finding-events'] });
    },
  });
};

export const useValidateFindingMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) =>
      apiPost<FindingLifecycleRunResponse>(`/findings/${findingId}/validate`),
    onSuccess: (data, findingId) => {
      void qc.invalidateQueries({ queryKey: ['finding', findingId] });
      void qc.invalidateQueries({ queryKey: ['finding-events', findingId] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({ queryKey: ['run', data.run.id] });
    },
  });
};

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const useAssetsQuery = (
  filters?: { scopeId?: string | null; kind?: string },
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['assets', filters],
    queryFn: () =>
      apiGet<Asset[]>('/assets', {
        ...(filters?.scopeId ? { scopeId: filters.scopeId } : {}),
        ...(filters?.kind ? { kind: filters.kind } : {}),
      }),
    enabled: options?.enabled ?? true,
  });
};

export const useAssetDetailQuery = (id: string) => {
  return useQuery({
    queryKey: ['asset', id],
    queryFn: () => apiGet<Asset>(`/assets/${id}`),
    enabled: !!id,
  });
};

export const useAssetServicesQuery = (assetId: string) => {
  return useQuery({
    queryKey: ['asset-services', assetId],
    queryFn: () => apiGet<InventoryService[]>(`/assets/${assetId}/services`),
    enabled: !!assetId,
  });
};

export const useAssetEndpointsQuery = (assetId: string) => {
  return useQuery({
    queryKey: ['asset-endpoints', assetId],
    queryFn: () => apiGet<AssetEndpoint[]>(`/assets/${assetId}/endpoints`),
    enabled: !!assetId,
  });
};

export const useAssetSubdomainsQuery = (assetId: string) => {
  return useQuery({
    queryKey: ['asset-subdomains', assetId],
    queryFn: () => apiGet<AssetSubdomain[]>(`/assets/${assetId}/subdomains`),
    enabled: !!assetId,
  });
};

export const useAssetTechQuery = (assetId: string) => {
  return useQuery({
    queryKey: ['asset-tech', assetId],
    queryFn: () => apiGet<AssetTechFingerprint[]>(`/assets/${assetId}/tech`),
    enabled: !!assetId,
  });
};

// Fetch the curated customer summary of the latest broad scan.
export function useAssetScanCoverageQuery(assetId: string) {
  return useQuery({
    queryKey: ['asset-scan-coverage', assetId],
    queryFn: () => apiGet<AssetScanCoverage | null>(`/assets/${assetId}/scan-coverage`),
    enabled: !!assetId,
  });
}

export function useScopePlanQuery(scopeId: string) {
  return useQuery({
    queryKey: ['scope-plan', scopeId],
    queryFn: () => apiGet<{ plan: import('./types').InventoryNote | null }>(`/scopes/${scopeId}/plan`),
    enabled: !!scopeId,
    retry: (failureCount, error) => {
      const apiError = toApiError(error);
      if (apiError.status === 404) {
        return false;
      }
      if (!apiError.status || apiError.status >= 500) {
        return failureCount < 2;
      }
      return false;
    },
  });
}

export const useAssetFindingsQuery = (assetId: string) => {
  return useQuery({
    queryKey: ['asset-findings', assetId],
    queryFn: () => apiGet<Finding[]>(`/assets/${assetId}/findings`),
    enabled: !!assetId,
  });
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const getRunListRefetchInterval = (runList: Run[] | undefined): number | false =>
  runList?.some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'paused')
    ? 5_000
    : false;

export type RunsQueryFilters = {
  scopeId?: string | null;
  status?: string;
};

export const useRunsQuery = (
  filters?: RunsQueryFilters,
  options?: {
    enabled?: boolean;
    refetchInterval?: number | false | ((query: Query<Run[]>) => number | false | undefined);
  },
) => {
  return useQuery({
    queryKey: ['runs', filters],
    queryFn: () =>
      apiGet<Run[]>('/runs', {
        ...(filters?.scopeId ? { scopeId: filters.scopeId } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      }),
    enabled: options?.enabled ?? true,
    // Run-detail polling cannot refresh independent run-list cache keys. Keep a
    // list fresh only while its own cached payload says work is active; once the
    // backend reports a terminal state this automatically stops polling.
    refetchInterval: options?.refetchInterval ?? ((query: Query<Run[]>) =>
      getRunListRefetchInterval(query.state.data)),
  });
};

export const useRunDetailQuery = (
  id: string,
  options?: {
    enabled?: boolean;
    refetchInterval?: number | false | ((query: Query<Run>) => number | false | undefined);
  },
) => {
  return useQuery({
    queryKey: ['run', id],
    queryFn: () => apiGet<Run>(`/runs/${id}`),
    enabled: options?.enabled ?? !!id,
    refetchInterval: options?.refetchInterval ?? false,
  });
};

export const useRunFindingsQuery = (runId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['run-findings', runId],
    queryFn: () => apiGet<Finding[]>(`/runs/${runId}/findings`),
    enabled: options?.enabled ?? !!runId,
  });
};

export const useRunInventoryDiffQuery = (runId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['run-inventory-diff', runId],
    queryFn: () => apiGet<RunInventoryDiff>(`/runs/${runId}/inventory-diff`),
    enabled: options?.enabled ?? !!runId,
  });
};

export const useRunCodeReviewQuery = (
  runId: string,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) => {
  return useQuery({
    queryKey: ['run-code-review', runId],
    queryFn: () => apiGet<CodeReviewRunBundle>(`/runs/${runId}/code-review`),
    enabled: options?.enabled ?? !!runId,
    refetchInterval: options?.refetchInterval ?? false,
  });
};

export const useRunActivityQuery = (
  runId: string,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) => {
  return useQuery({
    queryKey: ['run-activity', runId],
    queryFn: () => apiGet<RunActivitySummary>(`/runs/${runId}/activity`),
    enabled: options?.enabled ?? !!runId,
    refetchInterval: options?.refetchInterval ?? false,
  });
};

export const useRunComplianceReadinessQuery = (runId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['run-compliance-readiness', runId],
    queryFn: () => apiGet<ComplianceReadinessResponse>(`/runs/${runId}/compliance-readiness`),
    enabled: options?.enabled ?? !!runId,
  });
};

export const useRunPhasesQuery = (runId: string, options?: { enabled?: boolean; refetchInterval?: number | false }) => {
  return useQuery({
    queryKey: ['run-phases', runId],
    queryFn: () => apiGet<RunPhaseSessionEntry[]>(`/runs/${runId}/phases`),
    enabled: options?.enabled ?? !!runId,
    refetchInterval: options?.refetchInterval ?? false,
  });
};

export const useCreateRunMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scopeId: string;
      goal: string;
      modelId?: string;
      modelCategory?: string;
      executionTarget?: ExecutionTarget;
      trigger?: string;
      vars?: Record<string, unknown>;
    }) => apiPost<{ run: Run; sessionId: string }>('/runs', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
};

/* The scope's code source is what is reviewed: the API pins its commit (a clone)
   or content hash (a folder) when the run starts. */
export const useStartCodeReviewMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scopeId: string;
      allowedPaths?: string[];
      excludedPaths?: string[];
      goal?: string;
      modelId?: string;
      modelCategory?: string;
    }) =>
      apiPost<{
        run: Run;
        sessionId: string | null;
        codeReview: {
          repository: string;
          immutableCommitSha: string;
          manifestHash: string;
          manifestFileCount: number;
          completeness: 'complete' | 'partial' | 'blocked';
        };
      }>('/runs/code-reviews', body),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({
        queryKey: ['run-code-review', result.run.id],
      });
    },
  });
};

export const useRequestCodeReviewFixMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      findingId,
      findingVersion,
      vulnerableCommitSha,
    }: {
      runId: string;
      findingId: string;
      findingVersion: number;
      vulnerableCommitSha: string;
    }) =>
      apiPost<CodeReviewFixRequest>(`/runs/${runId}/code-review/findings/${findingId}/fix`, {
        findingVersion,
        vulnerableCommitSha,
      }),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({
        queryKey: ['run-code-review', variables.runId],
      });
    },
  });
};

export const useStartComplianceReportMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scopeId: string;
      framework: ComplianceFrameworkKey;
      title?: string;
      sourceRunId?: string | null;
      modelId?: string;
      modelCategory?: string;
      executionTarget?: ExecutionTarget;
      trigger?: string;
    }) => apiPost<{ run: Run; sessionId: string; phaseId: string }>(
      '/runs/compliance-readiness-report',
      body,
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
      void qc.invalidateQueries({ queryKey: ['compliance-report-history'] });
    },
  });
};

export const useStartComplianceAssessmentMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scopeId: string;
      framework?: ComplianceFrameworkKey;
      title?: string;
      controlIds?: string[];
      modelId?: string;
      modelCategory?: string;
      executionTarget?: ExecutionTarget;
      trigger?: string;
      focus?: 'assessment' | 'evidence_mapping';
    }) =>
      apiPost<{
        run: Run;
        sessionId: string;
        complianceAssessment: {
          framework: ComplianceFrameworkKey;
          focus?: 'assessment' | 'evidence_mapping';
          selectionMode: 'planner' | 'explicit';
          supportedControlPack: string;
          candidateControlIds: string[];
          candidateProofObligationIds: string[];
          candidateProofObligations: Array<{
            controlId: string;
            title: string;
            implementationSpec: 'required' | 'addressable' | 'mixed' | null;
            pciDssRequirement: string | null;
            pciDssGoal: string | null;
            pciDssApproach: 'defined' | 'customized_eligible' | 'compensating_possible' | null;
            pciDssSaqTypes: string[] | null;
            pciDssCdeScope: 'cde' | 'connected_to' | 'security_impacting' | 'payment_page' | 'program' | null;
            pciDssAccountData: 'chd' | 'sad' | 'pan' | 'none' | null;
            id: string;
            statement: string;
            requiredEvidence: string[];
            acceptedMethods: string[];
          }>;
          controlIds?: string[];
          proofObligationIds?: string[];
          proofObligations?: Array<{
            controlId: string;
            title: string;
            implementationSpec: 'required' | 'addressable' | 'mixed' | null;
            pciDssRequirement: string | null;
            pciDssGoal: string | null;
            pciDssApproach: 'defined' | 'customized_eligible' | 'compensating_possible' | null;
            pciDssSaqTypes: string[] | null;
            pciDssCdeScope: 'cde' | 'connected_to' | 'security_impacting' | 'payment_page' | 'program' | null;
            pciDssAccountData: 'chd' | 'sad' | 'pan' | 'none' | null;
            id: string;
            statement: string;
            requiredEvidence: string[];
            acceptedMethods: string[];
          }>;
        };
      }>('/runs/compliance-assessments', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({ queryKey: ['compliance-readiness'] });
    },
  });
};

export const useCancelRunMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiPost<{ success: boolean }>(`/runs/${runId}/cancel`),
    onSuccess: (_data, runId) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      void qc.invalidateQueries({ queryKey: ['run-events', runId] });
      void qc.invalidateQueries({ queryKey: ['run-activity', runId] });
      void qc.invalidateQueries({ queryKey: ['run-phases', runId] });
    },
  });
};

export const useApproveRunMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiPost<{ success: boolean }>(`/runs/${runId}/approve`),
    onSuccess: (_data, runId) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      void qc.invalidateQueries({ queryKey: ['run-events', runId] });
      void qc.invalidateQueries({ queryKey: ['run-phases', runId] });
    },
  });
};

export const useRejectRunMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiPost<{ success: boolean }>(`/runs/${runId}/reject`),
    onSuccess: (_data, runId) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      void qc.invalidateQueries({ queryKey: ['run-events', runId] });
      void qc.invalidateQueries({ queryKey: ['run-phases', runId] });
    },
  });
};

export const useRequestPlanFeedbackMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, feedback }: { runId: string; feedback: string }) =>
      apiPost<PlanFeedbackResponse>(`/runs/${runId}/plan-feedback`, {
        feedback,
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['run', vars.runId] });
      const previousRun = qc.getQueryData<Run>(['run', vars.runId]);
      if (previousRun) {
        applyRunToCaches(qc, toPlanRevisionRun(previousRun));
      }
      return { previousRun };
    },
    onError: (_error, vars, context) => {
      if (context?.previousRun) {
        applyRunToCaches(qc, context.previousRun);
      }
      void qc.invalidateQueries({ queryKey: ['run', vars.runId] });
    },
    onSuccess: (data, vars) => {
      applyRunToCaches(qc, data.run);
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['run', vars.runId] });
      void qc.invalidateQueries({ queryKey: ['run-events', vars.runId] });
      void qc.invalidateQueries({ queryKey: ['run-phases', vars.runId] });
    },
  });
};

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const useScopesQuery = () => {
  return useQuery({
    queryKey: ['scopes'],
    queryFn: () => apiGet<Scope[]>('/scopes'),
  });
};

export const useScopeDetailQuery = (id: string) => {
  return useQuery({
    queryKey: ['scope', id],
    queryFn: async () => {
      const res = await apiGet<Record<string, unknown>>(`/scopes/${id}`);
      // Backend returns { scope, targets }; keep the scope plus a derived single-target status.
      if (res && typeof res === 'object' && 'scope' in res && res.scope) {
        const scope = res.scope as Scope;
        const targets = (res.targets as unknown[] | undefined) ?? [];
        const exclusions = (res.exclusions as ScopeExclusion[] | undefined) ?? [];
        return { ...scope, targetCount: targets.length, exclusions } as Scope;
      }
      // Flat scope object fallback
      return res as unknown as Scope;
    },
    enabled: !!id,
  });
};

export const useScopeTargetsQuery = (scopeId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['scope-targets', scopeId],
    queryFn: () => apiGet<ScopeTarget[]>(`/scopes/${scopeId}/targets`),
    enabled: (options?.enabled ?? true) && !!scopeId,
  });
};

export interface ScopeEngagementBriefPayload {
  mission?: string | null;
  impactTolerance?: 'non_destructive' | 'poc' | 'full';
  complianceFrameworks?: ComplianceFrameworkKey[] | null;
}

export const useCreateScopeMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body: {
        name: string;
      } & ScopeEngagementBriefPayload & {
        /* Optional targets so create is one atomic request: the scope, its
           targets and the statement commit together or not at all. */
        targets?: Array<{ type: string; value: string; verificationMethod?: string }>;
        authorization?: { accepted: true };
      },
      /* The created targets come back with the scope so onboarding does not
         have to re-query for the verification token it needs next. */
    ) => apiPost<Scope & { targets?: ScopeTarget[] }>('/scopes', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scopes'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useUpdateScopeMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      status?: string;
      /* The scope page stages its edits and commits them here, so one Save is
         one revision of the contract covered by one statement. */
      targets?: {
        add?: Array<{ type: string; value: string; verificationMethod?: string }>;
        remove?: string[];
      };
      exclusions?: {
        add?: Array<{ type: 'domain' | 'cidr'; value: string }>;
        remove?: string[];
      };
      /* Required only when the edit widens what may be tested (adds a root,
         removes an exclusion, raises impact, changes network). Narrowing and
         descriptive edits save without it. */
      authorization?: { accepted: true };
    } & ScopeEngagementBriefPayload) => apiPut<Scope>(`/scopes/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scopes'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
      void qc.invalidateQueries({ queryKey: ['scope-targets'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

// ---------------------------------------------------------------------------
// Scope code source: the folder or git URL Code Review reads
// ---------------------------------------------------------------------------

type CodeSourceResponse = { codeSource: CodeSource | null };

const codeSourceQueryKey = (scopeId: string) => ['scope-code-source', scopeId] as const;

/* A clone runs in the background, so while the source reads `cloning` the
   query asks again every 2 s until it is ready or failed. */
export const useScopeCodeSourceQuery = (scopeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    queryKey: codeSourceQueryKey(scopeId),
    queryFn: async () => (await apiGet<CodeSourceResponse>(`/scopes/${scopeId}/code-source`)).codeSource,
    enabled: (options?.enabled ?? true) && !!scopeId,
    refetchInterval: (query) => (query.state.data?.status === 'cloning' ? 2_000 : false),
  });

/* The scopes carry `codeSource` too (the home reads it there), so every change
   refreshes them as well as the source itself. */
export const invalidateScopeCodeSource = (qc: ReturnType<typeof useQueryClient>, scopeId: string) => {
  void qc.invalidateQueries({ queryKey: ['scopes'] });
  void qc.invalidateQueries({ queryKey: ['scope', scopeId] });
};

const settleCodeSource = (
  qc: ReturnType<typeof useQueryClient>,
  scopeId: string,
  codeSource: CodeSource | null,
) => {
  qc.setQueryData(codeSourceQueryKey(scopeId), codeSource);
  invalidateScopeCodeSource(qc, scopeId);
};

export const useSetScopeCodeSourceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scopeId,
      ...body
    }: {
      scopeId: string;
      kind: CodeSource['kind'];
      location: string;
      ref?: string | null;
    }) => apiPut<CodeSourceResponse>(`/scopes/${scopeId}/code-source`, body),
    onSuccess: (result, { scopeId }) => settleCodeSource(qc, scopeId, result.codeSource),
  });
};

export const useRefreshScopeCodeSourceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scopeId: string) => apiPost<CodeSourceResponse>(`/scopes/${scopeId}/code-source/refresh`),
    onSuccess: (result, scopeId) => settleCodeSource(qc, scopeId, result.codeSource),
  });
};

export const useRemoveScopeCodeSourceMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scopeId: string) => apiDelete<null>(`/scopes/${scopeId}/code-source`),
    onSuccess: (_result, scopeId) => settleCodeSource(qc, scopeId, null),
  });
};

export const useAddTargetMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scopeId,
      type,
      value,
      verificationMethod,
      authorization,
    }: {
      scopeId: string;
      type: string;
      value: string;
      verificationMethod?: string;
      authorization?: { accepted: true };
    }) =>
      apiPost<ScopeTarget>(`/scopes/${scopeId}/targets`, {
        type,
        value,
        ...(verificationMethod ? { verificationMethod } : {}),
        ...(authorization ? { authorization } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scope-targets'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useRemoveTargetMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, targetId }: { scopeId: string; targetId: string }) =>
      apiDelete<void>(`/scopes/${scopeId}/targets/${targetId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scope-targets'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useVerifyTargetMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scopeId,
      targetId,
      method,
    }: {
      scopeId: string;
      targetId: string;
      method?: 'dns_txt' | 'http_well_known';
    }) =>
      apiPost<{ verified: boolean; message: string }>(`/scopes/${scopeId}/verify`, {
        targetId,
        ...(method ? { method } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scope-targets'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useAutoVerifyTargetMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, targetId }: { scopeId: string; targetId: string }) =>
      apiPost<{ verified: boolean; message: string }>(`/scopes/${scopeId}/verify-auto`, { targetId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scope-targets'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export const useOrganizationQuery = () => {
  return useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<Organization>('/organization'),
  });
};

export const useUpdateOrganizationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Organization>) => apiPut<Organization>('/organization', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['organization'] });
    },
  });
};

export const useOrganizationMembersQuery = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['organization-members'],
    queryFn: () => apiGet<OrganizationMember[]>('/organization/members'),
    enabled: options?.enabled ?? true,
  });
};

export const useAuditLogsQuery = (filters: {
  limit?: number;
  action?: string;
  resourceType?: string;
  from?: string;
  to?: string;
}) =>
  useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => apiGet<import('./types').AuditLog[]>('/audit-logs', filters as Record<string, unknown>),
  });

export interface RunnerScopeInfo {
  id: string;
  name: string;
  status: string;
}

export const useRunnersQuery = (filters?: { status?: string; type?: string }, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['runners', filters],
    queryFn: () =>
      apiGet<Runner[]>('/runners', {
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.type ? { type: filters.type } : {}),
      }),
    enabled: options?.enabled ?? true,
  });
};

export const useRunnerDetailQuery = (id: string, options?: { enabled?: boolean; refetchInterval?: number | false }) => {
  return useQuery({
    queryKey: ['runner', id],
    queryFn: () => apiGet<RunnerDetail>(`/runners/${id}`),
    enabled: options?.enabled ?? !!id,
    refetchInterval: options?.refetchInterval ?? false,
  });
};

export const useDeployRunnerMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; type?: 'private'; platform?: string; architecture?: string }) =>
      apiPost<DeployRunnerResponse>('/runners', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
};

export const useUpdateRunnerScopesMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runnerId, scopeIds }: { runnerId: string; scopeIds: string[] }) =>
      apiPut<RunnerDetail>(`/runners/${runnerId}/scopes`, { scopeIds }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['runner', vars.runnerId] });
      void qc.invalidateQueries({ queryKey: ['runners'] });
      void qc.invalidateQueries({ queryKey: ['scopes'] });
      void qc.invalidateQueries({ queryKey: ['scope'] });
    },
  });
};

export const useRotateRunnerTokenMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runnerId: string) =>
      apiPost<{ token: string; installCommand: string }>(`/runners/${runnerId}/rotate-token`),
    onSuccess: (_data, runnerId) => {
      void qc.invalidateQueries({ queryKey: ['runner', runnerId] });
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
  });
};

export const useDeleteRunnerMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runnerId: string) => apiDelete<void>(`/runners/${runnerId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
};

// ---------------------------------------------------------------------------
// Automations (Phase 6)
// ---------------------------------------------------------------------------

export type AutomationTriggerType = 'scheduled' | 'continuous' | 'event';
export type AutomationEventType =
  'finding_created' | 'finding_status_changed' | 'run_completed' | 'asset_discovered' | 'runner_offline';

export type AutomationTriggerConfig =
  | { type: 'scheduled'; cron: string; timezone: string }
  | { type: 'continuous'; intervalMinutes: number }
  | {
      type: 'event';
      eventType: AutomationEventType;
      filter?: Record<string, string>;
    };

export const useAutomationsQuery = (filters?: {
  scopeId?: string;
  isActive?: boolean;
  triggerType?: AutomationTriggerType;
}) => {
  return useQuery({
    queryKey: ['automations', filters],
    queryFn: () =>
      apiGet<Automation[]>('/automations', {
        ...(filters?.scopeId ? { scopeId: filters.scopeId } : {}),
        ...(typeof filters?.isActive === 'boolean' ? { isActive: String(filters.isActive) } : {}),
        ...(filters?.triggerType ? { triggerType: filters.triggerType } : {}),
      }),
  });
};

export const useAutomationDetailQuery = (id: string) => {
  return useQuery({
    queryKey: ['automation', id],
    queryFn: () => apiGet<AutomationDetail>(`/automations/${id}`),
    enabled: !!id,
  });
};

export const useCreateAutomationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      scopeId: string;
      modelId?: string | null;
      modelCategory?: string | null;
      workflowDiscipline?: RunWorkflowDiscipline;
      complianceFrameworkKey?: ComplianceFrameworkKey | null;
      executionTarget?: ExecutionTarget;
      goal: string;
      triggerType: AutomationTriggerType;
      triggerConfig: AutomationTriggerConfig;
      isActive?: boolean;
    }) => apiPost<Automation>('/automations', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useUpdateAutomationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      description?: string;
      scopeId?: string;
      modelId?: string | null;
      modelCategory?: string | null;
      workflowDiscipline?: RunWorkflowDiscipline;
      complianceFrameworkKey?: ComplianceFrameworkKey | null;
      executionTarget?: ExecutionTarget;
      goal?: string;
      triggerType?: AutomationTriggerType;
      triggerConfig?: AutomationTriggerConfig;
      isActive?: boolean;
    }) => apiPut<Automation>(`/automations/${id}`, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['automation', vars.id] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useDeleteAutomationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean }>(`/automations/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useToggleAutomationMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPut<Automation>(`/automations/${id}/toggle`),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['automation', id] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      invalidateSetupReadinessQueries(qc);
    },
  });
};

export const useRunAutomationNowMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<{ run: Run; sessionId: string }>(`/automations/${id}/run-now`),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['automation', id] });
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
};

// ---------------------------------------------------------------------------
// Access Materials (PRD-11)
// ---------------------------------------------------------------------------

export const useScopeAccessMaterialsQuery = (scopeId: string) => {
  return useQuery({
    queryKey: ['access-materials', scopeId],
    queryFn: () => apiGet<ScopeAccessMaterial[]>(`/scopes/${scopeId}/access-materials`),
    enabled: !!scopeId,
  });
};

export const useCreateScopeAccessMaterialMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, ...body }: CreateAccessMaterialPayload & { scopeId: string }) =>
      apiPost<ScopeAccessMaterial>(`/scopes/${scopeId}/access-materials`, body as Record<string, unknown>),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: ['access-materials', vars.scopeId],
      });
      void qc.invalidateQueries({ queryKey: ['scope', vars.scopeId] });
      void qc.invalidateQueries({ queryKey: ['scopes'] });
    },
  });
};

export const useUpdateScopeAccessMaterialMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scopeId,
      materialId,
      ...body
    }: UpdateAccessMaterialPayload & { scopeId: string; materialId: string }) =>
      apiPut<ScopeAccessMaterial>(`/scopes/${scopeId}/access-materials/${materialId}`, body as Record<string, unknown>),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: ['access-materials', vars.scopeId],
      });
    },
  });
};

export const useDeleteScopeAccessMaterialMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, materialId }: { scopeId: string; materialId: string }) =>
      apiDelete<void>(`/scopes/${scopeId}/access-materials/${materialId}`),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: ['access-materials', vars.scopeId],
      });
      void qc.invalidateQueries({ queryKey: ['scope', vars.scopeId] });
      void qc.invalidateQueries({ queryKey: ['scopes'] });
    },
  });
};

// ---------------------------------------------------------------------------
// Threat Watch — exposures
// ---------------------------------------------------------------------------

/**
 * Exposures can be organization-wide or restricted to an active scope.
 *
 * Dashboard and asset views omit `scopeId` because they intentionally use the
 * organization feed. Risks passes the active scope so its exposure and finding
 * inputs describe the same set of assets.
 */
export const useExposuresQuery = (
  filters?: {
    state?: 'open' | ExposureMatchState;
    severity?: string;
    scopeId?: string | null;
  },
  options?: { enabled?: boolean },
) => {
  return useQuery({
    queryKey: ['exposures', filters],
    enabled: options?.enabled ?? true,
    queryFn: () =>
      apiGet<ExposureMatchListResponse>('/exposure', {
        ...(filters?.scopeId ? { scopeId: filters.scopeId } : {}),
        ...(filters?.state ? { state: filters.state } : {}),
        ...(filters?.severity ? { severity: filters.severity } : {}),
      }),
    select: (data) => data.matches,
  });
};

/** One exposure with its advisory, the component we observed, and its timeline. */
export const useExposureDetailQuery = (id: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['exposure', id],
    enabled: !!id && (options?.enabled ?? true),
    queryFn: () => apiGet<ExposureMatchDetailResponse>(`/exposure/${id}`),
  });
};

/**
 * Start a verification run for one exposure.
 *
 * This starts an agent run, which is why it is a deliberate action rather than
 * something the page does on load. Idempotent on the server by match state, so
 * a double-click returns the in-flight run instead of starting a second.
 */
export const useVerifyExposureMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (matchId: string) =>
      apiPost<StartExposureVerificationResponse>(`/exposure/${matchId}/verify`),
    onSuccess: (_data, matchId) => {
      void qc.invalidateQueries({ queryKey: ['exposures'] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['exposure', matchId] });
      // A verification is a run, so the runs list is now stale too.
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
};

/** Close one advisory match without changing the component inventory. */
export const useDismissExposureMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ matchId, reason }: { matchId: string; reason: string }) =>
      apiPost<{ id: string; state: string }>(`/exposure/${matchId}/dismiss`, {
        reason,
      }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['exposures'] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['exposure', variables.matchId] });
    },
  });
};

export type ExposureComponentCorrection = {
  matchId: string;
  action: 'not_present' | 'version_correction';
  reason: string;
  correctedVersion?: string;
};

/** Save an attributed correction to the component belief behind a match. */
export const useCreateExposureOverrideMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ matchId, ...body }: ExposureComponentCorrection) =>
      apiPut<{ reconciliationPending: boolean }>(`/exposure/${matchId}/override`, body),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['exposures'] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['exposure', variables.matchId] });
    },
  });
};

/** Remove a saved component correction and re-evaluate its advisory matches. */
export const useDeleteExposureOverrideMutation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (matchId: string) =>
      apiDelete<{ removed: boolean; reconciliationPending: boolean }>(`/exposure/${matchId}/override`),
    onSuccess: (_data, matchId) => {
      void qc.invalidateQueries({ queryKey: ['exposures'] });
      void qc.invalidateQueries({ queryKey: ['risks'] });
      void qc.invalidateQueries({ queryKey: ['exposure', matchId] });
    },
  });
};
