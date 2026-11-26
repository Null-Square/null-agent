import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  scopeTestPersonas,
  scopes,
  type ScopeTestPersonaRow,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';

export const TEST_PERSONA_KINDS = [
  'custom_header',
  'bearer_token',
  'cookie_session',
  'storage_state',
] as const;

export type TestPersonaKind = (typeof TEST_PERSONA_KINDS)[number];

export interface TestPersonaRecord {
  id: string;
  scopeId: string;
  label: string;
  roleLabel: string | null;
  kind: TestPersonaKind;
  username: string | null;
  headerName: string | null;
  appliesToHosts: string[];
  refreshConfigured: boolean;
  metadata: Record<string, unknown>;
  lastUsedAt: Date | null;
  refreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedPersonaHttpAuth {
  personaId: string;
  label: string;
  roleLabel: string | null;
  kind: Exclude<TestPersonaKind, 'storage_state'>;
  username: string | null;
  targetHost: string;
  headers: Record<string, string>;
  appliedHeaderNames: string[];
  refreshProcedure: Record<string, unknown>;
}

type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

type EncryptedPersonaPayload = {
  schema: 'persona_secret/v1';
  authSecret: string;
  refreshProcedure: Record<string, unknown>;
};

type ParsedPersonaInput = z.infer<typeof SavePersonaSchema>;

const AUTO_KEY_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const UUIDISH = /^[0-9a-fA-F-]{36}$/;

const PersonaKindSchema = z.enum(TEST_PERSONA_KINDS);

const normalizeRequiredText = (field: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, `${field} is required`);

const normalizeOptionalText = z
  .string()
  .optional()
  .transform((value) => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  });

const normalizeOptionalNullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const sanitizeRefreshProcedureMetadata = (
  procedure: Record<string, unknown>,
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    'type',
    'url',
    'method',
    'includePersonaAuth',
    'secretJsonPath',
    'tokenJsonPath',
    'cookieHeaderJsonPath',
    'headerValueJsonPath',
  ]) {
    const value = procedure[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      metadata[key] = value;
    }
  }
  return metadata;
};

const HostPatternSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => value.length > 0, 'Host pattern cannot be empty')
  .refine((value) => isValidHostPattern(value), 'Host pattern must be an exact host or *.suffix wildcard');

const HostPatternsSchema = z
  .array(HostPatternSchema)
  .optional()
  .transform((value) => Array.from(new Set(value ?? [])));

const RefreshProcedureSchema = z
  .record(z.unknown())
  .optional()
  .transform((value) => toRecord(value));

const MetadataSchema = z
  .record(z.unknown())
  .optional()
  .transform((value) => toRecord(value));

const PersonaCommonSchema = {
  personaId: normalizeOptionalText,
  label: normalizeRequiredText('label'),
  roleLabel: normalizeOptionalNullableText,
  username: normalizeOptionalNullableText,
  appliesToHosts: HostPatternsSchema,
  refreshProcedure: RefreshProcedureSchema,
  metadata: MetadataSchema,
};

export const SavePersonaSchema = z.discriminatedUnion('kind', [
  z.object({
    ...PersonaCommonSchema,
    kind: z.literal('custom_header'),
    headerName: normalizeRequiredText('headerName'),
    headerValue: normalizeRequiredText('headerValue'),
  }),
  z.object({
    ...PersonaCommonSchema,
    kind: z.literal('bearer_token'),
    token: normalizeRequiredText('token'),
  }),
  z.object({
    ...PersonaCommonSchema,
    kind: z.literal('cookie_session'),
    cookieHeader: normalizeRequiredText('cookieHeader'),
  }),
  z.object({
    ...PersonaCommonSchema,
    kind: z.literal('storage_state'),
    storageStateJson: normalizeRequiredText('storageStateJson'),
  }),
]);

const normalizeHost = (value: string): string => value.trim().toLowerCase();

const isValidHostPattern = (value: string): boolean => {
  if (!value) return false;
  if (value.includes('*')) {
    if (!value.startsWith('*.')) return false;
    const suffix = value.slice(2);
    return suffix.length > 0 && !suffix.includes('*') && !suffix.startsWith('.') && !suffix.endsWith('.');
  }
  return !value.includes('*') && !value.startsWith('.') && !value.endsWith('.');
};

