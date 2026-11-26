/**
 * SessionResponseBuilder - DTO transformations and response formatting
 * 
 * Extracted from sessions.router.ts to centralize response building logic.
 * This service handles:
 * - Session status derivation
 * - Usage metrics resolution
 * - Message/Artifact DTO transformations
 * - Artifact content caching with TTL
 * - Download URL generation
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseS3Uri } from '@/shared/storage/s3Utils';
import { ErrorFactory, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import { redactProviderReasoningMetadata } from '@/domains/agent-brain/domain/reasoning/providerReasoning';
import {
  sessionResolverAppService,
  type DerivedRuntimeState,
  type LiveSessionState,
} from '@/app/services/platform/sessions/sessionResolverAppService';
import type { SessionRowDTO } from '@/shared/types/dtos';

// ============================================================================
// Types
// ============================================================================

export interface SessionUsageDTO {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow?: number | null;
  lastTurnInputTokens?: number;
  contextRemaining?: number | null;
  cachedPromptTokens?: number;
  cost?: number;
  overhead?: number;
  platformCost?: number;
  platformPrice?: number;
  credits?: number;
  currency?: string;
  model?: string;
}

export interface UsageHistoryEntryDTO {
  turn: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp?: number;
}

export interface MessageRowDTO {
  id: string;
  role: string;
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
  createdAt?: Date | number | string | null;
  timestamp?: number | null;
}

export interface MessageResponseDTO {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
  timestamp: number;
  createdAt?: string;
}

export interface ArtifactRowDTO {
  id: string;
  filePath: string;
  originalName: string;
  fileType?: string | null;
  sizeBytes?: number | bigint | string | null;
  createdAt?: Date | number | null;
}

export interface ArtifactDetailDTO {
  id: string;
  filePath: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  createdAt: number;
  storage: 'local' | 's3';
  bucket?: string;
}

export interface SessionArtifact {
  id: string;
  filePath: string;
  fileType?: string;
  originalName?: string;
}

// Flag keys for usage data
const TOKEN_USAGE_FLAG = 'token_usage';
const TOKEN_USAGE_HISTORY_FLAG = 'token_usage_history';

// ============================================================================
// SessionResponseBuilder Class
// ============================================================================

export interface SessionResponseBuilderDeps {
  s3Artifacts?: S3StorageService;
  artifactStorageRoot: string;
}

export interface RuntimeStateOptions {
  row?: Partial<SessionRowDTO> | null;
  liveSession?: LiveSessionState;
  metadata?: Record<string, unknown> | null;
  blockedReason?: string | null;
  completed?: boolean;
  isProcessing?: boolean;
  pendingApproval?: { toolCallId: string } | null;
}

export class SessionResponseBuilder {
  private readonly log = logger.child({ scope: 'SessionResponseBuilder' });
  
  // In-memory cache for artifact content with TTL
  private readonly artifactContentCache = new Map<string, { content: string; expiresAt: number }>();
  private readonly ARTIFACT_CACHE_TTL_MS = 60_000; // 60 seconds
  private readonly ARTIFACT_CACHE_MAX_ENTRIES = 100;

  constructor(private readonly deps: SessionResponseBuilderDeps) {}

  // ============================================================================
  // Artifact Content Caching
  // ============================================================================

  getCachedArtifactContent(key: string): string | undefined {
    const cached = this.artifactContentCache.get(key);
    if (!cached) return undefined;
    if (Date.now() > cached.expiresAt) {
      this.artifactContentCache.delete(key);
      return undefined;
    }
    // Refresh entry to keep recent items hot.
    this.artifactContentCache.delete(key);
    this.artifactContentCache.set(key, cached);
    return cached.content;
  }

  setCachedArtifactContent(key: string, content: string): void {
    if (this.artifactContentCache.has(key)) {
      this.artifactContentCache.delete(key);
    }
    this.artifactContentCache.set(key, {
      content,
      expiresAt: Date.now() + this.ARTIFACT_CACHE_TTL_MS,
    });
    while (this.artifactContentCache.size > this.ARTIFACT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.artifactContentCache.keys().next().value;
      if (!oldestKey) break;
      this.artifactContentCache.delete(oldestKey);
    }
  }

  // ============================================================================
  // Status Derivation
  // ============================================================================

  /**
   * Derive canonical session state from multiple sources with priority:
   * 1. blocked_reason / pending interactions -> paused + pauseReason/interactionType
   * 2. recent activity / in-memory processing -> running
   * 3. completed -> completed
   * 4. else -> idle
   */
  deriveSessionStatus(
    session?: {
      stateMachine?: { isProcessing: () => boolean };
      pendingApproval?: unknown;
      flags?: { session?: { completed?: boolean } };
    },
    blockedReason?: string | null,
    dbCompleted?: boolean,
    isProcessingOverride?: boolean,
  ): string {
    return this.deriveSessionState(session, blockedReason, dbCompleted, isProcessingOverride).status;
  }

  deriveRuntimeState(options: RuntimeStateOptions): DerivedRuntimeState {
    return sessionResolverAppService.deriveRuntimeState({
      session: options.row ?? null,
      liveSession: options.liveSession,
      metadata: options.metadata,
      blockedReason: options.blockedReason,
      completed: options.completed,
      isProcessing: options.isProcessing,
      pendingApproval: options.pendingApproval,
    });
  }

  deriveSessionState(
    session?: {
      stateMachine?: { isProcessing: () => boolean };
      pendingApproval?: unknown;
      flags?: { session?: { completed?: boolean } };
    },
    blockedReason?: string | null,
    dbCompleted?: boolean,
    isProcessingOverride?: boolean,
  ): DerivedRuntimeState {
    const pendingApproval = session?.pendingApproval
      ? (session.pendingApproval as { toolCallId: string })
      : null;
    return this.deriveRuntimeState({
      liveSession: session as LiveSessionState | undefined,
      blockedReason,
      completed: dbCompleted,
      isProcessing: isProcessingOverride,
      pendingApproval,
    });
  }

  // ============================================================================
  // Usage Resolution
  // ============================================================================

  resolveUsage(session: SessionState | null): SessionUsageDTO | null {
    const usageFromSession = session?.usage;
    const usageFromFlags = session?.flags ? session.flags[TOKEN_USAGE_FLAG] : undefined;
    const baseUsage = (usageFromSession ?? usageFromFlags ?? null) as SessionUsageDTO | null;
    
    // Get last turn's input tokens from usage history
    const historyFlag = session?.flags ? session.flags[TOKEN_USAGE_HISTORY_FLAG] : undefined;
    const historyEntries = Array.isArray(historyFlag) 
      ? historyFlag 
      : ((historyFlag as Record<string, unknown>)?.entries ?? []) as UsageHistoryEntryDTO[];
    const lastEntry = historyEntries.length > 0 ? historyEntries[historyEntries.length - 1] : null;
    
    const lastTurnInputTokens = lastEntry?.promptTokens ?? baseUsage?.promptTokens ?? 0;
    
    if (baseUsage && session?.modelContextWindow) {
      return {
        ...baseUsage,
        contextWindow: session.modelContextWindow,
        lastTurnInputTokens,
        contextRemaining: Math.max(0, session.modelContextWindow - lastTurnInputTokens),
      };
    }
    
    if (baseUsage) {
      return {
        ...baseUsage,
        lastTurnInputTokens,
      };
    }
    return baseUsage;
  }

  resolveUsageHistory(session: SessionState | null): UsageHistoryEntryDTO[] | undefined {
    const historyFlag = session?.flags ? session.flags[TOKEN_USAGE_HISTORY_FLAG] : undefined;
    if (Array.isArray(historyFlag)) {
      return historyFlag as UsageHistoryEntryDTO[];
    }
    if (historyFlag && typeof historyFlag === 'object' && Array.isArray((historyFlag as Record<string, unknown>).entries)) {
      return (historyFlag as Record<string, UsageHistoryEntryDTO[]>).entries;
    }
    return undefined;
  }

  // ============================================================================
  // DTO Transformations
  // ============================================================================

  isInternalMessage(row: Pick<MessageRowDTO, 'metadata'> | null | undefined): boolean {
    return row?.metadata?.visibility === 'internal';
  }

  filterVisibleMessages<T extends Pick<MessageRowDTO, 'metadata'>>(rows: T[]): T[] {
    return rows.filter((row) => !this.isInternalMessage(row));
  }

  toMessageResponse(row: MessageRowDTO): MessageResponseDTO {
    const created =
      row?.createdAt instanceof Date
        ? row.createdAt.getTime()
        : typeof row?.createdAt === 'number'
          ? row.createdAt
          : typeof row?.createdAt === 'string'
            ? Date.parse(row.createdAt)
            : typeof row?.timestamp === 'number'
              ? row.timestamp
              : Date.now();

    return {
      id: row.id,
      role: row.role as 'user' | 'assistant' | 'tool',
      content: row.content,
      toolName: row.toolName,
      toolCallId: row.toolCallId,
      metadata: redactProviderReasoningMetadata(row.metadata) ?? null,
      status: row.status ?? (row.metadata?.status as string | undefined),
      timestamp: Number.isFinite(created) ? created : Date.now(),
      createdAt:
        row?.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : typeof row?.createdAt === 'string'
            ? row.createdAt
            : undefined,
    };
  }

  adaptArtifactRow(row: ArtifactRowDTO): ArtifactDetailDTO {
    const parsed = row?.filePath ? parseS3Uri(String(row.filePath)) : null;
    return {
      id: row.id,
      filePath: row.filePath,
      originalName: row.originalName,
      fileType: row.fileType ?? 'file',
      sizeBytes: Number(row.sizeBytes ?? 0),
      createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : (row.createdAt ?? Date.now()),
      storage: parsed ? 's3' : 'local',
      bucket: parsed?.bucket,
    };
  }

  // ============================================================================
  // Download URL Generation
  // ============================================================================

  async buildDownloadUrl(
    artifact: SessionArtifact,
    sessionId?: string,
  ): Promise<string | undefined> {
    const { s3Artifacts } = this.deps;
    const parsed = parseS3Uri(artifact.filePath);
    if (parsed && s3Artifacts && parsed.bucket === s3Artifacts.getBucket()) {
      try {
        return await s3Artifacts.getPresignedUrl(parsed.key);
      } catch (error) {
        const appErr = toAppError(error);
        this.log.warn({ err: appErr, sessionId, artifactId: artifact.id }, 'failed to presign artifact download');
      }
    }
    return undefined;
  }

  // ============================================================================
  // Artifact Content Reading
  // ============================================================================

  async readArtifactContent(
    sessionId: string,
    artifact: SessionArtifact,
  ): Promise<{ content: string; kind: string }> {
    const { s3Artifacts, artifactStorageRoot } = this.deps;
    const parsed = parseS3Uri(artifact.filePath);
    
    if (parsed && s3Artifacts && parsed.bucket === s3Artifacts.getBucket()) {
      try {
        const buffer = await s3Artifacts.getObjectBuffer(parsed.key);
        return { content: buffer.toString('utf-8'), kind: artifact.fileType || 'file' };
      } catch (error) {
        const appErr = toAppError(error);
        this.log.warn({ err: appErr, sessionId, artifactId: artifact.id }, 'failed to read artifact content from s3');
      }
    }

    const absolutePath = path.resolve(artifactStorageRoot, artifact.filePath);
    const relative = path.relative(artifactStorageRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw ErrorFactory.auth.insufficientPermissions('artifact', {
        context: { sessionId, artifactId: artifact.id, path: artifact.filePath },
      });
    }
    if (!fs.existsSync(absolutePath)) {
      throw ErrorFactory.resource.notFound('artifact', artifact.filePath, {
        context: { sessionId, artifactId: artifact.id },
      });
    }
    const raw = await fs.promises.readFile(absolutePath, 'utf-8');
    return { content: raw, kind: artifact.fileType || 'file' };
  }

  // ============================================================================
  // Utility Helpers
  // ============================================================================

  toMillis(value: Date | number | string | undefined, fallback: number): number {
    if (value instanceof Date) return value.getTime();
    const numeric = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(numeric) ? Number(numeric) : fallback;
  }
}
