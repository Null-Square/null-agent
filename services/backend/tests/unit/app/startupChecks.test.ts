import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  getPool: vi.fn(() => ({
    query: mocks.query,
  })),
}));

import { ensureDatabaseSchema } from '@/app/startupChecks';

const REQUIRED_TABLES = [
  'public.agent_sessions',
  'public.agent_messages',
  'public.agent_artifacts',
  'public.trace_index',
  'public.users',
  'public.organizations',
  'public.organization_members',
  'public.settings',
  'public.models',
  'public.usage_records',
  'public.notifications',
];

const queueSchemaState = (existingTables: string[]) => {
  const existing = new Set(existingTables);
  mocks.query.mockImplementation(async (_query: string, [table]: [string]) => ({
    rows: [{ oid: existing.has(table) ? `${table}_oid` : null }],
  }));
};

describe('ensureDatabaseSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when the drizzle migration table and the local product tables (owner, organization, settings, notifications) exist', async () => {
    queueSchemaState(['drizzle.__drizzle_migrations', ...REQUIRED_TABLES]);

    await expect(ensureDatabaseSchema()).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledTimes(1 + REQUIRED_TABLES.length);
    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      'select to_regclass($1) as oid',
      ['drizzle.__drizzle_migrations'],
    );
    expect(mocks.query).not.toHaveBeenCalledWith('select to_regclass($1) as oid', ['public.drizzle_migrations']);
  });

  it('accepts the public migration table as a fallback', async () => {
    queueSchemaState(['public.drizzle_migrations', ...REQUIRED_TABLES]);

    await expect(ensureDatabaseSchema()).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      'select to_regclass($1) as oid',
      ['drizzle.__drizzle_migrations'],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      'select to_regclass($1) as oid',
      ['public.drizzle_migrations'],
    );
  });

  it('throws a helpful error listing every missing table', async () => {
    queueSchemaState([
      'public.agent_sessions',
      'public.agent_messages',
      'public.agent_artifacts',
      'public.organizations',
      'public.organization_members',
      'public.settings',
      'public.models',
      'public.notifications',
    ]);

    await expect(ensureDatabaseSchema()).rejects.toThrow(
      '[Startup] Missing required tables: drizzle_migrations, trace_index, users, usage_records. Run migrations (e.g., npm run db:migrate) before starting the API.',
    );
  });
});
