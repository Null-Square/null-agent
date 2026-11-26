import { createHash } from 'node:crypto';

import { db } from '@/db/client';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import {
  CodeReviewFindingService,
  ReportCodeReviewCandidateSchema,
  ValidateCodeReviewFindingSchema,
  resolveCodeReviewSourceAnchor,
  type VerifiedCodeReviewLocation,
} from '@/domains/security-ops/code-review/CodeReviewFindingService';
import {
  CODE_REVIEW_MEMORY_OBSERVATION_TYPES,
  CODE_REVIEW_MEMORY_TYPES,
  CodeReviewMemoryService,
  type CodeReviewMemoryType,
} from '@/domains/security-ops/code-review/CodeReviewMemoryService';
import { redactCodeReviewText } from '@/domains/security-ops/code-review/CodeReviewRedaction';
import { logger } from '@/shared/logger';
import {
  filterCodeReviewManifestFiles,
  validateCodeReviewRepositoryRead,
} from '@/domains/security-ops/runs/codeReviewRunContext';
import { resolveSecurityOpsToolContext } from '../securityopsContext';
import { formatToolError, pickToolArgsPreview } from './shared';
import {
  loadBoundCodeReviewManifest,
  requireHostedPort,
  resolveCodeReviewRepositorySource,
} from './codeReviewSource';

const findingService = new CodeReviewFindingService(db);
const memoryService = new CodeReviewMemoryService(db);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireCodeReviewContext = (
  ctx: ToolContext,
  allowedPhases: readonly string[],
) => {
  const context = resolveSecurityOpsToolContext(ctx);
  if (
    context.workflowDiscipline !== 'code_review'
    || !context.codeReview
    || !context.organizationId
    || !context.scopeId
    || !context.runId
  ) {
    throw new Error('This tool requires a typed standalone Code Review run context');
  }
  if (!context.activePhaseKey || !allowedPhases.includes(context.activePhaseKey)) {
    throw new Error(
      `This Code Review tool is only available in ${allowedPhases.join(' or ')}`,
    );
  }
  return context as typeof context & {
    organizationId: string;
    scopeId: string;
    runId: string;
    codeReview: NonNullable<typeof context.codeReview>;
    activePhaseKey: string;
  };
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const MAX_CODE_REVIEW_SEARCH_FILES = 50;
const MAX_CODE_REVIEW_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_CODE_REVIEW_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_CODE_REVIEW_SEARCH_MATCHES = 50;
const MAX_CODE_REVIEW_SEARCH_MATCHES_PER_FILE = 5;

/**
 * Memory selector shared by the hosted read and write paths so a hosted host
 * evaluates anchor compatibility against exactly the manifest the tools serve.
 */
const hostedMemorySelector = (
  context: ReturnType<typeof requireCodeReviewContext>,
  manifest: { files: Array<{ path: string; blobSha: string; size?: number | null }> },
) => ({
  manifestFiles: manifest.files,
  immutableCommitSha: context.codeReview.repository.immutableCommitSha,
  manifestCompleteness: context.codeReview.reviewScope.completeness,
  allowedPaths: context.codeReview.reviewScope.allowedPaths,
  excludedPaths: context.codeReview.reviewScope.excludedPaths,
});

export const ListCodeReviewRepositoryFiles: ToolImpl = {
  meta: {
    name: 'list_code_review_repository_files',
    description:
      'List a page of files from the immutable manifest bound to this Code Review run. The backend re-resolves the exact commit and rejects manifest drift.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ListCodeReviewRepositoryFiles.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, [
            'planning',
            'review_mapping',
            'review_analysis',
            'review_validation',
          ]);
          const result = await loadBoundCodeReviewManifest(ctx, context);
          const manifestHash = context.codeReview.reviewScope.manifestHash;
          const files = filterCodeReviewManifestFiles({
            files: result.files,
            allowedPaths: context.codeReview.reviewScope.allowedPaths,
            excludedPaths: context.codeReview.reviewScope.excludedPaths,
          });
          const input = isRecord(args) ? args : {};
          const offset = Number.isSafeInteger(input.offset) && Number(input.offset) >= 0
            ? Number(input.offset)
            : 0;
          const limit = Number.isSafeInteger(input.limit)
            ? Math.max(1, Math.min(Number(input.limit), 500))
            : 200;
          return {
            ok: true,
            data: {
              repositoryId: result.repositoryId,
              repository: result.repository,
              commitSha: result.ref,
              manifestHash,
              completeness:
                result.completeness === 'partial'
                  ? 'partial'
                  : context.codeReview.reviewScope.completeness,
              files: files.slice(offset, offset + limit),
              offset,
              limit,
              totalCount: files.length,
              hasMore: offset + limit < files.length,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['offset', 'limit']),
    );
  },
};

