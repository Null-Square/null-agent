import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { CodeReviewFindingIdSchema } from './CodeReviewFindingService';
import {
  assetScopeMemberships,
  assets,
  codeReviewFindings,
  codeReviewRunMemorySnapshots,
  inventoryNotes,
  type CodeReviewContext,
  type CodeReviewMemorySnapshotCounts,
  type InventoryNoteRow,
} from '@/db/schema';
import {
  buildCodeReviewManifestHash,
  filterCodeReviewManifestFiles,
  type CodeReviewManifestFile,
} from '@/domains/security-ops/runs/codeReviewRunContext';
import { ntypeSchemas } from '@/domains/security-ops/tools/ntypeSchemas';
import { logger } from '@/shared/logger';
import { redactCodeReviewText } from './CodeReviewRedaction';

export const CODE_REVIEW_MEMORY_TYPES = [
  'review.map',
  'review.disposition',
  'review.coverage',
] as const;

export type CodeReviewMemoryType = (typeof CODE_REVIEW_MEMORY_TYPES)[number];
export type CodeReviewMemoryState =
  | 'current'
  | 'needs_recheck'
  | 'superseded'
  | 'historical'
  | 'out_of_scope';

export const CODE_REVIEW_MEMORY_OBSERVATION_TYPES = [
  'architecture',
  'entry_point',
  'trust_boundary',
  'authentication',
  'authorization',
  'data_flow',
  'security_control',
  'dependency',
  'configuration',
  'generated_or_vendored',
  'test_coverage',
  'review_limitation',
] as const;

export type CodeReviewMemoryObservationType =
  (typeof CODE_REVIEW_MEMORY_OBSERVATION_TYPES)[number];

export type CodeReviewMemoryAnchor = {
  path: string;
  blobSha: string;
};

export type CodeReviewMemoryRecord = {
  id: string;
  type: CodeReviewMemoryType;
  state: CodeReviewMemoryState;
  statement: string;
  observationType: CodeReviewMemoryObservationType;
  confidence: number;
  anchors: CodeReviewMemoryAnchor[];
  firstSeenCommitSha: string;
  lastConfirmedCommitSha: string;
  sourceRunId: string;
  findingFingerprint?: string;
  outcome?: 'rejected' | 'validated' | 'blocked' | 'deferred';
  rationale?: string;
  coverage?: CodeReviewCoverageMemory;
  lastSeenAt: Date;
  stateReason?: string;
};

export type CodeReviewCoverageMemory = {
  reviewedPathPrefixes: string[];
  techniquesAttempted: string[];
  skippedPaths: Array<{ path: string; reason: string }>;
  result: 'complete' | 'partial' | 'blocked';
};

export type CodeReviewMemorySnapshot = {
  promptText: string;
  counts: CodeReviewMemorySnapshotCounts;
  records: CodeReviewMemoryRecord[];
};

const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => !value.startsWith('/') && !value.includes('\\') && !/(?:^|\/)\.\.(?:\/|$)/u.test(value),
    'must be a safe repository-relative path',
  );

const coverageMemorySchema = z.object({
  reviewedPathPrefixes: z.array(repositoryPathSchema).max(50).default([]),
  techniquesAttempted: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  skippedPaths: z.array(z.object({
    path: repositoryPathSchema,
    reason: z.string().trim().min(1).max(500),
  })).max(50).default([]),
  result: z.enum(['complete', 'partial', 'blocked']),
});

