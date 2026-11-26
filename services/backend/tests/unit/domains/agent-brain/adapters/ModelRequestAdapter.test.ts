import { describe, expect, it, vi } from 'vitest';

import { ModelRequestAdapter } from '@/domains/agent-brain/adapters/ModelRequestAdapter';
import { modelRequestRecords } from '@/db/schema';

const row = {
  requestId: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 2,
  sessionId: '22222222-2222-4222-8222-222222222222',
  runId: 'run-1',
  stepId: 'step-1',
  turn: 3,
  callOrdinal: 1,
  routeReason: 'session_pinned',
  provider: 'openai',
  model: 'gpt-test',
  routedContextCapacity: 128000,
  messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
  systemContent: ['system'],
  tools: [],
  toolChoice: null,
  generationSettings: { max_tokens: 100 },
  contextMeasurementRefs: ['context-1'],
  transformationRefs: ['messages:digest'],
  envelope: { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], stream: true },
  digest: 'sha256:abc',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('ModelRequestAdapter', () => {
  it('appends and maps an immutable request record', async () => {
    const insertChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([row]),
    } as any;
    const db = { insert: vi.fn().mockReturnValue(insertChain) } as any;
    const adapter = new ModelRequestAdapter(db);

    const record = await adapter.append({
      ...row,
      messages: row.messages as any,
      tools: [],
    });

    expect(db.insert).toHaveBeenCalledWith(modelRequestRecords);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledWith({
      target: modelRequestRecords.requestId,
    });
    expect(record).toMatchObject({
      requestId: row.requestId,
      provenance: 'recorded',
      digest: row.digest,
      createdAt: row.createdAt,
    });
  });

  it('reads the same request by durable identity', async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([row]),
    } as any;
    const db = { select: vi.fn().mockReturnValue(chain) } as any;
    const adapter = new ModelRequestAdapter(db);

    await expect(adapter.findByRequestId(row.requestId)).resolves.toMatchObject({
      requestId: row.requestId,
      provenance: 'recorded',
      envelope: row.envelope,
    });
  });
});
