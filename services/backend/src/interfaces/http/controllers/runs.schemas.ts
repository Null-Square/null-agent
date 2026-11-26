import { z } from 'zod';
import { MODEL_CATEGORIES } from '@null-ai/contracts';
import { COMPLIANCE_FRAMEWORK_KEYS } from '@/domains/security-ops/compliance/frameworks';

export const MAX_RUN_LIST_LIMIT = 1000;
export const DEFAULT_RUN_LIST_LIMIT = 500;

const ListStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

const PauseReasonSchema = z.enum(['manual', 'approval', 'credits', 'runner', 'system']).nullable();
const ExecutionTargetSchema = z.enum(['cloud', 'scope_runner']);
const InteractionTypeSchema = z.enum(['none', 'plan_approval']);

const TriggerSchema = z.enum(['manual', 'scheduled', 'event']);
const WorkflowDisciplineSchema = z.enum(['pentest', 'compliance', 'code_review']);
const ComplianceFrameworkSchema = z.enum(COMPLIANCE_FRAMEWORK_KEYS);
const ComplianceAssessmentFocusSchema = z.enum(['assessment', 'evidence_mapping']);
export const MAX_COMPLIANCE_ASSESSMENT_CONTROL_IDS = 64;

export const RunIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

export const CodeReviewFindingParamSchema = RunIdParamSchema.extend({
  findingId: z.string().uuid('findingId must be a valid UUID'),
});

export const CodeReviewFixRequestBodySchema = z.object({
  findingVersion: z.number().int().positive(),
  vulnerableCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu),
});

export const RunsListQuerySchema = z.object({
  scopeId: z.string().uuid('scopeId must be a valid UUID').optional(),
  status: z.union([ListStatusSchema, z.literal('all')]).optional(),
  trigger: z.union([TriggerSchema, z.literal('all')]).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive number')
    .optional(),
});

export const RunCreateBodySchema = z.object({
  scopeId: z.string().min(1, 'scopeId is required'),
  goal: z.string().trim().min(1, 'goal is required'),
  modelId: z.string().uuid('modelId must be a valid UUID').optional(),
  modelCategory: z.enum(MODEL_CATEGORIES).optional(),
  executionTarget: ExecutionTargetSchema.optional(),
  trigger: TriggerSchema.optional(),
  vars: z.record(z.unknown()).optional(),
});

const RepositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => !value.startsWith('/') && !value.includes('\\') && !/(?:^|\/)\.\.(?:\/|$)/u.test(value),
    'repository paths must be relative and cannot contain traversal',
  );

/**
 * A scope has one code source, so the scope names the repository. The commit
 * is the source's current one (a clone's HEAD, or a folder's content hash).
 */
export const CodeReviewCreateBodySchema = z.object({
  scopeId: z.string().uuid('scopeId must be a valid UUID'),
  allowedPaths: z.array(RepositoryPathSchema).max(200).default([]),
  excludedPaths: z.array(RepositoryPathSchema).max(200).default([]),
  goal: z.string().trim().min(1).max(8_000).optional(),
  modelId: z.string().uuid('modelId must be a valid UUID').optional(),
  modelCategory: z.enum(MODEL_CATEGORIES).optional(),
});

export const CodeReviewContextSchema = z.object({
  operation: z.enum(['repository_review', 'pull_request_review', 'finding_fix']),
  repository: z.object({
    provider: z.enum(['github', 'local']),
    installationId: z.string(),
    repositoryId: z.string(),
    fullName: z.string(),
    visibility: z.enum(['private', 'public', 'internal', 'unknown']),
    immutableCommitSha: z.string(),
    requestedRef: z.string().optional(),
    defaultBranch: z.string(),
  }),
  reviewScope: z.object({
    mode: z.enum(['repository', 'paths', 'pull_request']),
    allowedPaths: z.array(z.string()),
    excludedPaths: z.array(z.string()),
    contextReadPolicy: z.string(),
    manifestHash: z.string(),
    completeness: z.enum(['complete', 'partial', 'blocked']),
  }),
  pullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    baseRef: z.string(),
    baseSha: z.string(),
    headRef: z.string(),
    headSha: z.string(),
    diffManifestHash: z.string(),
    deliveryId: z.string().optional(),
  }).optional(),
  findingFix: z.object({
    findingId: z.string().uuid(),
    findingVersion: z.number().int().positive(),
    vulnerableCommitSha: z.string(),
    approvedPatchHash: z.string().optional(),
    parentReviewRunId: z.string().uuid(),
  }).optional(),
  policySnapshot: z.object({
    version: z.string(),
    toolProfile: z.string(),
    pathPolicy: z.string(),
    networkPolicy: z.string(),
    publicationPolicy: z.string(),
  }),
});

const CodeReviewTimestampSchema = z.string().datetime();

