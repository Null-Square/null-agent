import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { and, desc, eq, gt, gte } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { oobInteractions, oobTokens, type OobTokenRow } from '@/db/schema';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { toSafeError } from '@/shared/errors';
import { InteractshClient, type InteractshInteraction } from './InteractshClient';

const TOKENS_FILE = '.oob-tokens.ndjson';
const INTERACTIONS_FILE = '.oob-interactions.ndjson';
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_INTERACTION_BYTES = 8_000;

export type OobServiceConfig = {
  interactshServerUrl?: string;
  interactshAuthToken?: string;
  interactshCallbackDomain?: string;
  interactshCallbackScheme?: 'http' | 'https';
  pollIntervalSeconds: number;
  tokenDefaultTtlSeconds: number;
  tokenMaxTtlSeconds: number;
};

export type CreateOobTokenInput = {
  label?: string;
  ttlSeconds?: number;
  sessionId: string;
  userId: string;
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  workspaceDir?: string;
};

export type CheckOobInteractionsInput = {
  token: string;
  since?: string;
  limit?: number;
  sessionId: string;
  userId: string;
  organizationId?: string;
  scopeId?: string;
  workspaceDir?: string;
};

export type OobTokenResult = {
  token: string;
  label?: string;
  hostname: string;
  url: string;
  dns: string;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  sessionId: string;
  userId: string;
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  mode: 'interactsh' | 'file';
  unavailable?: boolean;
  unavailableReason?: string;
};

export type OobInteractionResult = {
  id?: string;
  token: string;
  ts: string;
  protocol: string;
  sourceIp?: string;
  hostname?: string;
  method?: string;
  path?: string;
  payloadPreview?: string;
};

export type OobCheckResult = {
  token: string;
  expired?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  interactions: OobInteractionResult[];
  count: number;
  mode: 'interactsh' | 'file';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeTtl = (value: unknown, defaultTtl: number, maxTtl: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(60, Math.min(maxTtl, Math.floor(value)))
    : defaultTtl;

const appendNdjson = async (workspaceDir: string, fileName: string, record: Record<string, unknown>): Promise<void> => {
  const target = path.resolve(workspaceDir, fileName);
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, 'utf8');
};

const readNdjson = async (workspaceDir: string, fileName: string): Promise<Record<string, unknown>[]> => {
  const target = path.resolve(workspaceDir, fileName);
  try {
    const raw = await fs.readFile(target, 'utf8');
    return raw
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const safeString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const capString = (value: string): string =>
  Buffer.byteLength(value, 'utf8') > MAX_INTERACTION_BYTES
    ? `${value.slice(0, MAX_INTERACTION_BYTES)}...[truncated]`
    : value;

const redactText = (value: string): string =>
  value
    .replace(/(authorization\s*[:=]\s*)([^\r\n&]+)/giu, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)([^\r\n]+)/giu, '$1[REDACTED]')
    .replace(/(set-cookie\s*[:=]\s*)([^\r\n]+)/giu, '$1[REDACTED]')
    .replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)([^\s&]+)/giu, '$1[REDACTED]');

const payloadPreview = (interaction: InteractshInteraction | Record<string, unknown>): string | undefined => {
  const raw = 'raw' in interaction ? interaction.raw : undefined;
  if (typeof raw === 'string') {
    return capString(redactText(raw));
  }
  if (raw !== undefined) {
    return capString(redactText(JSON.stringify(raw)));
  }
  const payload = 'payload' in interaction ? interaction.payload : interaction;
  return capString(redactText(JSON.stringify(payload)));
};

const toDate = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
};

const createToken = (): string => randomUUID().replace(/-/g, '');

const buildDedupeKey = (token: string, interaction: OobInteractionResult): string =>
  createHash('sha256')
    .update([
      token,
      interaction.ts,
      interaction.protocol,
      interaction.sourceIp ?? '',
      interaction.hostname ?? '',
      interaction.method ?? '',
      interaction.path ?? '',
      interaction.payloadPreview ?? '',
    ].join('\n'))
    .digest('hex');

