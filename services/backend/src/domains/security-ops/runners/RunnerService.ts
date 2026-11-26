import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  runnerScopeAssignments,
  runners,
  runnerTokens,
  runs,
  scopes,
  type RunRow,
  type RunnerRow,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { logger } from '@/shared/logger';
import {
  runnerConnectionRegistry,
  type RunnerConnectionRegistry,
} from './RunnerConnectionRegistry';
import {
  DEFAULT_EXECUTION_TARGET,
  type ExecutionTarget,
} from '@/domains/security-ops/runs/executionTargets';

export type RunnerType = 'cloud' | 'private';
export type RunnerStatus = 'online' | 'busy' | 'offline' | 'quarantined';

export interface RunnerSummary extends RunnerRow {
  assignedScopes: string[];
}

export interface RunnerDetail extends RunnerSummary {
  scopes: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  recentRuns: RunRow[];
}

export interface RunnerAuthContext {
  runnerId: string;
  organizationId: string;
  tokenId: string;
  runnerType: RunnerType;
}

const DEFAULT_RUNNER_API_URL = 'http://127.0.0.1:3001';
// The sandbox image `docker compose up` builds; it exists only where it was built, so it is never pulled.
const DEFAULT_RUNNER_IMAGE = 'null-ai-sandbox:local';
const DEFAULT_LOCAL_RUNNER_IMAGE = 'nullsquare-runner-local:latest';
const TOKEN_ROTATION_GRACE_MS = 30_000;
const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const RUNNER_PROTOCOL_VERSION = 2;
const REQUIRED_RUNNER_CAPABILITIES = ['session_init', 'session_destroy', 'file_stat', 'browser_action'] as const;

const isWindowsAbsolutePath = (value: string): boolean => /^[a-z]:[\\/]/i.test(value);

const joinHostPath = (base: string, ...parts: string[]): string => {
  const pathApi = isWindowsAbsolutePath(base) ? path.win32 : path.posix;
  return pathApi.join(base, ...parts);
};

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const createRunnerToken = (): { token: string; tokenHash: string; prefix: string } => {
  const token = `ns_live_${randomBytes(20).toString('hex')}`;
  return {
    token,
    tokenHash: hashToken(token),
    prefix: token.slice(0, 12),
  };
};

const resolveRunnerImage = (): string => {
  const configured = process.env.RUNNER_IMAGE?.trim();
  if (configured) return configured;
  return DEFAULT_RUNNER_IMAGE;
};

const resolveInstallTarget = (
  apiUrl: string,
): { apiUrl: string; useHostNetwork: boolean; addHostGateway: boolean; isLocalApi: boolean } => {
  try {
    const parsed = new URL(apiUrl);
    const host = parsed.hostname.toLowerCase();
    if (!LOCAL_API_HOSTS.has(host)) {
      return { apiUrl, useHostNetwork: true, addHostGateway: false, isLocalApi: false };
    }

    // Containers cannot reach host localhost in bridge mode; route through host.docker.internal.
    parsed.hostname = 'host.docker.internal';
    return {
      apiUrl: parsed.toString().replace(/\/$/, ''),
      useHostNetwork: false,
      addHostGateway: true,
      isLocalApi: true,
    };
  } catch {
    return { apiUrl, useHostNetwork: true, addHostGateway: false, isLocalApi: false };
  }
};

const resolveConfiguredLocalRunnerBuildContext = (): string | null => {
  const configured = process.env.RUNNER_LOCAL_BUILD_CONTEXT?.trim();
  return configured && configured.length > 0 ? configured : null;
};