export const SearchCodeReviewRepository: ToolImpl = {
  meta: {
    name: 'search_code_review_repository',
    description:
      'Search a bounded page of manifest-authorized text files for a literal string at the exact immutable Code Review commit. Results contain redacted line previews and explicit scan coverage.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 120 },
        caseSensitive: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
        maxFiles: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_CODE_REVIEW_SEARCH_FILES,
        },
      },
      required: ['query'],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SearchCodeReviewRepository.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, [
            'planning',
            'review_mapping',
            'review_analysis',
            'review_validation',
          ]);
          const input = isRecord(args) ? args : {};
          const query = typeof input.query === 'string' ? input.query.trim() : '';
          if (query.length < 2 || query.length > 120) {
            throw new Error('query must contain between 2 and 120 characters');
          }
          const caseSensitive = input.caseSensitive === true;
          const offset = Number.isSafeInteger(input.offset) && Number(input.offset) >= 0
            ? Number(input.offset)
            : 0;
          const maxFiles = Number.isSafeInteger(input.maxFiles)
            ? Math.max(1, Math.min(Number(input.maxFiles), MAX_CODE_REVIEW_SEARCH_FILES))
            : 20;
          const source = resolveCodeReviewRepositorySource(ctx, context);
          const manifest = await loadBoundCodeReviewManifest(ctx, context);
          const manifestHash = context.codeReview.reviewScope.manifestHash;
          const files = filterCodeReviewManifestFiles({
            files: manifest.files,
            allowedPaths: context.codeReview.reviewScope.allowedPaths,
            excludedPaths: context.codeReview.reviewScope.excludedPaths,
          });
          const page = files.slice(offset, offset + maxFiles);
          const needle = caseSensitive ? query : query.toLowerCase();
          const matches: Array<{
            filePath: string;
            line: number;
            preview: string;
          }> = [];
          const skippedFiles: Array<{ filePath: string; reason: string }> = [];
          let scannedBytes = 0;
          let processedFiles = 0;
          let byteBudgetReached = false;
          let matchLimitReached = false;

          for (const file of page) {
            if (
              typeof file.size === 'number'
              && file.size > MAX_CODE_REVIEW_SEARCH_FILE_BYTES
            ) {
              skippedFiles.push({ filePath: file.path, reason: 'file_too_large' });
              processedFiles += 1;
              continue;
            }
            if (scannedBytes >= MAX_CODE_REVIEW_SEARCH_BYTES) {
              byteBudgetReached = true;
              break;
            }

            try {
              const readValidation = validateCodeReviewRepositoryRead({
                context: context.codeReview,
                repository: context.codeReview.repository.repositoryId,
                ref: context.codeReview.repository.immutableCommitSha,
                path: file.path,
              });
              if (!readValidation.ok) {
                throw new Error(readValidation.issues.join('; '));
              }
              const result = await source.readFile({
                path: file.path,
                ref: context.codeReview.repository.immutableCommitSha,
              });
              const content = result.content.replace(/\r\n?/gu, '\n');
              const contentBytes = Buffer.byteLength(content, 'utf8');
              if (
                contentBytes > MAX_CODE_REVIEW_SEARCH_FILE_BYTES
                || scannedBytes + contentBytes > MAX_CODE_REVIEW_SEARCH_BYTES
              ) {
                skippedFiles.push({ filePath: file.path, reason: 'byte_budget' });
                processedFiles += 1;
                continue;
              }
              scannedBytes += contentBytes;
              let fileMatches = 0;
              for (const [lineIndex, line] of content.split('\n').entries()) {
                const haystack = caseSensitive ? line : line.toLowerCase();
                if (!haystack.includes(needle)) continue;
                matches.push({
                  filePath: file.path,
                  line: lineIndex + 1,
                  preview: redactCodeReviewText(line).slice(0, 500),
                });
                fileMatches += 1;
                if (
                  fileMatches >= MAX_CODE_REVIEW_SEARCH_MATCHES_PER_FILE
                  || matches.length >= MAX_CODE_REVIEW_SEARCH_MATCHES
                ) {
                  matchLimitReached = true;
                  break;
                }
              }
            } catch (error) {
              skippedFiles.push({
                filePath: file.path,
                reason: formatToolError(error).slice(0, 240),
              });
            }
            processedFiles += 1;
            if (matches.length >= MAX_CODE_REVIEW_SEARCH_MATCHES) break;
          }

          const nextOffset = offset + processedFiles;
          const truncationReasons = [
            ...(byteBudgetReached ? ['byte_budget'] : []),
            ...(matchLimitReached ? ['match_limit'] : []),
            ...(skippedFiles.length > 0 ? ['skipped_files'] : []),
          ];
          return {
            ok: true,
            data: {
              repositoryId: manifest.repositoryId,
              commitSha: manifest.ref,
              manifestHash,
              querySha256: sha256(query),
              queryLength: query.length,
              caseSensitive,
              matches,
              matchCount: matches.length,
              offset,
              nextOffset,
              processedFiles,
              totalManifestFiles: files.length,
              scannedBytes,
              skippedFiles,
              hasMore: nextOffset < files.length,
              truncated: truncationReasons.length > 0,
              truncationReasons,
              completeness:
                nextOffset < files.length || truncationReasons.length > 0
                  ? 'partial'
                  : manifest.completeness,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['caseSensitive', 'offset', 'maxFiles']),
    );
  },
};

