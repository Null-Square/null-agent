/** An in-memory models table with the ModelRepository surface the model services use. */
export type InMemoryModelRepo = ReturnType<typeof createInMemoryModelRepo>;

type Row = Record<string, any>;

export const createInMemoryModelRepo = (initial: Row[] = []) => {
  const rows: Row[] = initial.map((row) => ({
    isActive: false,
    isDefault: false,
    apiKey: null,
    apiBaseUrl: null,
    updatedAt: new Date(),
    ...row,
  }));
  let next = 1;
  const find = (id: string) => rows.find((row) => row.id === id) ?? null;
  const repo: any = {
    rows,
    list: async () => [...rows],
    listActive: async () => rows.filter((row) => row.isActive),
    listActiveByCategory: async () => rows.filter((row) => row.isActive),
    getById: async (id: string) => find(id),
    getByIdForUpdate: async (id: string) => find(id),
    getDefault: async () => rows.find((row) => row.isDefault) ?? null,
    getByModelName: async (name: string) => rows.find((row) => row.modelName === name) ?? null,
    getByProvider: async (provider: string) => rows.find((row) => row.provider === provider) ?? null,
    getByProviderAndModelName: async (provider: string, modelName: string) =>
      rows.find((row) => row.provider === provider && row.modelName === modelName) ?? null,
    create: async (data: Row) => {
      const row = { id: `new-${next++}`, isActive: false, isDefault: false, apiBaseUrl: null, updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async (id: string, patch: Row) => {
      const row = find(id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date() });
      return row;
    },
    makeOnlyConnection: async (id: string) => {
      for (const row of rows) {
        row.isActive = row.id === id;
        row.isDefault = row.id === id;
      }
    },
    transaction: async (operation: (repository: unknown, database: unknown) => Promise<unknown>) => operation(repo, {}),
  };
  return repo;
};