const fromConfig = (config?: ResolvedConfig): OobServiceConfig => {
  const envServerUrl = process.env.INTERACTSH_SERVER_URL?.trim();
  const envAuthToken = process.env.INTERACTSH_SERVER_AUTH_TOKEN?.trim();
  const envCallbackDomain = process.env.INTERACTSH_CALLBACK_DOMAIN?.trim();
  const envCallbackScheme = process.env.INTERACTSH_CALLBACK_SCHEME?.trim();
  return {
    interactshServerUrl: config?.oob?.interactshServerUrl ?? (envServerUrl || undefined),
    interactshAuthToken: config?.oob?.interactshAuthToken ?? (envAuthToken || undefined),
    interactshCallbackDomain: config?.oob?.interactshCallbackDomain ?? (envCallbackDomain || undefined),
    interactshCallbackScheme: config?.oob?.interactshCallbackScheme ?? (envCallbackScheme === 'http' ? 'http' : envCallbackScheme === 'https' ? 'https' : undefined),
    pollIntervalSeconds: Number(config?.oob?.pollIntervalSeconds ?? process.env.INTERACTSH_POLL_INTERVAL_SECONDS ?? 10),
    tokenDefaultTtlSeconds: Number(config?.oob?.tokenDefaultTtlSeconds ?? process.env.OOB_TOKEN_DEFAULT_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
    tokenMaxTtlSeconds: Number(config?.oob?.tokenMaxTtlSeconds ?? process.env.OOB_TOKEN_MAX_TTL_SECONDS ?? MAX_TTL_SECONDS),
  };
};

export class OobService {
  private readonly config: OobServiceConfig;
  private readonly client?: InteractshClient;
  private poller?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseClient,
    options: { config?: ResolvedConfig | OobServiceConfig; client?: InteractshClient } = {},
  ) {
    this.config = 'pollIntervalSeconds' in (options.config ?? {})
      ? options.config as OobServiceConfig
      : fromConfig(options.config as ResolvedConfig | undefined);
    this.client = options.client ?? (this.config.interactshServerUrl
      ? new InteractshClient({
        serverUrl: this.config.interactshServerUrl,
        authToken: this.config.interactshAuthToken,
        callbackDomain: this.config.interactshCallbackDomain,
        callbackScheme: this.config.interactshCallbackScheme,
      })
      : undefined);
  }

  isInteractshConfigured(): boolean {
    return Boolean(this.config.interactshServerUrl);
  }

  async createToken(input: CreateOobTokenInput): Promise<OobTokenResult> {
    const ttlSeconds = normalizeTtl(input.ttlSeconds, this.config.tokenDefaultTtlSeconds, this.config.tokenMaxTtlSeconds);
    if (!this.isInteractshConfigured()) {
      return this.createFileToken(input, ttlSeconds);
    }
    if (!this.config.interactshAuthToken) {
      return this.createUnavailableToken(input, ttlSeconds, 'INTERACTSH_SERVER_AUTH_TOKEN is required when INTERACTSH_SERVER_URL is set');
    }
    if (!input.organizationId || !input.scopeId) {
      return this.createUnavailableToken(input, ttlSeconds, 'OOB DB mode requires organizationId and scopeId on the run context');
    }
    if (!this.client) {
      return this.createUnavailableToken(input, ttlSeconds, 'Interactsh client is not configured');
    }

    let registration;
    try {
      registration = await this.client.registerToken();
    } catch (error) {
      logger.warn({ err: toSafeError(error) }, 'Failed to register OOB token with interactsh');
      return this.createUnavailableToken(input, ttlSeconds, 'failed to register token with interactsh server');
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const result: OobTokenResult = {
      token: registration.token,
      label: input.label,
      hostname: registration.hostname,
      url: registration.url,
      dns: registration.dns,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlSeconds,
      sessionId: input.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      scopeId: input.scopeId,
      runId: input.runId,
      mode: 'interactsh',
    };

    await this.database.insert(oobTokens).values({
      token: registration.token,
      organizationId: input.organizationId,
      scopeId: input.scopeId,
      userId: input.userId,
      runId: input.runId,
      sessionId: input.sessionId,
      label: input.label,
      hostname: registration.hostname,
      url: result.url,
      dns: registration.dns,
      correlationId: registration.correlationId,
      secretKey: registration.secretKey,
      privateKeyPem: registration.privateKeyPem,
      mode: 'interactsh',
      issuedAt,
      expiresAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    this.startPoller();
    return result;
  }

  async checkInteractions(input: CheckOobInteractionsInput): Promise<OobCheckResult> {
    if (!this.isInteractshConfigured()) {
      return this.checkFileInteractions(input);
    }
    if (!input.organizationId) {
      return {
        token: input.token,
        unavailable: true,
        unavailableReason: 'OOB DB mode requires organizationId on the run context',
        interactions: [],
        count: 0,
        mode: 'interactsh',
      };
    }
    const tokenRow = await this.loadToken(input.token, input.organizationId);
    if (!tokenRow) {
      return {
        token: input.token,
        unavailable: true,
        unavailableReason: `OOB token ${input.token} was not issued for this organization`,
        interactions: [],
        count: 0,
        mode: 'interactsh',
      };
    }
    if (Date.now() > tokenRow.expiresAt.getTime()) {
      return { token: input.token, expired: true, interactions: [], count: 0, mode: 'interactsh' };
    }

    await this.pollTokenAndPersist(tokenRow);
    const since = input.since ? new Date(input.since) : null;
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(100, Math.floor(input.limit)))
      : 20;

    const where = since && !Number.isNaN(since.getTime())
      ? and(eq(oobInteractions.tokenId, tokenRow.id), gte(oobInteractions.ts, since))
      : eq(oobInteractions.tokenId, tokenRow.id);
    const rows = await this.database
      .select()
      .from(oobInteractions)
      .where(where)
      .orderBy(desc(oobInteractions.ts))
      .limit(limit);

    const interactions = rows.map((row) => ({
      id: row.id,
      token: row.token,
      ts: row.ts.toISOString(),
      protocol: row.protocol,
      sourceIp: row.sourceIp ?? undefined,
      hostname: row.hostname ?? undefined,
      method: row.method ?? undefined,
      path: row.path ?? undefined,
      payloadPreview: row.payloadPreview ?? undefined,
    }));
    return { token: input.token, interactions, count: interactions.length, mode: 'interactsh' };
  }

  async pollActiveTokens(): Promise<number> {
    if (!this.client || !this.config.interactshAuthToken) {
      return 0;
    }
    const active = await this.database
      .select()
      .from(oobTokens)
      .where(gt(oobTokens.expiresAt, new Date()))
      .limit(100);
    let count = 0;
    for (const token of active) {
      count += await this.pollTokenAndPersist(token);
    }
    return count;
  }

  shutdown(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  private startPoller(): void {
    if (this.poller || !this.client || !this.config.interactshAuthToken) {
      return;
    }
    const intervalMs = Math.max(1, this.config.pollIntervalSeconds) * 1000;
    this.poller = setInterval(() => {
      this.pollActiveTokens().catch((error) => {
        logger.warn({ err: toSafeError(error) }, 'OOB poller failed');
      });
    }, intervalMs);
    this.poller.unref?.();
  }

  private async pollTokenAndPersist(tokenRow: OobTokenRow): Promise<number> {
    if (!this.client || !this.config.interactshAuthToken) {
      return 0;
    }
    if (!tokenRow.correlationId || !tokenRow.secretKey || !tokenRow.privateKeyPem) {
      logger.warn({ token: tokenRow.token }, 'Skipping OOB poll for token missing interactsh session material');
      return 0;
    }
    let interactions: InteractshInteraction[];
    try {
      interactions = await this.client.pollToken({
        correlationId: tokenRow.correlationId,
        secretKey: tokenRow.secretKey,
        privateKeyPem: tokenRow.privateKeyPem,
      });
    } catch (error) {
      logger.warn({ err: toSafeError(error), token: tokenRow.token }, 'Failed to poll OOB interactions');
      return 0;
    }

    let created = 0;
    for (const interaction of interactions) {
      const normalized = this.normalizeInteraction(tokenRow.token, interaction);
      const dedupeKey = buildDedupeKey(tokenRow.token, normalized);
      await this.database
        .insert(oobInteractions)
        .values({
          organizationId: tokenRow.organizationId,
          scopeId: tokenRow.scopeId,
          userId: tokenRow.userId,
          tokenId: tokenRow.id,
          token: tokenRow.token,
          runId: tokenRow.runId,
          sessionId: tokenRow.sessionId,
          ts: new Date(normalized.ts),
          protocol: normalized.protocol,
          sourceIp: normalized.sourceIp,
          hostname: normalized.hostname,
          method: normalized.method,
          path: normalized.path,
          payloadPreview: normalized.payloadPreview,
          payload: interaction.payload ?? {},
          dedupeKey,
        })
        .onConflictDoNothing({
          target: [oobInteractions.organizationId, oobInteractions.token, oobInteractions.dedupeKey],
        });
      created += 1;
    }
    await this.database
      .update(oobTokens)
      .set({ lastPolledAt: new Date(), updatedAt: new Date() })
      .where(eq(oobTokens.id, tokenRow.id));
    return created;
  }

  private normalizeInteraction(token: string, interaction: InteractshInteraction): OobInteractionResult {
    const ts = toDate(interaction.ts).toISOString();
    const protocol = safeString(interaction.protocol)?.toLowerCase() ?? 'unknown';
    const hostname = interaction.hostname && interaction.hostname.includes(token)
      ? interaction.hostname
      : interaction.hostname;
    return {
      token,
      ts,
      protocol,
      sourceIp: safeString(interaction.sourceIp),
      hostname: safeString(hostname),
      method: safeString(interaction.method)?.toUpperCase(),
      path: safeString(interaction.path),
      payloadPreview: payloadPreview(interaction),
    };
  }

  private async loadToken(token: string, organizationId: string): Promise<OobTokenRow | undefined> {
    const rows = await this.database
      .select()
      .from(oobTokens)
      .where(and(eq(oobTokens.token, token), eq(oobTokens.organizationId, organizationId)))
      .limit(1);
    return rows[0];
  }

  private async createFileToken(input: CreateOobTokenInput, ttlSeconds: number): Promise<OobTokenResult> {
    if (!input.workspaceDir) {
      return this.createUnavailableToken(input, ttlSeconds, 'Session workspace is not available');
    }
    const domain = process.env.NULLAI_OOB_DOMAIN || process.env.INTERACTSH_SERVER || 'oast.fun';
    const token = createToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const hostname = `${token}.${domain}`;
    const record: OobTokenResult = {
      token,
      label: input.label,
      hostname,
      url: `https://${hostname}/`,
      dns: hostname,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlSeconds,
      sessionId: input.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      scopeId: input.scopeId,
      runId: input.runId,
      mode: 'file',
      unavailable: true,
      unavailableReason: 'INTERACTSH_SERVER_URL is not configured; using offline file fallback',
    };
    await appendNdjson(input.workspaceDir, TOKENS_FILE, record);
    return record;
  }

  private createUnavailableToken(input: CreateOobTokenInput, ttlSeconds: number, reason: string): OobTokenResult {
    const token = createToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    return {
      token,
      label: input.label,
      hostname: '',
      url: '',
      dns: '',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlSeconds,
      sessionId: input.sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      scopeId: input.scopeId,
      runId: input.runId,
      mode: this.isInteractshConfigured() ? 'interactsh' : 'file',
      unavailable: true,
      unavailableReason: reason,
    };
  }

  private async checkFileInteractions(input: CheckOobInteractionsInput): Promise<OobCheckResult> {
    if (!input.workspaceDir) {
      return {
        token: input.token,
        unavailable: true,
        unavailableReason: 'Session workspace is not available',
        interactions: [],
        count: 0,
        mode: 'file',
      };
    }
    const tokenRecords = (await readNdjson(input.workspaceDir, TOKENS_FILE))
      .filter((entry) => entry.token === input.token)
      .reverse();
    const tokenRecord = tokenRecords[0];
    if (!tokenRecord) {
      return {
        token: input.token,
        unavailable: true,
        unavailableReason: `OOB token ${input.token} was not issued in this workspace`,
        interactions: [],
        count: 0,
        mode: 'file',
      };
    }
    const expiresAtMs = typeof tokenRecord.expiresAt === 'string' ? new Date(tokenRecord.expiresAt).getTime() : 0;
    if (expiresAtMs && Date.now() > expiresAtMs) {
      return { token: input.token, expired: true, interactions: [], count: 0, mode: 'file' };
    }
    const sinceMs = input.since ? new Date(input.since).getTime() : 0;
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(100, Math.floor(input.limit)))
      : 20;
    const interactions = (await readNdjson(input.workspaceDir, INTERACTIONS_FILE))
      .filter((entry) => entry.token === input.token || (typeof entry.hostname === 'string' && entry.hostname.includes(input.token)))
      .filter((entry) => {
        if (!sinceMs) return true;
        const ts = typeof entry.ts === 'string' ? new Date(entry.ts).getTime() : 0;
        return ts >= sinceMs;
      })
      .slice(-limit)
      .reverse()
      .map((entry) => ({
        token: input.token,
        ts: safeString(entry.ts) ?? new Date().toISOString(),
        protocol: safeString(entry.protocol) ?? 'unknown',
        sourceIp: safeString(entry.sourceIp) ?? safeString(entry.source_ip),
        hostname: safeString(entry.hostname),
        method: safeString(entry.method),
        path: safeString(entry.path),
        payloadPreview: payloadPreview(entry),
      }));
    return { token: input.token, interactions, count: interactions.length, mode: 'file' };
  }
}

export const createOobService = (database: DatabaseClient, config?: ResolvedConfig): OobService =>
  new OobService(database, { config });
