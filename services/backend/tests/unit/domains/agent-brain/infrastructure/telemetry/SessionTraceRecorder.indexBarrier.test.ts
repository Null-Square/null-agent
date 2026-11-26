import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';

/**
 * D5 — session close was well built: it stopped accepting writes, drained the queue, waited
 * for artifacts, flushed storage, reconciled high-water marks and built the index receipt.
 *
 * Then `upsertTraceIndex` caught every database failure, logged a warning and returned
 * successfully, so the caller believed the close had persisted. `RunTraceService` found no
 * row, constructed `terminalReceipt: false`, and degraded the integrity result for every run.
 * The `trace_index` table held zero rows globally and nothing in the system said so.
 *
 * A write that cannot be read back has not happened.
 */
describe('trace index persistence is part of the close barrier', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-barrier-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const closeSession = async (repo: unknown, sessionId = 'session-1') => {
    const recorder = new SessionTraceRecorder({ rootDir }, undefined, repo as never);
    await recorder.init(sessionId, {
      workspace: path.join(rootDir, 'workspace'),
      tools: [],
      model: 'test-model',
    });
    await recorder.write(sessionId, 1, { event: 'turn.start', severity: 'info', payload: {} });
    await recorder.close(sessionId, { terminal: 'session.done', status: 'completed' });
    return recorder;
  };

  const indexEntryFor = (sessionId: string): Record<string, unknown> | undefined => {
    const indexPath = path.join(rootDir, 'index.json');
    if (!fsSync.existsSync(indexPath)) return undefined;
    const parsed = JSON.parse(fsSync.readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return entries.find((entry) => (entry as { sessionId?: string })?.sessionId === sessionId) as
      Record<string, unknown> | undefined;
  };

  it('reports a complete close when the receipt is written and readable', async () => {
    const rows = new Map<string, unknown>();
    const repo = {
      upsert: vi.fn(async (entry: { sessionId: string }) => { rows.set(entry.sessionId, entry); }),
      find: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
    };

    await closeSession(repo);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(indexEntryFor('session-1')?.integrityStatus).toBe('complete');
  });

  it('does not report a complete close when the row cannot be written', async () => {
    const repo = {
      upsert: vi.fn(async () => { throw new Error('relation "trace_index" does not exist'); }),
      find: vi.fn(async () => null),
    };

    await closeSession(repo);

    // This is the exact production shape. It used to log a warning and claim success.
    expect(indexEntryFor('session-1')?.integrityStatus).not.toBe('complete');
  });

  it('does not report a complete close when the row is written but not readable', async () => {
    // A silent write is the same defect wearing a different hat.
    const repo = {
      upsert: vi.fn(async () => undefined),
      find: vi.fn(async () => null),
    };

    await closeSession(repo);

    expect(indexEntryFor('session-1')?.integrityStatus).not.toBe('complete');
  });

  it('retries a transient failure rather than degrading on the first error', async () => {
    let attempts = 0;
    const rows = new Map<string, unknown>();
    const repo = {
      upsert: vi.fn(async (entry: { sessionId: string }) => {
        attempts += 1;
        if (attempts < 3) throw new Error('connection terminated unexpectedly');
        rows.set(entry.sessionId, entry);
      }),
      find: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
    };

    await closeSession(repo);

    expect(attempts).toBe(3);
    expect(indexEntryFor('session-1')?.integrityStatus).toBe('complete');
  });

  it('leaves a repair receipt beside the trace when the row never lands', async () => {
    const repo = {
      upsert: vi.fn(async () => { throw new Error('deadlock detected'); }),
      find: vi.fn(async () => null),
    };

    await closeSession(repo);

    const receiptPath = path.join(rootDir, 'session-1', 'trace-index-failure.json');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as Record<string, unknown>;

    expect(receipt.schema).toBe('trace-index-failure/v1');
    expect(receipt.sessionId).toBe('session-1');
    expect(String(receipt.reason)).toContain('deadlock detected');
    expect(receipt.integrity).toBeDefined();
  });

  it('treats a deployment with no index configured as a shape, not a failure', async () => {
    // Local development and the Behavior Lab run without the repository. Marking every one of
    // those sessions degraded would make the signal useless.
    await closeSession(undefined);

    expect(indexEntryFor('session-1')?.integrityStatus).toBe('complete');
  });

  /**
   * The same barrier, in the configuration production actually runs.
   *
   * With object storage and no local copy the recorder writes its own close receipts and its own
   * terminal index row inside `persistCloseReceipts`, and the check at the end of `close` is
   * skipped because that path already ran. The result of that row write was discarded, so an
   * S3-only close reported success while `trace_index` held nothing — D5 surviving through a
   * different seam, invisible to every test that used the local filesystem.
   */
  describe('the close barrier holds in the S3-only configuration', () => {
    const makeS3 = () => {
      const objects = new Map<string, string>();
      return {
        objects,
        config: {
          client: {
            ensureBucket: vi.fn(async () => undefined),
            uploadBuffer: vi.fn(async (key: string, body: Buffer) => {
              objects.set(key, body.toString('utf8'));
            }),
            uploadFileFromPath: vi.fn(async () => undefined),
          },
        },
      };
    };

    const closeS3Session = async (repo: unknown, s3: ReturnType<typeof makeS3>, sessionId = 's3-session') => {
      const recorder = new SessionTraceRecorder(
        { rootDir },
        s3.config as never,
        repo as never,
      );
      await recorder.init(sessionId, {
        workspace: path.join(rootDir, 'workspace'),
        tools: [],
        model: 'test-model',
      });
      await recorder.write(sessionId, 1, { event: 'turn.start', severity: 'info', payload: {} });
      await recorder.close(sessionId, { terminal: 'session.done', status: 'completed' });
    };

    const uploadedIndex = (s3: ReturnType<typeof makeS3>, sessionId: string): Record<string, unknown> => {
      const raw = s3.objects.get(`${sessionId}/index.json`);
      expect(raw).toBeDefined();
      return JSON.parse(raw!) as Record<string, unknown>;
    };

    it('reports a complete close when the row is written and readable', async () => {
      const rows = new Map<string, unknown>();
      const repo = {
        upsert: vi.fn(async (entry: { sessionId: string }) => { rows.set(entry.sessionId, entry); }),
        find: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
      };
      const s3 = makeS3();

      await closeS3Session(repo, s3);

      expect(repo.find).toHaveBeenCalled();
      expect(uploadedIndex(s3, 's3-session').integrityStatus).toBe('complete');
    });

    it('does not report a complete close when the row cannot be written', async () => {
      const repo = {
        upsert: vi.fn(async () => { throw new Error('relation "trace_index" does not exist'); }),
        find: vi.fn(async () => null),
      };
      const s3 = makeS3();

      await closeS3Session(repo, s3);

      expect(uploadedIndex(s3, 's3-session').integrityStatus).not.toBe('complete');
    });

    it('does not report a complete close when the row is written but not readable', async () => {
      const repo = {
        upsert: vi.fn(async () => undefined),
        find: vi.fn(async () => null),
      };
      const s3 = makeS3();

      await closeS3Session(repo, s3);

      expect(uploadedIndex(s3, 's3-session').integrityStatus).not.toBe('complete');
    });

    it('leaves the repair receipt where the trace lives, not in a local directory', async () => {
      const repo = {
        upsert: vi.fn(async () => { throw new Error('connection terminated unexpectedly'); }),
        find: vi.fn(async () => null),
      };
      const s3 = makeS3();

      await closeS3Session(repo, s3);

      const marker = s3.objects.get('s3-session/trace-index-failure.json');
      expect(marker).toBeDefined();
      const parsed = JSON.parse(marker!) as Record<string, unknown>;
      expect(parsed.schema).toBe('trace-index-failure/v1');
      expect(String(parsed.reason)).toContain('connection terminated');
      expect(fsSync.existsSync(path.join(rootDir, 's3-session', 'trace-index-failure.json'))).toBe(false);
    });

    it('writes the degraded status durably rather than only in memory', async () => {
      const repo = {
        upsert: vi.fn(async () => { throw new Error('relation "trace_index" does not exist'); }),
        find: vi.fn(async () => null),
      };
      const s3 = makeS3();

      await closeS3Session(repo, s3);

      // The optimistic receipt is written first; what survives must be the degraded one.
      const integrity = JSON.parse(s3.objects.get('s3-session/integrity.json')!) as { status?: string };
      expect(integrity.status).not.toBe('complete');
      expect(uploadedIndex(s3, 's3-session').integrityStatus).toBe(integrity.status);
    });
  });

});
