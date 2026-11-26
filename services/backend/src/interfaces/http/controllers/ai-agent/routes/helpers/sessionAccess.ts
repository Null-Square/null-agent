import type { AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { AppError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import type { PlatformKernel } from '@/app/platform/kernel';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const getStringProp = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

const getSecurityOpsFlags = (
  session?: SessionState,
  metadata?: unknown,
): Record<string, unknown> | undefined => {
  const liveFlags = isRecord(session?.flags?.securityops)
    ? (session.flags.securityops as Record<string, unknown>)
    : undefined;
  if (liveFlags) {
    return liveFlags;
  }

  const metadataRecord = isRecord(metadata) ? metadata : undefined;
  const flags = isRecord(metadataRecord?.flags)
    ? (metadataRecord.flags as Record<string, unknown>)
    : undefined;
  return isRecord(flags?.securityops) ? (flags.securityops as Record<string, unknown>) : undefined;
};

export const resolveRunObservabilityContext = (
  session?: SessionState,
  metadata?: unknown,
): { runId: string; organizationId?: string } | null => {
  const securityops = getSecurityOpsFlags(session, metadata);
  const runId = getStringProp(securityops, 'runId');
  if (!runId) {
    return null;
  }
  return {
    runId,
    organizationId: getStringProp(securityops, 'organizationId'),
  };
};

export const assertRunObservabilityAccess = async (params: {
  session?: SessionState;
  metadata?: unknown;
  req: AuthenticatedRequest;
  accessControl: Pick<PlatformKernel['accessControl'], 'enforceRunObservabilityAccess'>;
}): Promise<void> => {
  const context = resolveRunObservabilityContext(params.session, params.metadata);
  if (!context) {
    return;
  }

  await params.accessControl.enforceRunObservabilityAccess({
    userId: params.req.user?.id,
    organizationId: context.organizationId ?? null,
  });
};

export const ensureSessionAccess = (session: SessionState, req: AuthenticatedRequest): void => {
  if (session?.userId && req.user?.id && session.userId !== req.user.id) {
    throw new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'You do not have access to this session', {
      context: { sessionId: session?.id },
    });
  }
};

export const ensureSessionExists: (
  session: SessionState | undefined,
  sessionId: string,
) => asserts session is SessionState = (session, sessionId) => {
  if (!session) {
    throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Session not found', {
      context: { sessionId },
    });
  }
};
