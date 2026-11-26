import { useCallback, useRef } from 'react';
import type {
  AIChatMessageInput,
  TaskSummary,
  ChatSessionSnapshot,
  PlanItem,
  TimelineEntry,
  ToolStreamState,
} from '@/types/chat';
import type { Dispatch } from '@modules/chat/store/store';
import type { RootAction } from '@modules/chat/store/types';
import {
  checkpointCreatedFromServer,
  checkpointRestoredFromServer,
  doneFromServer,
  errorFromServer,
  planStepStartedFromServer,
  planStepUpdatedFromServer,
  planTurnComplete,
  planUpdateFromServer,
  taskSelectedFromServer,
  toolResultFromServer,
  toolStartedFromServer,
  abortedFromServer,
  sandboxPolicyFromServer,
  usageRecordedFromServer,
  contextEstimateFromServer,
  timelineEventFromServer,
} from '@modules/chat/store/events';
import { messageActions, sessionActions } from '@modules/chat/store/actions';
import type { Coalescer } from '@modules/chat/store/coalesce';
import { decodeSseChunk } from '@modules/chat/store/streamUtils';
import { useQueryClient } from '@tanstack/react-query';
import { toApiError } from '@/shared/lib/apiError';
import { shouldPreferSessionSnapshot } from '@modules/chat/lib/sessionSnapshot';
import { logWorkbenchDebug, summarizeSessionSnapshot } from '@shared/lib/workbenchDebug';

const swallowError = (): void => {};
export interface UseChatStreamingOptions {
  apiBase: string;
  addMessage: (message: AIChatMessageInput) => string;
  dispatch: Dispatch;
  dispatchMany: (actions: RootAction[]) => void;
  pushToast: (message: string) => void;
  tokenCoalescer: Coalescer<string>;
  toolCoalescer: Coalescer<string>;
  flushCoalescedUpdates: () => void;
  resetCoalescers: () => void;
  createId: () => string;
  normalizeTaskSummary: (raw: Record<string, unknown> | undefined) => TaskSummary | undefined;
  syncSessionList?: boolean;
}

const parseData = <T,>(raw: string): T | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

type SnapshotMessage = NonNullable<ChatSessionSnapshot['messages']>[number];
type SnapshotTimelineEntry = NonNullable<ChatSessionSnapshot['timeline']>[number];

const mergeSnapshotMessage = (
  messages: SnapshotMessage[],
  targetId: string,
  patch: Partial<SnapshotMessage>,
  nextId?: string,
): SnapshotMessage[] => {
  const nextMessages = [...messages];
  const targetIndex = nextMessages.findIndex((message) => message.id === targetId);
  const finalId = nextId ?? patch.id ?? targetId;

  if (targetIndex !== -1) {
    const existing = nextMessages[targetIndex];
    nextMessages[targetIndex] = {
      ...existing,
      ...patch,
      id: finalId,
      timestamp: patch.timestamp ?? existing.timestamp ?? Date.now(),
    };
    if (finalId !== targetId) {
      return nextMessages.filter((message, index) => index === targetIndex || message.id !== finalId);
    }
    return nextMessages;
  }

  return [
    ...nextMessages,
    {
      id: finalId,
      role: (patch.role as SnapshotMessage['role']) ?? 'assistant',
      content: patch.content ?? '',
      timestamp: patch.timestamp ?? Date.now(),
      status: patch.status,
      toolName: patch.toolName,
      toolCallId: patch.toolCallId,
      metadata: patch.metadata,
    },
  ];
};

const mergeSnapshotTimelineEntry = (
  entries: SnapshotTimelineEntry[],
  incoming: SnapshotTimelineEntry,
): SnapshotTimelineEntry[] => {
  const next = [...entries];
  const replaceIndex =
    typeof incoming.replaceKey === 'string' && incoming.replaceKey.length > 0
      ? next.findIndex((entry) => entry.replaceKey === incoming.replaceKey)
      : -1;
  const idIndex = replaceIndex === -1 ? next.findIndex((entry) => entry.id === incoming.id) : -1;

  if (replaceIndex !== -1) {
    next[replaceIndex] = incoming;
  } else if (idIndex !== -1) {
    next[idIndex] = incoming;
  } else {
    next.push(incoming);
  }

  next.sort((left, right) => left.ts - right.ts);
  return next.slice(Math.max(0, next.length - 150));
};

