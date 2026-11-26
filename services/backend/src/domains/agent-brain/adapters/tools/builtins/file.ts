import { createHash } from 'crypto';
import * as path from 'path';
import { type ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { summarizeForNote } from '@/shared/utils/text';
const toWorkspaceRelativePath = (workspaceDir: string, absolutePath: string): string => {
  const relative = path.relative(workspaceDir, absolutePath);
  const normalized = relative.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Path escapes workspace');
  }
  return normalized;
};

const METHODOLOGY_PATH_PATTERN = /^\.skills\/([^/]+)\/methodology\.md$/;
const DEFAULT_FILE_READ_MAX_CHARS = 12_000;
const HARD_FILE_READ_MAX_CHARS = 16_000;
const HARD_FILE_READ_MAX_LINES = 2_000;
const MAX_FILE_READ_CACHE_ENTRIES = 50;
const FILE_READ_MAX_PREFIX_BYTES = HARD_FILE_READ_MAX_CHARS * 4 + 4096;
const RAW_ARTIFACT_DIGEST_HINT_MIN_BYTES = 32_000;
const SCAN_DIGEST_VISIBLE_PATH = '/workspace/scans/digest.md';

type FileReadArgs = {
  path?: string;
  offset?: unknown;
  limit?: unknown;
  maxChars?: unknown;
};

type FileReadCacheEntry = {
  contentHash: string;
  totalChars: number;
  totalLines: number;
  returnedChars: number;
  fileSizeBytes?: number;
  mtimeMs?: number | null;
  readAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toWorkspaceVisiblePath = (relativePath: string): string =>
  `/workspace/${relativePath.replace(/\\/g, '/').replace(/^\/+/u, '')}`;

const isRawScannerArtifactRead = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/u, '');
  return (
    /^\.artifacts\/(?:scans|phases|shell-jobs)\//u.test(normalized) &&
    !/^scans\/digest\.(?:md|json)$/u.test(normalized)
  );
};

const isCredentialPath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/gu, '');
  return normalized === '.credentials' || normalized.startsWith('.credentials/');
};

const isReportingSession = (session: NonNullable<ReturnType<typeof getSessionFromContext>>): boolean => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const phase = typeof securityops?.activePhaseKey === 'string'
    ? securityops.activePhaseKey.trim().toLowerCase()
    : '';
  return phase === 'reporting' || phase === 'review_reporting';
};

const statWorkspacePath = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  relativePath: string,
): Promise<{ exists: boolean; isFile: boolean; sizeBytes: number; mtimeMs: number | null } | undefined> => {
  if (typeof ctx.sandbox.statFile === 'function') {
    const stat = await ctx.sandbox.statFile(session, relativePath).catch(() => undefined);
    if (stat) {
      return stat;
    }
  }
  return undefined;
};

const buildRawArtifactDigestHint = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  relativePath: string,
  options: { fileSizeBytes?: number; truncated: boolean },
): Promise<Record<string, unknown> | undefined> => {
  if (!isRawScannerArtifactRead(relativePath)) {
    return undefined;
  }

  const largeRawRead =
    options.truncated ||
    (typeof options.fileSizeBytes === 'number' && options.fileSizeBytes >= RAW_ARTIFACT_DIGEST_HINT_MIN_BYTES);
  if (!largeRawRead) {
    return undefined;
  }

  const digestRelativePath = 'scans/digest.md';
  const digestStat = await statWorkspacePath(ctx, session, digestRelativePath);
  const hint = {
    digestPath: SCAN_DIGEST_VISIBLE_PATH,
    digestAvailable: digestStat?.exists === true && digestStat.isFile === true,
    rawPath: toWorkspaceVisiblePath(relativePath),
    reason: 'large_raw_scanner_artifact_read',
    nextAction:
      'Prefer /workspace/scans/digest.md, /workspace/scans/digest.json, and projected recon files before raw scanner artifacts. Open raw artifacts for evidence drill-down, parser repair, or details the digest does not contain.',
  };

  await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
    event: 'file_read.raw_artifact_digest_hint',
    severity: 'info',
    payload: hint,
    note: summarizeForNote(`raw artifact read; digest hint ${SCAN_DIGEST_VISIBLE_PATH}`),
  }).catch(() => undefined);

  return hint;
};

const normalizeInt = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

const normalizeOptionalInt = (value: unknown, min: number, max: number): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

const hashText = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const splitLines = (text: string): string[] =>
  text.length === 0 ? [] : text.split(/\r\n|\n|\r/);

const countLines = (text: string): number => splitLines(text).length;

