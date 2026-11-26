import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  scopeAccessMaterials,
  scopes,
  type ScopeAccessMaterialRow,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';

export const ACCESS_MATERIAL_KINDS = [
  'login_credential',
  'custom_header',
  'bearer_token',
  'cookie_session',
] as const;

export type ScopeAccessMaterialKind = (typeof ACCESS_MATERIAL_KINDS)[number];

export interface ScopeAccessMaterialRecord {
  id: string;
  scopeId: string;
  kind: ScopeAccessMaterialKind;
  label: string;
  username: string | null;
  headerName: string | null;
  notes: string | null;
  appliesToHosts: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScopeAccessMaterialContextEntry {
  id: string;
  kind: ScopeAccessMaterialKind;
  label: string;
  username: string | null;
  headerName: string | null;
  notes: string | null;
  appliesToHosts: string[];
}

type HeaderLikeMaterialKind = 'custom_header' | 'bearer_token' | 'cookie_session';

type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

type ResolvedMaterialBase = {
  id: string;
  kind: ScopeAccessMaterialKind;
  label: string;
  username: string | null;
  headerName: string | null;
  notes: string | null;
  appliesToHosts: string[];
};

type ResolvedSecretMaterial = ResolvedMaterialBase & {
  secret: string;
};

const AUTO_KEY_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const UUIDISH = /^[0-9a-fA-F-]{36}$/;

const MaterialKindSchema = z.enum(ACCESS_MATERIAL_KINDS);

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

const HostPatternSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => value.length > 0, 'Host pattern cannot be empty')
  .refine((value) => isValidHostPattern(value), 'Host pattern must be an exact host or *.suffix wildcard');

const HostPatternsSchema = z
  .array(HostPatternSchema)
  .optional()
  .transform((value) => Array.from(new Set(value ?? [])));

const CreateAccessMaterialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login_credential'),
    label: normalizeOptionalText,
    username: normalizeRequiredText('username'),
    password: normalizeRequiredText('password'),
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('custom_header'),
    label: normalizeOptionalText,
    headerName: normalizeRequiredText('headerName'),
    headerValue: normalizeRequiredText('headerValue'),
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('bearer_token'),
    label: normalizeOptionalText,
    token: normalizeRequiredText('token'),
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('cookie_session'),
    label: normalizeOptionalText,
    cookieHeader: normalizeRequiredText('cookieHeader'),
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
]);

const UpdateAccessMaterialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login_credential'),
    label: normalizeOptionalText,
    username: normalizeOptionalText,
    password: normalizeOptionalText,
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('custom_header'),
    label: normalizeOptionalText,
    headerName: normalizeOptionalText,
    headerValue: normalizeOptionalText,
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('bearer_token'),
    label: normalizeOptionalText,
    token: normalizeOptionalText,
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
  z.object({
    kind: z.literal('cookie_session'),
    label: normalizeOptionalText,
    cookieHeader: normalizeOptionalText,
    notes: normalizeOptionalNullableText,
    appliesToHosts: HostPatternsSchema,
  }),
]);

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

const canonicalHeaderName = (value: string): string =>
  value
    .trim()
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('-');

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

export const hostMatchesPattern = (host: string, pattern: string): boolean => {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
};

