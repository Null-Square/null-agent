import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { fetchApi } from '@shared/api';
import type { RiskListItem, Run } from './types';
import {
  useCreateAutomationMutation,
  useDismissExposureMutation,
  useRiskSummaryQuery,
  useRequestPlanFeedbackMutation,
  useRisksQuery,
  getRunListRefetchInterval,
  useUpdateFindingMutation,
  useVerifyTargetMutation,
} from './api';

vi.mock('@shared/api', () => ({
  fetchApi: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const makeRun = (overrides: Partial<Run> = {}): Run =>
  ({
    id: 'run-1',
    organizationId: 'org-1',
    scopeId: 'scope-1',
    userId: 'user-1',
    sessionId: 'planner-session',
    plannerSessionId: 'planner-session',
    executorSessionId: null,
    activeSessionId: 'planner-session',
    title: 'Assessment',
    goal: 'Assess API auth flow',
    plan: '# Existing Plan',
    status: 'paused',
    pauseReason: 'approval',
    interactionType: 'plan_approval',
    awaitingPlanApproval: true,
    trigger: 'manual',
    runnerId: null,
    findingsCount: 0,
    highSeverityCount: 0,
    startedAt: '2026-05-03T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }) as Run;

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

const createWrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

describe('run list lifecycle polling', () => {
  it('polls cached active runs and stops after the backend reports a terminal state', () => {
    expect(getRunListRefetchInterval([makeRun({ status: 'running' })])).toBe(5_000);
    expect(getRunListRefetchInterval([makeRun({ status: 'queued' })])).toBe(5_000);
    expect(getRunListRefetchInterval([makeRun({ status: 'paused' })])).toBe(5_000);
    expect(getRunListRefetchInterval([makeRun({ status: 'failed' })])).toBe(false);
    expect(getRunListRefetchInterval([makeRun({ status: 'completed' })])).toBe(false);
    expect(getRunListRefetchInterval([])).toBe(false);
  });
});

describe('useRequestPlanFeedbackMutation', () => {
  it('optimistically switches plan approval UI state to planner revision state', async () => {
    const queryClient = createQueryClient();
    const previousRun = makeRun();
    const responseRun = makeRun({
      status: 'running',
      pauseReason: null,
      interactionType: 'none',
      awaitingPlanApproval: false,
    });

    queryClient.setQueryData(['run', 'run-1'], previousRun);
    queryClient.setQueryData(['runs'], [previousRun]);

    let resolvePost!: (value: { data: { success: true; run: Run; plannerSessionId: string } }) => void;
    vi.mocked(fetchApi.post).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve as typeof resolvePost;
        }),
    );

    const { result } = renderHook(() => useRequestPlanFeedbackMutation(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({
        runId: 'run-1',
        feedback: 'Narrow the plan to auth flows.',
      });
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<Run>(['run', 'run-1'])?.status).toBe('running');
    });
    expect(queryClient.getQueryData<Run>(['run', 'run-1'])).toMatchObject({
      pauseReason: null,
      interactionType: 'none',
      awaitingPlanApproval: false,
    });
    expect(queryClient.getQueryData<Run[]>(['runs'])?.[0]).toMatchObject({
      status: 'running',
      awaitingPlanApproval: false,
    });

    act(() => {
      resolvePost({
        data: {
          success: true,
          run: responseRun,
          plannerSessionId: 'planner-session',
        },
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(queryClient.getQueryData<Run>(['run', 'run-1'])).toMatchObject({
      status: 'running',
      awaitingPlanApproval: false,
    });
  });
});

describe('setup readiness invalidation', () => {
  it('refreshes assistant setup state after target verification', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(fetchApi.post).mockResolvedValueOnce({
      data: { verified: true, message: 'Verified' },
      status: 200,
      statusText: 'OK',
    });

    const { result } = renderHook(() => useVerifyTargetMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        scopeId: 'scope-1',
        targetId: 'target-1',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['chat-setup-readiness'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['scope'] });
  });

  it('refreshes assistant setup state after automation creation', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(fetchApi.post).mockResolvedValueOnce({
      data: { id: 'automation-1', scopeId: 'scope-1', name: 'Weekly checks' },
      status: 201,
      statusText: 'Created',
    });

    const { result } = renderHook(() => useCreateAutomationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        name: 'Weekly checks',
        scopeId: 'scope-1',
        goal: 'Run safe recurring checks.',
        triggerType: 'scheduled',
        triggerConfig: {
          type: 'scheduled',
          cron: '0 9 * * 1',
          timezone: 'UTC',
        },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['chat-setup-readiness'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['automations'] });
  });
});

describe('risk summary invalidation', () => {
  it('refreshes Risks after a finding state changes', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(fetchApi.patch).mockResolvedValueOnce({
      data: { id: 'finding-1' },
      status: 200,
      statusText: 'OK',
    });

    const { result } = renderHook(() => useUpdateFindingMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ id: 'finding-1', state: 'accepted' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['risks'] });
  });

  it('refreshes Risks after an exposure state changes', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(fetchApi.post).mockResolvedValueOnce({
      data: { id: 'exposure-1', state: 'dismissed' },
      status: 200,
      statusText: 'OK',
    });

    const { result } = renderHook(() => useDismissExposureMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        matchId: 'exposure-1',
        reason: 'Not installed',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['risks'] });
  });
});

describe('useRisksQuery', () => {
  it('reads the final risk list from one backend endpoint', async () => {
    const queryClient = createQueryClient();
    const risk: RiskListItem = {
      key: 'finding:finding-1',
      id: 'finding-1',
      recordKind: 'finding',
      title: 'Cross-tenant export',
      subtitle: 'Production',
      severity: 'critical',
      state: 'confirmed',
      assetValue: 'jobs.example.com',
      cvssScore: 9.1,
    };
    vi.mocked(fetchApi.get).mockResolvedValueOnce({
      data: {
        risks: [risk],
        summary: {
          total: 1,
          open: 1,
          openKev: 0,
          byState: { confirmed: 1 },
          bySeverity: { critical: 1 },
          openBySeverity: { critical: 1 },
        },
      },
      status: 200,
      statusText: 'OK',
    });

    const { result } = renderHook(() => useRisksQuery('scope-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual([risk]));
    expect(fetchApi.get).toHaveBeenCalledWith('/app/risks', {
      params: { scopeId: 'scope-1' },
    });
  });

  it('reads the exact risk summary from the same cached response', async () => {
    const queryClient = createQueryClient();
    const summary = {
      total: 4,
      open: 3,
      openKev: 1,
      byState: {
        potential: 1,
        verifying: 0,
        confirmed: 2,
        not_reproduced: 0,
        dismissed: 0,
        resolved: 1,
        accepted: 0,
      },
      bySeverity: { critical: 2, high: 2 },
      openBySeverity: { critical: 2, high: 1 },
    };
    vi.mocked(fetchApi.get).mockResolvedValueOnce({
      data: { risks: [], summary },
      status: 200,
      statusText: 'OK',
    });

    const { result } = renderHook(() => useRiskSummaryQuery('scope-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(summary));
    expect(fetchApi.get).toHaveBeenCalledWith('/app/risks', {
      params: { scopeId: 'scope-1' },
    });
  });

  it('does not fetch a risk summary for a disabled consumer', () => {
    const queryClient = createQueryClient();
    vi.mocked(fetchApi.get).mockClear();

    renderHook(() => useRiskSummaryQuery('scope-1', { enabled: false }), {
      wrapper: createWrapper(queryClient),
    });

    expect(fetchApi.get).not.toHaveBeenCalled();
  });
});
