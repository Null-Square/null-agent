import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  ReactNode,
} from 'react';
import {
  AIChatContextType,
  AIChatMessageInput,
  AIChatMessage,
  ChatSessionSnapshot,
  AIChatConfig,
  PlanItem,
  SessionArtifact,
} from '@/types/chat';
import { configureStore, useSelector } from '@modules/chat/store/store';
import { rootReducer, initialRootState } from '@modules/chat/store/rootReducer';
import type { RootAction, RootState } from '@modules/chat/store/types';
import type { StoreApi } from '@modules/chat/store/store';
import { generateMessageId } from '@modules/chat/store/utils';
import { normalizePlanItems, normalizeTaskSummary, normalizeToolStreams } from '@modules/chat/store/normalizers';
import {
  activityActions,
  configActions,
  messageActions,
  planActions,
  resetFeatureState,
  sessionActions,
  taskActions,
  toolActions,
} from '@modules/chat/store/actions';
import { useChatStreaming } from '@modules/chat/hooks/useChatStreaming';
import { useDerivedSessionTitle } from '@modules/chat/hooks/useDerivedSessionTitle';
import { useStarterPrompt } from '@modules/chat/hooks/useStarterPrompt';
import { useToast } from '@modules/chat/hooks/useToast';
import { useNotifier } from '@shared/hooks/useNotifier';
import { useSessionLifecycle } from '@modules/chat/hooks/useSessionLifecycle';
import { useStreamCoalescer } from '@modules/chat/hooks/useStreamCoalescer';
import { toHydratedMessages } from '@modules/chat/lib/messageUtils';
import {
  buildMessageFingerprint,
  buildPlanFingerprint,
  buildTimelineFingerprint,
  buildToolStreamFingerprint,
  getSessionSnapshotVersion,
  shouldPreferSessionSnapshot,
} from '@modules/chat/lib/sessionSnapshot';
import { useSessionDetailsQuery, useSessionsQuery } from '@modules/sessions';
import { resolveEffectiveSessionRuntime } from '@modules/sessions/lib/sessionStateUtils';
import { logWorkbenchDebug, summarizeSessionSnapshot } from '@shared/lib/workbenchDebug';
import { authenticatedFetch } from '@shared/api';
import { useQueryClient } from '@tanstack/react-query';

export type { AIChatState, AIChatAction } from './chatReducer';
export { aiChatReducer, initialState } from './chatReducer';

const API_DEFAULT_BASE = '';

const resolveApiBase = (): string =>
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
    ? import.meta.env.VITE_API_BASE_URL
    : API_DEFAULT_BASE;

const toSessionUsageConfig = (
  snapshot: ChatSessionSnapshot | undefined,
): AIChatConfig['usage'] | undefined => {
  const usage = snapshot?.usage;
  if (!usage) {
    return undefined;
  }
  const tokensUsed =
    typeof usage.lastTurnInputTokens === 'number'
      ? usage.lastTurnInputTokens
      : usage.promptTokens;
  return {
    tokensUsed,
    contextWindow: usage.contextWindow ?? undefined,
    contextRemaining:
      typeof usage.contextRemaining === 'number'
        ? usage.contextRemaining
        : usage.contextWindow
          ? Math.max(usage.contextWindow - tokensUsed, 0)
          : undefined,
  };
};

type AIChatInternalContext = {
  store: StoreApi;
  sessionId: string;
  readOnlySession: boolean;
  sessionMode: 'interactive' | 'automated' | null;
  runStatus?: string | null;
  desiredExecution: ChatSessionSnapshot['desiredExecution'];
  condition: ChatSessionSnapshot['condition'];
  conditionReason?: string | null;
  workbenchHeaderSlot?: ReactNode;
  executionTarget?: 'cloud' | 'scope_runner';
  runnerId?: string | null;
  runnerName?: string | null;
  coordination?: import('@/types/chat').SessionCoordination;
  workerTasks?: import('@/types/chat').WorkerTaskRecord[];
  workerResult?: import('@/types/chat').WorkerResultArtifact;
  artifacts?: SessionArtifact[];
  actions: {
    addMessage: (message: AIChatMessageInput) => string;
    sendPrompt: (prompt: string) => Promise<void>;
    abortTurn: () => Promise<void>;
    clearMessages: () => Promise<string>;
    approvePendingAction: (actionId: string) => Promise<void>;
    denyPendingAction: (actionId: string, reason?: string) => Promise<void>;
  };
  toastMessage?: string;
  clearToast: () => void;
  usageForConfig?: {
    contextWindow?: number;
  };
};

