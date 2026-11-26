import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession, newId } from '../../helpers/agentSessionDb';
import { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('TraceIndexRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;
  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) skip = true;
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.truncateAll();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('upserts and fetches trace index rows', async () => {
    if (!harness) return;
    const sessionId = await insertAgentSession(harness.db);
    const repo = new TraceIndexRepository(harness.db as any);

    await repo.upsert({
      sessionId,
      traceKey: 'trace.ndjson',
      markdownKey: 'trace.md',
      costKey: 'cost.json',
      artifactsPrefix: 'artifacts/',
      acceptedHighWater: 8,
      persistedHighWater: 7,
      integrityStatus: 'degraded',
      integrityDetails: { schema: 'trace-integrity/v1', issues: ['tail_missing'] },
    });

    const first = await repo.find(sessionId);
    expect(first?.traceKey).toBe('trace.ndjson');
    expect(first).toMatchObject({
      acceptedHighWater: 8,
      persistedHighWater: 7,
      integrityStatus: 'degraded',
    });

    await repo.upsert({
      sessionId,
      traceKey: 'trace2.ndjson',
      markdownKey: 'trace2.md',
      costKey: 'cost2.json',
      artifactsPrefix: 'artifacts2/',
      acceptedHighWater: 8,
      persistedHighWater: 8,
      integrityStatus: 'complete',
      integrityDetails: { schema: 'trace-integrity/v1', issues: [] },
    });

    const updated = await repo.find(sessionId);
    expect(updated?.traceKey).toBe('trace2.ndjson');
    expect(updated).toMatchObject({
      acceptedHighWater: 8,
      persistedHighWater: 8,
      integrityStatus: 'complete',
    });
  });

  itMaybe('lists trace index rows', async () => {
    if (!harness) return;
    const sessionA = await insertAgentSession(harness.db);
    const sessionB = await insertAgentSession(harness.db);
    const repo = new TraceIndexRepository(harness.db as any);

    await repo.upsert({
      sessionId: sessionA,
      traceKey: 'trace-a.ndjson',
      markdownKey: 'trace-a.md',
      costKey: 'cost-a.json',
      artifactsPrefix: 'artifacts/a',
    });
    await repo.upsert({
      sessionId: sessionB,
      traceKey: 'trace-b.ndjson',
      markdownKey: 'trace-b.md',
      costKey: 'cost-b.json',
      artifactsPrefix: 'artifacts/b',
    });

    const rows = await repo.list(0, 10);
    expect(rows.length).toBe(2);
  });
});



