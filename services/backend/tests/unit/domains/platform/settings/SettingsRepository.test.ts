import { describe, it, expect, vi } from 'vitest';
import { SettingsRepository } from '@/domains/platform/settings/SettingsRepository';

describe('SettingsRepository', () => {
  const buildDb = () => {
    const selectLimit = vi.fn();
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: insertValues }));

    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn(() => ({ where: deleteWhere }));

    return {
      select,
      update,
      insert,
      delete: deleteFn,
      mocks: {
        selectLimit,
        updateSet,
        update,
        insert,
        insertValues,
        delete: deleteFn,
        deleteWhere,
      },
    };
  };

  it('updates existing settings rows', async () => {
    const db = buildDb();
    db.mocks.selectLimit.mockResolvedValue([{ value: { foo: 'bar' } }]);
    const repo = new SettingsRepository(db as any);

    await repo.set('billing', { foo: 'bar' });

    expect(db.mocks.update).toHaveBeenCalled();
    expect(db.mocks.insert).not.toHaveBeenCalled();
    expect(db.mocks.updateSet).toHaveBeenCalledWith({
      value: { foo: 'bar' },
      updatedAt: expect.any(Date),
    });
  });

  it('inserts settings rows when missing', async () => {
    const db = buildDb();
    db.mocks.selectLimit.mockResolvedValue([]);
    const repo = new SettingsRepository(db as any);

    await repo.set('network', { allowOutbound: true });

    expect(db.mocks.insert).toHaveBeenCalled();
    expect(db.mocks.update).not.toHaveBeenCalled();
    expect(db.mocks.insertValues).toHaveBeenCalledWith({
      key: 'network',
      value: { allowOutbound: true },
    });
  });

  it('deletes obsolete settings rows', async () => {
    const db = buildDb();
    const repo = new SettingsRepository(db as any);

    await repo.delete('guardrails');

    expect(db.mocks.delete).toHaveBeenCalled();
    expect(db.mocks.deleteWhere).toHaveBeenCalled();
  });
});