export const CodeReviewSourceLocationSchema = z.object({
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  commitSha: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceExcerpt: z.string(),
  sourceExcerptSha256: z.string(),
  sourceOriginalSha256: z.string().optional(),
});

export const CodeReviewFindingSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  scopeId: z.string().uuid(),
  runId: z.string().uuid(),
  createdBySessionId: z.string().uuid().nullable(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  commitSha: z.string(),
  firstSeenCommitSha: z.string(),
  lastSeenCommitSha: z.string(),
  supersedesFindingId: z.string().uuid().nullable(),
  riskId: z.string().uuid().nullable(),
  fingerprint: z.string(),
  fingerprintVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  state: z.enum(['candidate', 'validated', 'rejected']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  confidence: z.number().min(0).max(1),
  category: z.string(),
  title: z.string(),
  summary: z.string(),
  impact: z.string(),
  remediation: z.string(),
  locations: z.array(CodeReviewSourceLocationSchema),
  changeAttribution: z.enum([
    'repository_scope',
    'introduced',
    'exposed',
    'worsened',
    'pre_existing_context',
  ]),
  attributionRationale: z.string().nullable(),
  validation: z.object({
    outcome: z.enum(['validated', 'rejected']),
    rationale: z.string(),
    validatedBySessionId: z.string().uuid(),
    validatedAt: CodeReviewTimestampSchema,
  }).nullable(),
  fixability: z.enum(['fixable', 'not_fixable', 'uncertain']),
  fixabilityRationale: z.string().nullable(),
  expectedFiles: z.array(z.string()),
  validationPlan: z.array(z.string()),
  createdAt: CodeReviewTimestampSchema,
  updatedAt: CodeReviewTimestampSchema,
});

export const CodeReviewReportSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  scopeId: z.string().uuid(),
  runId: z.string().uuid(),
  finalizedBySessionId: z.string().uuid().nullable(),
  executiveSummary: z.string(),
  scopeSummary: z.string(),
  markdown: z.string(),
  findingIds: z.array(z.string().uuid()),
  limitations: z.array(z.string()),
  completeness: z.enum(['complete', 'partial', 'blocked']),
  contentSha256: z.string(),
  createdAt: CodeReviewTimestampSchema,
  updatedAt: CodeReviewTimestampSchema,
});

export const CodeReviewFixRequestSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  findingId: z.string().uuid(),
  requestedByUserId: z.string().uuid(),
  findingVersion: z.number().int().positive(),
  vulnerableCommitSha: z.string(),
  status: z.enum([
    'requested',
    'generating',
    'preview_ready',
    'approved',
    'published',
    'failed',
    'cancelled',
  ]),
  createdAt: CodeReviewTimestampSchema,
  updatedAt: CodeReviewTimestampSchema,
});

export const CodeReviewGithubPublicationSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  scopeId: z.string().uuid(),
  pullRequestHeadId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  reportId: z.string().uuid().nullable(),
  status: z.enum([
    'queued',
    'processing',
    'retryable_failed',
    'published',
    'suppressed',
    'permanent_failed',
  ]),
  externalId: z.string(),
  remoteCheckRunId: z.number().int().nullable(),
  remoteCheckUrl: z.string().url().nullable(),
  contentSha256: z.string(),
  annotationsEnabled: z.boolean(),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: CodeReviewTimestampSchema,
  leaseExpiresAt: CodeReviewTimestampSchema.nullable(),
  lastAttemptAt: CodeReviewTimestampSchema.nullable(),
  lastError: z.string().nullable(),
  publishedAt: CodeReviewTimestampSchema.nullable(),
  createdAt: CodeReviewTimestampSchema,
  updatedAt: CodeReviewTimestampSchema,
});

export const CodeReviewRunBundleSchema = z.object({
  context: CodeReviewContextSchema,
  findings: z.array(CodeReviewFindingSchema),
  report: CodeReviewReportSchema.nullable(),
  fixRequests: z.array(CodeReviewFixRequestSchema),
  publication: CodeReviewGithubPublicationSchema.nullable(),
});

export const ComplianceReportCreateBodySchema = z.object({
  scopeId: z.string().min(1, 'scopeId is required'),
  framework: ComplianceFrameworkSchema,
  title: z.string().trim().min(1).optional(),
  sourceRunId: z.string().uuid('sourceRunId must be a valid UUID').nullable().optional(),
  modelId: z.string().uuid('modelId must be a valid UUID').optional(),
  modelCategory: z.enum(MODEL_CATEGORIES).optional(),
  executionTarget: ExecutionTargetSchema.optional(),
  trigger: TriggerSchema.optional(),
});

