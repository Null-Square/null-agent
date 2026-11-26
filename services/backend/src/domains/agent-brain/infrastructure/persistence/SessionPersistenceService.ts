import * as fs from 'fs';
import {
    type AgentCheckpointRow,
    type AgentSessionRow,
    type NewAgentSessionRow,
} from '@/db/schema';
import {
    type ArtifactRepository,
    type CheckpointRepository,
    type MessageRepository,
    type SessionRepository,
    type SessionUpdateFields,
    type MessageRow,
    type ArtifactRow,
} from '@/domains/agent-brain/adapters/persistence';
import {
    type CheckpointMetadata,
    type LiveToolStreamState,
    type Message,
    type PlanItem,
    type SessionCoordination,
    type SessionArtifact,
    type SessionFlags,
    type SessionState,
    type SessionTaskMeta,
    type ToolAccessPolicy,
    type TodoItem,
    type WorkerResultArtifact,
    type WorkerTaskRecord,
} from '../../domain/types';
import type { PromptProfile } from '../../domain/prompts';
import type { TimelineEntry } from '@null-ai/contracts';
import type {
    HydrationOptions,
    SessionExecutionCoordinationFacts,
} from '../../ports/sessionRepository';
import { logger } from '@/shared/logger';
import { createSessionStateMachine } from '../../domain/state';
import { toLogSafeError, toSafeError } from '@/shared/errors';
import { MemoryManager } from '../../domain/helpers/MemoryManager';
import { sanitizeLiveToolStreams } from '../../application/core/liveToolStreamSanitizer';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const getSessionCompletionFlag = (session: Pick<SessionState, 'flags'>): boolean => {
    const sessionFlags = isRecord(session.flags?.session)
        ? session.flags.session
        : undefined;
    const completed: unknown = sessionFlags?.completed;
    return completed === true || completed === 'true';
};

export type SessionPersistenceDeps = {
    sessions: SessionRepository;
    messages: MessageRepository;
    artifacts?: ArtifactRepository;
    checkpoints?: CheckpointRepository;
};

export type SessionPersistenceOptions = {
    verboseLogging?: boolean;
};

type PersistedSessionMetadata = {
    version?: number;
    profileKey?: string;
    promptProfile?: PromptProfile;
    extraContext?: string;
    scopeId?: string;
    softContextBlocks?: string[];
    planVersionHash?: string;
    sandboxProfile?: string;
    sandboxImage?: string;
    modelName?: string;
    modelContextWindow?: number;
    modelMaxOutputTokens?: number;
    modelTemperature?: number;
    toolPolicy?: ToolAccessPolicy;
    flags?: SessionFlags;
    memory?: Record<string, unknown>;
    pendingApproval?: SessionState['pendingApproval'];
    blockedMeta?: Record<string, unknown>;
    task?: SessionTaskMeta;
    coordination?: SessionCoordination;
    workerTasks?: WorkerTaskRecord[];
    workerResult?: WorkerResultArtifact;
    lastCheckpoint?: CheckpointMetadata;
    currentPlanStepId?: string;
    scratchTodos?: TodoItem[];
    turn?: number;
    liveToolStreams?: Record<string, LiveToolStreamState>;
    timeline?: TimelineEntry[];
};

export class SessionPersistenceService {
    private readonly sessionQueues = new Map<string, Promise<unknown>>();
    private readonly log = logger.child({ scope: 'SessionPersistence' });
    private readonly verboseLogging: boolean;

    constructor(
        private readonly deps: SessionPersistenceDeps,
        options: SessionPersistenceOptions = {},
    ) {
        this.verboseLogging = options.verboseLogging ?? false;
    }

