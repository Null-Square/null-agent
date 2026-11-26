import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import type { AuthenticatedUser } from '@/shared/types/express';

/**
 * The person using Null AI.
 *
 * Null AI runs for one person on their own computer, so nobody signs in: every request from the app
 * is this owner. The owner is one row in `users`, made the first time it is needed; its organization
 * is made the first time a request needs one (`resolvePrimaryOrganizationMembership`). Who can reach
 * the app at all is decided by `localHostOnly`: only requests addressed to this computer get here.
 */
export const LOCAL_OWNER_EMAIL = 'owner@null-ai.local';

let owner: Promise<AuthenticatedUser> | null = null;

const findOwner = async () => {
  const [row] = await db.select().from(users).where(eq(users.email, LOCAL_OWNER_EMAIL)).limit(1);
  return row;
};

const loadOrCreateOwner = async (): Promise<AuthenticatedUser> => {
  let row = await findOwner();
  if (!row) {
    await db
      .insert(users)
      .values({ email: LOCAL_OWNER_EMAIL, password_hash: '', email_verified: true, role: 'user' })
      .onConflictDoNothing();
    row = await findOwner();
  }
  if (!row) throw new Error('The local owner could not be created');
  return {
    id: row.id,
    email: row.email,
    role: row.role ?? 'user',
    created_at: row.created_at?.toISOString(),
    updated_at: row.updated_at?.toISOString(),
    email_verified: true,
    disabled: false,
  };
};

export const localOwner = (): Promise<AuthenticatedUser> => {
  owner ??= loadOrCreateOwner().catch((error: unknown) => {
    owner = null;
    throw error;
  });
  return owner;
};
