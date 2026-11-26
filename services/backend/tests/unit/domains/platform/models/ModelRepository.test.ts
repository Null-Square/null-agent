import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A chainable stand-in for drizzle's builders: every call is recorded, awaiting yields `rows`. */
const mocks = vi.hoisted(() => {
  const state = { rows: [] as any[], calls: [] as Array<{ op: string; args: unknown[] }> };
  const builder = (op: string): any => {
    const chain: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (value: any[]) => void) => resolve(state.rows);
        return (...args: unknown[]) => {
          state.calls.push({ op: `${op}.${String(prop)}`, args });
          return chain;
        };
      },
    });
    return chain;
  };
  const db = {
    select: (...args: unknown[]) => {
      state.calls.push({ op: 'select', args });
      return builder('select');
    },
    insert: (...args: unknown[]) => {
      state.calls.push({ op: 'insert', args });
      return builder('insert');
    },
    update: (...args: unknown[]) => {
      state.calls.push({ op: 'update', args });
      return builder('update');
    },
    execute: vi.fn(async () => undefined),
  };
  return { state, db };
});

vi.mock('@/db/client', () => ({ db: mocks.db }));

vi.mock('@/db/schema', () => ({
  models: {
    id: 'models.id',
    provider: 'models.provider',
    modelName: 'models.modelName',
    isDefault: 'models.isDefault',
    isActive: 'models.isActive',
    selectionCategory: 'models.selectionCategory',
    selectionPriority: 'models.selectionPriority',
    createdAt: 'models.createdAt',
    updatedAt: 'models.updatedAt',
  },
  usageRecords: { id: 'usage.id', modelId: 'usage.modelId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (field: unknown, value: unknown) => ({ eq: [field, value] }),
  ne: (field: unknown, value: unknown) => ({ ne: [field, value] }),
  and: (...parts: unknown[]) => ({ and: parts }),
  asc: (field: unknown) => ({ asc: field }),
  desc: (field: unknown) => ({ desc: field }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

import { ModelRepository } from '@/domains/platform/models/ModelRepository';

const calls = (op: string) => mocks.state.calls.filter((call) => call.op === op);

describe('ModelRepository', () => {
  const repo = new ModelRepository();

  beforeEach(() => {
    mocks.state.rows = [];
    mocks.state.calls = [];
  });

  it('lists models in a stable order: oldest first', async () => {
    mocks.state.rows = [{ id: 'm1' }, { id: 'm2' }];
    await expect(repo.list()).resolves.toEqual([{ id: 'm1' }, { id: 'm2' }]);
    expect(calls('select.orderBy')[0]?.args).toEqual([{ asc: 'models.createdAt' }, { asc: 'models.id' }]);
  });

  it('every effort tier lists the connected model: the category does not narrow the active rows', async () => {
    mocks.state.rows = [{ id: 'connection', isActive: true, isDefault: true }];
    for (const category of ['low', 'medium', 'high', 'extra_high'] as const) {
      mocks.state.calls = [];
      await expect(repo.listActiveByCategory(category)).resolves.toEqual(mocks.state.rows);
      expect(calls('select.where')[0]?.args).toEqual([{ eq: ['models.isActive', true] }]);
    }
  });

  it('looks a model up by name with the connection first, so a catalogue row never shadows it', async () => {
    mocks.state.rows = [{ id: 'connection' }];
    await expect(repo.getByModelName('gpt-5')).resolves.toEqual({ id: 'connection' });
    expect(calls('select.orderBy')[0]?.args).toEqual([{ desc: 'models.isActive' }, { desc: 'models.updatedAt' }]);
  });

  it('makes one row the only connection: others lose active and default, it gains both', async () => {
    await repo.makeOnlyConnection('m1');
    const sets = calls('update.set').map((call) => call.args[0]);
    expect(sets[0]).toMatchObject({ isActive: false, isDefault: false });
    expect(sets[1]).toMatchObject({ isActive: true, isDefault: true });
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
  });

  it('locks a row for a token refresh', async () => {
    mocks.state.rows = [{ id: 'm1' }];
    await expect(repo.getByIdForUpdate('m1')).resolves.toEqual({ id: 'm1' });
    expect(calls('select.for')[0]?.args).toEqual(['update']);
  });
});
