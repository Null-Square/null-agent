import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { HistoryTransformationAdapter } from '@/domains/agent-brain/adapters/HistoryTransformationAdapter';
import {
  buildContextMeasurement,
  toContextMeasurementSnapshot,
} from '@/domains/agent-brain/domain/context';
import { agentSessions } from '@/db/schema';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('HistoryTransformationAdapter DB contract', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let adapter: HistoryTransformationAdapter;

  beforeAll(async () => {
    harness = (await setupTestDb())!;
    adapter = new HistoryTransformationAdapter(harness.db as any);
  });

  afterAll(async () => harness?.dispose());
  beforeEach(async () => harness?.truncateAll());

  const seedSession = async (): Promise<string> => {
    const sessionId = uuidv4();
    await harness!.db.insert(agentSessions).values({
      id: sessionId,
      userId: null,
      mode: 'interactive',
      workspaceDir: `/tmp/${sessionId}`,
      metadata: {},
      plan: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    });
    return sessionId;
  };

  const snapshot = (sessionId: string, phase: string) => toContextMeasurementSnapshot(
    buildContextMeasurement({
      measurementId: `measurement-${phase}`,
      requestId: `request-${phase}`,
      sessionId,
      turn: 2,
      callOrdinal: 1,
      provider: 'fixture',
      model: 'fixture-model',
      routedCapacity: 128_000,
      capacitySource: 'model_config',
      envelope: { messages: [{ role: 'user', content: phase }], tools: [], max_tokens: 2_000 },
    }),
  );

  it('does not expose a prepared or replacement-persisted version as active', async () => {
    const sessionId = await seedSession();
    const transactionId = `history:${uuidv4()}`;
    await adapter.prepare({
      transactionId,
      schemaVersion: 1,
      sessionId,
      turn: 2,
      reducerProfile: 'pentest',
      reason: 'provider_context_overflow',
      intent: 'replace stable history range',
      inputHistoryVersion: 0,
      outputHistoryVersion: 1,
      inputMessageIds: ['message-1', 'message-2'],
      inputStartMessageId: 'message-1',
      inputEndMessageId: 'message-2',
      inputDigest: 'sha256:input',
      configurationDigest: 'sha256:configuration',
      beforeMeasurement: snapshot(sessionId, 'before'),
    });
    await expect(adapter.findActiveBySession(sessionId)).resolves.toBeUndefined();

    await adapter.persistReplacement(transactionId, {
      replacementSummary: 'replacement summary',
      replacementMessageId: 'summary-1',
      afterMeasurement: snapshot(sessionId, 'after'),
    });
    await expect(adapter.findActiveBySession(sessionId)).resolves.toBeUndefined();

    await adapter.activate(transactionId);
    await expect(adapter.findActiveBySession(sessionId)).resolves.toMatchObject({
      transactionId,
      status: 'activated',
      replacementMessageId: 'summary-1',
    });
  });

  it('atomically supersedes the prior active version and converges repeated activation', async () => {
    const sessionId = await seedSession();
    const activateVersion = async (version: number) => {
      const transactionId = `history:${uuidv4()}`;
      await adapter.prepare({
        transactionId,
        schemaVersion: 1,
        sessionId,
        turn: version,
        reducerProfile: 'compliance',
        reason: 'soft_threshold',
        intent: 'replace stable history range',
        inputHistoryVersion: version - 1,
        outputHistoryVersion: version,
        inputMessageIds: [`message-${version}`],
        inputStartMessageId: `message-${version}`,
        inputEndMessageId: `message-${version}`,
        inputDigest: `sha256:input-${version}`,
        configurationDigest: 'sha256:configuration',
        beforeMeasurement: snapshot(sessionId, `before-${version}`),
      });
      await adapter.persistReplacement(transactionId, {
        replacementSummary: `summary ${version}`,
        replacementMessageId: `summary-${version}`,
        afterMeasurement: snapshot(sessionId, `after-${version}`),
      });
      await adapter.activate(transactionId);
      await adapter.activate(transactionId);
      return transactionId;
    };

    const first = await activateVersion(1);
    const second = await activateVersion(2);
    await expect(adapter.findActiveBySession(sessionId)).resolves.toMatchObject({
      transactionId: second,
      outputHistoryVersion: 2,
    });
    await expect(adapter.findBySession(sessionId)).resolves.toEqual([
      expect.objectContaining({ transactionId: first, status: 'superseded' }),
      expect.objectContaining({ transactionId: second, status: 'activated' }),
    ]);
  });
});
