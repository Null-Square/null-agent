import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { ModelRequestAdapter } from '@/domains/agent-brain/adapters/ModelRequestAdapter';
import { canonicalizeModelRequestEnvelope } from '@/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import { agentSessions } from '@/db/schema';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ModelRequestAdapter DB contract', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>>;
  let adapter: ModelRequestAdapter;

  beforeAll(async () => {
    harness = (await setupTestDb())!;
    adapter = new ModelRequestAdapter(harness!.db as any);
  });

  afterAll(async () => harness?.dispose());
  beforeEach(async () => harness?.truncateAll());

  it('persists the complete canonical envelope and freezes request identity', async () => {
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
    const requestId = uuidv4();
    const canonical = canonicalizeModelRequestEnvelope({
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      tools: [],
      stream: true,
      max_tokens: 200,
    });
    const input = {
      requestId,
      schemaVersion: 2,
      sessionId,
      turn: 1,
      callOrdinal: 1,
      routeReason: 'session_pinned',
      provider: 'openai',
      model: 'gpt-test',
      routedContextCapacity: 128000,
      messages: canonical.envelope.messages as any,
      systemContent: ['system'],
      tools: [],
      generationSettings: { max_tokens: 200 },
      contextMeasurementRefs: [],
      transformationRefs: ['messages:test'],
      envelope: canonical.envelope,
      digest: canonical.digest,
    };

    await expect(adapter.append(input)).resolves.toMatchObject({
      requestId,
      provenance: 'recorded',
      digest: canonical.digest,
      envelope: canonical.envelope,
    });
    await expect(adapter.append(input)).resolves.toMatchObject({ requestId });
    await expect(adapter.append({ ...input, digest: 'sha256:different' }))
      .rejects.toMatchObject({ code: 'model_request_immutable_conflict' });
    await expect(adapter.findBySession(sessionId)).resolves.toHaveLength(1);
  });
});