const resolveLocalRunnerBuildContext = (): string | null => {
  const candidates = [
    process.cwd(),
    __dirname,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(current, 'services', 'sandbox', 'Dockerfile'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return null;
};

const shouldForceRemoteRunnerImage = (): boolean => process.env.RUNNER_FORCE_REMOTE_IMAGE === '1';

const shouldUseLocalRunnerBuild = (isLocalApi: boolean): boolean => {
  if (shouldForceRemoteRunnerImage()) {
    return false;
  }

  if (isLocalApi) {
    return true;
  }

  if (process.env.RUNNER_IMAGE?.trim()) {
    return false;
  }

  if (resolveConfiguredLocalRunnerBuildContext()) {
    return true;
  }

  return process.env.NODE_ENV !== 'production';
};

const runGitCommand = (args: string[], cwd?: string): string | null => {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};

const normalizeGitRemoteUrl = (value: string | null): string | null => {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }

  let normalized = raw;
  if (normalized.startsWith('git@github.com:')) {
    normalized = `https://github.com/${normalized.slice('git@github.com:'.length)}`;
  }
  normalized = normalized.replace(/\.{2,}git$/i, '.git');
  if (!/\.git$/i.test(normalized) && /^https:\/\/github\.com\/.+$/i.test(normalized)) {
    normalized = `${normalized}.git`;
  }

  if (!/^https:\/\/github\.com\/.+\.git$/i.test(normalized)) {
    return null;
  }

  return normalized;
};

const resolveGitBuildSource = (): { repoUrl: string; ref: string } | null => {
  const envRepoUrl = normalizeGitRemoteUrl(process.env.RUNNER_SOURCE_REPO_URL ?? null);
  const envRef = process.env.RUNNER_SOURCE_REF?.trim();
  if (envRepoUrl && envRef) {
    return { repoUrl: envRepoUrl, ref: envRef };
  }

  const repoRoot = resolveLocalRunnerBuildContext() ?? process.cwd();
  const detectedRepoUrl = normalizeGitRemoteUrl(runGitCommand(['remote', 'get-url', 'origin'], repoRoot));
  const detectedRef = runGitCommand(['rev-parse', 'HEAD'], repoRoot);
  if (!detectedRepoUrl || !detectedRef) {
    return null;
  }

  return { repoUrl: detectedRepoUrl, ref: detectedRef };
};

const sanitizeDockerName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'runner';
};

const quoteShellArg = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

const mergeRunnerMetadata = (
  existing: Record<string, string> | null | undefined,
  updates: Record<string, string | null | undefined>,
): Record<string, string> => {
  const next: Record<string, string> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value.length === 0) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  return next;
};

const buildInstallCommand = (runnerId: string, token: string, apiUrl: string): string => {
  const target = resolveInstallTarget(apiUrl);
  const suffix = sanitizeDockerName(runnerId.slice(0, 8));
  const containerName = `nullsquare-runner-${suffix}`;
  const volumeName = `nullsquare-runner-ws-${suffix}`;
  const runParts = [
    'docker run -d',
    '--pull always',
    `--name ${containerName}`,
    `-v ${volumeName}:/workspace`,
    '--restart unless-stopped',
    target.useHostNetwork ? '--network host' : null,
    target.addHostGateway ? '--add-host=host.docker.internal:host-gateway' : null,
    `-e TOKEN=${token}`,
    `-e API_URL=${target.apiUrl}`,
    `-e RUNNER_PROTOCOL_VERSION=${RUNNER_PROTOCOL_VERSION}`,
  ].filter(Boolean);

  if (shouldUseLocalRunnerBuild(target.isLocalApi)) {
    const explicitBuildContext = resolveConfiguredLocalRunnerBuildContext();
    if (explicitBuildContext) {
      const dockerfilePath = joinHostPath(explicitBuildContext, 'services', 'sandbox', 'Dockerfile');
      return [
        `docker build -f ${quoteShellArg(dockerfilePath)} -t ${DEFAULT_LOCAL_RUNNER_IMAGE} ${quoteShellArg(explicitBuildContext)}`,
        `docker rm -f ${containerName}`,
        `docker volume create ${volumeName}`,
        [...runParts.filter((part) => part !== '--pull always'), DEFAULT_LOCAL_RUNNER_IMAGE].join(' '),
      ].join('; ');
    }

    const gitSource = resolveGitBuildSource();
    if (gitSource) {
      return [
        `docker build --pull -f "services/sandbox/Dockerfile" -t ${DEFAULT_LOCAL_RUNNER_IMAGE} ${quoteShellArg(`${gitSource.repoUrl}#${gitSource.ref}`)}`,
        `docker rm -f ${containerName}`,
        `docker volume create ${volumeName}`,
        [...runParts.filter((part) => part !== '--pull always'), DEFAULT_LOCAL_RUNNER_IMAGE].join(' '),
      ].join('; ');
    }

    const buildContext = resolveLocalRunnerBuildContext();
    if (buildContext && !target.isLocalApi) {
      const dockerfilePath = path.join(buildContext, 'services', 'sandbox', 'Dockerfile');
      return [
        `docker build -f ${quoteShellArg(dockerfilePath)} -t ${DEFAULT_LOCAL_RUNNER_IMAGE} ${quoteShellArg(buildContext)}`,
        `docker rm -f ${containerName}`,
        `docker volume create ${volumeName}`,
        [...runParts.filter((part) => part !== '--pull always'), DEFAULT_LOCAL_RUNNER_IMAGE].join(' '),
      ].join('; ');
    }
  }

  const image = resolveRunnerImage();
  return [
    `docker rm -f ${containerName}`,
    `docker volume create ${volumeName}`,
    [...(image === DEFAULT_RUNNER_IMAGE ? runParts.filter((part) => part !== '--pull always') : runParts), image].join(' '),
  ].join('; ');
};