const getFileReadCache = (flags: Record<string, unknown>): Record<string, FileReadCacheEntry> => {
  const rawCache = flags.fileReadCache;
  if (!isRecord(rawCache)) {
    return {};
  }

  const cache: Record<string, FileReadCacheEntry> = {};
  for (const [key, value] of Object.entries(rawCache)) {
    if (!isRecord(value) || typeof value.contentHash !== 'string') {
      continue;
    }
    cache[key] = {
      contentHash: value.contentHash,
      totalChars: typeof value.totalChars === 'number' ? value.totalChars : 0,
      totalLines: typeof value.totalLines === 'number' ? value.totalLines : 0,
      returnedChars: typeof value.returnedChars === 'number' ? value.returnedChars : 0,
      fileSizeBytes: typeof value.fileSizeBytes === 'number' ? value.fileSizeBytes : undefined,
      mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : null,
      readAt: typeof value.readAt === 'string' ? value.readAt : '',
    };
  }
  return cache;
};

const setFileReadCacheEntry = (
  flags: Record<string, unknown>,
  cacheKey: string,
  entry: FileReadCacheEntry,
): void => {
  const cache = getFileReadCache(flags);
  cache[cacheKey] = entry;
  flags.fileReadCache = Object.fromEntries(
    Object.entries(cache).slice(-MAX_FILE_READ_CACHE_ENTRIES),
  );
};

const sliceFileContent = (
  content: string,
  options: { offset: number; limit?: number; maxChars: number },
): {
  content: string;
  totalChars: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  returnedChars: number;
  truncated: boolean;
  truncatedByChars: boolean;
  truncatedByLines: boolean;
  nextOffset?: number;
} => {
  const lines = splitLines(content);
  const totalLines = lines.length;
  const startLine = totalLines === 0 ? 1 : Math.min(options.offset, totalLines + 1);
  const startIndex = Math.max(0, startLine - 1);
  const sliceEnd =
    typeof options.limit === 'number'
      ? Math.min(startIndex + options.limit, totalLines)
      : totalLines;
  const selected = lines.slice(startIndex, sliceEnd).join('\n');
  const truncatedByLines = sliceEnd < totalLines;
  const truncatedByChars = selected.length > options.maxChars;
  const returnedContent = truncatedByChars ? selected.slice(0, options.maxChars) : selected;
  const returnedLineCount = countLines(returnedContent);
  const endLine =
    returnedLineCount > 0 ? startLine + returnedLineCount - 1 : Math.max(0, startLine - 1);
  const truncated = truncatedByChars || truncatedByLines;
  const nextOffset = truncated ? Math.min(totalLines + 1, Math.max(startLine + 1, endLine + 1)) : undefined;

  return {
    content: returnedContent,
    totalChars: content.length,
    totalLines,
    startLine,
    endLine,
    returnedChars: returnedContent.length,
    truncated,
    truncatedByChars,
    truncatedByLines,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
};

const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

const reconcileActiveMethodologyRequirement = (
  requirement: unknown,
  skill: string,
): {
  nextRequirement?: {
    stepId: string;
    skills: string[];
    paths: string[];
  };
  requirementCleared: boolean;
} => {
  if (
    typeof requirement !== 'object' ||
    requirement === null ||
    Array.isArray(requirement)
  ) {
    return { requirementCleared: false };
  }

  const record = requirement as {
    stepId?: unknown;
    skills?: unknown;
    paths?: unknown;
  };
  const stepId = typeof record.stepId === 'string' ? record.stepId.trim() : '';
  const skills = Array.isArray(record.skills)
    ? record.skills
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => normalizeSkillSlug(entry))
        .filter((entry) => entry.length > 0)
    : [];
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  if (!stepId || skills.length === 0) {
    return { requirementCleared: false };
  }

  if (!skills.includes(skill)) {
    return {
      nextRequirement: {
        stepId,
        skills,
        paths,
      },
      requirementCleared: false,
    };
  }

  const nextSkills = skills.filter((entry) => entry !== skill);
  if (nextSkills.length === 0) {
    return { requirementCleared: true };
  }

  return {
    nextRequirement: {
      stepId,
      skills: nextSkills,
      paths: nextSkills.map((entry) => `/workspace/.skills/${entry}/methodology.md`),
    },
    requirementCleared: false,
  };
};

