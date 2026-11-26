import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb } from '../../helpers/testDb';
import { ModelRateRepository } from '@/domains/platform/models/ModelRateRepository';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('ModelRateRepository (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let repo: ModelRateRepository;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
        return;
      }
      const table = await harness.pool.query(
        "SELECT to_regclass('public.model_rate_cards') AS name",
      );
      if (!table.rows[0]?.name) {
        skip = true;
        return;
      }
      repo = new ModelRateRepository(harness.db as any);
    } catch {
      skip = true;
    }
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.pool.query(
      "DELETE FROM models WHERE name LIKE 'Model Rate Integration %'",
    );
  });

  afterAll(async () => {
    if (harness && !skip) {
      await harness.pool.query(
        "DELETE FROM models WHERE name LIKE 'Model Rate Integration %'",
      );
    }
    await harness?.dispose();
  });

  const createModel = async () => {
    const id = randomUUID();
    await harness!.pool.query(
      `INSERT INTO models (id, name, provider, model_name, request_profile, is_active)
       VALUES ($1, $2, 'DEEPSEEK', $3, '{}'::jsonb, false)`,
      [id, `Model Rate Integration ${id}`, `model-rate-${id}`],
    );
    return id;
  };

  it('resolves exact UTC windows from the pinned deployment', async () => {
    if (skip) return;
    const modelId = await createModel();
    await repo.publish({
      modelId,
      effectiveFrom: new Date('2026-08-16T16:00:00Z'),
      currency: 'usd',
      baseCacheHitInputPer1m: 0.022,
      baseCacheMissInputPer1m: 0.66,
      baseOutputPer1m: 1.98,
      windows: [{
        name: 'peak',
        startMinuteUtc: 60,
        endMinuteUtc: 240,
        cacheHitInputPer1m: 0.044,
        cacheMissInputPer1m: 1.32,
        outputPer1m: 3.96,
      }],
    });

    const beforePeak = await repo.resolveQuote(modelId, new Date('2026-08-20T00:59:59Z'));
    const atPeak = await repo.resolveQuote(modelId, new Date('2026-08-20T01:00:00Z'));
    const afterPeak = await repo.resolveQuote(modelId, new Date('2026-08-20T04:00:00Z'));

    expect(beforePeak.rateWindowId).toBeNull();
    expect(beforePeak.cacheMissInputPer1m).toBe(0.66);
    expect(atPeak.rateWindowName).toBe('peak');
    expect(atPeak.cacheMissInputPer1m).toBe(1.32);
    expect(afterPeak.rateWindowId).toBeNull();
    expect(afterPeak.outputPer1m).toBe(1.98);
  });

  it('prices a model by name even when it is not active', async () => {
    if (skip) return;
    // `createModel` inserts with is_active = false, which is exactly the case that matters.
    //
    // Pricing an attempt says what *ran*; `is_active` says what may be *selected now*. This lookup
    // used to require is_active, which broke two real cases: deactivating a model made every past
    // attempt naming it unpriceable, and a model reachable only over a dev execution backend — no
    // API key, so never active — could not be costed at all. That second case took down every
    // subscription session the moment its pinned model was not also an API deployment.
    const modelId = await createModel();
    const [row] = (await harness!.pool.query('SELECT model_name FROM models WHERE id = $1', [modelId])).rows;
    await repo.publish({
      modelId,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      currency: 'usd',
      baseCacheHitInputPer1m: 0.4,
      baseCacheMissInputPer1m: 4,
      baseOutputPer1m: 20,
    });

    const quote = await repo.resolveQuoteByModelName(row.model_name, new Date('2026-08-20T00:00:00Z'));

    expect(quote.cacheMissInputPer1m).toBe(4);
    expect(quote.outputPer1m).toBe(20);
  });

  it('names the model it could not find, rather than blaming activation', async () => {
    if (skip) return;
    await expect(
      repo.resolveQuoteByModelName('model-that-was-never-seeded', new Date()),
    ).rejects.toThrow(/No model deployment named "model-that-was-never-seeded"/);
  });

  it('serializes concurrent publications and rejects the overlapping card', async () => {
    if (skip) return;
    const modelId = await createModel();
    const input = {
      modelId,
      effectiveFrom: new Date('2026-08-16T16:00:00Z'),
      currency: 'usd',
      baseCacheHitInputPer1m: 1,
      baseCacheMissInputPer1m: 2,
      baseOutputPer1m: 3,
    };

    const results = await Promise.allSettled([
      repo.publish(input),
      repo.publish({ ...input, baseOutputPer1m: 4 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repo.listByModel(modelId)).toHaveLength(1);
  });

  it('closes one open predecessor exactly at a later rate cutover', async () => {
    if (skip) return;
    const modelId = await createModel();
    const firstStart = new Date('2026-08-16T00:00:00Z');
    const cutover = new Date('2026-08-20T12:00:00Z');
    await repo.publish({
      modelId,
      effectiveFrom: firstStart,
      currency: 'usd',
      baseCacheHitInputPer1m: 1,
      baseCacheMissInputPer1m: 2,
      baseOutputPer1m: 3,
    });

    await repo.publish({
      modelId,
      effectiveFrom: cutover,
      currency: 'usd',
      baseCacheHitInputPer1m: 2,
      baseCacheMissInputPer1m: 4,
      baseOutputPer1m: 6,
    });

    const history = await repo.listByModel(modelId);
    expect(history).toHaveLength(2);
    expect(history[0]?.card.effectiveFrom).toEqual(firstStart);
    expect(history[0]?.card.effectiveTo).toEqual(cutover);
    expect((await repo.resolveQuote(modelId, new Date(cutover.getTime() - 1))).outputPer1m).toBe(3);
    expect((await repo.resolveQuote(modelId, cutover)).outputPer1m).toBe(6);
  });

  it('fails closed when the pinned deployment has no active rate', async () => {
    if (skip) return;
    const modelId = await createModel();

    await expect(
      repo.resolveQuote(modelId, new Date('2026-08-20T00:00:00Z')),
    ).rejects.toThrow('No active rate card');
  });
});