const normalizeRunnerType = (value: string | undefined): RunnerType => {
  if (value === 'cloud') return 'cloud';
  return 'private';
};

const parseCsv = (value: string | undefined | null): string[] =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseRunnerProtocolVersion = (runner: Pick<RunnerRow, 'metadata'>): number => {
  const raw = runner.metadata?.runnerProtocolVersion ?? runner.metadata?.protocolVersion;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseRunnerCapabilities = (runner: Pick<RunnerRow, 'metadata'>): string[] =>
  parseCsv(runner.metadata?.capabilities);

export const runnerCommandInternals = {
  buildInstallCommand,
  joinHostPath,
  normalizeGitRemoteUrl,
  resolveConfiguredLocalRunnerBuildContext,
};

export class RunnerService {
  private readonly log = logger.child({ scope: 'RunnerService' });

  constructor(
    private readonly db: DatabaseClient,
    private readonly connectionRegistry: RunnerConnectionRegistry = runnerConnectionRegistry,
  ) {}

  async deployRunner(
    orgId: string,
    params: {
      name: string;
      type?: string;
      platform?: string;
      architecture?: string;
      apiUrl?: string;
    },
  ): Promise<{ runner: RunnerSummary; token?: string; installCommand?: string }> {
    const name = params.name?.trim();
    if (!name) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'Runner name is required');
    }

    const type = normalizeRunnerType(params.type);
    if (type !== 'private') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Shared cloud runners are platform-managed and cannot be created through an organization endpoint.',
      );
    }
    const status: RunnerStatus = 'offline';

    const [runner] = await this.db
      .insert(runners)
      .values({
        organizationId: orgId,
        name,
        type,
        ownership: 'organization',
        schedulingMode: 'hold',
        status,
        platform: params.platform ?? 'docker',
        architecture: params.architecture ?? null,
        metadata: {
          healthState: 'awaiting_connect',
          healthReason: 'awaiting_connect',
          healthMessage: 'Awaiting first runner connection. Copy the deployment command and start the container.',
          requiredRunnerProtocolVersion: String(RUNNER_PROTOCOL_VERSION),
          requiredRunnerCapabilities: REQUIRED_RUNNER_CAPABILITIES.join(','),
        },
      })
      .returning();

    if (!runner) {
      throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create runner');
    }

    const { token, tokenHash, prefix } = createRunnerToken();
    await this.db.insert(runnerTokens).values({
      runnerId: runner.id,
      tokenHash,
      prefix,
      isActive: true,
    });

    const apiUrl = params.apiUrl?.trim() || DEFAULT_RUNNER_API_URL;
    return {
      runner: { ...runner, assignedScopes: [] },
      token,
      installCommand: buildInstallCommand(runner.id, token, apiUrl),
    };
  }

  async listRunners(
    orgId: string,
    filters?: { status?: string; type?: string },
  ): Promise<RunnerSummary[]> {
    const conditions = [eq(runners.organizationId, orgId)];
    if (filters?.status) {
      conditions.push(eq(runners.status, filters.status));
    }
    if (filters?.type) {
      conditions.push(eq(runners.type, filters.type));
    }

    const rows = await this.db
      .select()
      .from(runners)
      .where(and(...conditions))
      .orderBy(desc(runners.updatedAt), desc(runners.createdAt));

    if (rows.length === 0) return [];

    const runnerIds = rows.map((row) => row.id);
    const assignmentRows = await this.db
      .select({
        runnerId: runnerScopeAssignments.runnerId,
        scopeId: runnerScopeAssignments.scopeId,
      })
      .from(runnerScopeAssignments)
      .where(inArray(runnerScopeAssignments.runnerId, runnerIds));

    const scopeMap = new Map<string, string[]>();
    for (const assignment of assignmentRows) {
      const list = scopeMap.get(assignment.runnerId) ?? [];
      list.push(assignment.scopeId);
      scopeMap.set(assignment.runnerId, list);
    }

    return rows.map((row) => ({
      ...row,
      assignedScopes: scopeMap.get(row.id) ?? [],
    }));
  }

  async getRunner(orgId: string, runnerId: string): Promise<RunnerDetail> {
    const [runner] = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.organizationId, orgId)))
      .limit(1);

    if (!runner) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Runner not found');
    }

    const assignments = await this.db
      .select({
        id: scopes.id,
        name: scopes.name,
        status: scopes.status,
      })
      .from(runnerScopeAssignments)
      .innerJoin(scopes, eq(scopes.id, runnerScopeAssignments.scopeId))
      .where(eq(runnerScopeAssignments.runnerId, runner.id))
      .orderBy(asc(scopes.name));

    const recentRuns = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.organizationId, orgId), eq(runs.runnerId, runner.id)))
      .orderBy(desc(runs.createdAt))
      .limit(10);

    return {
      ...runner,
      assignedScopes: assignments.map((scope) => scope.id),
      scopes: assignments,
      recentRuns,
    };
  }

  async deleteRunner(orgId: string, runnerId: string): Promise<void> {
    const deleted = await this.db
      .delete(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.organizationId, orgId)))
      .returning({ id: runners.id });

    if (deleted.length === 0) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Runner not found');
    }
  }

  async updateScopeAssignments(
    orgId: string,
    runnerId: string,
    scopeIds: string[],
  ): Promise<RunnerDetail> {
    await this.getRunner(orgId, runnerId);

    const uniqueScopeIds = Array.from(new Set(scopeIds.filter(Boolean)));
    if (uniqueScopeIds.length > 0) {
      const validScopes = await this.db
        .select({ id: scopes.id })
        .from(scopes)
        .where(and(eq(scopes.organizationId, orgId), inArray(scopes.id, uniqueScopeIds)));

      if (validScopes.length !== uniqueScopeIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'One or more scopeIds are invalid');
      }

      const conflictingAssignments = await this.db
        .select({
          scopeId: runnerScopeAssignments.scopeId,
          runnerId: runnerScopeAssignments.runnerId,
        })
        .from(runnerScopeAssignments)
        .where(
          and(
            inArray(runnerScopeAssignments.scopeId, uniqueScopeIds),
            ne(runnerScopeAssignments.runnerId, runnerId),
          ),
        );

      if (conflictingAssignments.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'Each scope can only be attached to one private runner.',
          {
            httpStatus: 409,
            context: {
              reason: 'SCOPE_ALREADY_ASSIGNED',
              scopeIds: conflictingAssignments.map((assignment) => assignment.scopeId),
            },
          },
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(runnerScopeAssignments)
        .where(eq(runnerScopeAssignments.runnerId, runnerId));

      if (uniqueScopeIds.length > 0) {
        await tx.insert(runnerScopeAssignments).values(
          uniqueScopeIds.map((scopeId) => ({
            runnerId,
            scopeId,
          })),
        );
      }
    });

    return this.getRunner(orgId, runnerId);
  }

  async rotateToken(
    orgId: string,
    runnerId: string,
    apiUrl?: string,
  ): Promise<{ token: string; installCommand: string }> {
    const [runner] = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.organizationId, orgId)))
      .limit(1);

    if (!runner) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Runner not found');
    }
    if (runner.type !== 'private') {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Only private runners use auth tokens');
    }

    const { token, tokenHash, prefix } = createRunnerToken();
    const gracePeriodUntil = new Date(Date.now() + TOKEN_ROTATION_GRACE_MS);

    await this.db.transaction(async (tx) => {
      await tx
        .update(runnerTokens)
        .set({
          isActive: false,
          gracePeriodUntil,
        })
        .where(and(eq(runnerTokens.runnerId, runner.id), eq(runnerTokens.isActive, true)));

      await tx.insert(runnerTokens).values({
        runnerId: runner.id,
        tokenHash,
        prefix,
        isActive: true,
        gracePeriodUntil: null,
      });
    });

    const effectiveApiUrl = apiUrl?.trim() || DEFAULT_RUNNER_API_URL;
    const metadata = mergeRunnerMetadata(runner.metadata, {
      healthState: 'awaiting_redeploy',
      healthReason: 'awaiting_redeploy',
      healthMessage: 'Token rotated. Re-run the deployment command to reconnect this runner.',
      lastConnectionErrorCode: null,
      lastConnectionErrorAt: null,
    });
    await this.db
      .update(runners)
      .set({
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, runner.id));

    return {
      token,
      installCommand: buildInstallCommand(runner.id, token, effectiveApiUrl),
    };
  }

  async authenticateToken(token: string): Promise<RunnerAuthContext> {
    const tokenValue = token.trim();
    if (!tokenValue) {
      throw new AppError(ERROR_CODES.AUTH_INVALID_API_KEY, 'Runner token is required');
    }

    const now = new Date();
    const [row] = await this.db
      .select({
        tokenId: runnerTokens.id,
        runnerId: runners.id,
        organizationId: runners.organizationId,
        runnerType: runners.type,
        runnerOwnership: runners.ownership,
      })
      .from(runnerTokens)
      .innerJoin(runners, eq(runners.id, runnerTokens.runnerId))
      .where(
        and(
          eq(runnerTokens.tokenHash, hashToken(tokenValue)),
          or(eq(runnerTokens.isActive, true), sql`${runnerTokens.gracePeriodUntil} > ${now}`),
          or(isNull(runnerTokens.expiresAt), sql`${runnerTokens.expiresAt} > ${now}`),
        ),
      )
      .limit(1);

    if (!row || !row.organizationId || row.runnerOwnership !== 'organization' || row.runnerType !== 'private') {
      throw new AppError(ERROR_CODES.AUTH_INVALID_API_KEY, 'Invalid runner token');
    }

    await this.db
      .update(runnerTokens)
      .set({ lastUsedAt: now })
      .where(eq(runnerTokens.id, row.tokenId));

    return {
      tokenId: row.tokenId,
      runnerId: row.runnerId,
      organizationId: row.organizationId,
      runnerType: normalizeRunnerType(row.runnerType),
    };
  }

  async markOnline(
    auth: RunnerAuthContext,
    payload?: {
      version?: string;
      ipAddress?: string | null;
      metadata?: Record<string, string>;
    },
  ): Promise<void> {
    const now = new Date();
    const [existing] = await this.db
      .select({ metadata: runners.metadata })
      .from(runners)
      .where(and(eq(runners.id, auth.runnerId), eq(runners.organizationId, auth.organizationId)))
      .limit(1);

    const metadata = mergeRunnerMetadata(existing?.metadata, {
      ...(payload?.metadata ?? {}),
      healthState: 'connected',
      healthReason: 'connected',
      healthMessage: 'Runner connected to control plane.',
      lastConnectionErrorCode: null,
      lastConnectionErrorAt: null,
      requiredRunnerProtocolVersion: String(RUNNER_PROTOCOL_VERSION),
      requiredRunnerCapabilities: REQUIRED_RUNNER_CAPABILITIES.join(','),
    });

    const [updated] = await this.db
      .update(runners)
      .set({
        status: 'online',
        version: payload?.version?.trim() || null,
        ipAddress: payload?.ipAddress ?? null,
        metadata,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(and(eq(runners.id, auth.runnerId), eq(runners.organizationId, auth.organizationId)))
      .returning({ id: runners.id });

    if (!updated) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Runner not found');
    }
  }

  async markOffline(
    runnerId: string,
    health?: {
      state?: string;
      reason?: string;
      message?: string;
    },
  ): Promise<void> {
    const now = new Date();
    const [existing] = await this.db
      .select({ metadata: runners.metadata })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1);
    const metadata = mergeRunnerMetadata(existing?.metadata, {
      healthState: health?.state ?? 'offline',
      healthReason: health?.reason ?? 'runner_disconnected',
      healthMessage: health?.message ?? 'Runner disconnected from control plane.',
      lastConnectionErrorCode: health?.reason ?? 'runner_disconnected',
      lastConnectionErrorAt: now.toISOString(),
    });
    await this.db
      .update(runners)
      .set({
        status: 'offline',
        metadata,
        updatedAt: now,
      })
      .where(eq(runners.id, runnerId));
  }

  async markConnectionRejected(
    auth: RunnerAuthContext,
    details: {
      reason: string;
      message: string;
      protocolVersion?: number;
      capabilities?: string[];
    },
  ): Promise<void> {
    const now = new Date();
    const [existing] = await this.db
      .select({ metadata: runners.metadata })
      .from(runners)
      .where(and(eq(runners.id, auth.runnerId), eq(runners.organizationId, auth.organizationId)))
      .limit(1);

    const metadata = mergeRunnerMetadata(existing?.metadata, {
      healthState: details.reason,
      healthReason: details.reason,
      healthMessage: details.message,
      lastConnectionErrorCode: details.reason,
      lastConnectionErrorAt: now.toISOString(),
      runnerProtocolVersion:
        details.protocolVersion !== undefined ? String(details.protocolVersion) : existing?.metadata?.runnerProtocolVersion,
      capabilities:
        details.capabilities && details.capabilities.length > 0
          ? details.capabilities.join(',')
          : existing?.metadata?.capabilities,
      requiredRunnerProtocolVersion: String(RUNNER_PROTOCOL_VERSION),
      requiredRunnerCapabilities: REQUIRED_RUNNER_CAPABILITIES.join(','),
    });

    await this.db
      .update(runners)
      .set({
        status: 'offline',
        metadata,
        updatedAt: now,
      })
      .where(and(eq(runners.id, auth.runnerId), eq(runners.organizationId, auth.organizationId)));
  }

  async touchHeartbeat(runnerId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(runners)
      .set({
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(runners.id, runnerId));
  }

  isRunnerConnected(runnerId: string): boolean {
    return this.connectionRegistry.isConnected(runnerId);
  }

  getRequiredRunnerProtocolVersion(): number {
    return RUNNER_PROTOCOL_VERSION;
  }

  getRequiredRunnerCapabilities(): string[] {
    return Array.from(REQUIRED_RUNNER_CAPABILITIES);
  }

  getRunnerCapabilities(runner: Pick<RunnerRow, 'metadata'>): string[] {
    return parseRunnerCapabilities(runner);
  }

  getRunnerProtocolVersion(runner: Pick<RunnerRow, 'metadata'>): number {
    return parseRunnerProtocolVersion(runner);
  }

  getRunnerCompatibilityIssues(runner: Pick<RunnerRow, 'metadata'>): string[] {
    const issues: string[] = [];
    const protocolVersion = this.getRunnerProtocolVersion(runner);
    if (protocolVersion < RUNNER_PROTOCOL_VERSION) {
      issues.push(`protocol_version:${protocolVersion}`);
    }

    const capabilities = new Set(this.getRunnerCapabilities(runner));
    for (const capability of REQUIRED_RUNNER_CAPABILITIES) {
      if (!capabilities.has(capability)) {
        issues.push(`capability:${capability}`);
      }
    }

    return issues;
  }

  isRunnerCompatible(runner: Pick<RunnerRow, 'metadata'>): boolean {
    return this.getRunnerCompatibilityIssues(runner).length === 0;
  }

  async getAttachedRunner(orgId: string, scopeId: string): Promise<RunnerRow | null> {
    const [attachedRunner] = await this.db
      .select({ runner: runners })
      .from(runnerScopeAssignments)
      .innerJoin(runners, eq(runners.id, runnerScopeAssignments.runnerId))
      .where(
        and(
          eq(runnerScopeAssignments.scopeId, scopeId),
          eq(runners.organizationId, orgId),
          eq(runners.type, 'private'),
          eq(runners.ownership, 'organization'),
        ),
      )
      .limit(1);

    return attachedRunner?.runner ?? null;
  }

  async resolveRunner(
    orgId: string,
    scopeId: string,
    executionTarget: ExecutionTarget = DEFAULT_EXECUTION_TARGET,
  ): Promise<RunnerRow | null> {
    if (executionTarget !== 'scope_runner') {
      return null;
    }

    const attachedRunner = await this.getAttachedRunner(orgId, scopeId);
    if (!attachedRunner) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'This scope does not have an attached private runner.',
        {
          httpStatus: 409,
          context: { reason: 'RUNNER_NOT_ASSIGNED', scopeId },
        },
      );
    }

    const hasReportedHandshake =
      this.getRunnerProtocolVersion(attachedRunner) > 0 || this.getRunnerCapabilities(attachedRunner).length > 0;
    const compatibilityIssues = this.getRunnerCompatibilityIssues(attachedRunner);
    const recordedHealthReason = attachedRunner.metadata?.healthReason?.trim();
    if (
      recordedHealthReason === 'upgrade_required' ||
      (hasReportedHandshake && compatibilityIssues.length > 0)
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The attached private runner is outdated and must be redeployed or upgraded.',
        {
          httpStatus: 409,
          context: {
            reason: 'RUNNER_INCOMPATIBLE',
            scopeId,
            runnerId: attachedRunner.id,
            issues: compatibilityIssues,
          },
        },
      );
    }

    if (!this.connectionRegistry.isConnected(attachedRunner.id) || attachedRunner.status !== 'online') {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The attached private runner is offline.',
        {
          httpStatus: 409,
          context: { reason: 'RUNNER_OFFLINE', scopeId, runnerId: attachedRunner.id },
        },
      );
    }

    if (compatibilityIssues.length > 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'The attached private runner is outdated and must be redeployed or upgraded.',
        {
          httpStatus: 409,
          context: {
            reason: 'RUNNER_INCOMPATIBLE',
            scopeId,
            runnerId: attachedRunner.id,
            issues: compatibilityIssues,
          },
        },
      );
    }

    return attachedRunner;
  }

  async quarantineStaleRunners(
    maxHeartbeatAgeMs: number = 5 * 60 * 1000,
  ): Promise<Array<{ id: string; organizationId: string; name: string; lastHeartbeatAt: Date | null }>> {
    const cutoff = new Date(Date.now() - maxHeartbeatAgeMs);
    const candidates = await this.db
      .select({
        id: runners.id,
        organizationId: runners.organizationId,
        name: runners.name,
        lastHeartbeatAt: runners.lastHeartbeatAt,
      })
      .from(runners)
      .where(
        and(
          eq(runners.type, 'private'),
          eq(runners.ownership, 'organization'),
          ne(runners.status, 'offline'),
          ne(runners.status, 'quarantined'),
          lt(runners.lastHeartbeatAt, cutoff),
        ),
      );

    const stale = candidates
      .filter((runner): runner is typeof runner & { organizationId: string } => Boolean(runner.organizationId))
      .filter((runner) => !this.connectionRegistry.isConnected(runner.id));
    if (stale.length === 0) {
      return [];
    }

    const staleIds = stale.map((runner) => runner.id);
    const now = new Date();
    await this.db
      .update(runners)
      .set({
        status: 'quarantined',
        metadata: sql`jsonb_set(${runners.metadata}, '{healthState}', '"quarantined"', true)`,
        updatedAt: now,
      })
      .where(inArray(runners.id, staleIds));

    return stale;
  }
}
