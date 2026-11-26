export type UserNotificationDestination = 'run_detail' | 'run_workbench';

type SessionFlagsCarrier = {
  flags?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const extractRunIdFromSession = (
  session: SessionFlagsCarrier | undefined | null,
): string | undefined => {
  const flags = isRecord(session?.flags) ? session.flags : undefined;
  const securityops = flags && isRecord(flags.securityops) ? flags.securityops : undefined;
  return readString(securityops?.runId);
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

export const buildUserNotificationLink = (options: {
  destination: UserNotificationDestination;
  runId?: string | null;
  sessionId?: string | null;
}): string | null => {
  const runId = readString(options.runId);
  const sessionId = readString(options.sessionId);

  if (!runId) {
    return null;
  }

  if (options.destination === 'run_detail') {
    return buildRunDetailLink(runId);
  }

  return buildRunWorkbenchLink(runId, sessionId);
};

export const buildUserNotificationTarget = (options: {
  destination: UserNotificationDestination;
  runId?: string | null;
  sessionId?: string | null;
  ctaLabel?: string;
  data?: Record<string, unknown>;
}): { link: string | null; data: Record<string, unknown> } => {
  const runId = readString(options.runId);
  const sessionId = readString(options.sessionId);
  const ctaLabel = readString(options.ctaLabel);

  return {
    link: buildUserNotificationLink({
      destination: options.destination,
      runId,
      sessionId,
    }),
    data: {
      ...(options.data ?? {}),
      destination: options.destination,
      ...(runId ? { runId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(ctaLabel ? { ctaLabel } : {}),
    },
  };
};
