import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch, authenticatedFormDataFetch } from '@shared/api';

export type SetupReadinessLevel = 'blocked' | 'minimal' | 'ready' | 'optimized';
export type SetupActionStatus = 'required' | 'recommended' | 'complete';
export type SetupRecommendationSurface = 'home' | 'assistant' | 'onboarding';
export type SetupReadinessAction = {
  id:
    | 'add_target'
    | 'verify_target'
    | 'create_automation'
    | 'review_scope';
  title: string;
  description: string;
  status: SetupActionStatus;
  prompt: string;
  href?: string;
  priority?: number;
  reason?: string;
  dismissible?: boolean;
  stateSignature?: string;
  dismissed?: boolean;
  dismissedAt?: string;
};

export type SetupReadinessState = {
  schema: 'nullsquare.setup-readiness.v1';
  generatedAt: string;
  organization: {
    id: string;
    name: string;
  };
  scope: {
    id: string;
    name: string;
    status: string;
  };
  level: SetupReadinessLevel;
  progress: {
    completed: number;
    total: number;
    percent: number;
    label: string;
  };
  counts: {
    targetCount: number;
    verifiedTargetCount: number;
    connectedRepoCount: number;
    accessMaterialCount: number;
    automationCount: number;
    documentCount: number;
  };
  gates: Array<{
    id: string;
    label: string;
    status: 'complete' | 'pending' | 'recommended';
    required: boolean;
    description: string;
  }>;
  recommendations: SetupReadinessAction[];
  nextBestActions: SetupReadinessAction[];
  smartStarters: SetupReadinessAction[];
  dismissedRecommendations: SetupReadinessAction[];
};

export type ScopeDocumentKind = 'policy' | 'roe' | 'access_list' | 'network' | 'prior_report' | 'other';

export type ScopeDocumentSummary = {
  id: string;
  scopeId: string;
  kind: ScopeDocumentKind;
  fileName: string;
  mimeType: string | null;
  byteSize: number;
  sha256: string;
  parseStatus: 'parsed' | 'empty' | 'unsupported' | 'error';
  parseError: string | null;
  textPreview: string | null;
  textTruncated: boolean;
  createdAt: string;
  updatedAt: string;
};

export const setupReadinessQueryKey = (scopeId?: string | null) =>
  ['chat-setup-readiness', scopeId ?? 'none'] as const;

export const useSetupReadinessQuery = (
  scopeId: string | null | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery({
    queryKey: setupReadinessQueryKey(scopeId),
    enabled: (options?.enabled ?? true) && Boolean(scopeId),
    queryFn: () =>
      authenticatedFetch<SetupReadinessState>(
        `/api/app/chat/setup/state?scopeId=${encodeURIComponent(scopeId ?? '')}`,
      ),
    staleTime: 10_000,
  });

export const useDismissSetupRecommendationMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      scopeId: string;
      actionId: SetupReadinessAction['id'];
      stateSignature: string;
      surface?: SetupRecommendationSurface;
    }) =>
      authenticatedFetch<{
        recommendation: SetupReadinessAction;
        state: SetupReadinessState;
      }>(
        `/api/app/chat/setup/recommendations/${encodeURIComponent(params.actionId)}/dismiss`,
        {
          method: 'POST',
          body: JSON.stringify({
            scopeId: params.scopeId,
            stateSignature: params.stateSignature,
            surface: params.surface,
          }),
        },
      ),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(setupReadinessQueryKey(variables.scopeId), result.state);
      void queryClient.invalidateQueries({ queryKey: setupReadinessQueryKey(variables.scopeId) });
    },
  });
};

export const uploadScopeDocument = async (params: {
  scopeId: string;
  file: File;
  kind?: ScopeDocumentKind;
}): Promise<{ document: ScopeDocumentSummary }> => {
  const formData = new FormData();
  formData.append('file', params.file);
  formData.append('kind', params.kind ?? 'other');
  return authenticatedFormDataFetch<{ document: ScopeDocumentSummary }>(
    `/api/app/scopes/${encodeURIComponent(params.scopeId)}/documents`,
    formData,
  );
};