export const useChatStreaming = ({
  apiBase,
  addMessage,
  dispatch,
  dispatchMany,
  pushToast,
  tokenCoalescer,
  toolCoalescer,
  flushCoalescedUpdates,
  resetCoalescers,
  createId,
  normalizeTaskSummary,
  syncSessionList = true,
}: UseChatStreamingOptions) => {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef<boolean>(true);
  const isConnectingRef = useRef<boolean>(false);
  const assistantMessageRef = useRef<string | null>(null);
  const pendingUserMessagesRef = useRef<Array<{ tempId: string; content: string }>>([]);
  
  const queryClient = useQueryClient();

  const patchSessionSnapshotCache = useCallback(
    (
      sessionId: string,
      updater: (snapshot: ChatSessionSnapshot) => ChatSessionSnapshot,
    ) => {
      queryClient.setQueryData<ChatSessionSnapshot | undefined>(
        ['ai-agent-session', sessionId],
        (current) => (current ? updater(current) : current),
      );
    },
    [queryClient],
  );

  const patchSessionTimelineCache = useCallback(
    (sessionId: string, entry: TimelineEntry) => {
      patchSessionSnapshotCache(sessionId, (snapshot) => ({
        ...snapshot,
        timeline: mergeSnapshotTimelineEntry(snapshot.timeline ?? [], entry),
      }));
    },
    [patchSessionSnapshotCache],
  );

  const disconnectStream = useCallback(() => {
    if (typeof window !== 'undefined' && reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    flushCoalescedUpdates();
    resetCoalescers();
    shouldReconnectRef.current = false;
    const source = eventSourceRef.current;
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
      eventSourceRef.current = null;
    }
    dispatch(sessionActions.setStreamConnected(false));
    assistantMessageRef.current = null;
    isConnectingRef.current = false;
  }, [dispatch, flushCoalescedUpdates, resetCoalescers]);

  const connectStream = useCallback(
    (session: string) => {
      if (typeof window === 'undefined' || !session) {
        return;
      }

      const attemptConnect = (attempt: number) => {
        const baseDelay = 1000;
        const maxDelay = 10000;

        const scheduleReconnect = () => {
          if (!shouldReconnectRef.current) {
            return;
          }
          if (reconnectTimerRef.current) {
            return;
          }
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            attemptConnect(attempt + 1);
          }, delay);
        };

        try {
          shouldReconnectRef.current = true;

          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }

          const url = `${apiBase}/api/ai-agent/sessions/${encodeURIComponent(session)}/stream`;
          const source = new EventSource(url);
          eventSourceRef.current = source;
          isConnectingRef.current = true;
          const markStreamActivity = (kind: 'event' | 'ping' = 'event') => {
            dispatch(sessionActions.markStreamActivity(Date.now(), kind));
          };
          const addTrackedListener = (
            eventName: string,
            listener: (event: MessageEvent<string>) => void,
            options?: { markActivity?: boolean; activityKind?: 'event' | 'ping' },
          ) => {
            source.addEventListener(eventName, (event) => {
              if (options?.markActivity !== false) {
                markStreamActivity(options?.activityKind ?? 'event');
              }
              listener(event as MessageEvent<string>);
            });
          };

          source.onopen = () => {
            isConnectingRef.current = false;
            if (reconnectTimerRef.current) {
              window.clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
            dispatch(sessionActions.setStreamConnected(true));
            markStreamActivity('ping');
            logWorkbenchDebug('stream.open', { sessionId: session });
            // Refresh session state directly instead of blindly setting idle
            // This ensures we respect paused or other server-side states
            if (session) {
              queryClient.refetchQueries({
                queryKey: ['ai-agent-session', session],
                exact: true,
                type: 'active',
              }).catch(swallowError);
              logWorkbenchDebug('stream.open.refetch', { sessionId: session });
            }
          };

          source.onerror = () => {
            if (eventSourceRef.current === source) {
              eventSourceRef.current = null;
            }
            if (!shouldReconnectRef.current) {
              return;
            }
            source.close();
            isConnectingRef.current = false;
            dispatch(sessionActions.setStreamConnected(false));
            assistantMessageRef.current = null;
            scheduleReconnect();
          };

          addTrackedListener('token', (event) => {
            const chunk = decodeSseChunk((event as MessageEvent<string>).data);
            if (!chunk) {
              return;
            }
            if (!assistantMessageRef.current) {
              const messageId = addMessage({
                id: createId(),
                role: 'assistant',
                content: '',
                timestamp: new Date(),
                status: 'sending',
              });
              assistantMessageRef.current = messageId;
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                messages: mergeSnapshotMessage(snapshot.messages ?? [], messageId, {
                  id: messageId,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  status: 'sending',
                }),
              }));
            }
            const messageId = assistantMessageRef.current;
            if (messageId) {
              tokenCoalescer.append(messageId, chunk);
              patchSessionSnapshotCache(session, (snapshot) => {
                const currentMessages = snapshot.messages ?? [];
                const existing = currentMessages.find((message) => message.id === messageId);
                return {
                  ...snapshot,
                  messages: mergeSnapshotMessage(currentMessages, messageId, {
                    id: messageId,
                    role: 'assistant',
                    content: `${existing?.content ?? ''}${chunk}`,
                    timestamp: existing?.timestamp ?? Date.now(),
                    status: 'sending',
                  }),
                };
              });
            }
            dispatch(sessionActions.setLoading(true));
            
            // SSE â†’ Query Cache: patch running status
            // PAUSE PROTECTION: Block if paused/awaiting states are set
            // This prevents SSE from overwriting paused states
          });

          addTrackedListener('message_start', (event) => {
            const data = parseData<{ role?: string }>((event as MessageEvent<string>).data);
            if (data?.role === 'assistant') {
              if (!assistantMessageRef.current) {
                const messageId = addMessage({
                  id: createId(),
                  role: 'assistant',
                  content: '',
                  timestamp: new Date(),
                  status: 'sending',
                });
                assistantMessageRef.current = messageId;
                patchSessionSnapshotCache(session, (snapshot) => ({
                  ...snapshot,
                  messages: mergeSnapshotMessage(snapshot.messages ?? [], messageId, {
                    id: messageId,
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    status: 'sending',
                  }),
                }));
              }
              dispatch(sessionActions.setLoading(true));
              
              // SSE â†’ Query Cache: patch running status
              // PAUSE PROTECTION: Block if paused/awaiting states are set
            }
          });

          addTrackedListener('message', (event) => {
            const message = parseData<{
              id?: string;
              role?: 'user' | 'assistant' | 'tool';
              content?: string;
              timestamp?: number;
              metadata?: Record<string, unknown>;
              status?: 'sending' | 'sent' | 'error';
            }>((event as MessageEvent<string>).data);
            if (!message?.role) {
              return;
            }
            if (message.metadata?.visibility === 'internal') {
              return;
            }
            const incomingId = message.id ?? createId();
            const patch = {
              id: incomingId,
              role: message.role,
              content: message.content ?? '',
              metadata: message.metadata,
              timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
              status: message.status ?? (message.role === 'assistant' ? 'sent' : undefined),
            };

            let targetId = assistantMessageRef.current ?? incomingId;

            if (message.role === 'user') {
              const pendingIndex = pendingUserMessagesRef.current.findIndex(
                (pendingMessage) =>
                  pendingMessage.tempId === incomingId ||
                  (message.content !== undefined && pendingMessage.content === message.content)
              );

              if (pendingIndex !== -1) {
                const pending = pendingUserMessagesRef.current[pendingIndex];
                targetId = pending.tempId;
                pendingUserMessagesRef.current.splice(pendingIndex, 1);
              }
            }

            dispatch(
              messageActions.mergeMessage(targetId, patch, incomingId)
            );
            if (session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                messages: mergeSnapshotMessage(snapshot.messages ?? [], targetId, {
                  ...patch,
                  timestamp:
                    patch.timestamp instanceof Date
                      ? patch.timestamp.getTime()
                      : patch.timestamp,
                }, incomingId),
              }));
            }
            if (message.role === 'assistant') {
              assistantMessageRef.current = incomingId;
            }
          });

          addTrackedListener('message_end', (event) => {
            const data = parseData<{ messageId?: string }>((event as MessageEvent<string>).data);
            const messageId = data?.messageId ?? assistantMessageRef.current;
            flushCoalescedUpdates();
            if (messageId) {
              dispatch(messageActions.updateMessageStatus(messageId, 'sent'));
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                messages: mergeSnapshotMessage(snapshot.messages ?? [], messageId, {
                  id: messageId,
                  status: 'sent',
                }),
              }));
            }
            assistantMessageRef.current = null;
            dispatch(sessionActions.setLoading(false));
          });

          addTrackedListener('session.bootstrap', (event) => {
            const snapshot = parseData<ChatSessionSnapshot>((event as MessageEvent<string>).data);
            if (!snapshot || !session) {
              return;
            }
            logWorkbenchDebug('stream.bootstrap.received', summarizeSessionSnapshot(snapshot));
            queryClient.setQueryData<ChatSessionSnapshot | undefined>(
              ['ai-agent-session', session],
              (previous) => {
                const nextSnapshot = shouldPreferSessionSnapshot(previous, snapshot)
                  ? snapshot
                  : previous ?? snapshot;
                logWorkbenchDebug(
                  nextSnapshot === snapshot ? 'stream.bootstrap.applied' : 'stream.bootstrap.ignored',
                  {
                    sessionId: session,
                    previous: summarizeSessionSnapshot(previous),
                    incoming: summarizeSessionSnapshot(snapshot),
                  },
                );
                return nextSnapshot;
              },
            );
          });

          addTrackedListener('plan_update', (event) => {
            const items = parseData<PlanItem[]>(
              (event as MessageEvent<string>).data
            );
            dispatchMany(planUpdateFromServer(items));
            if (items && session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                plan: items,
              }));
            }
          });

          addTrackedListener('plan_step_started', (event) => {
            const data = parseData<{ stepId: string }>((event as MessageEvent<string>).data);
            dispatchMany(planStepStartedFromServer(data?.stepId));
            if (data?.stepId && session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                plan: (snapshot.plan ?? []).map((item) =>
                  item.id === data.stepId ? { ...item, status: 'running' } : item,
                ),
              }));
            }
          });

          addTrackedListener('turn_complete', () => {
            dispatchMany(planTurnComplete());
          });

          addTrackedListener('plan_step_updated', (event) => {
            const data = parseData<{
              stepId?: string;
              status?: string;
              notes?: string;
              outputSnippet?: string;
              lastTool?: string;
              artifactLinks?: unknown;
              checkpointId?: string;
              blockedReason?: string;
              startedAt?: unknown;
              completedAt?: unknown;
            }>((event as MessageEvent<string>).data);
            dispatchMany(planStepUpdatedFromServer(data));
            if (data?.stepId && session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                plan: (snapshot.plan ?? []).map((item) =>
                  item.id === data.stepId
                    ? {
                        ...item,
                        ...(data.status ? { status: data.status as typeof item.status } : {}),
                        ...(data.notes !== undefined ? { notes: data.notes } : {}),
                        ...(data.outputSnippet !== undefined ? { outputSnippet: data.outputSnippet } : {}),
                        ...(data.lastTool !== undefined ? { lastTool: data.lastTool } : {}),
                        ...(data.checkpointId !== undefined ? { checkpointId: data.checkpointId } : {}),
                        ...(data.blockedReason !== undefined ? { blockedReason: data.blockedReason } : {}),
                        ...(data.startedAt !== undefined ? { startedAt: Number(data.startedAt) } : {}),
                        ...(data.completedAt !== undefined ? { completedAt: Number(data.completedAt) } : {}),
                      }
                    : item,
                ),
              }));
            }
          });

          addTrackedListener('tool_started', (event) => {
            const data = parseData<{ name?: string; args?: Record<string, unknown>; toolCallId?: string }>(
              (event as MessageEvent<string>).data
            );
            dispatchMany(toolStartedFromServer(data));
            const toolName = data?.name;
            if (toolName && session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                liveToolStreams: {
                  ...(snapshot.liveToolStreams ?? {}),
                  [toolName]: {
                    name: toolName,
                    chunks: [],
                    status: 'running',
                    command:
                      data.args && typeof data.args.command === 'string'
                        ? data.args.command
                        : undefined,
                    lastUpdated: Date.now(),
                  },
                },
              }));
            }
          });

          addTrackedListener('tool_output', (event) => {
            const raw = parseData<{ name?: string; chunk?: string }>(
              (event as MessageEvent<string>).data
            );
            const chunk = decodeSseChunk(raw?.chunk);
            const toolName = raw?.name;
            if (!toolName || !chunk) {
              return;
            }
            toolCoalescer.append(toolName, chunk);
            if (session) {
              patchSessionSnapshotCache(session, (snapshot) => {
                const current = snapshot.liveToolStreams?.[toolName];
                return {
                  ...snapshot,
                  liveToolStreams: {
                    ...(snapshot.liveToolStreams ?? {}),
                    [toolName]: {
                      name: toolName,
                      chunks: [...(current?.chunks ?? []), chunk],
                      status: current?.status === 'completed' ? 'completed' : 'running',
                      command: current?.command,
                      result: current?.result,
                      lastUpdated: Date.now(),
                    },
                  },
                };
              });
            }
          });

          addTrackedListener('tool_result', (event) => {
            const data = parseData<{ name?: string; result?: unknown; toolCallId?: string }>(
              (event as MessageEvent<string>).data
            );
            flushCoalescedUpdates();
            dispatchMany(toolResultFromServer(data));
            const toolName = data?.name;
            if (toolName && session) {
              patchSessionSnapshotCache(session, (snapshot) => {
                const current = snapshot.liveToolStreams?.[toolName];
                const result = data.result as Record<string, unknown> | undefined;
                return {
                  ...snapshot,
                  liveToolStreams: {
                    ...(snapshot.liveToolStreams ?? {}),
                    [toolName]: {
                      name: toolName,
                      chunks: current?.chunks ?? [],
                      status:
                        result && 'error' in result
                          ? 'error'
                          : 'completed',
                      command: current?.command,
                      result: data.result as ToolStreamState['result'],
                      lastUpdated: Date.now(),
                    },
                  },
                };
              });
            }
          });

          addTrackedListener('task_selected', (event) => {
            const data = parseData<Record<string, unknown>>((event as MessageEvent<string>).data);
            const summary = normalizeTaskSummary(data);
            dispatchMany(taskSelectedFromServer(summary));
            if (summary && session) {
              patchSessionSnapshotCache(session, (snapshot) => ({
                ...snapshot,
                task: summary,
              }));
            }
          });

          addTrackedListener('sandbox_policy', (event) => {
            const data = parseData<Record<string, unknown>>(
              (event as MessageEvent<string>).data
            );
            dispatchMany(sandboxPolicyFromServer(data));
          });

          addTrackedListener('checkpoint_created', (event) => {
            const data = parseData<{ id?: string }>((event as MessageEvent<string>).data);
            dispatchMany(checkpointCreatedFromServer(data, createId));
          });

          addTrackedListener('checkpoint_restored', (event) => {
            const data = parseData<{ id?: string }>((event as MessageEvent<string>).data);
            dispatchMany(checkpointRestoredFromServer(data, createId));
          });

          addTrackedListener('aborted', (event) => {
            const data = parseData<{ reason?: string }>((event as MessageEvent<string>).data);
            flushCoalescedUpdates();
            dispatchMany(abortedFromServer());
            assistantMessageRef.current = null;
            pendingUserMessagesRef.current = [];
            if (session) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-session', session] }).catch(swallowError);
            }
            if (syncSessionList) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
            }
            if (data?.reason) {
              pushToast(data.reason);
            }
          });

          const handleUsageRecorded = (event: MessageEvent<string>) => {
            const data = parseData<Record<string, unknown>>((event as MessageEvent<string>).data);
            dispatchMany(usageRecordedFromServer(data));
            // keep session views fresh when usage updates arrive
            if (syncSessionList) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
            }
            if (session) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-session', session] }).catch(swallowError);
            }
          };
          addTrackedListener('usage.recorded', handleUsageRecorded);
          addTrackedListener('usage_recorded', handleUsageRecorded);

          addTrackedListener('done', () => {
            flushCoalescedUpdates();
            dispatchMany(doneFromServer());
            assistantMessageRef.current = null;
            pendingUserMessagesRef.current = [];
            // ensure session details/sessions list refresh after a turn finishes
            if (session) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-session', session] }).catch(swallowError);
            }
            if (syncSessionList) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
            }
          });

          // Legacy runtime status is a change notification only. The durable
          // execution projection is refetched as a whole; its payload is never
          // allowed to become frontend lifecycle authority.
          addTrackedListener('session.status', (event) => {
            const data = parseData<{
              id: string;
            }>((event as MessageEvent<string>).data);
            const sessionId = data?.id || session;
            if (sessionId) {
              queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionId] }).catch(swallowError);
              if (syncSessionList) {
                queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
              }
            }
          });

          // Real-time context estimate for live CTX bar updates (before LLM call)
          addTrackedListener('context_estimate', (event) => {
            const data = parseData<{
              estimatedTokens: number;
              contextWindow: number;
              maxHistoryTokens: number;
              percentUsed: number;
            }>((event as MessageEvent<string>).data);
            if (data) {
              dispatchMany(contextEstimateFromServer(data));
            }
          });

          // Context trimmed notification (when older messages are dropped)
          addTrackedListener('context_trimmed', (event) => {
            const data = parseData<{
              droppedMessages: number;
              keptMessages: number;
              usedTokens: number;
              tokenBudget: number;
              percentUsed: number;
            }>((event as MessageEvent<string>).data);
            if (data?.droppedMessages && data.droppedMessages > 0) {
              pushToast(`Context trimmed: ${data.droppedMessages} older message(s) removed to stay within context window.`);
            }
          });

          // Context warning (when approaching context limit)
          addTrackedListener('context_warning', (event) => {
            const data = parseData<{
              percentUsed: number;
              estimatedTokens: number;
              contextWindow: number;
            }>((event as MessageEvent<string>).data);
            if (data?.percentUsed) {
              pushToast(`Warning: Context ${data.percentUsed}% full. Older messages may be dropped soon.`);
            }
          });

          // Auto-compaction notification (when older messages are summarized)
          addTrackedListener('context_compacted', (event) => {
            const data = parseData<{
              beforeTokens: number;
              afterTokens: number;
              messagesSummarized: number;
              compactionVersion: number;
            }>((event as MessageEvent<string>).data);
            if (data?.messagesSummarized) {
              pushToast(`Context compacted: ${data.messagesSummarized} older messages summarized to save space.`);
            }
          });

          addTrackedListener('error', (event) => {
            const data = parseData<{ message?: string }>((event as MessageEvent<string>).data);
            flushCoalescedUpdates();
            dispatchMany(errorFromServer());
            assistantMessageRef.current = null;
            if (data?.message) {
              pushToast(data.message);
            }
          });

          addTrackedListener('timeline_event', (event) => {
            const entry = parseData<TimelineEntry>((event as MessageEvent<string>).data);
            if (!entry || !session) {
              return;
            }
            dispatchMany(timelineEventFromServer(entry));
            patchSessionTimelineCache(session, entry);
          });

          addTrackedListener('ping', () => {}, { activityKind: 'ping' });
        } catch (error: unknown) {
          const apiError = toApiError(error);
          console.error('Failed to connect to session stream', apiError.message);
          scheduleReconnect();
        }
      };

      attemptConnect(0);
    },
    [
      addMessage,
      apiBase,
      dispatch,
      dispatchMany,
      flushCoalescedUpdates,
      createId,
      normalizeTaskSummary,
      patchSessionSnapshotCache,
      patchSessionTimelineCache,
      queryClient,
      syncSessionList,
      pushToast,
      tokenCoalescer,
      toolCoalescer,
    ]
  );

  return {
    connectStream,
    disconnectStream,
    pendingUserMessagesRef,
    assistantMessageRef,
  };
};