export const QueryCodeReviewMemory: ToolImpl = {
  meta: {
    name: 'query_code_review_memory',
    description:
      'Query bounded repository memory labeled against the current immutable manifest. Memory is advisory and never substitutes for reading current source.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string', enum: [...CODE_REVIEW_MEMORY_TYPES] },
          maxItems: CODE_REVIEW_MEMORY_TYPES.length,
        },
        query: { type: 'string', minLength: 2, maxLength: 160 },
        includeNeedsRecheck: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryCodeReviewMemory.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, [
            'review_mapping',
            'review_analysis',
            'review_validation',
          ]);
          const input = isRecord(args) ? args : {};
          const types = Array.isArray(input.types)
            ? input.types.filter(
                (value): value is CodeReviewMemoryType =>
                  typeof value === 'string'
                  && CODE_REVIEW_MEMORY_TYPES.includes(value as CodeReviewMemoryType),
              )
            : undefined;
          const manifest = await loadBoundCodeReviewManifest(ctx, context);
          const hostedPort = requireHostedPort(context);
          if (hostedPort) {
            if (!hostedPort.queryCodeReviewMemory) {
              throw new Error('This host does not provide durable Code Review memory');
            }
            return {
              ok: true,
              data: {
                ...(await hostedPort.queryCodeReviewMemory({
                  ...hostedMemorySelector(context, manifest),
                  ...(types?.length ? { types } : {}),
                  ...(typeof input.query === 'string' ? { query: input.query } : {}),
                  includeNeedsRecheck: input.includeNeedsRecheck !== false,
                  ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
                }) as Record<string, unknown>),
                proofBoundary:
                  'Memory is advisory. Read relevant source at the current immutable commit before reporting, validating, rejecting, or suppressing a finding.',
              },
            };
          }
          const session = ctx.sessionStore.get(ctx.sessionId);
          if (!session?.userId) throw new Error('Code Review memory requires a user-bound session');
          const result = await memoryService.queryMemory({
            organizationId: context.organizationId,
            scopeId: context.scopeId,
            userId: session.userId,
            context: context.codeReview,
            manifestFiles: manifest.files,
            ...(types?.length ? { types } : {}),
            ...(typeof input.query === 'string' ? { query: input.query } : {}),
            includeNeedsRecheck: input.includeNeedsRecheck !== false,
            ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          });
          return {
            ok: true,
            data: {
              ...result,
              records: result.records.map((record) => ({
                ...record,
                lastSeenAt: record.lastSeenAt.toISOString(),
              })),
              proofBoundary:
                'Memory is advisory. Read relevant source at the current immutable commit before reporting, validating, rejecting, or suppressing a finding.',
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['types', 'query', 'includeNeedsRecheck', 'limit']),
    );
  },
};

