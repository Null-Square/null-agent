import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ResolvedConfig } from '@/config/configTypes';

export interface ToolInvocationRecordInput {
  sessionId?: string;
  automationRunId?: string | null;
  toolId: string;
  stepId?: string | null;
  input?: unknown;
}

export interface SessionArtifactInput {
  type?: string | null;
  path: string;
  label?: string | null;
  metadata?: Record<string, unknown>;
}

const INVOCATION_FILENAME = 'session-tool-invocations.json';

const resolveInvocationPath = (config?: ResolvedConfig): string => {
  const traceRoot = path.resolve(
    process.cwd(),
    config?.trace.traceLogsRoot ?? 'storage/object-store/traces',
  );
  const historyDir = path.dirname(traceRoot);
  return path.resolve(historyDir, INVOCATION_FILENAME);
};

/**
 * Lightweight recorder that tracks the latest invocation id per session.
 * The data is written to disk so artifact attachments remain referenceable
 * across restarts in the slim stack.
 */
export class SessionToolInvocationRecorder {
  private readonly latestInvocationBySession = new Map<string, string>();
  private readonly recordPath: string;
  private ready: Promise<void>;
  private saveTimer?: NodeJS.Timeout;
  private readonly config?: ResolvedConfig;

  constructor(config?: ResolvedConfig) {
    this.config = config;
    this.recordPath = resolveInvocationPath(config);
    this.ready = Promise.resolve(); // disable disk hydration to avoid creating session-tool-invocations.json
  }

  private async loadFromDisk(): Promise<void> {
    // no-op to prevent creating/reading session-tool-invocations.json
  }

  private scheduleSave(): void {
    // disabled: no disk persistence
  }

  private async persist(): Promise<void> {
    // disabled: avoid writing session-tool-invocations.json
  }

  async recordStart(input: ToolInvocationRecordInput): Promise<string | null> {
    await this.ready;
    if (!input.sessionId) {
      return null;
    }
    const id = uuidv4();
    this.latestInvocationBySession.set(input.sessionId, id);
    this.scheduleSave();
    return id;
  }

  async recordSuccess(_invocationId: string, _result: unknown): Promise<void> {
    // no-op; hook exists for future persistence if needed.
  }

  async recordFailure(_invocationId: string, _error: unknown): Promise<void> {
    // no-op; hook exists for future persistence if needed.
  }

  async recordArtifactsForSession(sessionId: string, _artifacts: SessionArtifactInput[]): Promise<void> {
    await this.ready;
    if (!this.latestInvocationBySession.has(sessionId)) {
      this.latestInvocationBySession.set(sessionId, uuidv4());
      this.scheduleSave();
    }
  }

  getLatestInvocationId(sessionId: string): string | undefined {
    return this.latestInvocationBySession.get(sessionId);
  }
}

export default SessionToolInvocationRecorder;