export const RecordCodeReviewMemoryInputSchema = z
  .object({
    type: z.enum(CODE_REVIEW_MEMORY_TYPES),
    statement: z.string().trim().min(8).max(1_200),
    observationType: z.enum(CODE_REVIEW_MEMORY_OBSERVATION_TYPES),
    confidence: z.number().min(0).max(1),
    anchorPaths: z.array(repositoryPathSchema).min(1).max(8),
    // Same two shapes as validation: uuid for an organization run, sha256
    // fingerprint for a hosted one. See CodeReviewFindingIdSchema.
    findingId: CodeReviewFindingIdSchema.optional(),
    outcome: z.enum(['rejected', 'validated', 'blocked', 'deferred']).optional(),
    rationale: z.string().trim().min(8).max(1_200).optional(),
    coverage: coverageMemorySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'review.disposition') {
      for (const key of ['findingId', 'outcome', 'rationale'] as const) {
        if (!value[key]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required for review.disposition`,
          });
        }
      }
    } else if (value.findingId || value.outcome || value.rationale) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: 'finding disposition fields are only valid for review.disposition',
      });
    }
    if (value.type === 'review.coverage' && !value.coverage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coverage'],
        message: 'coverage is required for review.coverage',
      });
    } else if (value.type !== 'review.coverage' && value.coverage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coverage'],
        message: 'coverage is only valid for review.coverage',
      });
    }
  });

export type RecordCodeReviewMemoryInput = z.infer<typeof RecordCodeReviewMemoryInputSchema>;

const MEMORY_RETENTION_DAYS = 365;
const MEMORY_QUERY_LIMIT = 500;
const MEMORY_PROMPT_RECORD_LIMIT = 30;
const MEMORY_PROMPT_CHAR_LIMIT = 6_000;
const MEMORY_PER_RUN_WRITE_LIMIT = 80;
const RUN_DIGEST_LIMIT = 10;
const MEMORY_TYPE_LIMITS: Record<CodeReviewMemoryType, number> = {
  'review.map': 150,
  'review.disposition': 250,
  'review.coverage': 80,
};
const MEMORY_STORAGE_LIMITS: Record<CodeReviewMemoryType | 'run.digest', number> = {
  ...MEMORY_TYPE_LIMITS,
  'run.digest': RUN_DIGEST_LIMIT,
};

const phaseMemoryType: Partial<Record<string, CodeReviewMemoryType>> = {
  review_mapping: 'review.map',
  review_validation: 'review.disposition',
  review_reporting: 'review.coverage',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const normalizePath = (value: string): string =>
  value.trim().replace(/^\.\/+/u, '').replace(/\/+$/u, '');

const normalizeStatementKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[^\p{L}\p{N}_./ -]/gu, '')
    .trim();

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const parseAnchors = (value: unknown): CodeReviewMemoryAnchor[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const anchors: CodeReviewMemoryAnchor[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = asString(item.path);
    const blobSha = asString(item.blobSha);
    if (!path || !blobSha) continue;
    const normalizedPath = normalizePath(path);
    const key = normalizedPath.toLowerCase();
    if (!normalizedPath || seen.has(key)) continue;
    seen.add(key);
    anchors.push({ path: normalizedPath, blobSha: blobSha.toLowerCase() });
  }
  return anchors;
};

const parseCoverage = (value: unknown): CodeReviewCoverageMemory | undefined => {
  const parsed = coverageMemorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const emptyCounts = (): CodeReviewMemorySnapshotCounts => ({
  considered: 0,
  current: 0,
  needsRecheck: 0,
  superseded: 0,
  historical: 0,
  outOfScope: 0,
});

const incrementStateCount = (
  counts: CodeReviewMemorySnapshotCounts,
  state: CodeReviewMemoryState,
): void => {
  if (state === 'needs_recheck') counts.needsRecheck += 1;
  else if (state === 'out_of_scope') counts.outOfScope += 1;
  else counts[state] += 1;
};

type PreparedManifest = {
  fullFiles: CodeReviewManifestFile[];
  scopedFiles: CodeReviewManifestFile[];
  fullByPath: Map<string, CodeReviewManifestFile>;
  scopedPaths: Set<string>;
};

export const evaluateCodeReviewMemoryCompatibility = (params: {
  anchors: readonly CodeReviewMemoryAnchor[];
  fullByPath: ReadonlyMap<string, CodeReviewManifestFile>;
  scopedPaths: ReadonlySet<string>;
  manifestCompleteness: CodeReviewContext['reviewScope']['completeness'];
  lastSeenAt: Date;
  now: Date;
  retentionDays?: number;
}): { state: CodeReviewMemoryState; reason?: string } => {
  const retentionDays = params.retentionDays ?? MEMORY_RETENTION_DAYS;
  const retentionCutoff = params.now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;
  if (params.lastSeenAt.getTime() < retentionCutoff) {
    return { state: 'historical', reason: 'retention_horizon' };
  }
  if (params.anchors.length === 0) {
    return { state: 'needs_recheck', reason: 'missing_verified_anchors' };
  }
  const absent = params.anchors.filter(
    (anchor) => !params.fullByPath.has(anchor.path.toLowerCase()),
  );
  const outsideScope = params.anchors.filter(
    (anchor) =>
      params.fullByPath.has(anchor.path.toLowerCase())
      && !params.scopedPaths.has(anchor.path.toLowerCase()),
  );
  const changed = params.anchors.filter((anchor) => {
    const current = params.fullByPath.get(anchor.path.toLowerCase());
    return current && current.blobSha.toLowerCase() !== anchor.blobSha.toLowerCase();
  });
  if (absent.length > 0 && params.manifestCompleteness === 'complete') {
    return {
      state: 'superseded',
      reason: `anchor_absent:${absent.map((anchor) => anchor.path).join(',')}`,
    };
  }
  if (outsideScope.length > 0) {
    return {
      state: 'out_of_scope',
      reason: `outside_current_path_scope:${outsideScope.map((anchor) => anchor.path).join(',')}`,
    };
  }
  if (absent.length > 0) {
    return {
      state: 'needs_recheck',
      reason: 'partial_manifest_missing_anchor',
    };
  }
  if (changed.length > 0) {
    return {
      state: 'needs_recheck',
      reason: `anchor_changed:${changed.map((anchor) => anchor.path).join(',')}`,
    };
  }
  return { state: 'current' };
};

export const selectCodeReviewMemoryIdsForPruning = (params: {
  rows: ReadonlyArray<{
    id: string;
    ntype: CodeReviewMemoryType | 'run.digest';
    lastSeenAt: Date;
  }>;
  now: Date;
  retentionDays?: number;
}): string[] => {
  const cutoff =
    params.now.getTime()
    - (params.retentionDays ?? MEMORY_RETENTION_DAYS) * 24 * 60 * 60 * 1_000;
  const retainedByType = new Map<string, number>();
  return [...params.rows]
    .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime())
    .flatMap((row) => {
      if (row.lastSeenAt.getTime() < cutoff) return [row.id];
      const retained = retainedByType.get(row.ntype) ?? 0;
      retainedByType.set(row.ntype, retained + 1);
      return retained >= MEMORY_STORAGE_LIMITS[row.ntype] ? [row.id] : [];
    });
};

type RepositoryAsset = {
  id: string;
  /** Provenance: null once the observing user is deleted. The asset survives. */
  userId: string | null;
};

export class CodeReviewMemoryService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  prepareManifest(
    context: CodeReviewContext,
    manifestFiles: readonly CodeReviewManifestFile[],
  ): PreparedManifest {
    const expectedHash = buildCodeReviewManifestHash({
      immutableCommitSha: context.repository.immutableCommitSha,
      files: manifestFiles,
      allowedPaths: context.reviewScope.allowedPaths,
      excludedPaths: context.reviewScope.excludedPaths,
    });
    if (expectedHash !== context.reviewScope.manifestHash) {
      throw new Error('Code Review memory manifest does not match the immutable run context');
    }

    const fullFiles = filterCodeReviewManifestFiles({
      files: manifestFiles,
      allowedPaths: [],
      excludedPaths: [],
    });
    const scopedFiles = filterCodeReviewManifestFiles({
      files: manifestFiles,
      allowedPaths: context.reviewScope.allowedPaths,
      excludedPaths: context.reviewScope.excludedPaths,
    });
    return {
      fullFiles,
      scopedFiles,
      fullByPath: new Map(fullFiles.map((file) => [file.path.toLowerCase(), file])),
      scopedPaths: new Set(scopedFiles.map((file) => file.path.toLowerCase())),
    };
  }

  async ensureRepositoryAsset(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    context: CodeReviewContext;
  }): Promise<RepositoryAsset> {
    return this.ensureRepositoryAssetProjection({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      userId: params.userId,
      repositoryId: params.context.repository.repositoryId,
      repositoryFullName: params.context.repository.fullName,
      visibility: params.context.repository.visibility,
    });
  }

  async ensureRepositoryAssetProjection(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    repositoryId: string;
    repositoryFullName: string;
    visibility: CodeReviewContext['repository']['visibility'];
  }): Promise<RepositoryAsset> {
    const stableTag = `github_repository:${params.repositoryId}`;
    const now = this.now();
    const repositoryUrl = `https://github.com/${params.repositoryFullName}`;
    const [tagged] = await this.db
      .select({
        id: assets.id,
        userId: assets.userId,
        tags: assets.tags,
        evidence: assets.evidence,
      })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, params.organizationId),
          eq(assets.kind, 'repository'),
          sql`${stableTag} = ANY(COALESCE(${assets.tags}, ARRAY[]::text[]))`,
        ),
      )
      .limit(1);

    if (tagged) {
      const tags = uniqueStrings([
        ...(tagged.tags ?? []).filter(
          (tag) => tag !== 'repository_disconnected' && tag !== 'repository_archived',
        ),
        'code_review',
        stableTag,
      ]);
      const evidence = [
        ...(tagged.evidence ?? []).filter((item) => item.label !== 'github'),
        { path: repositoryUrl, label: 'github' },
      ];
      // scopeId is not written here: a repository observed by a second scope
      // gains a membership rather than migrating away from the first.
      await this.db
        .update(assets)
        .set({
          value: params.repositoryFullName,
          tags,
          evidence,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(assets.id, tagged.id));
      await this.touchScopeMembership({
        organizationId: params.organizationId,
        assetId: tagged.id,
        scopeId: params.scopeId,
        now,
      });
      return { id: tagged.id, userId: tagged.userId };
    }

    // Matched on organization identity, not on the observing user: the same
    // repository reviewed by a second member of the org is one asset, and
    // filtering by user here would collide with assets_org_kind_value_unq.
    const [sameUserValue] = await this.db
      .select({
        id: assets.id,
        userId: assets.userId,
        tags: assets.tags,
        evidence: assets.evidence,
      })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, params.organizationId),
          eq(assets.kind, 'repository'),
          eq(assets.value, params.repositoryFullName),
        ),
      )
      .limit(1);
    if (sameUserValue) {
      await this.db
        .update(assets)
        .set({
          tags: uniqueStrings([
            ...(sameUserValue.tags ?? []).filter(
              (tag) => tag !== 'repository_disconnected' && tag !== 'repository_archived',
            ),
            'code_review',
            stableTag,
          ]),
          evidence: [
            ...(sameUserValue.evidence ?? []).filter((item) => item.label !== 'github'),
            { path: repositoryUrl, label: 'github' },
          ],
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(assets.id, sameUserValue.id));
      await this.touchScopeMembership({
        organizationId: params.organizationId,
        assetId: sameUserValue.id,
        scopeId: params.scopeId,
        now,
      });
      return { id: sameUserValue.id, userId: sameUserValue.userId };
    }

    try {
      const [created] = await this.db
        .insert(assets)
        .values({
          organizationId: params.organizationId,
          scopeId: params.scopeId,
          userId: params.userId,
          kind: 'repository',
          value: params.repositoryFullName,
          tags: ['code_review', stableTag],
          evidence: [{ path: repositoryUrl, label: 'github' }],
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: assets.id, userId: assets.userId });
      if (!created) throw new Error('Repository asset projection did not return a row');
      await this.touchScopeMembership({
        organizationId: params.organizationId,
        assetId: created.id,
        scopeId: params.scopeId,
        now,
      });
      return created;
    } catch (error) {
      const [afterRace] = await this.db
        .select({ id: assets.id, userId: assets.userId })
        .from(assets)
        .where(
          and(
            eq(assets.organizationId, params.organizationId),
            eq(assets.kind, 'repository'),
            eq(assets.value, params.repositoryFullName),
          ),
        )
        .limit(1);
      if (!afterRace) throw error;
      await this.touchScopeMembership({
        organizationId: params.organizationId,
        assetId: afterRace.id,
        scopeId: params.scopeId,
        now,
      });
      return afterRace;
    }
  }

  /**
   * Record that this scope has observed this repository. See
   * AssetIngestionWriter.touchScopeMembership — the two writers must agree,
   * because a repository and a domain are the same kind of thing here.
   */
  private async touchScopeMembership(params: {
    organizationId: string;
    assetId: string;
    scopeId: string;
    now: Date;
  }): Promise<void> {
    await this.db
      .insert(assetScopeMemberships)
      .values({
        organizationId: params.organizationId,
        assetId: params.assetId,
        scopeId: params.scopeId,
        firstSeenAt: params.now,
        lastSeenAt: params.now,
        createdAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [assetScopeMemberships.assetId, assetScopeMemberships.scopeId],
        set: { lastSeenAt: params.now, updatedAt: params.now },
      });
  }

  async retireRepositoryAssetProjections(params: {
    organizationId: string;
    reason: 'detached' | 'archived' | 'removed' | 'installation_disconnected';
    repositoryIds?: readonly string[];
  }): Promise<number> {
    const rows = await this.db
      .select({
        id: assets.id,
        tags: assets.tags,
      })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, params.organizationId),
          eq(assets.kind, 'repository'),
        ),
      );
    const requestedIds = params.repositoryIds
      ? new Set(params.repositoryIds.map((id) => id.toLowerCase()))
      : null;
    const selected = rows.filter((row) => {
      const repositoryTag = (row.tags ?? []).find((tag) => tag.startsWith('github_repository:'));
      if (!repositoryTag) return false;
      if (!requestedIds) return true;
      return requestedIds.has(repositoryTag.slice('github_repository:'.length).toLowerCase());
    });
    const retirementTag =
      params.reason === 'archived' ? 'repository_archived' : 'repository_disconnected';
    const now = this.now();
    await Promise.all(
      selected.map((row) =>
        this.db
          .update(assets)
          .set({
            tags: uniqueStrings([
              ...(row.tags ?? []).filter(
                (tag) => tag !== 'repository_disconnected' && tag !== 'repository_archived',
              ),
              retirementTag,
            ]),
            updatedAt: now,
          })
          .where(eq(assets.id, row.id))),
    );
    if (selected.length > 0) {
      logger.info(
        {
          organizationId: params.organizationId,
          reason: params.reason,
          repositoryIds: params.repositoryIds ?? 'all',
          retiredCount: selected.length,
        },
        '[code-review-memory] Retired repository asset projections without deleting memory',
      );
    }
    return selected.length;
  }

  async buildSnapshot(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    context: CodeReviewContext;
    manifestFiles: readonly CodeReviewManifestFile[];
    repositoryBrief?: string | null;
  }): Promise<CodeReviewMemorySnapshot> {
    const manifest = this.prepareManifest(params.context, params.manifestFiles);
    const asset = await this.ensureRepositoryAsset(params);
    await this.pruneRepositoryMemory(asset.id);
    const rows = await this.loadMemoryRows(asset.id);
    const records = rows.map((row) => this.toRecord(row, params.context, manifest));
    const counts = this.countRecords(records);
    await this.markCompatibilityStates(records, rows);
    logger.debug(
      {
        organizationId: params.organizationId,
        scopeId: params.scopeId,
        repositoryId: params.context.repository.repositoryId,
        commitSha: params.context.repository.immutableCommitSha,
        counts,
      },
      '[code-review-memory] Built revision-compatible memory snapshot',
    );
    return {
      promptText: this.formatPrompt(
        params.context,
        records,
        counts,
        params.repositoryBrief,
      ),
      counts,
      records,
    };
  }

  async persistRunSnapshot(params: {
    runId: string;
    organizationId: string;
    scopeId: string;
    context: CodeReviewContext;
    snapshot: CodeReviewMemorySnapshot;
  }): Promise<void> {
    const now = this.now();
    await this.db
      .insert(codeReviewRunMemorySnapshots)
      .values({
        runId: params.runId,
        organizationId: params.organizationId,
        scopeId: params.scopeId,
        repositoryId: params.context.repository.repositoryId,
        commitSha: params.context.repository.immutableCommitSha,
        promptText: params.snapshot.promptText,
        counts: params.snapshot.counts,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: codeReviewRunMemorySnapshots.runId,
        set: {
          promptText: params.snapshot.promptText,
          counts: params.snapshot.counts,
          updatedAt: now,
        },
      });
    logger.info(
      {
        runId: params.runId,
        organizationId: params.organizationId,
        scopeId: params.scopeId,
        repositoryId: params.context.repository.repositoryId,
        commitSha: params.context.repository.immutableCommitSha,
        counts: params.snapshot.counts,
      },
      '[code-review-memory] Persisted immutable run memory snapshot',
    );
  }

  async getRunSnapshotPrompt(params: {
    runId: string;
    organizationId: string;
  }): Promise<string> {
    const [row] = await this.db
      .select({ promptText: codeReviewRunMemorySnapshots.promptText })
      .from(codeReviewRunMemorySnapshots)
      .where(
        and(
          eq(codeReviewRunMemorySnapshots.runId, params.runId),
          eq(codeReviewRunMemorySnapshots.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row?.promptText?.trim() ?? '';
  }

  async queryMemory(params: {
    organizationId: string;
    scopeId: string;
    userId: string;
    context: CodeReviewContext;
    manifestFiles: readonly CodeReviewManifestFile[];
    types?: readonly CodeReviewMemoryType[];
    includeNeedsRecheck?: boolean;
    query?: string;
    limit?: number;
  }): Promise<{
    records: CodeReviewMemoryRecord[];
    counts: CodeReviewMemorySnapshotCounts;
    returned: number;
    truncated: boolean;
  }> {
    const snapshot = await this.buildSnapshot(params);
    const allowedTypes = new Set(params.types?.length ? params.types : CODE_REVIEW_MEMORY_TYPES);
    const query = params.query?.trim().toLowerCase() ?? '';
    const eligible = snapshot.records.filter((record) => {
      if (!allowedTypes.has(record.type)) return false;
      if (record.state !== 'current' && !(params.includeNeedsRecheck !== false && record.state === 'needs_recheck')) {
        return false;
      }
      if (!query) return true;
      return [
        record.statement,
        record.observationType,
        record.rationale ?? '',
        ...record.anchors.map((anchor) => anchor.path),
      ].some((value) => value.toLowerCase().includes(query));
    });
    const limit = Math.max(1, Math.min(params.limit ?? 25, 50));
    return {
      records: eligible.slice(0, limit),
      counts: snapshot.counts,
      returned: Math.min(eligible.length, limit),
      truncated: eligible.length > limit,
    };
  }

  async recordMemory(params: {
    organizationId: string;
    scopeId: string;
    runId: string;
    sessionId: string;
    userId: string;
    phaseKey: string;
    context: CodeReviewContext;
    manifestFiles: readonly CodeReviewManifestFile[];
    input: unknown;
  }): Promise<{
    noteId: string;
    created: boolean;
    dedupeKey: string;
    state: 'current';
    anchors: CodeReviewMemoryAnchor[];
  }> {
    const input = RecordCodeReviewMemoryInputSchema.parse(params.input);
    const expectedType = phaseMemoryType[params.phaseKey];
    if (!expectedType || expectedType !== input.type) {
      throw new Error(
        `${input.type} memory cannot be written during ${params.phaseKey}; expected ${expectedType ?? 'no durable memory writes'}`,
      );
    }
    if (params.context.operation !== 'repository_review') {
      throw new Error('Pull-request and finding-fix runs cannot write durable repository memory');
    }
    if (
      params.context.repository.requestedRef?.trim().toLowerCase()
      !== params.context.repository.defaultBranch.trim().toLowerCase()
    ) {
      throw new Error('Durable repository memory can only be written by a default-branch review');
    }

    const manifest = this.prepareManifest(params.context, params.manifestFiles);
    const scopedByPath = new Map(
      manifest.scopedFiles.map((file) => [file.path.toLowerCase(), file]),
    );
    const anchorPaths = uniqueStrings(input.anchorPaths.map(normalizePath));
    if (anchorPaths.length !== input.anchorPaths.length) {
      throw new Error('Memory anchor paths must be unique');
    }
    const anchors = anchorPaths.map((path) => {
      const file = scopedByPath.get(path.toLowerCase());
      if (!file) {
        throw new Error(`Memory anchor "${path}" is absent from the immutable allowed manifest`);
      }
      return { path: file.path, blobSha: file.blobSha };
    });

    const statement = redactCodeReviewText(input.statement).trim();
    if (statement.length < 8) {
      throw new Error('Memory statement is empty after redaction');
    }
    const rationale = input.rationale
      ? redactCodeReviewText(input.rationale).trim()
      : undefined;
    if (input.rationale && (!rationale || rationale.length < 8)) {
      throw new Error('Memory rationale is empty after redaction');
    }

    let findingFingerprint: string | undefined;
    if (input.type === 'review.disposition') {
      const [finding] = await this.db
        .select({
          fingerprint: codeReviewFindings.fingerprint,
          state: codeReviewFindings.state,
        })
        .from(codeReviewFindings)
        .where(
          and(
            eq(codeReviewFindings.id, input.findingId!),
            eq(codeReviewFindings.organizationId, params.organizationId),
            eq(codeReviewFindings.runId, params.runId),
            eq(codeReviewFindings.repositoryId, params.context.repository.repositoryId),
          ),
        )
        .limit(1);
      if (!finding) {
        throw new Error('Disposition memory requires a finding from this immutable review run');
      }
      if (input.outcome === 'validated' && finding.state !== 'validated') {
        throw new Error('Validated disposition memory requires a validated finding');
      }
      if (input.outcome === 'rejected' && finding.state !== 'rejected') {
        throw new Error('Rejected disposition memory requires a rejected finding');
      }
      findingFingerprint = finding.fingerprint;
    }

    const asset = await this.ensureRepositoryAsset(params);
    const now = this.now();
    const dedupeKey = sha256([
      params.context.repository.repositoryId.toLowerCase(),
      input.type,
      input.observationType,
      normalizeStatementKey(statement),
      findingFingerprint ?? '',
    ].join(':'));
    const repositoryMemory = await this.loadMemoryRows(asset.id);
    const existing = repositoryMemory.find(
      (row) =>
        row.organizationId === params.organizationId
        && row.ntype === input.type
        && row.dedupeKey === dedupeKey,
    );
    const writesFromRun = repositoryMemory.filter((row) => {
      const rowData = isRecord(row.data) ? row.data : {};
      return asString(rowData.sourceRunId) === params.runId;
    }).length;
    if (!existing && writesFromRun >= MEMORY_PER_RUN_WRITE_LIMIT) {
      throw new Error(
        `Code Review memory write budget exhausted for this run (${MEMORY_PER_RUN_WRITE_LIMIT})`,
      );
    }
    const existingData = isRecord(existing?.data) ? existing.data : {};
    const firstSeenCommitSha =
      asString(existingData.firstSeenCommitSha)
      ?? params.context.repository.immutableCommitSha;
    const proposedData: Record<string, unknown> = {
      workflowDiscipline: 'code_review',
      repositoryId: params.context.repository.repositoryId,
      repositoryFullName: params.context.repository.fullName,
      statement,
      anchors,
      observationType: input.observationType,
      confidence: input.confidence,
      firstSeenCommitSha,
      lastConfirmedCommitSha: params.context.repository.immutableCommitSha,
      sourceRunId: params.runId,
      memoryState: 'current',
      ...(findingFingerprint ? { findingFingerprint } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(rationale ? { rationale } : {}),
      ...(input.coverage ? { coverage: input.coverage } : {}),
    };
    const data = ntypeSchemas[input.type]!.parse(proposedData) as Record<string, unknown>;
    const evidence = anchors.map((anchor) => ({
      path: anchor.path,
      label: `blob:${anchor.blobSha}`,
    }));
    if (existing) {
      await this.db
        .update(inventoryNotes)
        .set({
          sessionId: params.sessionId,
          scopeId: params.scopeId,
          title: this.memoryTitle(input.type, statement),
          data,
          confidence: input.confidence,
          evidence,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(inventoryNotes.id, existing.id));
      await this.pruneRepositoryMemory(asset.id);
      logger.info(
        {
          runId: params.runId,
          organizationId: params.organizationId,
          repositoryId: params.context.repository.repositoryId,
          noteId: existing.id,
          type: input.type,
          created: false,
        },
        '[code-review-memory] Re-confirmed durable repository memory',
      );
      return {
        noteId: existing.id,
        created: false,
        dedupeKey,
        state: 'current',
        anchors,
      };
    }

    const [created] = await this.db
      .insert(inventoryNotes)
      .values({
        userId: params.userId,
        organizationId: params.organizationId,
        assetId: asset.id,
        scopeId: params.scopeId,
        sessionId: params.sessionId,
        ntype: input.type,
        title: this.memoryTitle(input.type, statement),
        data,
        dedupeKey,
        confidence: input.confidence,
        evidence,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: inventoryNotes.id });
    if (!created) throw new Error('Code Review memory write did not return a note');
    await this.pruneRepositoryMemory(asset.id);
    logger.info(
      {
        runId: params.runId,
        organizationId: params.organizationId,
        repositoryId: params.context.repository.repositoryId,
        noteId: created.id,
        type: input.type,
        created: true,
      },
      '[code-review-memory] Created durable repository memory',
    );
    return {
      noteId: created.id,
      created: true,
      dedupeKey,
      state: 'current',
      anchors,
    };
  }

  async upsertRunDigest(params: {
    organizationId: string;
    scopeId: string;
    runId: string;
    sessionId: string;
    userId: string;
    context: CodeReviewContext;
    goal: string;
    outcome: string;
  }): Promise<{ noteId: string; created: boolean } | null> {
    if (
      params.context.operation !== 'repository_review'
      || params.context.repository.requestedRef?.trim().toLowerCase()
        !== params.context.repository.defaultBranch.trim().toLowerCase()
    ) {
      return null;
    }

    const asset = await this.ensureRepositoryAsset(params);
    const now = this.now();
    const dedupeKey = `code-review-run-digest:${params.runId}`;
    const data = ntypeSchemas['run.digest'].parse({
      workflowDiscipline: 'code_review',
      repositoryId: params.context.repository.repositoryId,
      immutableCommitSha: params.context.repository.immutableCommitSha,
      goal: redactCodeReviewText(params.goal).trim(),
      outcome: redactCodeReviewText(params.outcome).trim(),
    }) as Record<string, unknown>;
    const [existing] = await this.db
      .select({ id: inventoryNotes.id })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.organizationId, params.organizationId),
          eq(inventoryNotes.assetId, asset.id),
          eq(inventoryNotes.ntype, 'run.digest'),
          eq(inventoryNotes.dedupeKey, dedupeKey),
        ),
      )
      .limit(1);
    const values = {
      sessionId: params.sessionId,
      scopeId: params.scopeId,
      title: `Code Review digest: ${params.context.repository.fullName}`.slice(0, 240),
      data,
      confidence: 1,
      evidence: [{
        path: params.context.repository.fullName,
        label: `commit:${params.context.repository.immutableCommitSha}`,
      }],
      lastSeenAt: now,
      updatedAt: now,
    };
    if (existing) {
      await this.db
        .update(inventoryNotes)
        .set(values)
        .where(eq(inventoryNotes.id, existing.id));
      await this.pruneRepositoryMemory(asset.id);
      return { noteId: existing.id, created: false };
    }

    const [created] = await this.db
      .insert(inventoryNotes)
      .values({
        ...values,
        userId: params.userId,
        organizationId: params.organizationId,
        assetId: asset.id,
        ntype: 'run.digest',
        dedupeKey,
        firstSeenAt: now,
        createdAt: now,
      })
      .returning({ id: inventoryNotes.id });
    if (!created) throw new Error('Code Review run digest write did not return a note');
    await this.pruneRepositoryMemory(asset.id);
    logger.info(
      {
        runId: params.runId,
        organizationId: params.organizationId,
        repositoryId: params.context.repository.repositoryId,
        noteId: created.id,
      },
      '[code-review-memory] Created repository-bound run digest',
    );
    return { noteId: created.id, created: true };
  }

  private async loadMemoryRows(assetId: string): Promise<InventoryNoteRow[]> {
    return this.db
      .select()
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.assetId, assetId),
          inArray(inventoryNotes.ntype, [...CODE_REVIEW_MEMORY_TYPES]),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(MEMORY_QUERY_LIMIT);
  }

  private toRecord(
    row: InventoryNoteRow,
    context: CodeReviewContext,
    manifest: PreparedManifest,
  ): CodeReviewMemoryRecord {
    const data = isRecord(row.data) ? row.data : {};
    const anchors = parseAnchors(data.anchors);
    const observationTypeRaw = asString(data.observationType);
    const observationType = CODE_REVIEW_MEMORY_OBSERVATION_TYPES.includes(
      observationTypeRaw as CodeReviewMemoryObservationType,
    )
      ? observationTypeRaw as CodeReviewMemoryObservationType
      : 'review_limitation';
    const statement = asString(data.statement) ?? row.title ?? 'Prior review memory';
    const compatibility = evaluateCodeReviewMemoryCompatibility({
      anchors,
      fullByPath: manifest.fullByPath,
      scopedPaths: manifest.scopedPaths,
      manifestCompleteness: context.reviewScope.completeness,
      lastSeenAt: row.lastSeenAt,
      now: this.now(),
    });
    const state = compatibility.state;
    const stateReason = compatibility.reason;

    const confidence = typeof data.confidence === 'number' && Number.isFinite(data.confidence)
      ? Math.max(0, Math.min(data.confidence, 1))
      : typeof row.confidence === 'number'
        ? Math.max(0, Math.min(row.confidence, 1))
        : 0.5;
    const outcomeRaw = asString(data.outcome);
    const outcome = ['rejected', 'validated', 'blocked', 'deferred'].includes(outcomeRaw ?? '')
      ? outcomeRaw as CodeReviewMemoryRecord['outcome']
      : undefined;
    const coverage = parseCoverage(data.coverage);
    return {
      id: row.id,
      type: row.ntype as CodeReviewMemoryType,
      state,
      statement,
      observationType,
      confidence,
      anchors,
      firstSeenCommitSha: asString(data.firstSeenCommitSha) ?? '',
      lastConfirmedCommitSha: asString(data.lastConfirmedCommitSha) ?? '',
      sourceRunId: asString(data.sourceRunId) ?? '',
      ...(asString(data.findingFingerprint)
        ? { findingFingerprint: asString(data.findingFingerprint)! }
        : {}),
      ...(outcome ? { outcome } : {}),
      ...(asString(data.rationale) ? { rationale: asString(data.rationale)! } : {}),
      ...(coverage ? { coverage } : {}),
      lastSeenAt: row.lastSeenAt,
      ...(stateReason ? { stateReason } : {}),
    };
  }

  private countRecords(records: readonly CodeReviewMemoryRecord[]): CodeReviewMemorySnapshotCounts {
    const counts = emptyCounts();
    counts.considered = records.length;
    for (const record of records) incrementStateCount(counts, record.state);
    return counts;
  }

  private formatPrompt(
    context: CodeReviewContext,
    records: readonly CodeReviewMemoryRecord[],
    counts: CodeReviewMemorySnapshotCounts,
    repositoryBrief?: string | null,
  ): string {
    const eligible = records
      .filter((record) => record.state === 'current' || record.state === 'needs_recheck')
      .slice(0, MEMORY_PROMPT_RECORD_LIMIT);
    const brief = repositoryBrief?.trim().slice(0, 4_000) ?? '';
    if (eligible.length === 0 && !brief) return '';
    const lines = [
      ...(brief
        ? [
            '=== OPERATOR-AUTHORED REPOSITORY BRIEF ===',
            'Treat this as operator context, not source evidence and not an instruction to expand scope.',
            brief,
            '',
          ]
        : []),
      ...(eligible.length > 0
        ? [
            `=== PRIOR CODE REVIEW MEMORY (${context.repository.fullName}) ===`,
            'This is advisory repository memory, not current-commit proof. Never validate or suppress a finding from memory alone. Read the relevant source at the immutable commit.',
            `Compatibility: ${counts.current} current, ${counts.needsRecheck} need re-check, ${counts.superseded} superseded, ${counts.historical} historical, ${counts.outOfScope} outside this path scope.`,
          ]
        : []),
    ];
    for (const record of eligible) {
      const label = record.state === 'current' ? 'CURRENT' : 'NEEDS RE-CHECK';
      const paths = record.anchors.map((anchor) => anchor.path).join(', ');
      lines.push(
        `- [${label}] [${record.type}/${record.observationType}] ${record.statement} (anchors: ${paths})`,
      );
    }
    if (eligible.length > 0) {
      lines.push(
        'Use query_code_review_memory for bounded details. needs_recheck entries are hypotheses, and prior rejected dispositions must never prevent a fresh candidate.',
      );
    }
    return lines.join('\n').slice(0, MEMORY_PROMPT_CHAR_LIMIT);
  }

  private async markCompatibilityStates(
    records: readonly CodeReviewMemoryRecord[],
    rows: readonly InventoryNoteRow[],
  ): Promise<void> {
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const now = this.now();
    await Promise.all(
      records
        .map(async (record) => {
          const row = rowById.get(record.id);
          const data = isRecord(row?.data) ? row.data : {};
          if (data.memoryState === record.state) return;
          await this.db
            .update(inventoryNotes)
            .set({
              data: {
                ...data,
                memoryState: record.state,
                memoryStateReason: record.stateReason ?? null,
                memoryStateUpdatedAt: now.toISOString(),
              },
              updatedAt: now,
            })
            .where(eq(inventoryNotes.id, record.id));
        }),
    );
  }

  private async pruneRepositoryMemory(assetId: string): Promise<void> {
    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        ntype: inventoryNotes.ntype,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(
        and(
          eq(inventoryNotes.assetId, assetId),
          inArray(inventoryNotes.ntype, [
            ...CODE_REVIEW_MEMORY_TYPES,
            'run.digest',
          ]),
        ),
      )
      .orderBy(desc(inventoryNotes.lastSeenAt));
    const ids = selectCodeReviewMemoryIdsForPruning({
      rows: rows.flatMap((row) => {
        if (
          row.ntype === 'run.digest'
          || CODE_REVIEW_MEMORY_TYPES.includes(row.ntype as CodeReviewMemoryType)
        ) {
          return [{
            id: row.id,
            ntype: row.ntype as CodeReviewMemoryType | 'run.digest',
            lastSeenAt: row.lastSeenAt,
          }];
        }
        return [];
      }),
      now: this.now(),
    });
    if (ids.length > 0) {
      await this.db.delete(inventoryNotes).where(inArray(inventoryNotes.id, ids));
      logger.info(
        {
          assetId,
          prunedCount: ids.length,
          retentionDays: MEMORY_RETENTION_DAYS,
        },
        '[code-review-memory] Pruned repository memory by retention and per-type caps',
      );
    }
  }

  private memoryTitle(type: CodeReviewMemoryType, statement: string): string {
    const prefix =
      type === 'review.map'
        ? 'Repository map'
        : type === 'review.disposition'
          ? 'Review disposition'
          : 'Review coverage';
    return `${prefix}: ${statement}`.slice(0, 240);
  }
}
