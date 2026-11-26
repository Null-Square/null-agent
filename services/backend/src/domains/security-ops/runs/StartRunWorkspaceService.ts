import type { RunRow } from '@/db/schema';
import type { AgentApiServices } from '@/app/services/agent/types';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { resolveRunnerSessionBinding } from '@/domains/security-ops/runners/runnerSession';
import type { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import {
  createSandboxWorkspaceTarget,
  type WorkspaceTarget,
} from '@/domains/security-ops/workspace/WorkspaceFilePort';
import type {
  ProjectionScope,
  WorkspaceProjectionService,
} from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { isTransientArtifactSubtreePath } from '@/shared/utils/artifact-path-filters';
import { AppError, ERROR_CODES, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { RunService } from './RunService';
import type { RunPhaseKey } from './PhaseProfileRegistry';
import { writeScopeCredentialsFile } from './writeScopeCredentialsFile';

const WORKSPACE_STORAGE_ERROR_PATTERN = /no space left on device|\bENOSPC\b|workspace\.quota_exceeded/i;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const WORKSPACE_PROJECTION_MAX_ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const isWorkspaceStorageError = (error: unknown): boolean => {
  if (error instanceof AppError && error.code === ERROR_CODES.RESOURCE_QUOTA_EXCEEDED) {
    return true;
  }
  if (WORKSPACE_STORAGE_ERROR_PATTERN.test(getErrorMessage(error))) {
    return true;
  }
  const cause = error instanceof Error && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  if (cause) {
    return isWorkspaceStorageError(cause);
  }
  return false;
};

export const toWorkspaceProjectionAppError = (
  error: unknown,
  context: Record<string, unknown>,
): AppError => {
  if (error instanceof AppError) {
    return error;
  }
  const cause = error instanceof Error ? error : undefined;
  if (isWorkspaceStorageError(error)) {
    const userAction = context.reason === 'run_start'
      ? 'Free workspace disk space, then start the run again.'
      : 'Free workspace disk space, then resume the run.';
    return new AppError(
      ERROR_CODES.RESOURCE_QUOTA_EXCEEDED,
      `Workspace storage is exhausted while projecting run state. ${userAction}`,
      {
        httpStatus: 429,
        userMessage: `The run workspace is out of storage. ${userAction}`,
        context,
        cause,
      },
    );
  }
  return new AppError(
    ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
    `Workspace projection failed: ${getErrorMessage(error)}`,
    {
      context,
      cause,
    },
  );
};

type StartRunSessionRepository = {
  setCompleted?: (id: string, completed: boolean) => Promise<boolean>;
  setBlockedReason?: (id: string, reason: string, meta?: Record<string, unknown>) => Promise<boolean>;
};

export type StartRunWorkspaceServiceDeps = {
  runService: Pick<RunService, 'transitionStatus' | 'recordRunEvent'>;
  agentServices: Pick<AgentApiServices, 'sessionStore' | 'sandbox' | 'traceRecorder'>;
  workspaceProjectionService?: WorkspaceProjectionService;
  sessionRepository?: StartRunSessionRepository;
  scopeAccessMaterialService?: ScopeAccessMaterialService;
};

export type ProjectRunWorkspaceParams = {
  orgId: string;
  scopeId: string;
  runId: string;
  session: SessionState;
  phaseKey?: string;
  assignedSkillSlugs?: string[];
  reason: string;
  scopes: ProjectionScope[];
};

export class StartRunWorkspaceService {
  constructor(private readonly deps: StartRunWorkspaceServiceDeps) {}

  createWorkspaceTarget(runId: string, session: SessionState): WorkspaceTarget {
    return createSandboxWorkspaceTarget({
      runId,
      session,
      sandbox: this.deps.agentServices.sandbox,
    });
  }

  async projectRunWorkspace(params: ProjectRunWorkspaceParams): Promise<void> {
    if (!this.deps.workspaceProjectionService) {
      return;
    }

    let result: Awaited<ReturnType<WorkspaceProjectionService['projectRunWorkspace']>> | null = null;
    for (let attempt = 1; attempt <= WORKSPACE_PROJECTION_MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await this.deps.workspaceProjectionService.projectRunWorkspace({
          orgId: params.orgId,
          scopeId: params.scopeId,
          runId: params.runId,
          sessionId: params.session.id,
          phaseKey: params.phaseKey,
          assignedSkillSlugs: params.assignedSkillSlugs,
          reason: params.reason,
          scopes: params.scopes,
          workspace: this.createWorkspaceTarget(params.runId, params.session),
        });
        break;
      } catch (error) {
        const appError = toWorkspaceProjectionAppError(error, {
          orgId: params.orgId,
          scopeId: params.scopeId,
          runId: params.runId,
          sessionId: params.session.id,
          reason: params.reason,
          phaseKey: params.phaseKey ?? null,
          scopes: params.scopes,
        });
        const willRetry =
          appError.code === ERROR_CODES.INTERNAL_DEPENDENCY_FAILED
          && attempt < WORKSPACE_PROJECTION_MAX_ATTEMPTS;
        const event = willRetry
          ? 'workspace_projection.retrying'
          : 'workspace_projection.failed';
        logger.warn(
          {
            err: appError,
            runId: params.runId,
            sessionId: params.session.id,
            reason: params.reason,
            attempt,
            maxAttempts: WORKSPACE_PROJECTION_MAX_ATTEMPTS,
            willRetry,
          },
          willRetry
            ? '[runs] Workspace projection failed transiently; retrying'
            : '[runs] Workspace projection failed',
        );
        this.deps.agentServices.traceRecorder?.write?.(
          params.session.id,
          params.session.turn ?? 0,
          {
            event,
            severity: willRetry ? 'warn' : 'error',
            payload: {
              reason: params.reason,
              scopes: params.scopes,
              phaseKey: params.phaseKey,
              errorCode: appError.code,
              errorMessage: appError.userMessage || appError.message,
              technicalError: getErrorMessage(error).slice(0, 500),
              retryable: appError.retryable,
              attempt,
              maxAttempts: WORKSPACE_PROJECTION_MAX_ATTEMPTS,
              runId: params.runId,
              scopeId: params.scopeId,
              orgId: params.orgId,
            },
            note: willRetry
              ? `workspace projection retry ${attempt}/${WORKSPACE_PROJECTION_MAX_ATTEMPTS} for ${params.reason}`
              : `workspace projection failed for ${params.reason}: ${appError.userMessage || appError.message}`,
          },
        ).catch((traceError: unknown) => {
          logger.warn(
            { err: traceError, runId: params.runId, sessionId: params.session.id },
            '[runs] Failed to record workspace projection failure trace',
          );
        });
        if (!willRetry) {
          throw appError;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, attempt * 100);
        });
      }
    }

    if (!result) {
      throw new AppError(
        ERROR_CODES.INTERNAL_DEPENDENCY_FAILED,
        'Workspace projection exhausted without a result',
      );
    }

    logger.info(
      {
        runId: params.runId,
        sessionId: params.session.id,
        reason: params.reason,
        written: result.written.length,
        warnings: result.warnings,
      },
      '[runs] Workspace projection completed',
    );
    this.deps.agentServices.traceRecorder?.write?.(params.session.id, params.session.turn ?? 0, {
      event: 'workspace_projection.projected',
      severity: result.warnings.length > 0 ? 'warn' : 'info',
      payload: {
        reason: params.reason,
        scopes: params.scopes,
        phaseKey: params.phaseKey,
        written: result.written.length,
        warnings: result.warnings,
        runId: params.runId,
        scopeId: params.scopeId,
        orgId: params.orgId,
      },
      note: `workspace projection ${params.reason}: ${result.written.length} file(s) written`,
    }).catch((traceError: unknown) => {
      logger.warn(
        { err: traceError, runId: params.runId, sessionId: params.session.id },
        '[runs] Failed to record workspace projection trace',
      );
    });
  }

  async failRunStartForWorkspaceProjectionFailure(params: {
    orgId: string;
    run: RunRow;
    session: SessionState;
    error: AppError;
  }): Promise<void> {
    const isStoragePressure = isWorkspaceStorageError(params.error);
    return this.failRunStart({
      ...params,
      code: isStoragePressure ? 'workspace_storage_pressure' : 'workspace_projection_failed',
      reason: 'run_start_workspace_projection_failed',
    });
  }

  async failRunStart(params: {
    orgId: string;
    run: RunRow;
    session: SessionState;
    error: AppError;
    code: string;
    reason: string;
  }): Promise<void> {
    const meta = {
      code: params.code,
      reason: params.reason,
      runId: params.run.id,
      message: params.error.userMessage || params.error.message,
      recoverable: false,
    };

    await this.deps.runService.transitionStatus(
      params.orgId,
      params.run.id,
      'failed',
    ).catch((error) => {
      logger.warn(
        { err: error, runId: params.run.id, reason: params.reason },
        '[runs] Failed to mark run failed after run-start failure',
      );
    });

    await this.deps.sessionRepository?.setBlockedReason?.(
      params.session.id,
      'error',
      meta,
    ).catch((error) => {
      logger.warn(
        { err: error, runId: params.run.id, sessionId: params.session.id, reason: params.reason },
        '[runs] Failed to persist run-start failure reason',
      );
      return false;
    });

    const liveSession = this.deps.agentServices.sessionStore.get(params.session.id) ?? params.session;
    liveSession.blockedReason = 'error';
    liveSession.blockedMeta = meta;
    liveSession.flags = {
      ...(liveSession.flags ?? {}),
      blocked_reason: 'error',
    };
    await this.deps.agentServices.sessionStore
      .setAsync(params.session.id, liveSession, `securityops.${params.reason}`)
      .catch((error) => {
        logger.warn(
          { err: error, runId: params.run.id, sessionId: params.session.id, reason: params.reason },
          '[runs] Failed to update live session after run-start failure',
        );
      });

    await this.deps.agentServices.sandbox.destroy(liveSession).catch((error) => {
      logger.warn(
        { err: error, runId: params.run.id, sessionId: params.session.id, reason: params.reason },
        '[runs] Failed to destroy sandbox after run-start failure',
      );
    });

    await this.deps.agentServices.sessionStore.cleanupRunWorkspaceAsync(params.run.id, {
      reason: params.reason,
      force: true,
      persist: false,
    }).catch((error) => {
      logger.warn(
        { err: error, runId: params.run.id, sessionId: params.session.id, reason: params.reason },
        '[runs] Failed to clean up run workspace after run-start failure',
      );
    });

    await this.deps.runService.recordRunEvent({
      runId: params.run.id,
      type: 'failed',
      note: JSON.stringify({
        reason: params.reason,
        code: meta.code,
        message: meta.message,
      }),
    }).catch((error) => {
      logger.warn(
        { err: error, runId: params.run.id, sessionId: params.session.id, reason: params.reason },
        '[runs] Failed to record run-start failure event',
      );
    });
  }

  async markCreatedPhaseSessionUnused(params: {
    session: SessionState;
    runId: string;
    phaseId: string;
    phaseKey: RunPhaseKey;
    reason: string;
    error: unknown;
  }): Promise<void> {
    const err = toAppError(params.error);
    const meta = {
      runId: params.runId,
      phaseId: params.phaseId,
      phaseKey: params.phaseKey,
      reason: params.reason,
      errorMessage: err.message,
    };

    await this.deps.sessionRepository?.setBlockedReason?.(params.session.id, params.reason, meta).catch((error) => {
      logger.warn({ err: error, sessionId: params.session.id, meta }, '[runs] Failed to mark unused phase session blocked');
      return false;
    });
    const journalProjected = await this.deps.agentServices.sessionStore
      .recordSessionCompletedAsync(params.session.id, 'phase_session_unused');
    const completionPersisted = journalProjected
      ? true
      : this.deps.sessionRepository?.setCompleted
        ? await this.deps.sessionRepository.setCompleted(params.session.id, true)
        : false;
    if (!completionPersisted) {
      throw new Error(`durable_unused_phase_completion_failed:${params.session.id}`);
    }

    const liveSession = this.deps.agentServices.sessionStore.get(params.session.id) ?? params.session;
    const nextFlags = { ...(liveSession.flags ?? {}) } as Record<string, unknown>;
    liveSession.flags = {
      ...nextFlags,
      blocked_reason: params.reason,
      phaseLifecycle: {
        ...(isRecord(nextFlags.phaseLifecycle) ? nextFlags.phaseLifecycle : {}),
        unused: true,
        ...meta,
      },
      session: {
        ...(isRecord(nextFlags.session) ? nextFlags.session : {}),
        completed: true,
      },
    };
    liveSession.completed = true;
    liveSession.blockedReason = params.reason;
    liveSession.blockedMeta = meta;
    await this.deps.agentServices.sessionStore
      .setAsync(params.session.id, liveSession, 'securityops.phase_session_unused')
      .catch((error) => {
        logger.warn({ err: error, sessionId: params.session.id, meta }, '[runs] Failed to persist unused phase session flags');
      });
  }

  async writeAndSyncScopeCredentialsIfAvailable(params: {
    sessionId: string;
    workspaceDir: string;
    orgId: string;
    scopeId: string;
    hasScopeAccessMaterials: boolean;
  }): Promise<void> {
    if (!params.hasScopeAccessMaterials || !this.deps.scopeAccessMaterialService) {
      return;
    }

    await writeScopeCredentialsFile({
      workspaceDir: params.workspaceDir,
      orgId: params.orgId,
      scopeId: params.scopeId,
      service: this.deps.scopeAccessMaterialService,
    });
    await this.syncWorkspaceFileToRunner(params.sessionId, params.workspaceDir, '.credentials');
  }

  async importSourceRunArtifacts(
    sourceWorkspaceDir: string,
    targetWorkspaceDir: string,
  ): Promise<void> {
    const normalizedRoot = '.artifacts';
    const sourceRoot = path.resolve(sourceWorkspaceDir, normalizedRoot);
    const targetRoot = path.resolve(targetWorkspaceDir, normalizedRoot);
    if (sourceRoot === targetRoot) {
      return;
    }

    const stat = await fs.stat(sourceRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      return;
    }

    const copyRecursive = async (sourceCurrent: string, targetCurrent: string): Promise<void> => {
      await fs.mkdir(targetCurrent, { recursive: true });
      const entries = await fs.readdir(sourceCurrent, { withFileTypes: true });
      for (const entry of entries) {
        const sourceEntry = path.join(sourceCurrent, entry.name);
        const relativePath = path.relative(sourceWorkspaceDir, sourceEntry).replace(/\\/g, '/');
        if (isTransientArtifactSubtreePath(relativePath)) {
          continue;
        }

        const targetEntry = path.join(targetCurrent, entry.name);
        if (entry.isDirectory()) {
          await copyRecursive(sourceEntry, targetEntry);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        await fs.mkdir(path.dirname(targetEntry), { recursive: true });
        await fs.copyFile(sourceEntry, targetEntry);
      }
    };

    await copyRecursive(sourceRoot, targetRoot);
  }

  async syncWorkspaceFileToRunner(
    sessionId: string,
    workspaceDir: string,
    relativePath: string,
  ): Promise<void> {
    const session = this.deps.agentServices.sessionStore.get(sessionId);
    if (!session || !resolveRunnerSessionBinding(session).runnerId) {
      return;
    }

    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolutePath = path.resolve(workspaceDir, normalizedPath);
    let content: Buffer;
    try {
      content = await fs.readFile(absolutePath);
    } catch {
      return;
    }

    await this.deps.agentServices.sandbox.writeFile(session, normalizedPath, content);
  }

  async syncWorkspaceSubtreeToRunner(
    sessionId: string,
    workspaceDir: string,
    relativeRoot: string,
  ): Promise<void> {
    const session = this.deps.agentServices.sessionStore.get(sessionId);
    if (!session || !resolveRunnerSessionBinding(session).runnerId) {
      return;
    }

    const normalizedRoot = relativeRoot.replace(/\\/g, '/').replace(/^\/+/, '');
    const absoluteRoot = path.resolve(workspaceDir, normalizedRoot);
    const stat = await fs.stat(absoluteRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      return;
    }

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const absoluteEntry = path.join(currentDir, entry.name);
        const relativePath = path.relative(workspaceDir, absoluteEntry).replace(/\\/g, '/');
        if (isTransientArtifactSubtreePath(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(absoluteEntry);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const content = await fs.readFile(absoluteEntry);
        await this.deps.agentServices.sandbox.writeFile(session, relativePath, content);
      }
    };

    await walk(absoluteRoot);
  }
}