    async hydrateAll(options: HydrationOptions = {}): Promise<SessionState[]> {
        try {
            const rows = await this.deps.sessions.listAll();
            // Initial application hydration restores only live runtime sessions.
            // Completed rows remain available through hydrateSession() for history
            // and trace/report reads, but must not be reactivated on every boot.
            const activeRows = rows.filter((row) => {
                const metadata = (row.metadata ?? {}) as PersistedSessionMetadata;
                return row.completed !== true
                    && !getSessionCompletionFlag({ flags: metadata.flags ?? {} });
            });
            // Prefer most recently active sessions first to cap load.
            const sortedRows = activeRows.sort((a, b) => {
                const aTs = a.lastActiveAt?.getTime() ?? a.updatedAt?.getTime() ?? 0;
                const bTs = b.lastActiveAt?.getTime() ?? b.updatedAt?.getTime() ?? 0;
                return bTs - aTs;
            });
            const filteredRows =
                options.recentMs && options.recentMs > 0
                    ? sortedRows.filter((row) => {
                        const ts = row.lastActiveAt?.getTime() ?? row.updatedAt?.getTime() ?? 0;
                        return Date.now() - ts <= options.recentMs!;
                    })
                    : sortedRows;
            const limitedRows =
                typeof options.maxSessions === 'number' && options.maxSessions > 0
                    ? filteredRows.slice(0, options.maxSessions)
                    : filteredRows;

            const sessions: SessionState[] = [];

            for (const row of limitedRows) {
                const [messageRows, artifactRows, checkpointRows] = await Promise.all([
                    this.deps.messages.listBySession(row.id),
                    this.deps.artifacts?.listBySession(row.id) ?? Promise.resolve([]),
                    this.deps.checkpoints?.listBySession(row.id) ?? Promise.resolve([]),
                ]);

                const session = this.hydrateSessionFromRow(
                    row,
                    this.limitByCount(messageRows, options.maxMessages),
                    this.limitByCount(artifactRows, options.maxArtifacts),
                    this.limitByCount(checkpointRows, options.maxCheckpoints),
                );

                // Ensure workspace exists
                if (!fs.existsSync(session.workspaceDir)) {
                    fs.mkdirSync(session.workspaceDir, { recursive: true });
                }

                sessions.push(session);
            }

            this.log.info(
                {
                    count: sessions.length,
                    truncated: activeRows.length > sessions.length,
                },
                '[SessionPersistence] Hydrated sessions',
            );
            return sessions;
        } catch (error) {
            this.log.error({ err: error }, '[SessionPersistence] Unable to hydrate sessions');
            return [];
        }
    }

    async hydrateSession(sessionId: string, options: HydrationOptions = {}): Promise<SessionState | undefined> {
        try {
            const row = await this.deps.sessions.findById?.(sessionId);
            if (!row) {
                return undefined;
            }
            const [messageRows, artifactRows, checkpointRows] = await Promise.all([
                this.deps.messages.listBySession(sessionId),
                this.deps.artifacts?.listBySession(sessionId) ?? Promise.resolve([]),
                this.deps.checkpoints?.listBySession(sessionId) ?? Promise.resolve([]),
            ]);
            const session = this.hydrateSessionFromRow(
                row,
                this.limitByCount(messageRows, options.maxMessages),
                this.limitByCount(artifactRows, options.maxArtifacts),
                this.limitByCount(checkpointRows, options.maxCheckpoints),
            );
            if (!fs.existsSync(session.workspaceDir)) {
                fs.mkdirSync(session.workspaceDir, { recursive: true });
            }
            return session;
        } catch (error) {
            this.log.error({ err: error, sessionId }, '[SessionPersistence] Unable to hydrate session');
            return undefined;
        }
    }

    async getExecutionCoordinationFacts(
        sessionId: string,
    ): Promise<SessionExecutionCoordinationFacts | null> {
        return this.deps.sessions.getExecutionCoordinationFacts(sessionId);
    }

    async getExecutionCoordinationFactsMany(
        sessionIds: readonly string[],
    ): Promise<SessionExecutionCoordinationFacts[]> {
        return this.deps.sessions.getExecutionCoordinationFactsMany(sessionIds);
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.deps.sessions.delete(sessionId);
    }

