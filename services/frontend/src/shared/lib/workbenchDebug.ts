import type { ChatSessionSnapshot } from '@/types/chat';

const WORKBENCH_DEBUG_KEY = 'null.debug.workbench';

const canUseWindow = (): boolean => typeof window !== 'undefined';
const isDev = (): boolean =>
  typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

export const isWorkbenchDebugEnabled = (): boolean => {
  if (isDev()) {
    return true;
  }
  if (!canUseWindow()) {
    return false;
  }

  const debugFlag = window.localStorage.getItem(WORKBENCH_DEBUG_KEY);
  if (debugFlag === '1' || debugFlag === 'true') {
    return true;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get('debugWorkbench') === '1';
};

export const logWorkbenchDebug = (event: string, payload?: Record<string, unknown>): void => {
  if (!isWorkbenchDebugEnabled()) {
    return;
  }

  if (payload) {
    console.info(`[workbench] ${event}`, payload);
    return;
  }

  console.info(`[workbench] ${event}`);
};

export const summarizeSessionSnapshot = (
  snapshot?: Partial<ChatSessionSnapshot> | null,
): Record<string, unknown> => ({
  id: snapshot?.id ?? null,
  status: snapshot?.status ?? null,
  version: snapshot?.version ?? null,
  mode: snapshot?.mode ?? null,
  pauseReason: snapshot?.pause_reason ?? null,
  interactionType: snapshot?.interaction_type ?? null,
  blockedReason: snapshot?.blocked_reason ?? null,
  executionTarget: snapshot?.executionTarget ?? null,
  runnerId: snapshot?.runnerId ?? null,
  runnerName: snapshot?.runnerName ?? null,
  messages: snapshot?.messages?.length ?? 0,
  plan: snapshot?.plan?.length ?? 0,
  artifacts: snapshot?.artifacts?.length ?? 0,
  timeline: snapshot?.timeline?.length ?? 0,
  toolStreams: Object.keys(snapshot?.liveToolStreams ?? {}).length,
  hasTask: Boolean(snapshot?.task),
  hasUsage: Boolean(snapshot?.usage),
});