export const personaHostMatchesPattern = (host: string, pattern: string): boolean => {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
};

export const canonicalPersonaHeaderName = (value: string): string =>
  value
    .trim()
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('-');

const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    return new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      { httpStatus: 400 },
    );
  }
  if (error instanceof Error) {
    return new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, error.message, { httpStatus: 500 });
  }
  return new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Unexpected error', { httpStatus: 500 });
};

const normalizePersonaRecord = (row: ScopeTestPersonaRow): TestPersonaRecord => ({
  id: row.id,
  scopeId: row.scopeId,
  label: row.label,
  roleLabel: row.roleLabel ?? null,
  kind: PersonaKindSchema.parse(row.kind),
  username: row.username ?? null,
  headerName: row.headerName ?? null,
  appliesToHosts: row.appliesToHosts ?? [],
  refreshConfigured: Object.keys(row.refreshProcedure ?? {}).length > 0,
  metadata: row.metadata ?? {},
  lastUsedAt: row.lastUsedAt ?? null,
  refreshedAt: row.refreshedAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class PersonaService {
  private readonly encryptionKeyEnvName = 'ACCESS_MATERIALS_ENCRYPTION_KEY';

  constructor(private readonly db: DatabaseClient) {}

  async listForScope(orgId: string, scopeId: string): Promise<TestPersonaRecord[]> {
    await this.ensureScopeOwned(orgId, scopeId);
    const rows = await this.db
      .select()
      .from(scopeTestPersonas)
      .where(and(eq(scopeTestPersonas.organizationId, orgId), eq(scopeTestPersonas.scopeId, scopeId)))
      .orderBy(scopeTestPersonas.label, scopeTestPersonas.createdAt);

    return rows.map(normalizePersonaRecord);
  }

  async saveForScope(params: {
    orgId: string;
    scopeId: string;
    actorUserId: string | null;
    input: unknown;
  }): Promise<TestPersonaRecord> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const parsed = SavePersonaSchema.parse(params.input);
    const current = parsed.personaId
      ? await this.findById(params.orgId, params.scopeId, parsed.personaId)
      : await this.findByLabel(params.orgId, params.scopeId, parsed.label);
    const refreshProcedure = parsed.refreshProcedure ?? {};
    const encrypted = this.encryptPersonaPayload({
      authSecret: this.extractSecret(parsed),
      refreshProcedure,
    });
    const now = new Date();

    const values = {
      organizationId: params.orgId,
      scopeId: params.scopeId,
      label: parsed.label,
      roleLabel: parsed.roleLabel ?? null,
      kind: parsed.kind,
      username: parsed.username ?? null,
      headerName: parsed.kind === 'custom_header' ? canonicalPersonaHeaderName(parsed.headerName) : null,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      appliesToHosts: parsed.appliesToHosts ?? [],
      refreshProcedure: sanitizeRefreshProcedureMetadata(refreshProcedure),
      metadata: parsed.metadata ?? {},
      updatedAt: now,
    };

    if (current) {
      const [row] = await this.db
        .update(scopeTestPersonas)
        .set(values)
        .where(
          and(
            eq(scopeTestPersonas.id, current.id),
            eq(scopeTestPersonas.organizationId, params.orgId),
            eq(scopeTestPersonas.scopeId, params.scopeId),
          ),
        )
        .returning();

      if (!row) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Persona not found', { httpStatus: 404 });
      }
      return normalizePersonaRecord(row);
    }

    const [row] = await this.db
      .insert(scopeTestPersonas)
      .values({
        ...values,
        createdByUserId: params.actorUserId,
        createdAt: now,
      })
      .returning();

    return normalizePersonaRecord(row);
  }

  async deleteForScope(params: { orgId: string; scopeId: string; persona: string }): Promise<void> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const current = await this.resolveRow(params.orgId, params.scopeId, params.persona);
    await this.db.delete(scopeTestPersonas).where(eq(scopeTestPersonas.id, current.id));
  }

  async loadForScope(params: {
    orgId: string;
    scopeId: string;
    persona: string;
    url?: string;
  }): Promise<TestPersonaRecord & { targetHost: string | null }> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const row = await this.resolveRow(params.orgId, params.scopeId, params.persona);
    const record = normalizePersonaRecord(row);
    const targetHost = params.url ? this.extractTargetHost(params.url) : null;
    if (targetHost) {
      this.ensureHostAllowed(row, targetHost);
    }
    await this.markUsed(row.id);
    return { ...record, targetHost };
  }

  async resolveHttpAuth(params: {
    orgId: string;
    scopeId: string;
    persona: string;
    url: string;
  }): Promise<ResolvedPersonaHttpAuth> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const targetHost = this.extractTargetHost(params.url);
    const row = await this.resolveRow(params.orgId, params.scopeId, params.persona);
    const kind = PersonaKindSchema.parse(row.kind);
    if (kind === 'storage_state') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Persona "${row.label}" stores browser state and cannot be used for HTTP replay`,
        { httpStatus: 400 },
      );
    }
    this.ensureHostAllowed(row, targetHost);
    const payload = this.decryptPersonaPayload(row);
    const secret = payload.authSecret;

    const headers = this.headersForSecret(kind, row, secret);
    await this.markUsed(row.id);
    return {
      personaId: row.id,
      label: row.label,
      roleLabel: row.roleLabel ?? null,
      kind,
      username: row.username ?? null,
      targetHost,
      headers,
      appliedHeaderNames: Object.keys(headers),
      refreshProcedure: payload.refreshProcedure,
    };
  }

  async updatePersonaSecret(params: {
    orgId: string;
    scopeId: string;
    personaId: string;
    secret: string;
  }): Promise<void> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const row = await this.findById(params.orgId, params.scopeId, params.personaId);
    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Persona not found', { httpStatus: 404 });
    }
    const currentPayload = this.decryptPersonaPayload(row);
    const encrypted = this.encryptPersonaPayload({
      authSecret: params.secret,
      refreshProcedure: currentPayload.refreshProcedure,
    });
    const now = new Date();
    await this.db
      .update(scopeTestPersonas)
      .set({
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        refreshedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(scopeTestPersonas.id, params.personaId),
          eq(scopeTestPersonas.organizationId, params.orgId),
          eq(scopeTestPersonas.scopeId, params.scopeId),
        ),
      );
  }

  private async ensureScopeOwned(orgId: string, scopeId: string): Promise<void> {
    const [scope] = await this.db
      .select({ id: scopes.id })
      .from(scopes)
      .where(and(eq(scopes.id, scopeId), eq(scopes.organizationId, orgId)))
      .limit(1);

    if (!scope) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found', { httpStatus: 404 });
    }
  }

  private async resolveRow(orgId: string, scopeId: string, personaRef: string): Promise<ScopeTestPersonaRow> {
    const normalizedRef = personaRef.trim();
    if (!normalizedRef) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'persona is required', { httpStatus: 400 });
    }

    const row = UUIDISH.test(normalizedRef)
      ? await this.findById(orgId, scopeId, normalizedRef)
      : await this.findByLabel(orgId, scopeId, normalizedRef);

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Persona not found', { httpStatus: 404 });
    }
    return row;
  }

  private async findById(
    orgId: string,
    scopeId: string,
    personaId: string,
  ): Promise<ScopeTestPersonaRow | null> {
    const [row] = await this.db
      .select()
      .from(scopeTestPersonas)
      .where(
        and(
          eq(scopeTestPersonas.id, personaId),
          eq(scopeTestPersonas.organizationId, orgId),
          eq(scopeTestPersonas.scopeId, scopeId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async findByLabel(
    orgId: string,
    scopeId: string,
    label: string,
  ): Promise<ScopeTestPersonaRow | null> {
    const [row] = await this.db
      .select()
      .from(scopeTestPersonas)
      .where(
        and(
          eq(scopeTestPersonas.organizationId, orgId),
          eq(scopeTestPersonas.scopeId, scopeId),
          eq(scopeTestPersonas.label, label),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private extractTargetHost(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      return normalizeHost(url.hostname);
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'url must be a valid URL', { httpStatus: 400 });
    }
  }

  private ensureHostAllowed(row: ScopeTestPersonaRow, targetHost: string): void {
    const patterns = row.appliesToHosts ?? [];
    if (patterns.length === 0 || patterns.some((pattern) => personaHostMatchesPattern(targetHost, pattern))) {
      return;
    }

    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      `Persona "${row.label}" is not allowed for host ${targetHost}`,
      { httpStatus: 400 },
    );
  }

  private headersForSecret(
    kind: Exclude<TestPersonaKind, 'storage_state'>,
    row: ScopeTestPersonaRow,
    secret: string,
  ): Record<string, string> {
    switch (kind) {
      case 'custom_header': {
        const headerName = canonicalPersonaHeaderName(row.headerName ?? '');
        if (!headerName) {
          throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Custom header name is missing', {
            httpStatus: 400,
          });
        }
        return { [headerName]: secret };
      }
      case 'bearer_token':
        return { Authorization: `Bearer ${secret}` };
      case 'cookie_session':
        return { Cookie: secret };
      default:
        throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Unsupported persona kind', {
          httpStatus: 400,
        });
    }
  }

  private markUsed(personaId: string): Promise<void> {
    return this.db
      .update(scopeTestPersonas)
      .set({ lastUsedAt: new Date() })
      .where(eq(scopeTestPersonas.id, personaId))
      .then(() => undefined);
  }

  private extractSecret(input: ParsedPersonaInput): string {
    switch (input.kind) {
      case 'custom_header':
        return input.headerValue;
      case 'bearer_token':
        return input.token;
      case 'cookie_session':
        return input.cookieHeader;
      case 'storage_state':
        return input.storageStateJson;
      default:
        throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Unsupported persona kind', {
          httpStatus: 400,
        });
    }
  }

  private encryptPersonaPayload(input: {
    authSecret: string;
    refreshProcedure: Record<string, unknown>;
  }): EncryptedSecret {
    return this.encrypt(
      JSON.stringify({
        schema: 'persona_secret/v1',
        authSecret: input.authSecret,
        refreshProcedure: input.refreshProcedure,
      } satisfies EncryptedPersonaPayload),
    );
  }

  private decryptPersonaPayload(row: ScopeTestPersonaRow): EncryptedPersonaPayload {
    const decrypted = this.decrypt({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      authTag: row.secretAuthTag,
      keyVersion: row.keyVersion,
    });
    try {
      const parsed = JSON.parse(decrypted) as unknown;
      if (
        isRecord(parsed) &&
        parsed.schema === 'persona_secret/v1' &&
        typeof parsed.authSecret === 'string'
      ) {
        return {
          schema: 'persona_secret/v1',
          authSecret: parsed.authSecret,
          refreshProcedure: toRecord(parsed.refreshProcedure),
        };
      }
    } catch {
      // Backward-compatible read for any early rows that stored only the auth secret.
    }
    return {
      schema: 'persona_secret/v1',
      authSecret: decrypted,
      refreshProcedure: row.refreshProcedure ?? {},
    };
  }

  private encrypt(secret: string): EncryptedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: AUTO_KEY_VERSION,
    };
  }

  private decrypt(secret: EncryptedSecret): string {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getEncryptionKey(),
        Buffer.from(secret.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (error) {
      throw toAppError(error);
    }
  }

  private getEncryptionKey(): Buffer {
    const raw = process.env[this.encryptionKeyEnvName];
    if (!raw || !raw.trim()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `${this.encryptionKeyEnvName} is not configured`,
        { httpStatus: 503 },
      );
    }

    let key: Buffer;
    try {
      key = Buffer.from(raw.trim(), 'base64');
    } catch {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `${this.encryptionKeyEnvName} must be valid base64`,
        { httpStatus: 503 },
      );
    }

    if (key.length !== KEY_BYTES) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `${this.encryptionKeyEnvName} must decode to ${KEY_BYTES} bytes`,
        { httpStatus: 503 },
      );
    }

    return key;
  }
}
