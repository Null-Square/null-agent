import type { AppLogger } from '@/shared/logger';
import type { SessionRepositoryPort } from '../../ports';
import type { Message, SessionState, CheckpointMetadata } from '../../domain/types';
import type { HydrationOptions } from '../../ports/sessionRepository';
import { SessionPersistenceHelper } from './SessionPersistenceHelper';

export interface SessionPersistenceAdapterOptions {
  sessions: Map<string, SessionState>;
  sessionRepository?: SessionRepositoryPort;
  logger: AppLogger;
  onPersistError?: (info: {
    sessionId: string;
    stage: 'session' | 'metadata' | 'message' | 'checkpoint';
    error: Error;
    attempt?: number;
  }) => void;
  hydrationOptions?: HydrationOptions;
  ensureWorkspace?: (dir: string, ownerId?: string) => Promise<void>;
}

export class SessionPersistenceAdapter {
  private readonly helper: SessionPersistenceHelper;
  private readonly sessionRepository?: SessionRepositoryPort;

  constructor(options: SessionPersistenceAdapterOptions) {
    this.sessionRepository = options.sessionRepository;
    this.helper = new SessionPersistenceHelper({
      sessions: options.sessions,
      persistedSessionIds: new Set<string>(),
      sessionRepository: options.sessionRepository,
      logger: options.logger,
      onPersistError: options.onPersistError,
      hydrationOptions: options.hydrationOptions,
      workspaceManager: options.ensureWorkspace
        ? { ensureWorkspace: options.ensureWorkspace }
        : undefined,
    });
  }

  startHydration(): Promise<void> {
    return this.helper.startHydration();
  }

  whenReady(): Promise<void> {
    return this.helper.whenReady();
  }

  hydrateIfMissing(sessionId: string): Promise<void> {
    return this.helper.hydrateIfMissing(sessionId);
  }

  queuePersistSession(session: SessionState, options: { insert?: boolean } = {}): void {
    this.helper.queuePersistSession(session, options);
  }

  queuePersistMetadata(session: SessionState): void {
    this.helper.queuePersistMetadata(session);
  }

  queuePersistMessage(sessionId: string, message: Message): void {
    this.helper.queuePersistMessage(sessionId, message);
  }

  queuePersistCheckpoint(sessionId: string, metadata: CheckpointMetadata): void {
    this.helper.queuePersistCheckpoint(sessionId, metadata);
  }

  waitForSessionPersisted(sessionId: string): Promise<void> {
    return this.helper.waitForSessionPersisted(sessionId);
  }

  waitForMetadataPersisted(sessionId: string): Promise<void> {
    return this.helper.waitForMetadataPersisted(sessionId);
  }

  isPersisted(sessionId: string): boolean {
    return this.helper.isPersisted(sessionId);
  }

  removePersisted(sessionId: string): void {
    this.helper.removePersisted(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.sessionRepository?.deleteSession) {
      await this.sessionRepository.deleteSession(sessionId);
    }
    this.helper.removePersisted(sessionId);
  }
}