    async persistSession(session: SessionState, isNew: boolean): Promise<void> {
        return this.enqueue(session.id, async () => {
            try {
                const expectedVersion = !isNew && typeof session.version === 'number'
                    ? Math.max(0, session.version - 1)
                    : undefined;
                if (isNew) {
                    try {
                        await this.deps.sessions.create(this.serializeSession(session));
                        return;
                    } catch (error: unknown) {
                        if (!this.isDuplicateKeyError(error)) {
                            throw error;
                        }
                        // If already exists (replay/race), fall through to update.
                    }
                }

                const updated = await this.tryUpdateSession(session, expectedVersion, /*logOnConflict*/ true);
                if (!updated) {
                    return;
                }
            } catch (error: unknown) {
                const cause = this.getErrorCause(error);
                this.log.error(
                    {
                        err: toLogSafeError(error),
                        cause: cause ? toLogSafeError(cause).message : undefined,
                        sessionId: session.id,
                    },
                    '[SessionPersistence] Failed to persist session',
                );
            }
        });
    }

    async persistMetadata(session: SessionState): Promise<void> {
        return this.enqueue(session.id, async () => {
            const expectedVersion = typeof session.version === 'number' ? Math.max(0, session.version - 1) : undefined;
            const fields: SessionUpdateFields = {
                metadata: this.buildMetadata(session),
                updatedAt: new Date(),
                lastActiveAt: new Date(session.lastActive),
            };
            const updated = await this.tryUpdateFields(session.id, fields, expectedVersion, /*logOnConflict*/ false);
            if (!updated) {
                await this.tryUpdateFields(session.id, fields, undefined, /*logOnConflict*/ false);
            }
        });
    }

    async persistMessage(sessionId: string, message: Message): Promise<void> {
        try {
            await this.deps.messages.append({
                sessionId,
                role: message.role,
                content: message.content,
                toolName: message.toolName ?? null,
                toolCallId: message.toolCallId ?? null,
                metadata: {
                    ...(message.metadata ?? {}),
                    ...(message.status ? { status: message.status } : {}),
                    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
                },
                createdAt: new Date(message.timestamp),
            });
        } catch (error: unknown) {
            const cause = this.getErrorCause(error);
            this.log.error(
                {
                    err: toLogSafeError(error),
                    cause: cause ? toLogSafeError(cause).message : undefined,
                    sessionId,
                },
                '[SessionPersistence] Failed to persist message',
            );
        }
    }

    async persistCheckpoint(sessionId: string, metadata: CheckpointMetadata): Promise<void> {
        if (!this.deps.checkpoints) return;

        try {
            await this.deps.checkpoints.create({
                id: metadata.id,
                sessionId,
                parentId: null,
                metadata: { ...metadata },
                createdAt: new Date(metadata.ts ?? Date.now()),
            });
        } catch (error) {
            this.log.error(
                { err: toLogSafeError(error), sessionId, checkpointId: metadata.id },
                '[SessionPersistence] Failed to persist checkpoint',
            );
        }
    }

    private serializeSession(session: SessionState): NewAgentSessionRow {
        return {
            id: session.id,
            userId: session.userId ?? null,
            mode: session.mode ?? 'automated',
            agentType: session.agentType ?? 'chat',
            title: session.title ?? session.task?.title ?? null,
            scopeId: session.scopeId ?? null,
            workspaceDir: session.workspaceDir,
            metadata: this.buildMetadata(session),
            plan: session.plan ?? [],
            summary: session.summary ?? null,
            completed: this.isSessionCompleted(session),
            createdAt: new Date(session.createdAt),
            updatedAt: new Date(),
            lastActiveAt: new Date(session.lastActive),
        };
    }

    private serializeSessionUpdate(session: SessionState): SessionUpdateFields {
        return {
            userId: session.userId ?? null,
            mode: session.mode ?? 'automated',
            agentType: session.agentType ?? 'chat',
            title: session.title ?? session.task?.title ?? null,
            scopeId: session.scopeId ?? null,
            workspaceDir: session.workspaceDir,
            metadata: this.buildMetadata(session),
            updatedAt: new Date(),
            lastActiveAt: new Date(session.lastActive),
        };
    }