const recordMethodologyRead = async (
  ctx: ToolContext,
  session: ReturnType<typeof getSessionFromContext>,
  relativePath: string,
): Promise<void> => {
  if (!session) {
    return;
  }
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const match = normalizedPath.match(METHODOLOGY_PATH_PATTERN);
  if (!match) {
    return;
  }

  const skill = normalizeSkillSlug(match[1]);
  if (!skill) {
    return;
  }

  const readAt = new Date().toISOString();
  const existingReads =
    typeof session.flags.skillMethodologyReads === 'object' &&
    session.flags.skillMethodologyReads !== null &&
    !Array.isArray(session.flags.skillMethodologyReads)
      ? session.flags.skillMethodologyReads
      : {};

  session.flags.skillMethodologyReads = {
    ...existingReads,
    [skill]: {
      readAt,
      byPlanStepId: session.currentPlanStepId,
      path: `/workspace/${normalizedPath}`,
    },
  };
  const requirementState = reconcileActiveMethodologyRequirement(
    session.flags.activeMethodologyRequirement,
    skill,
  );
  if (requirementState.nextRequirement) {
    session.flags.activeMethodologyRequirement = requirementState.nextRequirement;
  } else if (requirementState.requirementCleared) {
    delete session.flags.activeMethodologyRequirement;
  }

  await ctx.sessionStore.setAsync(session.id, session, 'file_read.skill_methodology_read');
  await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
    event: 'skill.methodology.read',
    severity: 'info',
    payload: {
      skill,
      path: `/workspace/${normalizedPath}`,
      stepId: session.currentPlanStepId,
      readAt,
      ...(requirementState.nextRequirement
        ? { remainingRequiredSkills: requirementState.nextRequirement.skills }
        : requirementState.requirementCleared
          ? { remainingRequiredSkills: [] }
          : {}),
    },
    note: summarizeForNote(`${skill} methodology read for ${session.currentPlanStepId ?? 'no active step'}`),
  }).catch(() => undefined);
};

