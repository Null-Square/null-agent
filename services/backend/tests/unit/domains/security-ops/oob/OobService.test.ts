import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { oobInteractions, oobTokens } from '@/db/schema';
import { OobService } from '@/domains/security-ops/oob/OobService';

const makeFakeDb = () => {
  const state = {
    tokens: [] as any[],
    interactions: [] as any[],
    updates: [] as any[],
  };

  const db = {
    insert(table: unknown) {
      return {
        values(value: any) {
          if (table === oobTokens) {
            const row = {
              id: value.id ?? 'token-row-1',
              ...value,
              scopeId: value.scopeId ?? null,
              runId: value.runId ?? null,
              sessionId: value.sessionId ?? null,
              lastPolledAt: value.lastPolledAt ?? null,
              createdAt: value.createdAt ?? new Date(),
              updatedAt: value.updatedAt ?? new Date(),
            };
            state.tokens.push(row);
            return Promise.resolve([row]);
          }
          if (table === oobInteractions) {
            const exists = state.interactions.some(
              (row) =>
                row.organizationId === value.organizationId &&
                row.token === value.token &&
                row.dedupeKey === value.dedupeKey,
            );
            if (!exists) {
              state.interactions.push({
                id: value.id ?? `interaction-${state.interactions.length + 1}`,
                ...value,
                scopeId: value.scopeId ?? null,
                runId: value.runId ?? null,
                sessionId: value.sessionId ?? null,
                createdAt: value.createdAt ?? new Date(),
              });
            }
            return {
              onConflictDoNothing: () => Promise.resolve(undefined),
            };
          }
          return Promise.resolve(undefined);
        },
      };
    },
    select() {
      let table: unknown;
      return {
        from(nextTable: unknown) {
          table = nextTable;
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit(count: number) {
          const rows =
            table === oobTokens
              ? state.tokens.slice(0, count)
              : state.interactions.slice().sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, count);
          return Promise.resolve(rows);
        },
      };
    },
    update(table: unknown) {
      return {
        set(value: any) {
          return {
            where() {
              state.updates.push({ table, value });
              if (table === oobTokens && state.tokens[0]) {
                Object.assign(state.tokens[0], value);
              }
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };

  return { db: db as any, state };
};

describe('OobService', () => {
  it('uses file fallback when interactsh is not configured', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-oob-'));
    const { db } = makeFakeDb();
    const service = new OobService(db, {
      config: {
        pollIntervalSeconds: 10,
        tokenDefaultTtlSeconds: 3600,
        tokenMaxTtlSeconds: 86400,
      },
    });

    const token = await service.createToken({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      workspaceDir,
      label: 'blind ssrf',
    });

    await fs.appendFile(
      path.join(workspaceDir, '.oob-interactions.ndjson'),
      `${JSON.stringify({
        token: token.token,
        ts: '2026-05-01T00:00:00.000Z',
        protocol: 'dns',
        sourceIp: '203.0.113.10',
        hostname: token.hostname,
        raw: 'Authorization: secret-token',
      })}\n`,
      'utf8',
    );

    const result = await service.checkInteractions({
      token: token.token,
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      workspaceDir,
    });

    expect(token.mode).toBe('file');
    expect(token.unavailable).toBe(true);
    expect(result.count).toBe(1);
    expect(result.interactions[0]?.payloadPreview).toContain('[REDACTED]');
  });

  it('persists interactsh tokens and polled interactions in DB mode', async () => {
    const { db, state } = makeFakeDb();
    const client = {
      callbackDomain: 'oast.nullai.io',
      registerToken: vi.fn().mockResolvedValue({
        token: '0123456789abcdef0123abcdef012',
        correlationId: '0123456789abcdef0123',
        secretKey: 'secret-key',
        privateKeyPem: 'private-key',
        hostname: '0123456789abcdef0123abcdef012.oast.nullai.io',
        url: 'http://0123456789abcdef0123abcdef012.oast.nullai.io/',
        dns: '0123456789abcdef0123abcdef012.oast.nullai.io',
      }),
      pollToken: vi.fn().mockResolvedValue([
        {
          ts: '2026-05-01T01:00:00.000Z',
          protocol: 'http',
          sourceIp: '198.51.100.15',
          hostname: 'placeholder.oast.nullai.io',
          method: 'GET',
          path: '/probe',
          raw: 'GET /probe HTTP/1.1\r\nCookie: session=secret',
          payload: { path: '/probe' },
        },
      ]),
    };
    const service = new OobService(db, {
      config: {
        interactshServerUrl: 'https://oast.nullai.io',
        interactshAuthToken: 'token',
        interactshCallbackDomain: 'oast.nullai.io',
        interactshCallbackScheme: 'http',
        pollIntervalSeconds: 10,
        tokenDefaultTtlSeconds: 3600,
        tokenMaxTtlSeconds: 86400,
      },
      client: client as any,
    });

    const token = await service.createToken({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
      label: 'blind ssrf',
    });

    const result = await service.checkInteractions({
      token: token.token,
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
    });

    service.shutdown();

    expect(token.mode).toBe('interactsh');
    expect(token.hostname).toMatch(/\.oast\.nullai\.io$/u);
    expect(state.tokens).toHaveLength(1);
    expect(client.registerToken).toHaveBeenCalled();
    expect(client.pollToken).toHaveBeenCalledWith({
      correlationId: '0123456789abcdef0123',
      secretKey: 'secret-key',
      privateKeyPem: 'private-key',
    });
    expect(state.interactions).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.interactions[0]).toMatchObject({
      protocol: 'http',
      sourceIp: '198.51.100.15',
      path: '/probe',
    });
    expect(result.interactions[0]?.payloadPreview).toContain('[REDACTED]');
  });

  it('detects interactsh configuration from environment variables (dev/staging parity)', () => {
    const { db } = makeFakeDb();
    const prevUrl = process.env.INTERACTSH_SERVER_URL;
    const prevToken = process.env.INTERACTSH_SERVER_AUTH_TOKEN;
    try {
      process.env.INTERACTSH_SERVER_URL = 'http://oast.nullsquare.net';
      process.env.INTERACTSH_SERVER_AUTH_TOKEN = 'env-token';
      // No explicit config -> service must resolve interactsh mode from process.env,
      // which is exactly how local dev inherits the deployed OOB ingress.
      const service = new OobService(db);
      expect(service.isInteractshConfigured()).toBe(true);
      service.shutdown();
    } finally {
      if (prevUrl === undefined) delete process.env.INTERACTSH_SERVER_URL;
      else process.env.INTERACTSH_SERVER_URL = prevUrl;
      if (prevToken === undefined) delete process.env.INTERACTSH_SERVER_AUTH_TOKEN;
      else process.env.INTERACTSH_SERVER_AUTH_TOKEN = prevToken;
    }
  });

  it('falls back to offline file mode when no interactsh env is configured', () => {
    const { db } = makeFakeDb();
    const prevUrl = process.env.INTERACTSH_SERVER_URL;
    try {
      delete process.env.INTERACTSH_SERVER_URL;
      const service = new OobService(db);
      expect(service.isInteractshConfigured()).toBe(false);
      service.shutdown();
    } finally {
      if (prevUrl !== undefined) process.env.INTERACTSH_SERVER_URL = prevUrl;
    }
  });

  it('marks OOB unavailable when interactsh URL is set without auth token', async () => {
    const { db } = makeFakeDb();
    const service = new OobService(db, {
      config: {
        interactshServerUrl: 'https://oast.nullai.io',
        pollIntervalSeconds: 10,
        tokenDefaultTtlSeconds: 3600,
        tokenMaxTtlSeconds: 86400,
      },
    });

    const token = await service.createToken({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
    });

    expect(token.unavailable).toBe(true);
    expect(token.unavailableReason).toContain('INTERACTSH_SERVER_AUTH_TOKEN');
  });
});