export const RecordCodeReviewMemory: ToolImpl = {
  meta: {
    name: 'record_code_review_memory',
    description:
      'Propose one durable repository-memory statement. The backend binds repository, commit, blob hashes, finding identity, scope, and write eligibility.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...CODE_REVIEW_MEMORY_TYPES] },
        statement: { type: 'string', minLength: 8, maxLength: 1200 },
        observationType: {
          type: 'string',
          enum: [...CODE_REVIEW_MEMORY_OBSERVATION_TYPES],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        anchorPaths: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 500 },
          minItems: 1,
          maxItems: 8,
        },
        findingId: { type: 'string', format: 'uuid' },
        outcome: {
          type: 'string',
          enum: ['rejected', 'validated', 'blocked', 'deferred'],
        },
        rationale: { type: 'string', minLength: 8, maxLength: 1200 },
        coverage: {
          type: 'object',
          properties: {
            reviewedPathPrefixes: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 500 },
              maxItems: 50,
            },
            techniquesAttempted: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 160 },
              maxItems: 50,
            },
            skippedPaths: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', minLength: 1, maxLength: 500 },
                  reason: { type: 'string', minLength: 1, maxLength: 500 },
                },
                required: ['path', 'reason'],
              },
              maxItems: 50,
            },
            result: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
          },
          required: [
            'reviewedPathPrefixes',
            'techniquesAttempted',
            'skippedPaths',
            'result',
          ],
        },
      },
      required: ['type', 'statement', 'observationType', 'confidence', 'anchorPaths'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      RecordCodeReviewMemory.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, [
            'review_mapping',
            'review_validation',
            'review_reporting',
          ]);
          const manifest = await loadBoundCodeReviewManifest(ctx, context);
          const hostedPort = requireHostedPort(context);
          const result = hostedPort
            ? await (async () => {
                if (!hostedPort.recordCodeReviewMemory) {
                  throw new Error('This host does not provide durable Code Review memory');
                }
                return hostedPort.recordCodeReviewMemory({
                  ...hostedMemorySelector(context, manifest),
                  runId: context.runId,
                  sessionId: ctx.sessionId,
                  phaseKey: context.activePhaseKey,
                  operation: context.codeReview.operation,
                  defaultBranchReview:
                    context.codeReview.repository.requestedRef?.trim().toLowerCase()
                    === context.codeReview.repository.defaultBranch.trim().toLowerCase(),
                  input: isRecord(args) ? args : {},
                }) as Promise<Record<string, unknown>>;
              })()
            : await (async () => {
                const session = ctx.sessionStore.get(ctx.sessionId);
                if (!session?.userId) {
                  throw new Error('Code Review memory requires a user-bound session');
                }
                return memoryService.recordMemory({
                  organizationId: context.organizationId,
                  scopeId: context.scopeId,
                  runId: context.runId,
                  sessionId: ctx.sessionId,
                  userId: session.userId,
                  phaseKey: context.activePhaseKey,
                  context: context.codeReview,
                  manifestFiles: manifest.files,
                  input: args,
                });
              })();
          return {
            ok: true,
            data: {
              ...result,
              backendBound: {
                repositoryId: context.codeReview.repository.repositoryId,
                commitSha: context.codeReview.repository.immutableCommitSha,
                manifestHash: context.codeReview.reviewScope.manifestHash,
              },
            },
          };
        } catch (error) {
          let securityContext: ReturnType<typeof resolveSecurityOpsToolContext> | undefined;
          try {
            securityContext = resolveSecurityOpsToolContext(ctx);
          } catch {
            // Preserve the original governed-write rejection. Telemetry must
            // never replace it with a secondary context-resolution failure.
          }
          logger.warn(
            {
              organizationId: securityContext?.organizationId,
              scopeId: securityContext?.scopeId,
              runId: securityContext?.runId,
              phaseKey: securityContext?.activePhaseKey,
              reason: formatToolError(error),
            },
            '[code-review-memory] Rejected durable memory write',
          );
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['type', 'observationType', 'confidence', 'anchorPaths', 'findingId', 'outcome']),
    );
  },
};