export const ComplianceAssessmentCreateBodySchema = z.object({
  scopeId: z.string().min(1, 'scopeId is required'),
  framework: ComplianceFrameworkSchema.default('soc2'),
  title: z.string().trim().min(1).optional(),
  controlIds: z
    .array(z.string().trim().min(1).max(80).transform((value) => value.toUpperCase()))
    .min(1)
    .max(MAX_COMPLIANCE_ASSESSMENT_CONTROL_IDS)
    .optional(),
  modelId: z.string().uuid('modelId must be a valid UUID').optional(),
  modelCategory: z.enum(MODEL_CATEGORIES).optional(),
  executionTarget: ExecutionTargetSchema.optional(),
  trigger: TriggerSchema.optional(),
  focus: ComplianceAssessmentFocusSchema.optional(),
});

export const RunActionResponseSchema = z.object({
  success: z.boolean(),
});

export const RunApproveBodySchema = z.object({}).strict();

export const PlanFeedbackBodySchema = z.object({
  feedback: z.string().trim().min(1, 'feedback is required'),
});

export const RunSummarySchema = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid(),
  activeSessionId: z.string().uuid().nullable().optional(),
  sessionId: z.string().uuid().nullable(),
  plannerSessionId: z.string().uuid().nullable().optional(),
  executorSessionId: z.string().uuid().nullable().optional(),
  modelId: z.string().uuid().nullable().optional(),
  modelCategory: z.enum(MODEL_CATEGORIES).nullable().optional(),
  title: z.string().nullable().optional(),
  goal: z.string(),
  executionTarget: ExecutionTargetSchema.optional(),
  workflowDiscipline: WorkflowDisciplineSchema.optional(),
  codeReviewOperation: z
    .enum(['repository_review', 'pull_request_review', 'finding_fix'])
    .nullable()
    .optional(),
  codeReviewContext: CodeReviewContextSchema.nullable().optional(),
  status: ListStatusSchema,
  pauseReason: PauseReasonSchema.optional(),
  interactionType: InteractionTypeSchema.optional(),
  awaitingPlanApproval: z.boolean().optional(),
  trigger: TriggerSchema,
  displayId: z.string(),
  scopeName: z.string(),
  impactTolerance: z.enum(['non_destructive', 'poc', 'full']).optional(),
  findingsDiscovered: z.number().optional(),
  inventoryChanges: z.string().optional(),
  runnerId: z.string().uuid().nullable().optional(),
  runnerName: z.string().nullable().optional(),
  queuedAt: z.coerce.date().nullable().optional(),
  capacityWaitReason: z
    .enum([
      'waiting_for_capacity',
      'waiting_for_plan_slot',
      'preparing_secure_environment',
      'launch_recovered',
      'unable_to_schedule_safely',
    ])
    .nullable()
    .optional(),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date().optional(),
});

export const RunUsageTotalsSchema = z.object({
  promptTokens: z.number(),
  cachedPromptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  nativeCost: z.number(),
  overhead: z.number(),
  platformCost: z.number(),
  platformPrice: z.number(),
  creditEquivalent: z.number(),
  credits: z.number(),
  entries: z.number(),
});

export const RunUsagePhaseSummarySchema = RunUsageTotalsSchema.extend({
  sessionId: z.string().uuid(),
});

export const RunUsageSummarySchema = z.object({
  total: RunUsageTotalsSchema,
  planner: RunUsagePhaseSummarySchema.nullable(),
  executor: RunUsagePhaseSummarySchema.nullable(),
});

export const RunDetailSchema = RunSummarySchema.extend({
  plan: z.string().nullable().optional(),
  findingsCount: z.number().optional(),
  inventoryAdded: z.number().optional(),
  usageSummary: RunUsageSummarySchema,
}).passthrough();

export const RunStartResponseSchema = z.object({
  run: RunSummarySchema,
  sessionId: z.string().uuid().nullable(),
  policySlug: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
  idempotentReplay: z.boolean().optional(),
  runner: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      type: z.string().optional(),
      status: z.string().optional(),
    })
    .nullable()
    .optional(),
  scheduling: z.object({
    state: z.enum(['queued', 'preparing', 'started']),
    reason: z
      .enum([
        'waiting_for_capacity',
        'waiting_for_plan_slot',
        'preparing_secure_environment',
        'launch_recovered',
        'unable_to_schedule_safely',
      ])
      .nullable(),
    submittedAt: z.coerce.date().nullable(),
    estimatedStart: z.coerce.date().nullable(),
  }).optional(),
});

export const CodeReviewStartResponseSchema = RunStartResponseSchema.extend({
  codeReview: z.object({
    repository: z.string(),
    immutableCommitSha: z.string(),
    manifestHash: z.string(),
    manifestFileCount: z.number().int().nonnegative(),
    completeness: z.enum(['complete', 'partial', 'blocked']),
  }),
});

export const RunApproveResponseSchema = z.object({
  run: RunSummarySchema,
  sessionId: z.string().uuid(),
  policySlug: z.string().nullable().optional(),
});

export const RunPlanFeedbackResponseSchema = z.object({
  success: z.literal(true),
  run: RunSummarySchema,
  plannerSessionId: z.string().uuid(),
});
