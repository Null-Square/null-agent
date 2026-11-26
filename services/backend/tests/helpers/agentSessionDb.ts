import crypto from 'crypto';
import type { TestDb } from './testDb';
import { agentSessions, type NewAgentSessionRow } from '@/db/schema';
import { sql } from 'drizzle-orm';

export const newId = () => crypto.randomUUID();

export async function insertAgentSession(
  db: TestDb['db'],
  overrides: Partial<NewAgentSessionRow> = {},
): Promise<string> {
  const id = overrides.id ?? newId();
  const userId = overrides.userId ?? null;
  const now = new Date();
  if (userId) {
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash)
          VALUES (${userId}, ${`test-${userId}@example.com`}, ${'test-hash'})
          ON CONFLICT DO NOTHING`,
    );
  }
  await db.insert(agentSessions).values({
    id,
    userId,
    mode: 'interactive',
    workspaceDir: `/tmp/${id}`,
    metadata: {},
    plan: [],
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    ...overrides,
  });
  return id;
}
