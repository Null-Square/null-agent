import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import { setupTestDb } from '../../helpers/testDb';
import {
  organizations,
  scopeTestPersonas,
  scopes,
  users,
} from '@/db/schema';
import { PersonaService } from '@/domains/security-ops/personas/PersonaService';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('PersonaService (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let previousAccessKey: string | undefined;
  let skip = false;

  beforeAll(async () => {
    previousAccessKey = process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;
    process.env.ACCESS_MATERIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    try {
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
    if (previousAccessKey === undefined) {
      delete process.env.ACCESS_MATERIALS_ENCRYPTION_KEY;
    } else {
      process.env.ACCESS_MATERIALS_ENCRYPTION_KEY = previousAccessKey;
    }
  });

  const createFixture = async () => {
    const db = harness!.db;
    const userId = randomUUID();
    const [{ id: orgId }] = await db
      .insert(organizations)
      .values({
        name: 'Persona Test Org',
        slug: `persona-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      })
      .returning({ id: organizations.id });
    await db.insert(users).values({
      id: userId,
      email: `persona-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password_hash: 'test',
    });
    const [{ id: scopeId }] = await db
      .insert(scopes)
      .values({
        organizationId: orgId,
        name: 'Persona Test Scope',
      })
      .returning({ id: scopes.id });
    return { db, service: new PersonaService(db as any), userId, orgId, scopeId };
  };

  it('stores refresh secrets encrypted while exposing only safe metadata', async () => {
    if (skip || !harness) return;
    const { db, service, userId, orgId, scopeId } = await createFixture();

    const persona = await service.saveForScope({
      orgId,
      scopeId,
      actorUserId: userId,
      input: {
        kind: 'bearer_token',
        label: 'owner',
        roleLabel: 'owner',
        token: 'owner-token',
        appliesToHosts: ['example.com'],
        refreshProcedure: {
          type: 'http_request',
          url: 'https://example.com/oauth/token',
          method: 'POST',
          headers: { Authorization: 'Bearer refresh-bootstrap' },
          body: 'refresh_token=secret-refresh-token',
          tokenJsonPath: 'access_token',
        },
      },
    });

    const [row] = await db
      .select()
      .from(scopeTestPersonas)
      .where(eq(scopeTestPersonas.id, persona.id));
    expect(row.secretCiphertext).not.toContain('owner-token');
    expect(row.secretCiphertext).not.toContain('secret-refresh-token');
    expect(row.refreshProcedure).toEqual({
      type: 'http_request',
      url: 'https://example.com/oauth/token',
      method: 'POST',
      tokenJsonPath: 'access_token',
    });

    const resolved = await service.resolveHttpAuth({
      orgId,
      scopeId,
      persona: 'owner',
      url: 'https://example.com/api/users/1',
    });

    expect(resolved.headers).toEqual({ Authorization: 'Bearer owner-token' });
    expect(resolved.refreshProcedure).toMatchObject({
      body: 'refresh_token=secret-refresh-token',
      headers: { Authorization: 'Bearer refresh-bootstrap' },
    });
  });

  it('loads a saved persona from a later service instance within the same scope', async () => {
    if (skip || !harness) return;
    const { db, service, userId, orgId, scopeId } = await createFixture();

    await service.saveForScope({
      orgId,
      scopeId,
      actorUserId: userId,
      input: {
        kind: 'cookie_session',
        label: 'viewer',
        roleLabel: 'viewer',
        cookieHeader: 'sid=viewer-session',
        appliesToHosts: ['app.example.com'],
      },
    });

    const laterRunService = new PersonaService(db as any);
    const loaded = await laterRunService.loadForScope({
      orgId,
      scopeId,
      persona: 'viewer',
      url: 'https://app.example.com/dashboard',
    });

    expect(loaded).toMatchObject({
      label: 'viewer',
      roleLabel: 'viewer',
      kind: 'cookie_session',
      targetHost: 'app.example.com',
    });
  });

  it('refuses persona resolution outside the saved organization and scope', async () => {
    if (skip || !harness) return;
    const first = await createFixture();
    const second = await createFixture();

    await first.service.saveForScope({
      orgId: first.orgId,
      scopeId: first.scopeId,
      actorUserId: first.userId,
      input: {
        kind: 'bearer_token',
        label: 'owner',
        roleLabel: 'owner',
        token: 'owner-token',
        appliesToHosts: ['example.com'],
      },
    });

    await expect(first.service.resolveHttpAuth({
      orgId: second.orgId,
      scopeId: second.scopeId,
      persona: 'owner',
      url: 'https://example.com/api/me',
    })).rejects.toThrow(/Persona not found|Scope not found/u);
  });

  it('enforces host applicability before resolving HTTP auth', async () => {
    if (skip || !harness) return;
    const { service, userId, orgId, scopeId } = await createFixture();

    await service.saveForScope({
      orgId,
      scopeId,
      actorUserId: userId,
      input: {
        kind: 'custom_header',
        label: 'api-user',
        headerName: 'X-Api-Key',
        headerValue: 'api-key-secret',
        appliesToHosts: ['api.example.com', '*.tenant.example.com'],
      },
    });

    await expect(service.resolveHttpAuth({
      orgId,
      scopeId,
      persona: 'api-user',
      url: 'https://admin.example.com/api/me',
    })).rejects.toThrow(/not allowed for host admin\.example\.com/u);

    await expect(service.resolveHttpAuth({
      orgId,
      scopeId,
      persona: 'api-user',
      url: 'https://alpha.tenant.example.com/api/me',
    })).resolves.toMatchObject({
      headers: { 'X-Api-Key': 'api-key-secret' },
    });
  });
});