export const ReportCodeReviewCandidate: ToolImpl = {
  meta: {
    name: 'report_code_review_candidate',
    description:
      'Persist a source-attributed Code Review candidate. Copy an exact sourceAnchor from the immutable repository read; the backend resolves its line range and hashes the source, so model-counted line numbers are never trusted.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        category: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        impact: { type: 'string' },
        remediation: { type: 'string' },
        changeAttribution: {
          type: 'string',
          enum: [
            'repository_scope',
            'introduced',
            'exposed',
            'worsened',
            'pre_existing_context',
          ],
          description:
            'Use repository_scope for full repository reviews. Pull-request reviews must classify whether the PR introduced, exposed, worsened, or merely contextualized the issue.',
        },
        attributionRationale: {
          type: 'string',
          description: 'Required for pull-request review candidates.',
        },
        locations: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              commitSha: {
                type: 'string',
                description: 'Optional exact source commit. Defaults to review head; PR reviews may use the typed base SHA for deleted or modified source.',
              },
              sourceAnchor: {
                type: 'string',
                description:
                  'Exact, case-sensitive source text copied from read_connected_repository_file. Include the security-relevant source, guard, or sink itself rather than a nearby declaration or comment.',
              },
              occurrence: {
                type: 'integer',
                minimum: 1,
                description:
                  '1-based match occurrence. Omit when the sourceAnchor is unique; required when identical source text occurs more than once.',
              },
              contextBeforeLines: {
                type: 'integer',
                minimum: 0,
                maximum: 20,
                default: 1,
              },
              contextAfterLines: {
                type: 'integer',
                minimum: 0,
                maximum: 20,
                default: 1,
              },
            },
            required: ['filePath', 'sourceAnchor'],
          },
        },
      },
      required: [
        'severity',
        'confidence',
        'category',
        'title',
        'summary',
        'impact',
        'remediation',
        'changeAttribution',
        'locations',
      ],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ReportCodeReviewCandidate.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, ['review_analysis']);
          const input = ReportCodeReviewCandidateSchema.parse(args);
          const source = resolveCodeReviewRepositorySource(ctx, context);
          const fileCache = new Map<string, string>();
          const verifiedLocations: VerifiedCodeReviewLocation[] = [];

          for (const location of input.locations) {
            const locationCommitSha =
              location.commitSha ?? context.codeReview.repository.immutableCommitSha;
            const fileCacheKey = `${locationCommitSha.toLowerCase()}:${location.filePath}`;
            const readValidation = validateCodeReviewRepositoryRead({
              context: context.codeReview,
              repository: context.codeReview.repository.repositoryId,
              ref: locationCommitSha,
              path: location.filePath,
            });
            if (!readValidation.ok) {
              throw new Error(readValidation.issues.join('; '));
            }
            let content = fileCache.get(fileCacheKey);
            if (content === undefined) {
              const file = await source.readFile({
                path: location.filePath,
                ref: locationCommitSha,
              });
              content = file.content.replace(/\r\n?/gu, '\n');
              fileCache.set(fileCacheKey, content);
            }
            const resolvedLocation = resolveCodeReviewSourceAnchor(
              redactCodeReviewText(content),
              location,
            );
            const sourceExcerpt = content
              .split('\n')
              .slice(resolvedLocation.startLine - 1, resolvedLocation.endLine)
              .join('\n');
            verifiedLocations.push({
              filePath: location.filePath,
              commitSha: locationCommitSha,
              startLine: resolvedLocation.startLine,
              endLine: resolvedLocation.endLine,
              sourceExcerpt: resolvedLocation.sourceExcerpt,
              sourceExcerptSha256: sha256(resolvedLocation.sourceExcerpt),
              sourceOriginalSha256: sha256(sourceExcerpt),
            });
          }

          const hostedPort = requireHostedPort(context);
          if (hostedPort) {
            if (!hostedPort.reportCodeReviewCandidate) {
              throw new Error('This host does not persist Code Review candidates');
            }
            const hosted = await hostedPort.reportCodeReviewCandidate({
              runId: context.runId,
              sessionId: ctx.sessionId,
              fingerprint: sha256([
                context.codeReview.repository.repositoryId.toLowerCase(),
                input.category.trim().toLowerCase(),
                ...verifiedLocations.map(
                  (location) =>
                    `${location.filePath.toLowerCase()}:${location.startLine}:${location.endLine}`,
                ),
              ].join('|')),
              input: input as unknown as Record<string, unknown>,
              verifiedLocations,
            });
            return { ok: true, data: hosted };
          }
          const result = await findingService.reportCandidate({
            organizationId: context.organizationId,
            runId: context.runId,
            sessionId: ctx.sessionId,
            input,
            verifiedLocations,
          });
          return {
            ok: true,
            data: {
              findingId: result.finding.id,
              created: result.created,
              state: result.finding.state,
              version: result.finding.version,
              locations: result.finding.locations,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(
        args,
        ['title', 'severity', 'category', 'changeAttribution', 'locations'],
      ),
    );
  },
};