export const FileRead: ToolImpl = {
  meta: {
    name: 'file_read',
    description:
      'Read content from a file in the workspace. Supports bounded reads with 1-based offset, line limit, and maxChars. Large files are capped by default; use nextOffset for the next chunk.',
    category: 'fs',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: '1-based starting line. Defaults to 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: HARD_FILE_READ_MAX_LINES,
          description: 'Maximum number of lines to return.',
        },
        maxChars: {
          type: 'integer',
          minimum: 1,
          maximum: HARD_FILE_READ_MAX_CHARS,
          description: `Maximum characters to return. Defaults to ${DEFAULT_FILE_READ_MAX_CHARS}.`,
        },
      },
      required: ['path'],
    },
    risks: ['read'],
  },
  async run({ path: targetPath, offset, limit, maxChars }: FileReadArgs, ctx: ToolContext) {
    const requestedPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!requestedPath) {
      return {
        ok: false,
        data: { error: 'path is required' },
      };
    }
    const normalizedOffset = normalizeInt(offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const normalizedLimit = normalizeOptionalInt(limit, 1, HARD_FILE_READ_MAX_LINES);
    const normalizedMaxChars = normalizeInt(
      maxChars,
      DEFAULT_FILE_READ_MAX_CHARS,
      1,
      HARD_FILE_READ_MAX_CHARS,
    );
    const normalized = ctx.guards.pathGuard.ensureInsideWorkspace(requestedPath);
    return runWithGuards(
      FileRead.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (!session) {
          throw new Error(`Session ${ctx.sessionId} not found`);
        }

        const relativePath = toWorkspaceRelativePath(ctx.workspaceDir, normalized);
        if (isReportingSession(session) && isCredentialPath(relativePath)) {
          return {
            ok: false,
            data: {
              error: 'credential files are not available to reporting sessions',
              path: requestedPath,
            },
          };
        }
        const fileStat = await ctx.sandbox.statFile?.(session, relativePath).catch(() => undefined);
        const maxReadBytes = Math.min(
          FILE_READ_MAX_PREFIX_BYTES,
          Math.max(8192, normalizedMaxChars * 4 + 4096),
        );
        const content = await ctx.sandbox.readFile(session, relativePath, maxReadBytes);
        const contentText = content.toString('utf-8');
        const contentHash = hashText(contentText);
        const truncatedByBytes =
          fileStat?.exists === true &&
          typeof fileStat.sizeBytes === 'number' &&
          fileStat.sizeBytes > content.byteLength;
        const sliced = sliceFileContent(contentText, {
          offset: normalizedOffset,
          limit: normalizedLimit,
          maxChars: normalizedMaxChars,
        });
        const responseTruncated = sliced.truncated || truncatedByBytes;
        session.flags = session.flags ?? {};
        const cacheFlags = session.flags as Record<string, unknown>;
        const cacheKey = [
          relativePath.replace(/\\/g, '/'),
          normalizedOffset,
          normalizedLimit ?? 'all',
          normalizedMaxChars,
        ].join(':');
        const previousRead = getFileReadCache(cacheFlags)[cacheKey];
        const fileIdentityMatches =
          typeof fileStat?.sizeBytes === 'number'
            ? previousRead?.fileSizeBytes === fileStat.sizeBytes &&
              previousRead?.mtimeMs === (typeof fileStat.mtimeMs === 'number' ? fileStat.mtimeMs : null)
            : true;
        const unchanged =
          previousRead?.contentHash === contentHash &&
          previousRead.totalChars === sliced.totalChars &&
          previousRead.totalLines === sliced.totalLines &&
          fileIdentityMatches;
        setFileReadCacheEntry(cacheFlags, cacheKey, {
          contentHash,
          totalChars: sliced.totalChars,
          totalLines: sliced.totalLines,
          returnedChars: sliced.returnedChars,
          ...(typeof fileStat?.sizeBytes === 'number' ? { fileSizeBytes: fileStat.sizeBytes } : {}),
          mtimeMs: typeof fileStat?.mtimeMs === 'number' ? fileStat.mtimeMs : null,
          readAt: new Date().toISOString(),
        });
        await recordMethodologyRead(ctx, session, relativePath);
        const digestFirst = await buildRawArtifactDigestHint(ctx, session, relativePath, {
          fileSizeBytes: typeof fileStat?.sizeBytes === 'number' ? fileStat.sizeBytes : undefined,
          truncated: responseTruncated,
        });
        await ctx.sessionStore
          .setAsync(session.id, session, unchanged ? 'file_read.cache_hit' : 'file_read.cache_update')
          .catch(() => undefined);

        if (unchanged) {
          return {
            ok: true,
            data: {
              status: 'file_unchanged',
              path: requestedPath,
              content: '',
              totalChars: sliced.totalChars,
              totalLines: sliced.totalLines,
              startLine: sliced.startLine,
              endLine: sliced.endLine,
              returnedChars: 0,
              unchanged: true,
              ...(typeof fileStat?.sizeBytes === 'number' ? { fileSizeBytes: fileStat.sizeBytes } : {}),
              ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
              ...(digestFirst ? { digestFirst } : {}),
              contentHash,
            },
          };
        }

        return {
          ok: true,
          data: {
            path: requestedPath,
            content: sliced.content,
            totalChars: sliced.totalChars,
            totalLines: sliced.totalLines,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            returnedChars: sliced.returnedChars,
            truncated: responseTruncated,
            truncatedByChars: sliced.truncatedByChars,
            truncatedByLines: sliced.truncatedByLines,
            ...(typeof fileStat?.sizeBytes === 'number' ? { fileSizeBytes: fileStat.sizeBytes } : {}),
            ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
            ...(sliced.nextOffset !== undefined ? { nextOffset: sliced.nextOffset } : {}),
            ...(digestFirst ? { digestFirst } : {}),
            contentHash,
          },
        };
      },
      {},
      {
        path: requestedPath,
        offset: normalizedOffset,
        ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {}),
        maxChars: normalizedMaxChars,
      }
    );
  },
};

export const FileWrite: ToolImpl = {
  meta: {
    name: 'file_write',
    description: 'Write text to a file under the workspace.',
    category: 'fs',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target path relative to the workspace.' },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['path', 'content'],
    },
    risks: ['write'],
  },
  async run(
    { path: targetPath, content }: { path?: string; content?: string },
    ctx: ToolContext,
  ) {
    const requestedPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!requestedPath) {
      return { ok: false, data: { error: 'path is required' } };
    }
    if (typeof content !== 'string') {
      return { ok: false, data: { error: 'content must be a string' } };
    }
    const normalized = ctx.guards.pathGuard.ensureInsideWorkspace(requestedPath);
    return runWithGuards(
      FileWrite.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (!session) {
          throw new Error(`Session ${ctx.sessionId} not found`);
        }

        const relativePath = toWorkspaceRelativePath(ctx.workspaceDir, normalized);
        await ctx.sandbox.writeFile(session, relativePath, content);
        return { ok: true, data: { success: true, path: requestedPath } };
      },
      {},
      { path: requestedPath, bytes: content.length }
    );
  },
};

export const FileBuiltins = [FileRead, FileWrite];

/** Registry-compatible export - ToolModuleDefinition format */
export const tools: ToolModuleDefinition[] = FileBuiltins.map(fromToolImpl);
