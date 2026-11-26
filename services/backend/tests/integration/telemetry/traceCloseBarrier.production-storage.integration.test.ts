import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import { agentSessions, traceIndex } from '@/db/schema';
import { S3StorageService } from '@/shared/storage/S3StorageService';
import { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { createTraceRecorder } from '@/app/factories/telemetry';
import type { ResolvedConfig } from '@/config/configTypes';
import type { S3Bundle } from '@/app/factories/storage';
import { setupTestDb, type TestDb } from '../../helpers/testDb';

/**
 * The composition the product actually ships, against the storage it actually uses.
 *
 * Every other trace test — including the assembled `shipping-composition` scenario — runs the
 * recorder over a temp directory with an in-memory index. That configuration is not the one
 * production runs: `createTraceRecorder` hard-codes `keepLocalCopy: false`, so whenever an
 * object-store client exists the recorder is S3-only and takes an entirely different close
 * path.
 *
 * That gap hid a P0. `persistCloseReceipts` wrote its own terminal index row on the S3-only
 * path and discarded the result, and the degrade that D5 exists to perform sat behind
 * `if (!this.useS3Only)`. A close reported success while `trace_index` held nothing — the
 * original D5 defect, in the only configuration that matters, passing every local test.
 *
 * So this file does what the audit asked for: real Postgres, real object storage, the real
 * factory, close, throw the runtime away, build new readers, and read the trace back through
 * the path a reader uses.
 */
const s3Endpoint = process.env.TEST_S3_ENDPOINT;
const s3AccessKey = process.env.TEST_S3_ACCESS_KEY;
const s3SecretKey = process.env.TEST_S3_SECRET_KEY;
const canRun = Boolean(process.env.TEST_DATABASE_URL && s3Endpoint && s3AccessKey && s3SecretKey);
const maybeDescribe = canRun ? describe : describe.skip;

/** The chain a run must leave behind: request, attempt, tool, close, read model. */
const REQUIRED_CHAIN = [
  'cache.lineage_expectation',
  'model.attempt.started',
  'tool.start',
  'tool.finish',
  'model.attempt.settled',
  'usage.recorded',
] as const;

maybeDescribe('trace close barrier against production storage', () => {
  let harness: TestDb;
  let bucket: string;
  let writerS3: S3StorageService;
  const createdSessionIds: string[] = [];

  const makeS3 = (): S3StorageService => new S3StorageService({
    endpoint: s3Endpoint!,
    region: 'us-east-1',
    accessKeyId: s3AccessKey!,
    secretAccessKey: s3SecretKey!,
    forcePathStyle: true,
    bucket,
  });

  beforeAll(async () => {
    const testDb = await setupTestDb();
    if (!testDb) throw new Error('TEST_DATABASE_URL is required');
    harness = testDb;
    bucket = `test-traces-${Date.now()}`;
    writerS3 = makeS3();
    await writerS3.ensureBucket();
  }, 120_000);

  afterAll(async () => {
    // Clean up only what this file created. `truncateAll` would delete rows belonging to any
    // integration test running beside it, which is its own source of flakiness.
    for (const sessionId of createdSessionIds) {
      await harness?.db.delete(traceIndex).where(eq(traceIndex.sessionId, sessionId)).catch(() => undefined);
      await harness?.db.delete(agentSessions).where(eq(agentSessions.id, sessionId)).catch(() => undefined);
      await writerS3?.deletePrefix(`${sessionId}/`).catch(() => undefined);
    }
    await harness?.dispose();
  });

  const traceConfig = {
    trace: {
      traceLogsRoot: '.traces-unused-in-s3-only',
      traceInlineLimit: 4_096,
      stdoutChunkSize: 8_192,
      traceCompressOverBytes: 1_000_000,
      traceRetentionDays: 7,
      s3FlushIntervalMs: 50,
      s3FlushMaxEvents: 1,
    },
  } as unknown as ResolvedConfig;

  const createSessionRow = async (): Promise<string> => {
    const [row] = await harness.db
      .insert(agentSessions)
      .values({ workspaceDir: '/workspace/production-storage-test' })
      .returning({ id: agentSessions.id });
    createdSessionIds.push(row!.id);
    return row!.id;
  };

  /** Boots the shipping recorder over real storage and runs one session through it. */
  const runSessionThroughShippingRecorder = async (params: {
    sessionId: string;
    repo: TraceIndexRepository;
  }): Promise<void> => {
    const s3Bundle: S3Bundle = {
      s3TracesClient: makeS3(),
      s3TracesBucket: bucket,
      s3ArtifactsBucket: bucket,
      s3WorkspacesBucket: bucket,
    };
    const recorder = createTraceRecorder(traceConfig, s3Bundle, params.repo);

    await recorder.init(params.sessionId, {
      workspace: '/workspace/production-storage-test',
      tools: ['http_payload'],
      model: 'test-model',
    });
    for (const event of REQUIRED_CHAIN) {
      await recorder.write(params.sessionId, 1, {
        event,
        severity: 'info',
        payload: { event, sessionId: params.sessionId },
      });
    }
    await recorder.close(params.sessionId, { terminal: 'session.done', status: 'completed' });
  };

  const readTraceEvents = async (sessionId: string): Promise<Array<Record<string, unknown>>> => {
    // A fresh client, the way a reader in another process would build one.
    const readerS3 = makeS3();
    const buffer = await readerS3.getObjectBuffer(`${sessionId}/trace.ndjson`);
    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const readUploadedIndex = async (sessionId: string): Promise<Record<string, unknown>> => {
    const readerS3 = makeS3();
    const buffer = await readerS3.getObjectBuffer(`${sessionId}/index.json`);
    return JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
  };

  it('closes, forgets the runtime, and hands a reader the whole trace back', async () => {
    const sessionId = await createSessionRow();

    await runSessionThroughShippingRecorder({
      sessionId,
      repo: new TraceIndexRepository(harness.db),
    });

    // Everything above is gone now. What follows only knows the session id.
    const events = await readTraceEvents(sessionId);
    const names = events.map((event) => String(event.event));
    for (const required of REQUIRED_CHAIN) {
      expect(names).toContain(required);
    }
    // Order survives the round trip, which is what makes the chain reconstructable.
    const chainOrder = names.filter((name) => (REQUIRED_CHAIN as readonly string[]).includes(name));
    expect(chainOrder).toEqual([...REQUIRED_CHAIN]);

    const row = await new TraceIndexRepository(harness.db).find(sessionId);
    expect(row).not.toBeNull();
    expect(row!.integrityStatus).toBe('complete');
    expect(row!.acceptedHighWater).toBe(row!.persistedHighWater);
    expect(row!.acceptedHighWater).toBeGreaterThan(0);

    // The row is a pointer, so the object it points at has to be there.
    const pointed = await makeS3().objectExistsWithReason(row!.traceKey);
    expect(pointed.exists).toBe(true);
  }, 120_000);

  it('does not report a complete close when the terminal row cannot be written', async () => {
    const sessionId = await createSessionRow();
    const repo = new TraceIndexRepository(harness.db);
    const upsertFailure = new Error('relation "trace_index" does not exist');
    vi.spyOn(repo, 'upsert').mockRejectedValue(upsertFailure);

    await runSessionThroughShippingRecorder({ sessionId, repo });

    // This is the production shape of D5: the trace is intact and unfindable.
    const row = await new TraceIndexRepository(harness.db).find(sessionId);
    expect(row).toBeNull();

    const events = await readTraceEvents(sessionId);
    expect(events.length).toBeGreaterThan(0);

    // And the durable receipt says so, rather than claiming a clean close.
    const index = await readUploadedIndex(sessionId);
    expect(index.integrityStatus).not.toBe('complete');

    const marker = await makeS3().getObjectBuffer(`${sessionId}/trace-index-failure.json`);
    const parsed = JSON.parse(marker.toString('utf8')) as Record<string, unknown>;
    expect(parsed.schema).toBe('trace-index-failure/v1');
    expect(String(parsed.reason)).toContain('trace_index');

    vi.restoreAllMocks();
  }, 120_000);

  it('does not report a complete close when the row is written but not readable', async () => {
    const sessionId = await createSessionRow();
    const repo = new TraceIndexRepository(harness.db);
    // A write that cannot be read back has not happened — a replica that never caught up, a
    // transaction rolled back underneath, a row deleted between write and read.
    vi.spyOn(repo, 'find').mockResolvedValue(null);

    await runSessionThroughShippingRecorder({ sessionId, repo });

    const index = await readUploadedIndex(sessionId);
    expect(index.integrityStatus).not.toBe('complete');

    vi.restoreAllMocks();
  }, 120_000);

  it('keeps each session own trace and own row', async () => {
    const first = await createSessionRow();
    const second = await createSessionRow();

    await runSessionThroughShippingRecorder({ sessionId: first, repo: new TraceIndexRepository(harness.db) });
    await runSessionThroughShippingRecorder({ sessionId: second, repo: new TraceIndexRepository(harness.db) });

    const firstEvents = await readTraceEvents(first);
    const secondEvents = await readTraceEvents(second);

    expect(firstEvents.every((event) => event.sessionId === first || (event.payload as { sessionId?: string })?.sessionId === first)).toBe(true);
    expect(secondEvents.every((event) => event.sessionId === second || (event.payload as { sessionId?: string })?.sessionId === second)).toBe(true);

    const reader = new TraceIndexRepository(harness.db);
    expect((await reader.find(first))?.traceKey).toContain(first);
    expect((await reader.find(second))?.traceKey).toContain(second);
  }, 120_000);
});
