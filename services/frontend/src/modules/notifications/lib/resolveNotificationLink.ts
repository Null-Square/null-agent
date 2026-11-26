import type { Notification } from '../api/notifications';

const SESSION_LINK_PATTERN = /^\/sessions?\/([^/?#]+)$/i;

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const buildRunDetailLink = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;

const buildRunWorkbenchLink = (runId: string, sessionId?: string): string => {
  const base = `/runs/${encodeURIComponent(runId)}/workbench`;
  if (!sessionId) {
    return base;
  }

  const params = new URLSearchParams({ session: sessionId });
  return `${base}?${params.toString()}`;
};

export function resolveNotificationLink(notification: Notification): string | null {
  const rawLink = readString(notification.link) ?? null;
  const data = notification.data ?? {};
  const runId = readString(data.runId);
  const sessionIdFromData = readString(data.sessionId);
  const destination = readString(data.destination);
  const sessionIdFromLink = rawLink ? SESSION_LINK_PATTERN.exec(rawLink)?.[1] : undefined;
  const sessionId = sessionIdFromData ?? sessionIdFromLink;

  if (destination === 'run_detail' && runId) {
    return buildRunDetailLink(runId);
  }

  if (destination === 'run_workbench' && runId) {
    return buildRunWorkbenchLink(runId, sessionId);
  }

  if (rawLink?.startsWith('/runs/')) {
    return rawLink;
  }

  if (rawLink && SESSION_LINK_PATTERN.test(rawLink) && runId) {
    return notification.type === 'task_completed'
      ? buildRunDetailLink(runId)
      : buildRunWorkbenchLink(runId, sessionId);
  }

  return rawLink;
}