export const QueryCodeReviewFindings: ToolImpl = {
  meta: {
    name: 'query_code_review_findings',
    description:
      'Query candidates and validated or rejected findings belonging only to the current Code Review run.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['candidate', 'validated', 'rejected'],
        },
      },
      required: [],
    },
    risks: ['read'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      QueryCodeReviewFindings.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, [
            'review_analysis',
            'review_validation',
            'review_reporting',
          ]);
          const input = isRecord(args) ? args : {};
          const state = ['candidate', 'validated', 'rejected'].includes(String(input.state))
            ? input.state as 'candidate' | 'validated' | 'rejected'
            : undefined;
          const hostedPort = requireHostedPort(context);
          if (hostedPort) {
            if (!hostedPort.queryCodeReviewFindings) {
              throw new Error('This host does not persist Code Review findings');
            }
            return {
              ok: true,
              data: await hostedPort.queryCodeReviewFindings(state ? { state } : {}),
            };
          }
          const findings = await findingService.listFindings({
            organizationId: context.organizationId,
            runId: context.runId,
            state,
          });
          return {
            ok: true,
            data: {
              findings,
              totalCount: findings.length,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(args, ['state']),
    );
  },
};

export const ValidateCodeReviewFinding: ToolImpl = {
  meta: {
    name: 'validate_code_review_finding',
    description:
      'Record the independent outcome for one current-run Code Review candidate. The agent owns the fixability judgment; fixable outcomes must include the expected files and validation plan needed by the later user-controlled fix flow.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        findingId: { type: 'string' },
        findingVersion: {
          type: 'integer',
          minimum: 1,
          description: 'Exact candidate version returned by query_code_review_findings.',
        },
        outcome: { type: 'string', enum: ['validated', 'rejected'] },
        rationale: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        fixability: { type: 'string', enum: ['fixable', 'not_fixable', 'uncertain'] },
        fixabilityRationale: { type: 'string' },
        expectedFiles: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        validationPlan: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      },
      required: [
        'findingId',
        'findingVersion',
        'outcome',
        'rationale',
        'confidence',
        'fixability',
      ],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      ValidateCodeReviewFinding.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, ['review_validation']);
          const input = ValidateCodeReviewFindingSchema.parse(args);
          for (const filePath of input.expectedFiles) {
            const validation = validateCodeReviewRepositoryRead({
              context: context.codeReview,
              repository: context.codeReview.repository.repositoryId,
              ref: context.codeReview.repository.immutableCommitSha,
              path: filePath,
            });
            if (!validation.ok) {
              throw new Error(`Expected fix file ${filePath} is out of scope: ${validation.issues.join('; ')}`);
            }
          }
          const hostedPort = requireHostedPort(context);
          if (hostedPort) {
            if (!hostedPort.validateCodeReviewFinding) {
              throw new Error('This host does not persist Code Review validation outcomes');
            }
            return {
              ok: true,
              data: await hostedPort.validateCodeReviewFinding({
                runId: context.runId,
                sessionId: ctx.sessionId,
                input: input as unknown as Record<string, unknown>,
              }),
            };
          }
          const finding = await findingService.validateFinding({
            organizationId: context.organizationId,
            runId: context.runId,
            sessionId: ctx.sessionId,
            input,
          });
          return { ok: true, data: finding };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(
        args,
        ['findingId', 'findingVersion', 'outcome', 'confidence', 'fixability'],
      ),
    );
  },
};

