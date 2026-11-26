import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { ulid } from 'ulid';
import { NdjsonWriter } from './writers/NdjsonWriter';
import { type MarkdownHeader, MarkdownWriter } from './writers/MarkdownWriter';
import type { IndexEntry } from './writers/FileIndex';
import { FileIndex } from './writers/FileIndex';
import { redactPayload } from './redact';
import {
  type SessionTraceCloseMeta,
  type SessionTraceRecorderOptions,
  type SessionTraceSeed,
  type TraceSessionContext,
  type TraceEvent,
  type TraceEventPayload,
  type TraceArtifactReceipt,
  type TraceCorrelationHeader,
  type TraceWriteResult,
  type TraceWriteRejectionReason,
} from './types';
import { type S3StorageService } from '@/shared/storage/S3StorageService';
import { sessionIdFromPath } from './utils';
import type { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { logger } from '@/shared/logger';
import { toSafeError } from '@/shared/errors';
import {
  reconcileTraceIntegrity,
  type TraceIntegrityResult,
} from './TraceIntegrity';

interface SessionContext {
  id: string;
  createdAt: string;
  seed: SessionTraceSeed;
  dir: string;
  artifactDir: string;
  ndjson?: NdjsonWriter;
  markdown?: MarkdownWriter;
  ndjsonBuffer?: string[];
  markdownBuffer?: string[];
  ndjsonDirty?: boolean;
  markdownDirty?: boolean;
  pendingTraceEvents?: number;
  flushTimer?: NodeJS.Timeout;
  flushPromise?: Promise<void>;
  /**
   * The accepted ordinal the in-flight upload will have persisted once it lands.
   *
   * `persistedHighWater` used to be advanced only by the invocation that owned the upload. A
   * second invocation that merely awaited that upload — which is exactly what close does —
   * saw `ndjsonDirty` already cleared, skipped the upload block, and never advanced anything.
   * Whether the mark moved then depended on which continuation the event loop ran first, and
   * in practice it lost: every S3-only session closed `degraded` with a high-water mismatch,
   * on traces that were completely intact in object storage.
   */
  inflightNdjsonHighWater?: number;
  currentTurn: number;
  turns: number;
  toolErrors: number;
  bytesWritten: number;
  s3TraceFlushes?: number;
  s3TraceObjectsUploaded?: number;
  s3TraceBytesUploaded?: number;
  lastEventAt?: string;
  acceptingWrites: boolean;
  writeTail: Promise<void>;
  acceptedHighWater: number;
  persistedHighWater: number;
  writerFailed: boolean;
  rejectedWrites: Array<{
    reason: TraceWriteRejectionReason;
    event?: string;
    required?: boolean;
  }>;
  artifactReceipts: Map<string, TraceArtifactReceipt>;
  pendingArtifactWrites: Set<Promise<void>>;
  failedArtifactWrites: Set<string>;
  integrity?: TraceIntegrityResult;
  closed?: boolean;
}

type TraceS3Config = {
  client: S3StorageService;
  bucket: string;
};

class NoopIndex {
  update(_sessionId: string, _entry: IndexEntry): void {
    // no-op for S3-only mode
  }
}

const DEFAULT_OPTIONS: SessionTraceRecorderOptions = {
  rootDir: path.resolve(process.cwd(), 'logs', 'ai-agent'),
  inlineLimit: 4096,
  stdoutChunkSize: 65536,
  compressOverBytes: 1_048_576,
  retentionDays: 14,
  s3FlushIntervalMs: 5_000,
  s3FlushMaxEvents: 25,
};

export class SessionTraceRecorder {
  private readonly options: SessionTraceRecorderOptions;
  private readonly sessions: Map<string, SessionContext> = new Map();
  private readonly index: { update: (sessionId: string, entry: IndexEntry) => void };
  private readonly s3?: TraceS3Config;
  private readonly useS3Only: boolean;
  private readonly keepLocalCopy: boolean;
  private readonly pendingContext: Map<string, Partial<SessionTraceSeed>> = new Map();
  private readonly closedSessionIds: Set<string> = new Set();
  private readonly log = logger.child({ scope: 'SessionTraceRecorder' });

  constructor(
    options?: Partial<SessionTraceRecorderOptions>,
    s3?: TraceS3Config,
    private readonly traceIndexRepo?: TraceIndexRepository,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };
    this.keepLocalCopy = this.options.keepLocalCopy === true;
    this.useS3Only = Boolean(s3) && !this.keepLocalCopy;
    if (!this.useS3Only) {
      fs.mkdirSync(this.options.rootDir, { recursive: true });
    }
    this.index = this.useS3Only ? new NoopIndex() : new FileIndex(path.join(this.options.rootDir, 'index.json'));
    this.s3 = s3;
    // Eager bucket ensure for traces
    if (this.s3) {
      void this.s3.client.ensureBucket().catch((err) =>
        this.log.warn({ err }, '[TraceRecorder] ensureBucket failed'),
      );
    }
  }

  async init(sessionId: string, seed: SessionTraceSeed): Promise<void> {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const createdAt = new Date().toISOString();
    const pendingSeedContext = this.pendingContext.get(sessionId);
    this.pendingContext.delete(sessionId);
    const initialSeed = this.mergeSeed(seed, pendingSeedContext);
    const dir = path.join(this.options.rootDir, sessionId);
    const artifactDir = path.join(dir, 'artifacts');
    if (!this.useS3Only) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    const ndjson = this.useS3Only ? undefined : new NdjsonWriter(path.join(dir, 'trace.ndjson'));
    const markdown = this.useS3Only ? undefined : new MarkdownWriter(path.join(dir, 'trace.md'));

    const context: SessionContext = {
      id: sessionId,
      createdAt,
      seed: initialSeed,
      dir,
      artifactDir,
      ndjson,
      markdown,
      ndjsonBuffer: this.useS3Only ? [] : undefined,
      markdownBuffer: this.useS3Only ? [] : undefined,
      currentTurn: 0,
      turns: 0,
      toolErrors: 0,
      bytesWritten: 0,
      s3TraceFlushes: 0,
      s3TraceObjectsUploaded: 0,
      s3TraceBytesUploaded: 0,
      acceptingWrites: true,
      writeTail: Promise.resolve(),
      acceptedHighWater: 0,
      persistedHighWater: 0,
      writerFailed: false,
      rejectedWrites: [],
      artifactReceipts: new Map(),
      pendingArtifactWrites: new Set(),
      failedArtifactWrites: new Set(),
    };

    this.closedSessionIds.delete(sessionId);
    this.sessions.set(sessionId, context);

    const header: MarkdownHeader = {
      sessionId,
      createdAt,
      workspace: initialSeed.workspace,
      container: initialSeed.container,
      tools: initialSeed.tools,
    };
    if (this.useS3Only && context.markdownBuffer) {
      context.markdownBuffer.push(`# Session ${sessionId}\n\n`);
      context.markdownBuffer.push(`Workspace: ${seed.workspace}\n\n`);
    } else {
      context.markdown?.writeHeader(header);
    }

    await this.write(sessionId, 0, {
      event: 'session.init',
      severity: 'info',
      payload: {
        workspace: initialSeed.workspace,
        container: initialSeed.container,
        tools: initialSeed.tools,
        profileKey: initialSeed.profileKey,
        promptProfile: initialSeed.promptProfile,
        agentType: initialSeed.agentType ?? 'chat',
        agentRole: initialSeed.agentRole ?? initialSeed.agentType ?? 'chat',
        runId: initialSeed.runId,
        phaseId: initialSeed.phaseId,
        workerTaskId: initialSeed.workerTaskId,
        extraContext: initialSeed.extraContext ?? false,
        model: initialSeed.model,
      },
      note: `workspace=${path.basename(initialSeed.workspace)}`,
    });

    this.index.update(sessionId, {
      sessionId,
      createdAt,
      model: initialSeed.model,
      containerId: initialSeed.container?.id,
      status: 'active',
      turns: 0,
      toolErrors: 0,
      bytes: 0,
      lastEventAt: createdAt,
    });
  }

  updateContext(sessionId: string, context: Partial<TraceSessionContext> & { agentType?: string; context?: SessionTraceSeed['context'] }): void {
    const current = this.sessions.get(sessionId);
    if (!current || current.closed) {
      const pending = this.pendingContext.get(sessionId);
      this.pendingContext.set(sessionId, this.mergeSeed(pending ?? {}, context));
      return;
    }
    current.seed = this.mergeSeed(current.seed, context);
  }

  writeJsonArtifact(sessionId: string, name: string, value: unknown): string | undefined {
    const context = this.sessions.get(sessionId);
    if (!context || context.closed) {
      return undefined;
    }

    const safeName = name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artifact';
    const redacted = redactPayload(value as TraceEventPayload, {
      inlineLimit: Number.MAX_SAFE_INTEGER,
      compressOverBytes: Number.MAX_SAFE_INTEGER,
    }).payload;
    let serialized: string;
    try {
      serialized = JSON.stringify(redacted, null, 2);
    } catch (error) {
      serialized = JSON.stringify({
        error: 'Could not serialize artifact',
        message: (error as Error).message,
      }, null, 2);
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    return this.writeArtifact(
      context,
      `${safeName}-${ulid()}`,
      '.json',
      Buffer.from(serialized, 'utf8'),
      bytes >= this.options.compressOverBytes,
    ).path;
  }

  async write(sessionId: string, turn: number, event: TraceEvent): Promise<TraceWriteResult> {
    const context = this.sessions.get(sessionId);
    if (!context) {
      return {
        accepted: false,
        reason: this.closedSessionIds.has(sessionId) ? 'closed' : 'missing_context',
      };
    }
    if (!context.acceptingWrites || context.closed) {
      return { accepted: false, reason: 'closed' };
    }

    const operation = context.writeTail.then(() => this.writeAccepted(context, turn, event));
    context.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeAccepted(
    context: SessionContext,
    turn: number,
    event: TraceEvent,
  ): Promise<TraceWriteResult> {
    const sessionId = context.id;
    if (context.writerFailed) {
      const rejection = { reason: 'writer_failed' as const, event: event.event, required: true };
      context.rejectedWrites.push(rejection);
      return { accepted: false, reason: rejection.reason };
    }

    const eventId = ulid();
    const acceptedOrdinal = context.acceptedHighWater + 1;
    const timestamp = new Date().toISOString();
    const monotonic = performance.now();

    const links: Record<string, string> = { ...(event.links || {}) };
    const hasPayload = typeof event.payload !== 'undefined';

    try {
      let redactionResult: ReturnType<typeof redactPayload> | undefined;
      if (hasPayload) {
        redactionResult = redactPayload(event.payload as TraceEventPayload, {
          inlineLimit: this.options.inlineLimit,
          compressOverBytes: this.options.compressOverBytes,
          createArtifact: ({ content, extension, compress }) =>
            this.writeArtifact(context, eventId, extension, content, compress),
        });
      }

      if (redactionResult?.artifactPath) {
        links.artifact = redactionResult.artifactPath;
        await Promise.all([...context.pendingArtifactWrites]);
      }

      const eventName = event.event;
      const correlation = this.buildCorrelationHeader({
        eventId,
        eventName,
        sessionId,
        turn,
        payload: event.payload,
        artifactReceipt: redactionResult?.artifactReceipt,
      });
      // Extract business context from seed
      const ctx = context.seed.context;
      const record: Record<string, unknown> & { event: string; severity: string } = {
        schemaVersion: 3,
        id: eventId,
        acceptedOrdinal,
        ...correlation,
        parentEventId: event.parentEventId ?? null,
        depth: event.depth ?? 0,
        runId: context.seed.runId,
        agentType: context.seed.agentType ?? 'chat',
        agentRole: context.seed.agentRole ?? context.seed.agentType ?? 'chat',
        phaseId: context.seed.phaseId,
        workerTaskId: context.seed.workerTaskId,
        // Business context - high-cardinality fields for analytics
        userId: ctx?.userId,
        tier: ctx?.tier,
        model: ctx?.model ?? context.seed.model,
        imageId: ctx?.imageId ?? context.seed.container?.image,
        // Event data
        ts: timestamp,
        tsp: Number(monotonic.toFixed(3)),
        severity: event.severity ?? 'info',
        links: Object.keys(links).length ? links : undefined,
        note: event.note,
      };

      if (hasPayload && redactionResult) {
        record.payload = redactionResult.payload;
      }

      let s3NdjsonDirty = false;
      let s3MarkdownDirty = false;

      if (this.useS3Only && context.ndjsonBuffer) {
        context.ndjsonBuffer.push(JSON.stringify(record));
        s3NdjsonDirty = true;
      } else if (context.ndjson) {
        await context.ndjson.append(record);
        context.persistedHighWater = acceptedOrdinal;
      } else {
        throw new Error('Trace writer is unavailable');
      }

      context.acceptedHighWater = acceptedOrdinal;
      context.bytesWritten += Buffer.byteLength(JSON.stringify(record), 'utf8');
      context.lastEventAt = timestamp;
      context.turns = Math.max(context.turns, turn);
      if (turn !== context.currentTurn && turn > 0) {
        if (this.useS3Only && context.markdownBuffer) {
          context.markdownBuffer.push(`\n## Turn ${turn}\n`);
          s3MarkdownDirty = true;
        } else {
          context.markdown?.appendTurn(turn);
        }
        context.currentTurn = turn;
      }
      const summary = `- **${timestamp}** [${eventName}] ${event.note ?? ''}`.trimEnd();
      if (this.useS3Only && context.markdownBuffer) {
        context.markdownBuffer.push(`${summary}\n`);
        s3MarkdownDirty = true;
      } else {
        context.markdown?.appendEvent(summary);
      }

      if (s3NdjsonDirty || s3MarkdownDirty) {
        this.scheduleS3TraceFlush(sessionId, context, {
          ndjson: s3NdjsonDirty,
          markdown: s3MarkdownDirty,
        });
      }

      if (eventName.startsWith('tool.') && record.severity === 'error') {
        context.toolErrors += 1;
      }
      if (eventName === 'error' && redactionResult) {
        const payload = redactionResult.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload === 'object' && payload['class'] === 'tool') {
          context.toolErrors += 1;
        }
      }

      this.index.update(sessionId, {
        sessionId,
        createdAt: context.createdAt,
        model: context.seed.model,
        containerId: context.seed.container?.id,
        status: 'active',
        turns: context.turns,
        toolErrors: context.toolErrors,
        bytes: context.bytesWritten,
        lastEventAt: context.lastEventAt,
        acceptedHighWater: context.acceptedHighWater,
        persistedHighWater: context.persistedHighWater,
      });

      return { accepted: true, eventId, acceptedOrdinal };
    } catch (error) {
      context.writerFailed = true;
      const rejection = { reason: 'writer_failed' as const, event: event.event, required: true };
      context.rejectedWrites.push(rejection);
      this.log.error({ err: error, sessionId, event: event.event }, 'Trace write rejected');
      return { accepted: false, reason: rejection.reason };
    }
  }

  private buildCorrelationHeader(input: {
    eventId: string;
    eventName: string;
    sessionId: string;
    turn: number;
    payload: TraceEventPayload | undefined;
    artifactReceipt?: TraceArtifactReceipt;
  }): TraceCorrelationHeader {
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? input.payload as Record<string, unknown>
      : {};
    const stringField = (...names: string[]): string | undefined => {
      for (const name of names) {
        const value = payload[name];
        if (typeof value === 'string' && value.trim()) return value;
      }
      return undefined;
    };
    const numberField = (...names: string[]): number | undefined => {
      for (const name of names) {
        const value = payload[name];
        if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      }
      return undefined;
    };
    return {
      eventId: input.eventId,
      event: input.eventName,
      sessionId: input.sessionId,
      turn: input.turn,
      requestId: stringField('requestId', 'modelRequestId'),
      attemptId: stringField('attemptId'),
      attemptOrdinal: numberField('attemptOrdinal'),
      toolCallId: stringField('toolCallId'),
      name: stringField('name', 'toolName'),
      status: stringField('status'),
      outcome: stringField('outcome'),
      artifactRef: input.artifactReceipt?.path,
      artifactSha256: input.artifactReceipt?.sha256,
    };
  }

  private mergeSeed<TBase extends Partial<SessionTraceSeed>>(base: TBase, patch?: Partial<SessionTraceSeed>): TBase & Partial<SessionTraceSeed> {
    if (!patch) {
      return { ...base };
    }
    return {
      ...base,
      ...patch,
      context: {
        ...(base.context ?? {}),
        ...(patch.context ?? {}),
      },
    };
  }

  private scheduleS3TraceFlush(
    sessionId: string,
    context: SessionContext,
    dirty: { ndjson?: boolean; markdown?: boolean },
  ): void {
    if (!this.useS3Only || !this.s3 || context.closed) {
      return;
    }
    context.ndjsonDirty = Boolean(context.ndjsonDirty || dirty.ndjson);
    context.markdownDirty = Boolean(context.markdownDirty || dirty.markdown);
    context.pendingTraceEvents = (context.pendingTraceEvents ?? 0) + 1;

    const maxEvents = Math.max(1, this.options.s3FlushMaxEvents ?? DEFAULT_OPTIONS.s3FlushMaxEvents ?? 25);
    if (context.pendingTraceEvents >= maxEvents) {
      void this.flushS3Trace(sessionId, context).catch((error) => {
        this.log.warn({ err: error, sessionId }, '[TraceRecorder] Failed to flush batched S3 trace');
      });
      return;
    }

    if (context.flushTimer) {
      return;
    }
    const intervalMs = Math.max(0, this.options.s3FlushIntervalMs ?? DEFAULT_OPTIONS.s3FlushIntervalMs ?? 5_000);
    context.flushTimer = setTimeout(() => {
      context.flushTimer = undefined;
      void this.flushS3Trace(sessionId, context).catch((error) => {
        this.log.warn({ err: error, sessionId }, '[TraceRecorder] Failed to flush scheduled S3 trace');
      });
    }, intervalMs);
    context.flushTimer.unref?.();
  }

  private clearS3FlushTimer(context: SessionContext): void {
    if (!context.flushTimer) {
      return;
    }
    clearTimeout(context.flushTimer);
    context.flushTimer = undefined;
  }

  private async flushS3Trace(sessionId: string, context: SessionContext, final: boolean = false): Promise<void> {
    if (!this.useS3Only || !this.s3) return;
    this.clearS3FlushTimer(context);

    if (context.flushPromise) {
      try {
        await context.flushPromise;
        // That upload carried the buffer, so whatever it covered is persisted — no matter
        // which invocation started it or whose continuation runs first.
        if (context.inflightNdjsonHighWater !== undefined) {
          context.persistedHighWater = Math.max(
            context.persistedHighWater,
            context.inflightNdjsonHighWater,
          );
        }
      } catch (error) {
        if (final) {
          this.log.warn({ err: error, sessionId }, '[TraceRecorder] Previous S3 trace flush failed before final flush');
        } else {
          throw error;
        }
      }
    }

    const ndjsonKey = `${sessionId}/trace.ndjson`;
    const markdownKey = `${sessionId}/trace.md`;
    const uploadNdjson = Boolean(context.ndjsonDirty && context.ndjsonBuffer && context.ndjsonBuffer.length > 0);
    const uploadMarkdown = Boolean(context.markdownDirty && context.markdownBuffer && context.markdownBuffer.length > 0);
    const flushHighWater = context.acceptedHighWater;

    const ndjsonPayload =
      uploadNdjson && context.ndjsonBuffer && context.ndjsonBuffer.length > 0
        ? Buffer.from(context.ndjsonBuffer.join('\n') + '\n', 'utf-8')
        : undefined;
    const markdownPayload =
      uploadMarkdown && context.markdownBuffer && context.markdownBuffer.length > 0
        ? Buffer.from(context.markdownBuffer.join(''), 'utf-8')
        : undefined;

    if (ndjsonPayload || markdownPayload) {
      if (uploadNdjson) {
        context.ndjsonDirty = false;
      }
      if (uploadMarkdown) {
        context.markdownDirty = false;
      }
      context.pendingTraceEvents = 0;

      const uploads: Promise<unknown>[] = [];
      if (ndjsonPayload) {
        uploads.push(this.s3.client.uploadBuffer(ndjsonKey, ndjsonPayload));
      }
      if (markdownPayload) {
        uploads.push(this.s3.client.uploadBuffer(markdownKey, markdownPayload));
      }

      const uploadPromise = Promise.all(uploads).catch((error) => {
        if (uploadNdjson) {
          context.ndjsonDirty = true;
          // Nothing landed, so nothing may be claimed as persisted from this attempt. Any
          // earlier success is already reflected in `persistedHighWater` itself.
          context.inflightNdjsonHighWater = undefined;
        }
        if (uploadMarkdown) {
          context.markdownDirty = true;
        }
        throw error;
      });
      const trackedPromise = uploadPromise.then(() => undefined);
      context.flushPromise = trackedPromise;
      if (ndjsonPayload) {
        // Declared before the await, so anyone waiting on this upload can settle the mark
        // themselves rather than depending on this invocation getting there first.
        context.inflightNdjsonHighWater = Math.max(
          context.inflightNdjsonHighWater ?? 0,
          flushHighWater,
        );
      }
      try {
        await trackedPromise;
        context.s3TraceFlushes = (context.s3TraceFlushes ?? 0) + 1;
        context.s3TraceObjectsUploaded =
          (context.s3TraceObjectsUploaded ?? 0) +
          (ndjsonPayload ? 1 : 0) +
          (markdownPayload ? 1 : 0);
        context.s3TraceBytesUploaded =
          (context.s3TraceBytesUploaded ?? 0) +
          (ndjsonPayload?.length ?? 0) +
          (markdownPayload?.length ?? 0);
        if (ndjsonPayload) {
          context.persistedHighWater = Math.max(context.persistedHighWater, flushHighWater);
        }
      } finally {
        if (context.flushPromise === trackedPromise) {
          context.flushPromise = undefined;
        }
      }
    }

    if (final && (context.ndjsonDirty || context.markdownDirty)) {
      await this.flushS3Trace(sessionId, context, true);
      return;
    }

  }

  async close(sessionId: string, meta: SessionTraceCloseMeta): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (!context) {
      this.closedSessionIds.add(sessionId);
      return;
    }
    // Quiescent close barrier: reject new work first, then drain every write that was
    // accepted into the session-local serialization queue.
    context.acceptingWrites = false;
    context.closed = true;
    this.clearS3FlushTimer(context);
    await context.writeTail;

    let closeBarrierFailed = false;
    let closeBarrierError: unknown;
    try {
      await Promise.all([...context.pendingArtifactWrites]);
    } catch (error) {
      closeBarrierFailed = true;
      closeBarrierError = error;
    }
    if (context.failedArtifactWrites.size > 0) {
      closeBarrierFailed = true;
      closeBarrierError ??= new Error(
        `Trace artifact writes failed: ${[...context.failedArtifactWrites].join(', ')}`,
      );
    }
    try {
      if (this.useS3Only) {
        await this.flushS3Trace(sessionId, context, true);
      } else {
        await Promise.all([context.ndjson?.close(), context.markdown?.close()]);
        context.persistedHighWater = context.acceptedHighWater;
      }
    } catch (error) {
      closeBarrierFailed = true;
      closeBarrierError ??= error;
    }
    if (closeBarrierFailed) {
      context.writerFailed = true;
      context.rejectedWrites.push({
        reason: 'writer_failed',
        event: 'session.close',
        required: true,
      });
      this.log.error({ err: closeBarrierError, sessionId }, 'Trace close barrier failed');
    }

    context.integrity = reconcileTraceIntegrity({
      sessionId,
      acceptedHighWater: context.acceptedHighWater,
      persistedHighWater: context.persistedHighWater,
      terminalReceipt: !closeBarrierFailed,
      writerFailed: context.writerFailed,
      rejectedWrites: context.rejectedWrites,
      expectations: [...context.artifactReceipts.values()].map((receipt) => ({
        surface: 'artifacts' as const,
        id: receipt.path,
        present: true,
        valid: !context.failedArtifactWrites.has(receipt.path),
      })),
    });

    const indexEntry: IndexEntry = {
      sessionId,
      createdAt: context.createdAt,
      model: context.seed.model,
      containerId: context.seed.container?.id,
      status: meta.status ?? meta.terminal,
      turns: meta.turns ?? context.turns,
      toolErrors: meta.toolErrors ?? context.toolErrors,
      bytes: meta.bytesWritten ?? context.bytesWritten,
      lastEventAt: meta.lastEventAt ?? context.lastEventAt ?? context.createdAt,
      acceptedHighWater: context.acceptedHighWater,
      persistedHighWater: context.persistedHighWater,
      integrityStatus: context.integrity.status,
      storage: {
        s3TraceFlushes: context.s3TraceFlushes ?? 0,
        s3TraceObjectsUploaded: context.s3TraceObjectsUploaded ?? 0,
        s3TraceBytesUploaded: context.s3TraceBytesUploaded ?? 0,
      },
    };
    this.index.update(sessionId, indexEntry);
    try {
      await this.persistCloseReceipts(context, indexEntry);
    } catch (error) {
      context.integrity = reconcileTraceIntegrity({
        sessionId,
        acceptedHighWater: context.acceptedHighWater,
        persistedHighWater: context.persistedHighWater,
        terminalReceipt: false,
        writerFailed: context.writerFailed,
        rejectedWrites: context.rejectedWrites,
      });
      indexEntry.integrityStatus = context.integrity.status;
      this.index.update(sessionId, indexEntry);
      this.log.error({ err: error, sessionId }, 'Trace close receipt could not be persisted');
      await this.upsertTraceIndex(sessionId, context);
    }
    this.sessions.delete(sessionId);
    this.closedSessionIds.add(sessionId);

    // Emit canonical session summary (single authoritative log line)
    const durationMs = context.lastEventAt
      ? new Date(context.lastEventAt).getTime() - new Date(context.createdAt).getTime()
      : 0;
    const ctx = context.seed.context;
    this.log.info({
      event: 'session.summary',
      sessionId,
      userId: ctx?.userId,
      tier: ctx?.tier,
      model: ctx?.model ?? context.seed.model,
      imageId: ctx?.imageId ?? context.seed.container?.image,
      totalTurns: indexEntry.turns,
      toolErrors: indexEntry.toolErrors,
      bytesWritten: indexEntry.bytes,
      storage: indexEntry.storage,
      durationMs,
      status: indexEntry.status,
      terminal: meta.terminal,
      acceptedHighWater: context.acceptedHighWater,
      persistedHighWater: context.persistedHighWater,
      integrityStatus: context.integrity.status,
    }, 'Session complete');

    // TAIL SAMPLING: Decide whether to keep or discard this trace
    const sampling = this.options.sampling;
    const shouldKeep = this.shouldKeepTrace({
      durationMs,
      hasError: meta.terminal === 'error' || (indexEntry.toolErrors ?? 0) > 0,
      sampling,
    });

    if (!shouldKeep) {
      // Discard trace - delete local files and skip S3 sync
      this.log.debug(
        { sessionId, durationMs, reason: 'sampled_out' },
        'Discarding trace (tail sampling)',
      );
      await this.discardTrace(context);
      return;
    }

    await this.writeRetentionMarker(context.dir);
    await this.syncToS3(sessionId, context.dir);
    if (!this.useS3Only) {
      // The S3-only path already wrote and verified its row inside `persistCloseReceipts`,
      // because that is where it writes its receipts.
      const indexResult = await this.upsertTraceIndex(sessionId, context);
      if (indexResult.observed && !indexResult.persisted) {
        await this.degradeForMissingTraceIndex(sessionId, context, indexEntry, indexResult.error);
      }
    }
  }

  private async persistCloseReceipts(context: SessionContext, indexEntry: IndexEntry): Promise<void> {
    if (!context.integrity) return;
    const integrityPayload = Buffer.from(JSON.stringify(context.integrity, null, 2), 'utf8');
    if (this.useS3Only && this.s3) {
      const s3 = this.s3;
      const uploadReceipts = async (): Promise<void> => {
        await Promise.all([
          s3.client.uploadBuffer(
            `${context.id}/index.json`,
            Buffer.from(JSON.stringify({ ...indexEntry, integrity: context.integrity }), 'utf8'),
          ),
          s3.client.uploadBuffer(
            `${context.id}/integrity.json`,
            Buffer.from(JSON.stringify(context.integrity, null, 2), 'utf8'),
          ),
        ]);
      };

      await uploadReceipts();

      // D5 - and the receipt is not the row. This path writes its own terminal index row, so
      // it also owns the degrade when that row cannot be read back afterwards. Discarding the
      // result here was the original defect wearing object storage: the close reported success
      // while `trace_index` held nothing, and only the local path ever noticed.
      const indexResult = await this.upsertTraceIndex(context.id, context);
      if (indexResult.observed && !indexResult.persisted) {
        this.markTraceIndexMissing(context.id, context, indexEntry);
        await this.recordTraceIndexFailure(context.id, context, indexResult.error);
        // Rewrite them, so the durable receipt carries the degraded status rather than the
        // optimistic one written a moment ago.
        await uploadReceipts();
        this.log.error(
          { err: indexResult.error, sessionId: context.id, integrityStatus: context.integrity.status },
          '[TraceRecorder] Session closed without a discoverable terminal index receipt',
        );
      }
      return;
    }
    fs.mkdirSync(context.dir, { recursive: true });
    fs.writeFileSync(path.join(context.dir, 'integrity.json'), integrityPayload);
  }

  /**
   * D5 - the terminal index receipt is part of the close barrier, not a side effect.
   *
   * This used to catch every database failure, log a warning and return successfully, so the
   * caller believed the close had persisted. `RunTraceService` then found no row and
   * constructed `terminalReceipt: false`, which degraded the integrity result for every run.
   * The `trace_index` table held zero rows globally and nothing said so.
   *
   * A write that cannot be read back has not happened. The upsert is retried, then verified
   * by reading it, and a definitive failure is returned to the caller rather than absorbed.
   */
  private async upsertTraceIndex(
    sessionId: string,
    context: SessionContext,
  ): Promise<{ persisted: boolean; observed: boolean; error?: Error }> {
    if (!this.traceIndexRepo) {
      // No index is configured, so there is no receipt to discover. That is a deployment
      // shape, not a failure of this session.
      return { persisted: false, observed: false };
    }

    const attempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.traceIndexRepo.upsert({
          sessionId,
          traceKey: `${sessionId}/trace.ndjson`,
          markdownKey: `${sessionId}/trace.md`,
          costKey: `${sessionId}/cost.md`,
          artifactsPrefix: `${sessionId}/artifacts/`,
          acceptedHighWater: context.acceptedHighWater,
          persistedHighWater: context.persistedHighWater,
          integrityStatus: context.integrity?.status ?? 'degraded',
          integrityDetails: context.integrity ? { ...context.integrity } : {},
        });

        // Independently discoverable, or it does not count as a receipt.
        const found = await this.traceIndexRepo.find(sessionId);
        if (found) {
          return { persisted: true, observed: true };
        }
        lastError = new Error('Trace index row was not readable after a successful upsert');
      } catch (error: unknown) {
        lastError = toSafeError(error);
      }

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }

    return { persisted: false, observed: true, ...(lastError ? { error: lastError } : {}) };
  }

  /**
   * Records that a session closed without a discoverable terminal receipt. The trace itself
   * is intact; what is missing is the row that lets a reader find it, so the session is
   * degraded rather than complete and a repair receipt is left beside the trace.
   */
  /** Reconciles a session down to degraded because its terminal receipt is not discoverable. */
  private markTraceIndexMissing(
    sessionId: string,
    context: SessionContext,
    indexEntry: IndexEntry,
  ): void {
    context.integrity = reconcileTraceIntegrity({
      sessionId,
      acceptedHighWater: context.acceptedHighWater,
      persistedHighWater: context.persistedHighWater,
      terminalReceipt: false,
      writerFailed: context.writerFailed,
      rejectedWrites: context.rejectedWrites,
    });
    indexEntry.integrityStatus = context.integrity.status;
    this.index.update(sessionId, indexEntry);
  }

  /**
   * Leaves enough beside the trace for reconciliation to repair the row later — beside means
   * object storage when that is where the trace lives, not a local directory this mode never
   * created.
   */
  private async recordTraceIndexFailure(
    sessionId: string,
    context: SessionContext,
    error: Error | undefined,
  ): Promise<void> {
    const payload = JSON.stringify({
      schema: 'trace-index-failure/v1',
      sessionId,
      recordedAt: new Date().toISOString(),
      reason: error?.message ?? 'trace index row was not discoverable after close',
      acceptedHighWater: context.acceptedHighWater,
      persistedHighWater: context.persistedHighWater,
      integrity: context.integrity,
    }, null, 2);

    try {
      if (this.useS3Only && this.s3) {
        await this.s3.client.uploadBuffer(
          `${context.id}/trace-index-failure.json`,
          Buffer.from(payload, 'utf8'),
        );
        return;
      }
      await fs.promises.writeFile(
        path.join(context.dir, 'trace-index-failure.json'),
        payload,
        'utf8',
      );
    } catch (writeError: unknown) {
      this.log.error(
        { err: toSafeError(writeError), sessionId },
        '[TraceRecorder] Could not record the trace index failure beside the trace',
      );
    }
  }

  private async degradeForMissingTraceIndex(
    sessionId: string,
    context: SessionContext,
    indexEntry: IndexEntry,
    error: Error | undefined,
  ): Promise<void> {
    this.markTraceIndexMissing(sessionId, context, indexEntry);
    await this.recordTraceIndexFailure(sessionId, context, error);

    try {
      await this.persistCloseReceipts(context, indexEntry);
    } catch (receiptError: unknown) {
      this.log.error(
        { err: toSafeError(receiptError), sessionId },
        '[TraceRecorder] Could not rewrite close receipts after a trace index failure',
      );
    }

    this.log.error(
      { err: error, sessionId, integrityStatus: context.integrity?.status },
      '[TraceRecorder] Session closed without a discoverable terminal index receipt',
    );
  }

  /**
   * Tail sampling decision: should we keep this trace?
   * 
   * Rules (in order of priority):
   * 1. If sampling is disabled (no config), KEEP all
   * 2. If error occurred, KEEP (alwaysTraceOnError)
   * 3. If session was slow (> alwaysTraceIfSlowMs), KEEP
   * 4. Otherwise, random sample at configured rate
   */
  private shouldKeepTrace(opts: {
    durationMs: number;
    hasError: boolean;
    sampling?: SessionTraceRecorderOptions['sampling'];
  }): boolean {
    const { durationMs, hasError, sampling } = opts;

    // No sampling config = keep everything
    if (!sampling) {
      return true;
    }

    // Always keep errors
    if (sampling.alwaysTraceOnError && hasError) {
      return true;
    }

    // Always keep slow sessions
    if (sampling.alwaysTraceIfSlowMs > 0 && durationMs >= sampling.alwaysTraceIfSlowMs) {
      return true;
    }

    // Random sampling for happy-path traces
    const rate = Math.max(0, Math.min(1, sampling.rate));
    return Math.random() < rate;
  }

  /**
   * Discard trace files for a session (tail sampling decided not to keep it)
   */
  private async discardTrace(context: SessionContext): Promise<void> {
    // Don't delete anything if we're in S3-only mode (no local files)
    if (this.useS3Only) {
      // For S3-only, we'd need to delete from S3, but that's more complex
      // For now, just log that we're skipping the sync
      return;
    }

    // Delete local trace directory
    try {
      if (fs.existsSync(context.dir)) {
        fs.rmSync(context.dir, { recursive: true, force: true });
        this.log.debug({ sessionId: context.id, dir: context.dir }, 'Deleted trace directory (sampled out)');
      }
    } catch (error) {
      this.log.warn({ err: error, sessionId: context.id }, 'Failed to delete sampled-out trace directory');
    }
  }

  private writeArtifact(
    context: SessionContext,
    eventId: string,
    extension: string,
    content: Buffer,
    compress?: boolean
  ): TraceArtifactReceipt {
    const fileNameBase = `${eventId}${extension}`;
    const finalName = compress ? `${fileNameBase}.gz` : fileNameBase;
    const relative = path.posix.join('artifacts', finalName.replace(/\\/g, '/'));
    const payload = compress ? zlib.gzipSync(content) : content;
    const receipt: TraceArtifactReceipt = {
      path: relative,
      bytes: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
    };
    context.artifactReceipts.set(relative, receipt);

    if (this.useS3Only && this.s3) {
      const key = `${context.id}/${relative}`;
      const upload = this.s3.client.uploadBuffer(key, payload).then(() => undefined);
      context.pendingArtifactWrites.add(upload);
      void upload.then(
        () => context.pendingArtifactWrites.delete(upload),
        (error) => {
          context.pendingArtifactWrites.delete(upload);
          context.failedArtifactWrites.add(relative);
          this.log.warn({ err: error, key }, '[TraceRecorder] Failed to upload trace artifact to S3');
        },
      );
      context.bytesWritten += payload.length;
      return receipt;
    }

    const filePath = path.join(context.artifactDir, finalName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, payload);
    if (this.keepLocalCopy && this.s3) {
      const key = `${context.id}/${relative}`;
      void this.s3.client.uploadBuffer(key, payload).catch((error) => {
        this.log.warn({ err: error, key }, '[TraceRecorder] Failed to upload trace artifact to S3');
      });
    }
    context.bytesWritten += payload.length;
    return receipt;
  }

  private async writeRetentionMarker(sessionDir: string): Promise<void> {
    try {
      const expireAt = new Date(Date.now() + this.options.retentionDays * 24 * 60 * 60 * 1000);
      if (this.useS3Only && this.s3) {
        const key = `${sessionIdFromPath(sessionDir)}/.retention`;
        await this.s3.client.uploadBuffer(key, Buffer.from(expireAt.toISOString(), 'utf-8'));
      } else {
        const markerPath = path.join(sessionDir, '.retention');
        fs.writeFileSync(markerPath, expireAt.toISOString(), 'utf8');
      }
    } catch (error: unknown) {
      const err = toSafeError(error);
      this.log.warn({ err }, 'Failed to write retention marker');
    }
  }

  private async syncToS3(sessionId: string, sessionDir: string): Promise<void> {
    if (!this.s3) return;
    const s3 = this.s3;
    try {
      await s3.client.ensureBucket();
      // ndjson + markdown buffers already flushed per write in S3-only mode.
      // When keeping a local copy, upload trace files at close.
      if (!this.useS3Only) {
        const ndjsonPath = path.join(sessionDir, 'trace.ndjson');
        if (fs.existsSync(ndjsonPath)) {
          await s3.client.uploadFileFromPath(`${sessionId}/trace.ndjson`, ndjsonPath);
        }
        const mdPath = path.join(sessionDir, 'trace.md');
        if (fs.existsSync(mdPath)) {
          await s3.client.uploadFileFromPath(`${sessionId}/trace.md`, mdPath);
        }
        const indexPath = path.join(this.options.rootDir, 'index.json');
        if (fs.existsSync(indexPath)) {
          await s3.client.uploadFileFromPath(`${sessionId}/index.json`, indexPath);
        }
      }
    } catch (error: unknown) {
      const err = toSafeError(error);
      this.log.warn({ err, sessionId }, '[TraceRecorder] Failed to sync trace to S3');
    }
  }

  /**
   * Sync entire workspace directory to S3/MinIO for backup/recovery.
   * 
   * This method recursively uploads all files from the workspace to S3
   * under the prefix: workspaces/{sessionId}/
   * 
   * @param sessionId - Session identifier
   * @param workspaceDir - Absolute path to workspace directory
   * @param options - Optional: max files, exclude patterns
   */
  async syncWorkspaceToS3(
    sessionId: string,
    workspaceDir: string,
    options: { maxFiles?: number; excludePatterns?: string[] } = {},
  ): Promise<{ success: boolean; filesUploaded: number; bytesUploaded: number; errors: string[] }> {
    if (!this.s3) {
      return { success: false, filesUploaded: 0, bytesUploaded: 0, errors: ['S3 not configured'] };
    }

    const { maxFiles = 1000, excludePatterns = ['.git', 'node_modules', '.env', '*.log'] } = options;
    const errors: string[] = [];
    let filesUploaded = 0;
    let bytesUploaded = 0;

    try {
      await this.s3.client.ensureBucket();

      // Get all files recursively
      const files = this.walkDirectory(workspaceDir, excludePatterns);

      // Limit file count
      const filesToUpload = files.slice(0, maxFiles);
      if (files.length > maxFiles) {
        this.log.warn(
          { sessionId, totalFiles: files.length, limit: maxFiles },
          '[TraceRecorder] Workspace has more files than limit, truncating',
        );
      }

      // Upload files in batches
      const batchSize = 10;
      for (let i = 0; i < filesToUpload.length; i += batchSize) {
        const batch = filesToUpload.slice(i, i + batchSize);
        const uploads = batch.map(async (filePath) => {
          try {
            const relativePath = path.relative(workspaceDir, filePath).replace(/\\/g, '/');
            const key = `workspaces/${sessionId}/${relativePath}`;
            const stats = fs.statSync(filePath);

            // Skip files larger than 10MB for safety
            if (stats.size > 10 * 1024 * 1024) {
              this.log.debug({ filePath, size: stats.size }, '[TraceRecorder] Skipping large file');
              return;
            }

            await this.s3!.client.uploadFileFromPath(key, filePath);
            filesUploaded++;
            bytesUploaded += stats.size;
          } catch (error: unknown) {
            const err = toSafeError(error);
            errors.push(`${filePath}: ${err.message}`);
          }
        });
        await Promise.all(uploads);
      }

      // Write manifest
      const manifest = {
        sessionId,
        workspaceDir,
        syncedAt: new Date().toISOString(),
        filesUploaded,
        bytesUploaded,
        errors: errors.length,
      };
      await this.s3.client.uploadBuffer(
        `workspaces/${sessionId}/_manifest.json`,
        Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      );

      this.log.info(
        { sessionId, filesUploaded, bytesUploaded, errors: errors.length },
        '[TraceRecorder] Workspace synced to S3',
      );

      return { success: errors.length === 0, filesUploaded, bytesUploaded, errors };
    } catch (error: unknown) {
      const err = toSafeError(error);
      this.log.error({ err, sessionId }, '[TraceRecorder] Failed to sync workspace to S3');
      return { success: false, filesUploaded, bytesUploaded, errors: [err.message] };
    }
  }

  /**
   * Recursively walk directory and return all file paths
   */
  private walkDirectory(dir: string, excludePatterns: string[]): string[] {
    const files: string[] = [];

    const shouldExclude = (name: string): boolean => {
      return excludePatterns.some((pattern) => {
        if (pattern.startsWith('*')) {
          return name.endsWith(pattern.slice(1));
        }
        return name === pattern;
      });
    };

    const walk = (currentDir: string): void => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (shouldExclude(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(dir);
    return files;
  }
}
