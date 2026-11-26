import { randomUUID } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { oobInteractions, oobTokens } from '@/db/schema';
import { OobService, type OobCheckResult } from '@/domains/security-ops/oob/OobService';

const ENABLED = process.env.RUN_OOB_DEV_PARITY_SMOKE === '1';
const describeExternalSmoke = ENABLED ? describe : describe.skip;

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
              id: value.id ?? randomUUID(),
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
                id: value.id ?? randomUUID(),
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
              : state.interactions
                .slice()
                .sort((a, b) => b.ts.getTime() - a.ts.getTime())
                .slice(0, count);
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

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when RUN_OOB_DEV_PARITY_SMOKE=1`);
  }
  return value;
};

const waitForInteraction = async (
  service: OobService,
  token: string,
  input: Omit<Parameters<OobService['checkInteractions']>[0], 'token'>,
): Promise<OobCheckResult> => {
  let latest: OobCheckResult | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    latest = await service.checkInteractions({ ...input, token });
    if (latest.count > 0) {
      return latest;
    }
    await delay(5_000);
  }
  return latest ?? {
    token,
    count: 0,
    interactions: [],
    mode: 'interactsh',
  };
};

describeExternalSmoke('OOB dev parity external smoke', () => {
  it(
    'registers a token, receives a public callback, and polls the interaction',
    async () => {
      requireEnv('INTERACTSH_SERVER_URL');
      requireEnv('INTERACTSH_SERVER_AUTH_TOKEN');
      const callbackDomain = requireEnv('INTERACTSH_CALLBACK_DOMAIN');
      const dnsProbe = `nullai-smoke-${Date.now()}.${callbackDomain}`;
      await resolve4(dnsProbe).catch((error: unknown) => {
        throw new Error(`OOB callback DNS is not delegated or reachable for ${dnsProbe}: ${error instanceof Error ? error.message : String(error)}`);
      });

      const { db, state } = makeFakeDb();
      const service = new OobService(db);
      const organizationId = randomUUID();
      const scopeId = randomUUID();
      const userId = randomUUID();
      const sessionId = randomUUID();
      const runId = randomUUID();

      const token = await service.createToken({
        label: 'dev parity smoke',
        ttlSeconds: 600,
        organizationId,
        scopeId,
        userId,
        sessionId,
        runId,
      });

      expect(service.isInteractshConfigured()).toBe(true);
      expect(token.unavailable, token.unavailableReason).not.toBe(true);
      expect(token.mode).toBe('interactsh');
      expect(token.hostname).toContain(callbackDomain);
      expect(state.tokens).toHaveLength(1);

      const callbackUrl = new URL('/nullai-oob-dev-smoke', token.url);
      callbackUrl.searchParams.set('nonce', token.token.slice(0, 10));

      await fetch(callbackUrl, {
        method: 'GET',
        headers: {
          'user-agent': 'nullai-oob-dev-parity-smoke',
        },
      }).catch((error: unknown) => {
        throw new Error(`OOB callback request failed before reaching ${token.hostname}: ${error instanceof Error ? error.message : String(error)}`);
      });

      const result = await waitForInteraction(service, token.token, {
        organizationId,
        scopeId,
        userId,
        sessionId,
        limit: 20,
      });

      service.shutdown();

      expect(result.mode).toBe('interactsh');
      expect(result.unavailable).not.toBe(true);
      expect(result.count).toBeGreaterThan(0);
      expect(state.interactions.length).toBeGreaterThan(0);
      expect(
        result.interactions.some((interaction) =>
          interaction.hostname?.includes(token.token) ||
          interaction.path?.includes('/nullai-oob-dev-smoke') ||
          interaction.payloadPreview?.includes('nullai-oob-dev-smoke'),
        ),
      ).toBe(true);
    },
    120_000,
  );
});