    private isSessionCompleted(session: SessionState): boolean {
        return session.completed === true || getSessionCompletionFlag(session);
    }

    /**
     * Run tasks serially per session id to avoid concurrent writes racing on the same session row.
     */
    private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
        const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(task);

        // Store a chain that swallows errors so later tasks are not blocked.
        this.sessionQueues.set(sessionId, next.catch(() => undefined));

        return next.finally(() => {
            const current = this.sessionQueues.get(sessionId);
            if (current === next || current === undefined) {
                this.sessionQueues.delete(sessionId);
            }
        });
    }

    private async tryUpdateSession(session: SessionState, expectedVersion?: number, logOnConflict = true): Promise<boolean> {
        return this.tryUpdateFields(
            session.id,
            this.serializeSessionUpdate(session),
            expectedVersion,
            logOnConflict,
        );
    }

    private async tryUpdateFields(
        sessionId: string,
        fields: SessionUpdateFields,
        expectedVersion?: number,
        logOnConflict = true,
    ): Promise<boolean> {
        try {
            await this.deps.sessions.update(sessionId, fields, { expectedVersion });
            return true;
        } catch (error: unknown) {
            if (this.isVersionConflict(error)) {
                if (logOnConflict && this.verboseLogging) {
                    console.debug?.(
                        `[SessionPersistence] optimistic miss for session ${sessionId} (expectedVersion=${expectedVersion ?? 'none'})`,
                    );
                }
                return false;
            }
            throw error;
        }
    }

    private isDuplicateKeyError(error: unknown): boolean {
        const msg = toSafeError(error).message;
        const code = this.getErrorCode(error);
        const cause = this.getErrorCause(error);
        const causeMsg = cause ? toSafeError(cause).message : '';
        return (
            code === '23505' ||
            msg.toLowerCase().includes('duplicate key') ||
            causeMsg.toLowerCase().includes('duplicate key')
        );
    }

    private isVersionConflict(error: unknown): boolean {
        const code = this.getErrorCode(error);
        const cause = this.getErrorCause(error);
        const msg = `${toSafeError(error).message} ${cause ? toSafeError(cause).message : ''}`.toLowerCase();
        return code === 'session_version_conflict' || code === 'session.conflict' || msg.includes('session_version_conflict');
    }

    private getErrorCause(error: unknown): unknown {
        return isRecord(error) ? error['cause'] : undefined;
    }

    private getErrorCode(error: unknown): string | undefined {
        if (isRecord(error) && typeof error['code'] === 'string') {
            return error['code'];
        }
        const cause = this.getErrorCause(error);
        if (isRecord(cause) && typeof cause['code'] === 'string') {
            return cause['code'];
        }
        return undefined;
    }

    private buildMetadata(session: SessionState): PersistedSessionMetadata {
        const flags = { ...(session.flags ?? {}) } as SessionFlags;
        if (isRecord(flags.session)) {
            const sessionFlags = { ...flags.session };
            delete sessionFlags.completed;
            if (Object.keys(sessionFlags).length > 0) flags.session = sessionFlags;
            else delete flags.session;
        }
        return {
            version: session.version ?? 0,
            profileKey: session.profileKey,
            promptProfile: session.promptProfile,
            extraContext: session.extraContext,
            scopeId: session.scopeId,
            softContextBlocks: session.softContextBlocks,
            planVersionHash: session.planVersionHash,
            sandboxProfile: session.sandboxProfile,
            sandboxImage: session.sandboxImage,
            modelName: session.modelName,
            modelContextWindow: session.modelContextWindow,
            modelMaxOutputTokens: session.modelMaxOutputTokens,
            modelTemperature: session.modelTemperature,
            toolPolicy: session.toolPolicy,
            // Lifecycle completion is a journal-owned coordination projection.
            // Mutable cache persistence must never complete or reopen a session
            // through the legacy metadata compatibility flag.
            flags,
            memory: session.memory as unknown as Record<string, unknown>,
            pendingApproval: session.pendingApproval,
            blockedMeta: session.blockedMeta,
            task: session.task,
            coordination: session.coordination,
            workerTasks: session.workerTasks ?? [],
            workerResult: session.workerResult,
            lastCheckpoint: session.lastCheckpoint,
            currentPlanStepId: session.currentPlanStepId,
            scratchTodos: session.scratchTodos ?? [],
            turn: session.turn ?? 0,
            liveToolStreams: sanitizeLiveToolStreams(session.liveToolStreams),
            timeline: session.timeline ?? [],
        };
    }

    private hydrateSessionFromRow(
        row: AgentSessionRow,
        messageRows: MessageRow[],
        artifactRows: ArtifactRow[],
        checkpointRows: AgentCheckpointRow[],
    ): SessionState {
        const metadata = (row.metadata ?? {}) as PersistedSessionMetadata;
        const metadataCompleted = getSessionCompletionFlag({ flags: metadata.flags ?? {} });
        const plan: PlanItem[] = Array.isArray(row.plan) ? (row.plan as PlanItem[]) : [];
        const scratchTodos: TodoItem[] = Array.isArray(metadata.scratchTodos)
            ? metadata.scratchTodos
            : [];
        const checkpoints: Record<string, CheckpointMetadata> = {};
        for (const checkpointRow of checkpointRows) {
            const checkpoint = this.adaptCheckpoint(checkpointRow);
            checkpoints[checkpoint.id] = checkpoint;
        }
        return {
            id: row.id,
            version: metadata.version ?? 0,
            userId: row.userId ?? undefined,
            messages: messageRows.map((message) => this.adaptMessage(message)),
            plan,
            scratchTodos,
            memory: MemoryManager.fromRecord(metadata.memory ?? {}),
            flags: metadata.flags ?? {},
            workspaceDir: row.workspaceDir,
            profileKey: metadata.profileKey,
            promptProfile: metadata.promptProfile ?? (row.agentType as SessionState['agentType']) ?? 'chat',
            extraContext: metadata.extraContext,
            scopeId: row.scopeId ?? metadata.scopeId,
            agentType: (row.agentType as SessionState['agentType']) ?? 'chat',
            completed: row.completed === true || metadataCompleted,
            createdAt: row.createdAt?.getTime() ?? Date.now(),
            lastActive: row.lastActiveAt?.getTime() ?? Date.now(),
            turn: metadata.turn ?? 0,
            blockedReason: row.blockedReason ?? undefined,
            blockedMeta: isRecord(metadata.blockedMeta) ? metadata.blockedMeta : undefined,
            pendingApproval: metadata.pendingApproval,
            checkpoints,
            lastCheckpoint: metadata.lastCheckpoint,
            task: metadata.task,
            coordination: metadata.coordination,
            workerTasks: Array.isArray(metadata.workerTasks) ? metadata.workerTasks : [],
            workerResult: metadata.workerResult,
            title: row.title ?? undefined,
            toolPolicy: metadata.toolPolicy,
            softContextBlocks: metadata.softContextBlocks,
            planVersionHash: metadata.planVersionHash,
            sandboxProfile: metadata.sandboxProfile,
            sandboxImage: metadata.sandboxImage,
            modelName: metadata.modelName,
            modelContextWindow: metadata.modelContextWindow,
            modelMaxOutputTokens: metadata.modelMaxOutputTokens,
            modelTemperature: metadata.modelTemperature,
            mode: (row.mode as 'interactive' | 'automated') ?? 'automated',
            summary: row.summary ?? undefined,
            artifacts: artifactRows.map((artifact) => this.adaptArtifact(artifact)),
            liveToolStreams: sanitizeLiveToolStreams(metadata.liveToolStreams),
            timeline: Array.isArray(metadata.timeline) ? metadata.timeline : [],
            usage: this.extractUsageFromFlags(metadata.flags),
            // CRITICAL: Attach state machine for hydrated sessions
            // Without this, deriveStatus() always returns 'idle'
            stateMachine: createSessionStateMachine(row.id, logger),
        };
    }

    private adaptMessage(row: MessageRow): Message {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const metadata = Object.keys(meta).length > 0 ? (meta as Message['metadata']) : undefined;
        return {
            id: row.id,
            role: row.role as Message['role'],
            content: row.content,
            toolName: row.toolName ?? undefined,
            timestamp: row.createdAt?.getTime() ?? Date.now(),
            metadata,
            status: typeof meta.status === 'string' ? (meta.status as Message['status']) : undefined,
            // CRITICAL: Restore tool linking fields for proper session resume
            toolCallId: row.toolCallId ?? undefined,
            tool_calls: Array.isArray(meta.tool_calls) ? meta.tool_calls as Message['tool_calls'] : undefined,
        };
    }

    private adaptArtifact(row: ArtifactRow): SessionArtifact {
        return {
            id: row.id,
            filePath: row.filePath,
            originalName: row.originalName,
            fileType: row.fileType ?? 'txt',
            sizeBytes: row.sizeBytes == null ? 0 : Number(row.sizeBytes),
            createdAt: row.createdAt?.getTime() ?? Date.now(),
        };
    }

    private adaptCheckpoint(row: AgentCheckpointRow): CheckpointMetadata {
        const meta = (row.metadata ?? {}) as Partial<CheckpointMetadata>;
        return {
            id: meta.id ?? row.id,
            ts: meta.ts ?? row.createdAt?.toISOString() ?? new Date().toISOString(),
            filesCount: meta.filesCount ?? 0,
            sizeBytes: meta.sizeBytes ?? 0,
        };
    }

    private extractUsageFromFlags(flags?: SessionFlags): SessionState['usage'] {
        const usage = (flags?.token_usage_totals as Record<string, unknown> | undefined) ?? undefined;
        if (!usage) return undefined;
        const promptTokens = Number(usage.promptTokens ?? 0);
        const completionTokens = Number(usage.completionTokens ?? 0);
        const totalTokens = Number(usage.totalTokens ?? promptTokens + completionTokens);
        const cost = usage.cost !== undefined ? Number(usage.cost) : undefined;
        const credits = usage.credits !== undefined ? Number(usage.credits) : undefined;
        const platformCost = usage.platformCost !== undefined ? Number(usage.platformCost) : undefined;
        const platformPrice = usage.platformPrice !== undefined ? Number(usage.platformPrice) : undefined;
        const currency = typeof usage.currency === 'string' ? usage.currency : undefined;
        const model = typeof usage.model === 'string' ? usage.model : undefined;
        const contextWindow = typeof usage.contextWindow === 'number' ? usage.contextWindow : undefined;
        const contextRemaining = typeof usage.contextRemaining === 'number' ? usage.contextRemaining : undefined;

        if ([promptTokens, completionTokens, totalTokens].every((v) => Number.isNaN(v))) {
            return undefined;
        }

        return {
            promptTokens: Number.isNaN(promptTokens) ? 0 : promptTokens,
            completionTokens: Number.isNaN(completionTokens) ? 0 : completionTokens,
            totalTokens: Number.isNaN(totalTokens) ? promptTokens + completionTokens : totalTokens,
            cost: Number.isNaN(cost ?? NaN) ? undefined : cost,
            credits: Number.isNaN(credits ?? NaN) ? undefined : credits,
            platformCost: Number.isNaN(platformCost ?? NaN) ? undefined : platformCost,
            platformPrice: Number.isNaN(platformPrice ?? NaN) ? undefined : platformPrice,
            currency,
            model,
            contextWindow,
            contextRemaining,
        };
    }

    private limitByCount<T>(items: T[], max?: number): T[] {
        if (typeof max !== 'number' || max <= 0) {
            return items;
        }
        if (items.length <= max) {
            return items;
        }
        return items.slice(items.length - max);
    }
}

