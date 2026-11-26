import { v4 as uuidv4 } from 'uuid';
import { type SessionStore } from './SessionStore';
import { type StreamBroker } from './StreamBroker';
import { type CheckpointMetadata, type SessionState } from '../../domain/types';
import { CheckpointStorage } from '../../infrastructure/checkpoints/CheckpointStorage';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { TraceEventPayload } from '../../infrastructure/telemetry';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';

// summarizeForNote imported from @/shared/utils/text

export class CheckpointManager {
  private readonly storage: CheckpointStorage;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly streamBroker: StreamBroker,
    private readonly traceRecorder?: SessionTraceRecorder,
  ) {
    this.storage = new CheckpointStorage();
  }

  async create(sessionId: string): Promise<CheckpointMetadata> {
    const session = this.ensureSession(sessionId);
    const checkpointsDir = await this.storage.ensureCheckpointRoot(session);
    const workspaceDir = session.workspaceDir;

    const checkpointId = uuidv4();
    const checkpointDir = await this.storage.createCheckpointDir(checkpointsDir, checkpointId);

    await this.storage.copyWorkspaceToCheckpoint(workspaceDir, checkpointDir);

    const stats = await this.storage.computeDirectoryStats(checkpointDir);
    const metadata: CheckpointMetadata = {
      id: checkpointId,
      ts: new Date().toISOString(),
      filesCount: stats.filesCount,
      sizeBytes: stats.sizeBytes,
    };

    this.sessionStore.addCheckpoint(sessionId, metadata);
    this.emitCreated(sessionId, metadata);
    await this.recordTrace(sessionId, session, 'checkpoint.created', metadata, `created:${metadata.id}`);
    return metadata;
  }

  async restore(sessionId: string, checkpointId: string): Promise<CheckpointMetadata> {
    const session = this.ensureSession(sessionId);
    const checkpointsDir = await this.storage.ensureCheckpointRoot(session);
    // We need to construct the path manually here as CheckpointStorage doesn't expose a join method,
    // but it's better to keep path logic consistent.
    // Ideally CheckpointStorage should handle this, but for now we assume standard structure.
    // Let's rely on CheckpointStorage to validate existence.
    // Actually, we can just use the path module here as it is a utility, or add a method to storage.
    // Let's add a method to storage or just use path.join since we import it?
    // Wait, I removed path import. Let's re-add path import or add a helper to storage.
    // Adding a helper to storage is cleaner but requires changing the previous file.
    // For now, I will re-import path as it is a standard lib and harmless for path manipulation.
    // BUT, the goal was to remove FS ops. Path ops are fine.
    // However, to be strictly cleaner, I should ask storage to get the path.
    // Let's just use path.join here.
    const path = require('path');
    const checkpointDir = path.join(checkpointsDir, checkpointId);
    const workspaceDir = session.workspaceDir;

    const exists = await this.storage.exists(checkpointDir);
    if (!exists) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    await this.storage.restoreCheckpointToWorkspace(checkpointDir, workspaceDir);

    let metadata = this.sessionStore.updateLastCheckpoint(sessionId, checkpointId);
    if (!metadata) {
      metadata = await this.rehydrateMetadataFromDisk(checkpointDir, checkpointId);
      this.sessionStore.addCheckpoint(sessionId, metadata);
    }

    this.emitRestored(sessionId, checkpointId);
    await this.recordTrace(sessionId, session, 'checkpoint.restored', metadata, `restored:${checkpointId}`);
    return metadata;
  }

  async list(sessionId: string): Promise<CheckpointMetadata[]> {
    return this.sessionStore.listCheckpoints(sessionId);
  }

  private ensureSession(sessionId: string): SessionState {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private emitCreated(sessionId: string, metadata: CheckpointMetadata): void {
    this.streamBroker.emit(sessionId, {
      type: 'checkpoint_created',
      data: metadata,
    });
  }

  private emitRestored(sessionId: string, checkpointId: string): void {
    this.streamBroker.emit(sessionId, {
      type: 'checkpoint_restored',
      data: { id: checkpointId },
    });
  }

  private async recordTrace(
    sessionId: string,
    session: SessionState,
    event: string,
    payload: unknown,
    noteText: string,
  ): Promise<void> {
    if (!this.traceRecorder) {
      return;
    }
    try {
      await this.traceRecorder.write(sessionId, (session.turn ?? 0) + 1, {
        event,
        severity: 'info',
        payload: toTracePayload(payload),
        note: summarizeForNote(noteText),
      });
    } catch (error) {
      logger.warn({ err: error, sessionId, event }, 'Failed to record trace event');
    }
  }

  private async rehydrateMetadataFromDisk(
    checkpointDir: string,
    checkpointId: string,
  ): Promise<CheckpointMetadata> {
    const stats = await this.storage.computeDirectoryStats(checkpointDir);
    const metadata: CheckpointMetadata = {
      id: checkpointId,
      ts: new Date().toISOString(),
      filesCount: stats.filesCount,
      sizeBytes: stats.sizeBytes,
    };
    return metadata;
  }
}

const toTracePayload = (value: unknown): TraceEventPayload => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toTracePayload(item));
  }
  if (typeof value === 'object') {
    return value;
  }
  return String(value);
};