const normalizeMaterialRecord = (row: ScopeAccessMaterialRow): ScopeAccessMaterialRecord => ({
  id: row.id,
  scopeId: row.scopeId,
  kind: MaterialKindSchema.parse(row.kind),
  label: row.label,
  username: row.username ?? null,
  headerName: row.headerName ?? null,
  notes: row.notes ?? null,
  appliesToHosts: row.appliesToHosts ?? [],
  lastUsedAt: row.lastUsedAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class ScopeAccessMaterialService {
  private readonly encryptionKeyEnvName = 'ACCESS_MATERIALS_ENCRYPTION_KEY';

  constructor(private readonly db: DatabaseClient) {}

  async listForScope(orgId: string, scopeId: string): Promise<ScopeAccessMaterialRecord[]> {
    await this.ensureScopeOwned(orgId, scopeId);

    const rows = await this.db
      .select()
      .from(scopeAccessMaterials)
      .where(and(eq(scopeAccessMaterials.organizationId, orgId), eq(scopeAccessMaterials.scopeId, scopeId)))
      .orderBy(scopeAccessMaterials.label, scopeAccessMaterials.createdAt);

    return rows.map(normalizeMaterialRecord);
  }

  async createForScope(params: {
    orgId: string;
    scopeId: string;
    actorUserId: string | null;
    input: unknown;
  }): Promise<ScopeAccessMaterialRecord> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const parsed = CreateAccessMaterialSchema.parse(params.input);
    const now = new Date();
    const encrypted = this.encrypt(this.extractSecret(parsed));

    const [row] = await this.db
      .insert(scopeAccessMaterials)
      .values({
        organizationId: params.orgId,
        scopeId: params.scopeId,
        kind: parsed.kind,
        label: this.deriveLabel(parsed),
        username: parsed.kind === 'login_credential' ? parsed.username : null,
        headerName: parsed.kind === 'custom_header' ? canonicalHeaderName(parsed.headerName) : null,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        notes: parsed.notes ?? null,
        appliesToHosts: parsed.appliesToHosts ?? [],
        createdByUserId: params.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return normalizeMaterialRecord(row);
  }

  async updateForScope(params: {
    orgId: string;
    scopeId: string;
    materialId: string;
    actorUserId: string | null;
    input: unknown;
  }): Promise<ScopeAccessMaterialRecord> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const parsed = UpdateAccessMaterialSchema.parse(params.input);
    const current = await this.getById(params.orgId, params.scopeId, params.materialId);
    if (current.kind !== parsed.kind) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Access material kind cannot be changed',
        { httpStatus: 400 },
      );
    }

    const secret = this.extractOptionalSecret(parsed);
    const encrypted = secret ? this.encrypt(secret) : null;
    const now = new Date();

    const [row] = await this.db
      .update(scopeAccessMaterials)
      .set({
        label: this.deriveUpdatedLabel(parsed, current),
        username:
          parsed.kind === 'login_credential'
            ? (parsed.username ?? current.username)
            : null,
        headerName:
          parsed.kind === 'custom_header'
            ? canonicalHeaderName(parsed.headerName ?? current.headerName ?? '')
            : null,
        notes: parsed.notes ?? current.notes,
        appliesToHosts: parsed.appliesToHosts ?? current.appliesToHosts,
        ...(encrypted
          ? {
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
              keyVersion: encrypted.keyVersion,
            }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(scopeAccessMaterials.id, params.materialId), eq(scopeAccessMaterials.scopeId, params.scopeId)))
      .returning();

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Access material not found', { httpStatus: 404 });
    }

    return normalizeMaterialRecord(row);
  }

  async deleteForScope(params: { orgId: string; scopeId: string; materialId: string }): Promise<void> {
    await this.ensureScopeOwned(params.orgId, params.scopeId);
    const current = await this.getById(params.orgId, params.scopeId, params.materialId);
    await this.db.delete(scopeAccessMaterials).where(eq(scopeAccessMaterials.id, current.id));
  }

  async listScopeContextMaterials(scopeId: string): Promise<ScopeAccessMaterialContextEntry[]> {
    const rows = await this.db
      .select({
        id: scopeAccessMaterials.id,
        kind: scopeAccessMaterials.kind,
        label: scopeAccessMaterials.label,
        username: scopeAccessMaterials.username,
        headerName: scopeAccessMaterials.headerName,
        notes: scopeAccessMaterials.notes,
        appliesToHosts: scopeAccessMaterials.appliesToHosts,
      })
      .from(scopeAccessMaterials)
      .where(eq(scopeAccessMaterials.scopeId, scopeId))
      .orderBy(scopeAccessMaterials.kind, scopeAccessMaterials.label);

    return rows.map((row) => ({
      id: row.id,
      kind: MaterialKindSchema.parse(row.kind),
      label: row.label,
      username: row.username ?? null,
      headerName: row.headerName ?? null,
      notes: row.notes ?? null,
      appliesToHosts: row.appliesToHosts ?? [],
    }));
  }

  async getAccessMaterialCountMap(scopeIds: readonly string[]): Promise<Map<string, number>> {
    const normalizedScopeIds = scopeIds.filter(
      (scopeId): scopeId is string => typeof scopeId === 'string' && scopeId.trim().length > 0,
    );
    if (normalizedScopeIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        scopeId: scopeAccessMaterials.scopeId,
        count: sql<number>`count(*)::int`,
      })
      .from(scopeAccessMaterials)
      .where(inArray(scopeAccessMaterials.scopeId, [...normalizedScopeIds]))
      .groupBy(scopeAccessMaterials.scopeId);

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.scopeId, Number(row.count ?? 0));
    }
    return counts;
  }

  async resolveHeaderLikeMaterial(params: {
    orgId: string;
    scopeId: string;
    material: string;
    url: string;
  }): Promise<{
    materialId: string;
    kind: HeaderLikeMaterialKind;
    label: string;
    targetHost: string;
    headers: Record<string, string>;
    appliedHeaderNames: string[];
  }> {
    const targetHost = this.extractTargetHost(params.url);
    const material = await this.resolveSecretMaterial(params.orgId, params.scopeId, params.material, [
      'custom_header',
      'bearer_token',
      'cookie_session',
    ]);
    this.ensureHostAllowed(material, targetHost);

    let headers: Record<string, string>;
    let appliedHeaderNames: string[];
    switch (material.kind) {
      case 'custom_header': {
        const headerName = canonicalHeaderName(material.headerName ?? '');
        if (!headerName) {
          throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Custom header name is missing', {
            httpStatus: 400,
          });
        }
        headers = { [headerName]: material.secret };
        appliedHeaderNames = [headerName];
        break;
      }
      case 'bearer_token':
        headers = { Authorization: `Bearer ${material.secret}` };
        appliedHeaderNames = ['Authorization'];
        break;
      case 'cookie_session':
        headers = { Cookie: material.secret };
        appliedHeaderNames = ['Cookie'];
        break;
      default:
        throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Unsupported access material kind', {
          httpStatus: 400,
        });
    }

    return {
      materialId: material.id,
      kind: material.kind as HeaderLikeMaterialKind,
      label: material.label,
      targetHost,
      headers,
      appliedHeaderNames,
    };
  }

  async resolveLoginCredential(params: {
    orgId: string;
    scopeId: string;
    material: string;
    url?: string;
  }): Promise<{
    materialId: string;
    kind: 'login_credential';
    label: string;
    username: string;
    password: string;
    targetHost: string | null;
  }> {
    const material = await this.resolveSecretMaterial(params.orgId, params.scopeId, params.material, ['login_credential']);
    if (!material.username) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Login credential username is missing', {
        httpStatus: 400,
      });
    }
    const targetHost = params.url ? this.extractTargetHost(params.url) : null;
    if (targetHost) {
      this.ensureHostAllowed(material, targetHost);
    }

    return {
      materialId: material.id,
      kind: 'login_credential',
      label: material.label,
      username: material.username,
      password: material.secret,
      targetHost,
    };
  }

  async touchLastUsed(materialId: string): Promise<void> {
    await this.markUsed(materialId);
  }

  /**
   * Decrypt and return the raw secret for a material by id.
   * Used only by writeScopeCredentialsFile at run start — no host enforcement.
   */
  async resolveSecretById(orgId: string, scopeId: string, materialId: string): Promise<string> {
    const row = await this.getById(orgId, scopeId, materialId);
    return this.decrypt({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      authTag: row.secretAuthTag,
      keyVersion: row.keyVersion,
    });
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

  private async getById(orgId: string, scopeId: string, materialId: string): Promise<ScopeAccessMaterialRow> {
    const [row] = await this.db
      .select()
      .from(scopeAccessMaterials)
      .where(
        and(
          eq(scopeAccessMaterials.id, materialId),
          eq(scopeAccessMaterials.organizationId, orgId),
          eq(scopeAccessMaterials.scopeId, scopeId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Access material not found', { httpStatus: 404 });
    }

    return row;
  }

  private async resolveSecretMaterial(
    orgId: string,
    scopeId: string,
    materialRef: string,
    allowedKinds: readonly ScopeAccessMaterialKind[],
  ): Promise<ResolvedSecretMaterial> {
    const normalizedRef = materialRef.trim();
    if (!normalizedRef) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'material is required', { httpStatus: 400 });
    }

    let rows: ScopeAccessMaterialRow[];
    if (UUIDISH.test(normalizedRef)) {
      const row = await this.getById(orgId, scopeId, normalizedRef);
      rows = [row];
    } else {
      rows = await this.db
        .select()
        .from(scopeAccessMaterials)
        .where(
          and(
            eq(scopeAccessMaterials.organizationId, orgId),
            eq(scopeAccessMaterials.scopeId, scopeId),
            eq(scopeAccessMaterials.label, normalizedRef),
          ),
        );
      if (rows.length === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Access material not found', { httpStatus: 404 });
      }
      if (rows.length > 1) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          `Multiple scope access materials match label "${normalizedRef}". Use the material id instead.`,
          { httpStatus: 400 },
        );
      }
    }

    const row = rows[0];
    const kind = MaterialKindSchema.parse(row.kind);
    if (!allowedKinds.includes(kind)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `Access material "${row.label}" is not compatible with this tool`,
        { httpStatus: 400 },
      );
    }

    return {
      id: row.id,
      kind,
      label: row.label,
      username: row.username ?? null,
      headerName: row.headerName ?? null,
      notes: row.notes ?? null,
      appliesToHosts: row.appliesToHosts ?? [],
      secret: this.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
        keyVersion: row.keyVersion,
      }),
    };
  }

  private extractTargetHost(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      return normalizeHost(url.hostname);
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'url must be a valid URL', { httpStatus: 400 });
    }
  }

  private ensureHostAllowed(material: ResolvedMaterialBase, targetHost: string): void {
    if (!material.appliesToHosts || material.appliesToHosts.length === 0) {
      return;
    }

    if (material.appliesToHosts.some((pattern) => hostMatchesPattern(targetHost, pattern))) {
      return;
    }

    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      `Access material "${material.label}" is not allowed for host ${targetHost}`,
      { httpStatus: 400 },
    );
  }

  private markUsed(materialId: string): Promise<void> {
    return this.db
      .update(scopeAccessMaterials)
      .set({ lastUsedAt: new Date() })
      .where(eq(scopeAccessMaterials.id, materialId))
      .then(() => undefined);
  }

  private extractSecret(input: z.infer<typeof CreateAccessMaterialSchema>): string {
    switch (input.kind) {
      case 'login_credential':
        return input.password;
      case 'custom_header':
        return input.headerValue;
      case 'bearer_token':
        return input.token;
      case 'cookie_session':
        return input.cookieHeader;
      default:
        throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Unsupported access material kind', {
          httpStatus: 400,
        });
    }
  }

  private extractOptionalSecret(input: z.infer<typeof UpdateAccessMaterialSchema>): string | null {
    switch (input.kind) {
      case 'login_credential':
        return input.password ?? null;
      case 'custom_header':
        return input.headerValue ?? null;
      case 'bearer_token':
        return input.token ?? null;
      case 'cookie_session':
        return input.cookieHeader ?? null;
      default:
        return null;
    }
  }

  private deriveLabel(input: z.infer<typeof CreateAccessMaterialSchema>): string {
    const explicit = input.label?.trim();
    if (explicit) return explicit;

    switch (input.kind) {
      case 'login_credential':
        return input.username;
      case 'custom_header':
        return canonicalHeaderName(input.headerName);
      case 'bearer_token':
        return 'Bearer token';
      case 'cookie_session':
        return 'Cookie session';
      default:
        return 'Access material';
    }
  }

  private deriveUpdatedLabel(
    input: z.infer<typeof UpdateAccessMaterialSchema>,
    current: ScopeAccessMaterialRow,
  ): string {
    const explicit = input.label?.trim();
    if (explicit) {
      return explicit;
    }

    switch (input.kind) {
      case 'login_credential':
        return input.username?.trim() || current.username || current.label;
      case 'custom_header':
        return input.headerName?.trim()
          ? canonicalHeaderName(input.headerName)
          : current.headerName || current.label;
      case 'bearer_token':
      case 'cookie_session':
      default:
        return current.label;
    }
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