export const FinalizeCodeReviewReport: ToolImpl = {
  meta: {
    name: 'finalize_code_review_report',
    description:
      'Finalize the standalone Code Review report from canonical validated findings. Pentest findings and report machinery are never consulted.',
    category: 'securityops',
    progressKind: 'canonical',
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        scopeSummary: { type: 'string' },
        limitations: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        completeness: {
          type: 'string',
          enum: ['complete', 'partial', 'blocked'],
          description:
            'Honest review coverage outcome. Complete manifest retrieval does not by itself prove complete review coverage.',
        },
      },
      required: ['executiveSummary', 'scopeSummary', 'limitations', 'completeness'],
    },
    risks: ['write'],
    returns: 'json',
  },

  async run(args, ctx: ToolContext) {
    return runWithGuards(
      FinalizeCodeReviewReport.meta,
      ctx,
      async () => {
        try {
          const context = requireCodeReviewContext(ctx, ['review_reporting']);
          const hostedPort = requireHostedPort(context);
          if (hostedPort) {
            if (!hostedPort.finalizeCodeReviewReport) {
              throw new Error('This host does not persist Code Review reports');
            }
            return {
              ok: true,
              data: await hostedPort.finalizeCodeReviewReport({
                runId: context.runId,
                sessionId: ctx.sessionId,
                input: isRecord(args) ? args : {},
              }),
            };
          }
          const report = await findingService.finalizeReport({
            organizationId: context.organizationId,
            runId: context.runId,
            sessionId: ctx.sessionId,
            input: args,
          });
          if (!report) {
            throw new Error('Code Review report could not be persisted');
          }
          return {
            ok: true,
            data: {
              reportId: report.id,
              findingIds: report.findingIds,
              completeness: report.completeness,
              contentSha256: report.contentSha256,
            },
          };
        } catch (error) {
          return { ok: false, data: { error: formatToolError(error) } };
        }
      },
      {},
      pickToolArgsPreview(
        args,
        ['executiveSummary', 'scopeSummary', 'limitations', 'completeness'],
      ),
    );
  },
};