const AIChatContext = createContext<AIChatInternalContext | null>(null);

interface AIChatProviderProps {
  children: ReactNode;
  sessionId?: string;
  runStatus?: string | null;
  configOverride?: Partial<AIChatConfig>;
  initialPlan?: PlanItem[];
  initialMessages?: AIChatMessage[];
  deleteSessionOnUnmount?: boolean;
  syncSessionList?: boolean;
  readOnlySession?: boolean;
  workbenchHeaderSlot?: ReactNode;
}

export const AIChatProvider: React.FC<AIChatProviderProps> = ({
  children,
  sessionId,
  runStatus,
  configOverride,
  initialPlan,
  initialMessages,
  deleteSessionOnUnmount = false,
  syncSessionList = true,
  readOnlySession = false,
  workbenchHeaderSlot,
}) => {
  const { store, dispatch } = useMemo(
    () => configureStore(initialRootState, rootReducer),
    [],
  );
  const queryClient = useQueryClient();
  const [currentSessionId, setCurrentSessionId] = useState<string>(sessionId ?? '');
  const [sessionMode, setSessionMode] = useState<'interactive' | 'automated' | null>(null);
  const [preferredSessionSnapshot, setPreferredSessionSnapshot] = useState<ChatSessionSnapshot | undefined>(undefined);
  const previousSessionIdRef = React.useRef(currentSessionId);
  const appliedSnapshotVersionRef = React.useRef<number>(-1);

  // Preload sessions list via react-query so sidebar/other components stay in sync
  useSessionsQuery({ enabled: syncSessionList && !readOnlySession });
  const {
    data: currentSessionSnapshot,
    refetch: refetchCurrentSessionSnapshot,
  } = useSessionDetailsQuery(currentSessionId || undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    setCurrentSessionId(sessionId ?? '');
  }, [sessionId]);

  useEffect(() => {
    if (previousSessionIdRef.current === currentSessionId) {
      return;
    }
    logWorkbenchDebug('session.changed', {
      previousSessionId: previousSessionIdRef.current || null,
      currentSessionId: currentSessionId || null,
    });
    previousSessionIdRef.current = currentSessionId;
    appliedSnapshotVersionRef.current = -1;
    setPreferredSessionSnapshot(undefined);
    dispatch(resetFeatureState());
    if (!currentSessionId) {
      setSessionMode(null);
    }
  }, [currentSessionId, dispatch]);

  useEffect(() => {
    if (initialPlan && initialPlan.length > 0) {
      dispatch(planActions.setPlan(initialPlan));
    }
  }, [dispatch, initialPlan]);

  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      initialMessages.forEach((message) =>
        dispatch(
          messageActions.addMessage({
            id: message.id,
            role: message.role,
            content: message.content,
            status: message.status ?? 'sent',
            timestamp: message.timestamp ?? new Date(),
          }),
        ),
      );
    }
  }, [dispatch, initialMessages]);

  useEffect(() => {
    if (!currentSessionId) {
      setPreferredSessionSnapshot(undefined);
      return;
    }
    if (!currentSessionSnapshot || currentSessionSnapshot.id !== currentSessionId) {
      return;
    }
    setPreferredSessionSnapshot((previous) => {
      const shouldAdopt = shouldPreferSessionSnapshot(previous, currentSessionSnapshot);
      logWorkbenchDebug(shouldAdopt ? 'snapshot.adopted' : 'snapshot.ignored', {
        currentSessionId,
        incoming: summarizeSessionSnapshot(currentSessionSnapshot),
        previous: summarizeSessionSnapshot(previous),
      });
      return shouldAdopt ? currentSessionSnapshot : previous;
    });
  }, [currentSessionId, currentSessionSnapshot]);

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }
    logWorkbenchDebug('snapshot.refetch.requested', { currentSessionId });
    void refetchCurrentSessionSnapshot()
      .then((result) => {
        logWorkbenchDebug('snapshot.refetch.resolved', {
          currentSessionId,
          hasData: Boolean(result.data),
          snapshot: summarizeSessionSnapshot(result.data),
        });
      })
      .catch((error: unknown) => {
        logWorkbenchDebug('snapshot.refetch.failed', {
          currentSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [currentSessionId, refetchCurrentSessionSnapshot]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getState = useCallback(() => store.getState(), [store]);

  const rootState = useSyncExternalStore<RootState>(subscribe, getState, getState);
  const usageForConfig = useMemo(() => rootState.config.value?.usage, [rootState.config.value]);

  const dispatchMany = useCallback(
    (actions: RootAction[]) => {
      actions.forEach(dispatch);
    },
    [dispatch],
  );
  // Stream coalescers - extracted to useStreamCoalescer hook
  const {
    tokenCoalescer,
    toolCoalescer,
    flushCoalescedUpdates,
    resetCoalescers,
  } = useStreamCoalescer({ dispatch });

  const apiBase = useMemo(resolveApiBase, []);

  const { toastMessage, pushToast, clearToast } = useToast();
  const notifier = useNotifier();

  const addMessage = useCallback(
    (message: AIChatMessageInput): string => {
      const id = message.id ?? generateMessageId();
      dispatch(
        messageActions.addMessage({
          id,
          role: message.role,
          content: message.content ?? '',
          status: message.status ?? 'sent',
          timestamp: message.timestamp ?? new Date(),
        }),
      );
      return id;
    },
    [dispatch],
  );

  const {
    connectStream,
    disconnectStream,
    assistantMessageRef,
    pendingUserMessagesRef,
  } = useChatStreaming({
    apiBase,
    addMessage,
    dispatch,
    dispatchMany,
    pushToast,
    tokenCoalescer,
    toolCoalescer,
    flushCoalescedUpdates,
    resetCoalescers,
    createId: generateMessageId,
    normalizeTaskSummary,
    syncSessionList,
  });

  const effectiveSessionSnapshot = preferredSessionSnapshot ?? currentSessionSnapshot;
  const executionReadModel = useMemo(
    () => resolveEffectiveSessionRuntime({
      desiredExecution: effectiveSessionSnapshot?.desiredExecution,
      condition: effectiveSessionSnapshot?.condition,
      conditionReason: effectiveSessionSnapshot?.conditionReason,
      status: effectiveSessionSnapshot?.status ?? rootState.session.status,
      pauseReason: effectiveSessionSnapshot?.pause_reason ?? rootState.session.pauseReason,
      interactionType: effectiveSessionSnapshot?.interaction_type ?? rootState.session.interactionType,
      blockedReason: effectiveSessionSnapshot?.blocked_reason ?? rootState.session.blockedReason,
    }),
    [
      effectiveSessionSnapshot?.blocked_reason,
      effectiveSessionSnapshot?.condition,
      effectiveSessionSnapshot?.conditionReason,
      effectiveSessionSnapshot?.desiredExecution,
      effectiveSessionSnapshot?.interaction_type,
      effectiveSessionSnapshot?.pause_reason,
      effectiveSessionSnapshot?.status,
      rootState.session.blockedReason,
      rootState.session.interactionType,
      rootState.session.pauseReason,
      rootState.session.status,
    ],
  );

  useEffect(() => {
    if (!effectiveSessionSnapshot) {
      return;
    }
    logWorkbenchDebug('snapshot.effective', summarizeSessionSnapshot(effectiveSessionSnapshot));
  }, [effectiveSessionSnapshot]);

  useEffect(() => {
    if (!effectiveSessionSnapshot) {
      return;
    }

    setSessionMode(effectiveSessionSnapshot.mode ?? null);

    const effectiveRuntime = resolveEffectiveSessionRuntime({
      desiredExecution: effectiveSessionSnapshot.desiredExecution,
      condition: effectiveSessionSnapshot.condition,
      conditionReason: effectiveSessionSnapshot.conditionReason,
      status: effectiveSessionSnapshot.status,
      pauseReason: effectiveSessionSnapshot.pause_reason ?? null,
      interactionType: effectiveSessionSnapshot.interaction_type ?? 'none',
      blockedReason: effectiveSessionSnapshot.blocked_reason ?? null,
      isTerminal: effectiveSessionSnapshot.completed === true,
    });
    const snapshotVersion = getSessionSnapshotVersion(effectiveSessionSnapshot);
    const nextStatus = effectiveRuntime.status;
    if (nextStatus) {
      if (typeof effectiveSessionSnapshot.version === 'number') {
        dispatch(
          sessionActions.setStatusWithVersion(
            nextStatus as Parameters<typeof sessionActions.setSessionStatus>[0],
            effectiveSessionSnapshot.version,
            effectiveRuntime.pauseReason,
            effectiveRuntime.interactionType,
          ),
        );
      } else {
        dispatch(sessionActions.setSessionStatus(nextStatus as Parameters<typeof sessionActions.setSessionStatus>[0]));
      }
    }
    if (snapshotVersion >= rootState.session.statusVersion) {
      dispatch(
        sessionActions.setPauseMeta(
          effectiveRuntime.pauseReason,
          effectiveRuntime.interactionType,
          effectiveRuntime.blockedReason,
        ),
      );
    }
    const snapshotUsage = toSessionUsageConfig(effectiveSessionSnapshot);
    if (snapshotUsage) {
      dispatch(configActions.setUsage(snapshotUsage));
    }
    if ('pendingApproval' in effectiveSessionSnapshot) {
      dispatch(sessionActions.setPendingApproval(effectiveSessionSnapshot.pendingApproval ?? null));
    }
  }, [effectiveSessionSnapshot, dispatch, rootState.session.statusVersion]);

  useEffect(() => {
    if (!currentSessionId || !effectiveSessionSnapshot) {
      return;
    }
    const snapshotVersion = getSessionSnapshotVersion(effectiveSessionSnapshot);
    const highestAppliedVersion = appliedSnapshotVersionRef.current;
    if (snapshotVersion < highestAppliedVersion) {
      return;
    }

    const hydratedMessages = toHydratedMessages(effectiveSessionSnapshot.messages ?? []);
    const hydratedPlan = normalizePlanItems(effectiveSessionSnapshot.plan ?? []);
    const hydratedToolStreams = normalizeToolStreams(effectiveSessionSnapshot.liveToolStreams);
    const hydratedTask = normalizeTaskSummary(
      (effectiveSessionSnapshot.task as Record<string, unknown> | undefined) ?? undefined,
    );
    const hydratedTimeline = effectiveSessionSnapshot.timeline ?? [];

    const currentMessages = rootState.messages.items;
    const currentPlan = rootState.plan.items;
    const currentToolStreams = rootState.tools.streams;
    const currentTask = rootState.task.current;
    const currentTimeline = rootState.activity.entries;

    const hasPendingLocalMessages = currentMessages.some((message) => message.status === 'sending');
    const currentMessageFingerprint = buildMessageFingerprint(currentMessages);
    const snapshotMessageFingerprint = buildMessageFingerprint(hydratedMessages);
    const currentPlanFingerprint = buildPlanFingerprint(currentPlan);
    const snapshotPlanFingerprint = buildPlanFingerprint(hydratedPlan);
    const currentToolFingerprint = buildToolStreamFingerprint(currentToolStreams);
    const snapshotToolFingerprint = buildToolStreamFingerprint(hydratedToolStreams);
    const currentTaskFingerprint = currentTask ? JSON.stringify(currentTask) : '';
    const snapshotTaskFingerprint = hydratedTask ? JSON.stringify(hydratedTask) : '';
    const currentTimelineFingerprint = buildTimelineFingerprint(currentTimeline);
    const snapshotTimelineFingerprint = buildTimelineFingerprint(hydratedTimeline);

    const canHydrateMessages =
      hydratedMessages.length > 0 &&
      (
        currentMessages.length === 0 ||
        hydratedMessages.length > currentMessages.length ||
        (!hasPendingLocalMessages &&
          snapshotMessageFingerprint !== currentMessageFingerprint &&
          snapshotVersion > highestAppliedVersion &&
          hydratedMessages.length >= currentMessages.length)
      );
    logWorkbenchDebug('snapshot.hydrate.evaluate', {
      currentSessionId,
      snapshotVersion,
      highestAppliedVersion,
      currentMessages: currentMessages.length,
      snapshotMessages: hydratedMessages.length,
      currentPlan: currentPlan.length,
      snapshotPlan: hydratedPlan.length,
      currentToolStreams: Object.keys(currentToolStreams).length,
      snapshotToolStreams: Object.keys(hydratedToolStreams).length,
      currentTimeline: currentTimeline.length,
      snapshotTimeline: hydratedTimeline.length,
      hasCurrentTask: Boolean(currentTask),
      hasSnapshotTask: Boolean(hydratedTask),
      canHydrateMessages,
    });
    if (canHydrateMessages) {
      logWorkbenchDebug('snapshot.hydrate.messages', {
        currentSessionId,
        count: hydratedMessages.length,
      });
      dispatch(messageActions.setMessages(hydratedMessages));
    }

    if (
      snapshotPlanFingerprint !== currentPlanFingerprint &&
      (
        hydratedPlan.length > 0 ||
        (currentPlan.length === 0 && snapshotVersion >= highestAppliedVersion)
      )
    ) {
      const canHydratePlan =
        currentPlan.length === 0 ||
        hydratedPlan.length > currentPlan.length ||
        (snapshotVersion > highestAppliedVersion &&
          hydratedPlan.length >= currentPlan.length);
      if (canHydratePlan) {
        logWorkbenchDebug('snapshot.hydrate.plan', {
          currentSessionId,
          count: hydratedPlan.length,
        });
        dispatch(planActions.setPlan(hydratedPlan));
      }
    }

    if (
      snapshotToolFingerprint !== currentToolFingerprint &&
      (
        Object.keys(hydratedToolStreams).length > 0 ||
        (Object.keys(currentToolStreams).length === 0 && snapshotVersion >= highestAppliedVersion)
      )
    ) {
      const currentToolCount = Object.keys(currentToolStreams).length;
      const snapshotToolCount = Object.keys(hydratedToolStreams).length;
      const canHydrateTools =
        currentToolCount === 0 ||
        snapshotToolCount > currentToolCount ||
        (snapshotVersion > highestAppliedVersion &&
          snapshotToolCount >= currentToolCount);
      if (canHydrateTools) {
        logWorkbenchDebug('snapshot.hydrate.tools', {
          currentSessionId,
          count: Object.keys(hydratedToolStreams).length,
        });
        dispatch(toolActions.hydrateToolStreams(hydratedToolStreams));
      }
    }

    if (
      snapshotTimelineFingerprint !== currentTimelineFingerprint &&
      (
        hydratedTimeline.length > 0 ||
        (currentTimeline.length === 0 && snapshotVersion >= highestAppliedVersion)
      )
    ) {
      const canHydrateTimeline =
        currentTimeline.length === 0 ||
        hydratedTimeline.length > currentTimeline.length ||
        (snapshotVersion > highestAppliedVersion &&
          hydratedTimeline.length >= currentTimeline.length);
      if (canHydrateTimeline) {
        logWorkbenchDebug('snapshot.hydrate.timeline', {
          currentSessionId,
          count: hydratedTimeline.length,
        });
        dispatch(activityActions.hydrateActivity(hydratedTimeline));
      }
    }

    if (
      snapshotTaskFingerprint !== currentTaskFingerprint &&
      (hydratedTask || (!currentTask && snapshotVersion >= highestAppliedVersion))
    ) {
      logWorkbenchDebug('snapshot.hydrate.task', {
        currentSessionId,
        hasTask: Boolean(hydratedTask),
      });
      dispatch(taskActions.setTask(hydratedTask));
    }

    appliedSnapshotVersionRef.current = Math.max(highestAppliedVersion, snapshotVersion);
  }, [
    currentSessionId,
    effectiveSessionSnapshot,
    dispatch,
    rootState.activity.entries,
    rootState.messages.items,
    rootState.plan.items,
    rootState.task,
    rootState.tools.streams,
  ]);

  // Apply external config overrides to store (e.g., plan gating)
  const prevConfigJsonRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!configOverride) return;
    const nextJson = JSON.stringify(configOverride);
    if (prevConfigJsonRef.current === nextJson) return;
    prevConfigJsonRef.current = nextJson;
    dispatch(configActions.setConfig(configOverride));
  }, [configOverride, dispatch]);

  useEffect(() => {
    if (!currentSessionId) {
      disconnectStream();
      return;
    }
    if (readOnlySession) {
      disconnectStream();
      return;
    }
    connectStream(currentSessionId);
  }, [connectStream, currentSessionId, disconnectStream, readOnlySession]);

  const {
    sendPrompt,
    abortTurn,
    clearMessages,
  } = useSessionLifecycle({
    currentSessionId,
    setCurrentSessionId,
    setSessionMode,
    dispatch,
    connectStream,
    disconnectStream,
    isLoading: rootState.session.isLoading,
    sessionMode,
    desiredExecution: executionReadModel.desiredExecution,
    condition: executionReadModel.condition,
    blockedReason: rootState.session.blockedReason,
    isAborting: rootState.session.isAborting,
    addMessage,
    pendingUserMessagesRef,
    assistantMessageRef,
    flushCoalescedUpdates,
    resetCoalescers,
    pushToast: notifier.error,
    clearToast,
    generateId: generateMessageId,
    syncSessionList: syncSessionList && !readOnlySession,
  });

  const approvePendingAction = useCallback(
    async (actionId: string): Promise<void> => {
      if (!currentSessionId) {
        return;
      }
      if (readOnlySession) {
        return;
      }

      await authenticatedFetch(`/api/ai-agent/sessions/${currentSessionId}/approve`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': `approve:${actionId}`,
        },
        body: JSON.stringify({ actionId }),
      });
      dispatch(sessionActions.clearPendingApproval(actionId));
      queryClient.invalidateQueries({ queryKey: ['ai-agent-session', currentSessionId] });
      queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
      void refetchCurrentSessionSnapshot();
    },
    [currentSessionId, dispatch, queryClient, readOnlySession, refetchCurrentSessionSnapshot],
  );

  const denyPendingAction = useCallback(
    async (actionId: string, reason?: string): Promise<void> => {
      if (!currentSessionId) {
        return;
      }
      if (readOnlySession) {
        return;
      }

      await authenticatedFetch(`/api/ai-agent/sessions/${currentSessionId}/deny`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': `deny:${actionId}`,
        },
        body: JSON.stringify({ actionId, ...(reason ? { reason } : {}) }),
      });
      dispatch(sessionActions.clearPendingApproval(actionId));
      queryClient.invalidateQueries({ queryKey: ['ai-agent-session', currentSessionId] });
      queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
      void refetchCurrentSessionSnapshot();
    },
    [currentSessionId, dispatch, queryClient, readOnlySession, refetchCurrentSessionSnapshot],
  );

  useDerivedSessionTitle({
    sessionId: currentSessionId,
    messages: rootState.messages.items,
    task: rootState.task.current,
    enabled: syncSessionList && !readOnlySession,
  });

  useEffect(() => {
    if (syncSessionList || !currentSessionId) {
      return;
    }
    queryClient.setQueryData<{ id: string }[] | undefined>(
      ['ai-agent-sessions'],
      (previous) => previous?.filter((session) => session.id !== currentSessionId) ?? previous,
    );
  }, [currentSessionId, queryClient, syncSessionList]);

  useStarterPrompt({
    currentSessionId,
    starterPrompt: rootState.task.starterPrompt,
    messages: rootState.messages.items.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    sendPrompt,
    dispatch,
  });

  const actionsApi = useMemo<AIChatInternalContext['actions']>(
    () => ({
      addMessage,
      sendPrompt: readOnlySession
        ? async () => {}
        : sendPrompt,
      abortTurn: readOnlySession
        ? async () => {}
        : abortTurn,
      clearMessages: readOnlySession
        ? async () => currentSessionId
        : clearMessages,
      approvePendingAction,
      denyPendingAction,
    }),
    [
      abortTurn,
      addMessage,
      approvePendingAction,
      clearMessages,
      currentSessionId,
      denyPendingAction,
      readOnlySession,
      sendPrompt,
    ],
  );

  const contextValue = useMemo<AIChatInternalContext>(
    () => ({
      store,
      sessionId: currentSessionId,
      readOnlySession,
      sessionMode,
      runStatus,
      desiredExecution: executionReadModel.desiredExecution,
      condition: executionReadModel.condition,
      conditionReason: executionReadModel.conditionReason,
      workbenchHeaderSlot,
      executionTarget: effectiveSessionSnapshot?.executionTarget,
      runnerId: effectiveSessionSnapshot?.runnerId ?? null,
      runnerName: effectiveSessionSnapshot?.runnerName ?? null,
      coordination: effectiveSessionSnapshot?.coordination,
      workerTasks: effectiveSessionSnapshot?.workerTasks,
      workerResult: effectiveSessionSnapshot?.workerResult,
      artifacts: effectiveSessionSnapshot?.artifacts,
      actions: actionsApi,
      toastMessage,
      clearToast,
      usageForConfig,
    }),
    [
      actionsApi,
      effectiveSessionSnapshot?.executionTarget,
      executionReadModel.condition,
      executionReadModel.conditionReason,
      executionReadModel.desiredExecution,
      effectiveSessionSnapshot?.runnerId,
      effectiveSessionSnapshot?.runnerName,
      effectiveSessionSnapshot?.coordination,
      effectiveSessionSnapshot?.workerTasks,
      effectiveSessionSnapshot?.workerResult,
      effectiveSessionSnapshot?.artifacts,
      clearToast,
      currentSessionId,
      runStatus,
      sessionMode,
      readOnlySession,
      usageForConfig,
      store,
      toastMessage,
      workbenchHeaderSlot,
    ],
  );

  useEffect(() => {
    return () => {
      if (deleteSessionOnUnmount && currentSessionId && !readOnlySession) {
        void authenticatedFetch(`/api/ai-agent/sessions/${currentSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      if (currentSessionId && deleteSessionOnUnmount) {
        queryClient.removeQueries({ queryKey: ['ai-agent-session', currentSessionId] });
      }
      if (!syncSessionList && currentSessionId) {
        queryClient.setQueryData<{ id: string }[] | undefined>(
          ['ai-agent-sessions'],
          (previous) => previous?.filter((session) => session.id !== currentSessionId) ?? previous,
        );
      }
      disconnectStream();
      resetCoalescers();
    };
  }, [
    currentSessionId,
    deleteSessionOnUnmount,
    disconnectStream,
    queryClient,
    readOnlySession,
    resetCoalescers,
    syncSessionList,
  ]);

  return <AIChatContext.Provider value={contextValue}>{children}</AIChatContext.Provider>;
};

export const useAIChat = (): AIChatContextType => {
  const context = useContext(AIChatContext);
  if (!context) {
    throw new Error('useAIChat must be used within an AIChatProvider');
  }

  const {
    store,
    sessionId,
    readOnlySession,
    sessionMode,
    runStatus,
    desiredExecution,
    condition,
    conditionReason,
    workbenchHeaderSlot,
    executionTarget,
    runnerId,
    runnerName,
    coordination,
    workerTasks,
    workerResult,
    actions,
    toastMessage,
    clearToast,
    artifacts,
    usageForConfig,
  } = context;

  const messages = useSelector(store, (root) => root.messages.items);
  const plan = useSelector(store, (root) => root.plan.items);
  const toolStreams = useSelector(store, (root) => root.tools.streams);
  const activity = useSelector(store, (root) => root.activity.entries);
  const config = useSelector(store, (root) => root.config.value);
  const isLoading = useSelector(store, (root) => root.session.isLoading);
  const sessionStatus = useSelector(store, (root) => root.session.status);
  const pauseReason = useSelector(store, (root) => root.session.pauseReason);
  const interactionType = useSelector(store, (root) => root.session.interactionType);
  const blockedReason = useSelector(store, (root) => root.session.blockedReason);
  const isAborting = useSelector(store, (root) => root.session.isAborting);
  const sandboxPolicy = useSelector(store, (root) => root.session.sandboxPolicy);
  const pendingApproval = useSelector(store, (root) => root.session.pendingApproval);
  const streamConnected = useSelector(store, (root) => root.session.streamConnected);
  const lastStreamActivityAt = useSelector(store, (root) => root.session.lastStreamActivityAt);
  const lastStreamPingAt = useSelector(store, (root) => root.session.lastStreamPingAt);
  const task = useSelector(store, (root) => root.task.current);
  const starterPrompt = useSelector(store, (root) => root.task.starterPrompt);
  return {
    messages,
    config: {
      ...config,
      usage: {
        ...(config?.usage ?? {}),
        ...(usageForConfig ?? {}),
      },
    },
    isLoading,
    sessionId,
    readOnlySession,
    sessionMode,
    runStatus,
    workbenchHeaderSlot,
    executionTarget,
    runnerId,
    runnerName,
    coordination,
    workerTasks,
    workerResult,
    artifacts,
    pendingApproval,
    sessionStatus,
    desiredExecution,
    condition,
    conditionReason,
    pauseReason,
    interactionType,
    blockedReason,
    isAborting,
    sandboxPolicy,
    plan,
    toolStreams,
    timeline: activity,
    activity,
    task,
    streamConnected,
    lastStreamActivityAt,
    lastStreamPingAt,
    starterPrompt,
    addMessage: actions.addMessage,
    sendPrompt: actions.sendPrompt,
    abortTurn: actions.abortTurn,
    clearMessages: actions.clearMessages,
    approvePendingAction: actions.approvePendingAction,
    denyPendingAction: actions.denyPendingAction,
    toastMessage,
    clearToast,
  };
};

export const useAIChatContext = (): AIChatInternalContext | null => useContext(AIChatContext);

export default AIChatProvider;







