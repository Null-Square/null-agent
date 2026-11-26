import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { agentSessions } from "./agent-brain";
import { organizations, users } from "./platform";
import { runs } from "./security-ops-core";
import { scopes } from "./security-ops-foundation";
import { findings } from "./security-ops-inventory";

export type CodeReviewFindingState = "candidate" | "validated" | "rejected";
export type CodeReviewFixability = "fixable" | "not_fixable" | "uncertain";
export type CodeReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type CodeReviewChangeAttribution =
  | "repository_scope"
  | "introduced"
  | "exposed"
  | "worsened"
  | "pre_existing_context";

export type CodeReviewSourceLocation = {
  repositoryId: string;
  repositoryFullName: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceExcerpt: string;
  sourceExcerptSha256: string;
  sourceOriginalSha256?: string;
};

export type CodeReviewValidation = {
  outcome: "validated" | "rejected";
  rationale: string;
  validatedBySessionId: string;
  validatedAt: string;
};

export type CodeReviewMemorySnapshotCounts = {
  considered: number;
  current: number;
  needsRecheck: number;
  superseded: number;
  historical: number;
  outOfScope: number;
};

export type CodeReviewPullRequestLineRange = {
  start: number;
  end: number;
};

export type CodeReviewPullRequestFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changedLineRanges: CodeReviewPullRequestLineRange[];
  patchAvailable: boolean;
};

export type CodeReviewPullRequestHeadState =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "superseded"
  | "draft"
  | "closed";

export type CodeReviewGitHubPublicationStatus =
  | "queued"
  | "processing"
  | "retryable_failed"
  | "published"
  | "suppressed"
  | "permanent_failed";

export type CodeReviewGitHubDeliveryStatus =
  | "pending"
  | "processing"
  | "completed"
  | "retryable_failed"
  | "permanent_failed";

export const codeReviewFindings = pgTable(
  "code_review_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    createdBySessionId: uuid("created_by_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    commitSha: text("commit_sha").notNull(),
    firstSeenCommitSha: text("first_seen_commit_sha").notNull(),
    lastSeenCommitSha: text("last_seen_commit_sha").notNull(),
    supersedesFindingId: uuid("supersedes_finding_id").references(
      (): AnyPgColumn => codeReviewFindings.id,
      { onDelete: "set null" },
    ),
    riskId: uuid("risk_id").references(() => findings.id, { onDelete: "set null" }),
    fingerprint: text("fingerprint").notNull(),
    fingerprintVersion: integer("fingerprint_version").notNull().default(1),
    version: integer("version").notNull().default(1),
    state: text("state").$type<CodeReviewFindingState>().notNull().default("candidate"),
    severity: text("severity").$type<CodeReviewFindingSeverity>().notNull(),
    confidence: real("confidence").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    impact: text("impact").notNull(),
    remediation: text("remediation").notNull(),
    locations: jsonb("locations").$type<CodeReviewSourceLocation[]>().notNull(),
    changeAttribution: text("change_attribution")
      .$type<CodeReviewChangeAttribution>()
      .notNull()
      .default("repository_scope"),
    attributionRationale: text("attribution_rationale"),
    validation: jsonb("validation").$type<CodeReviewValidation>(),
    fixability: text("fixability").$type<CodeReviewFixability>().notNull().default("uncertain"),
    fixabilityRationale: text("fixability_rationale"),
    expectedFiles: text("expected_files").array().notNull().default([]),
    validationPlan: text("validation_plan").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runFingerprintUnq: uniqueIndex("code_review_findings_run_fingerprint_unq").on(
      table.runId,
      table.fingerprint,
    ),
    runStateIdx: index("code_review_findings_run_state_idx").on(table.runId, table.state),
    orgScopeIdx: index("code_review_findings_org_scope_idx").on(
      table.organizationId,
      table.scopeId,
      table.createdAt,
    ),
    repositoryFingerprintIdx: index("code_review_findings_repository_fingerprint_idx").on(
      table.organizationId,
      table.repositoryId,
      table.fingerprint,
      table.createdAt,
    ),
    riskIdx: index("code_review_findings_risk_idx").on(table.riskId),
    stateCheck: check(
      "code_review_findings_state_check",
      sql`${table.state} IN ('candidate', 'validated', 'rejected')`,
    ),
    severityCheck: check(
      "code_review_findings_severity_check",
      sql`${table.severity} IN ('critical', 'high', 'medium', 'low', 'info')`,
    ),
    confidenceCheck: check(
      "code_review_findings_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    fixabilityCheck: check(
      "code_review_findings_fixability_check",
      sql`${table.fixability} IN ('fixable', 'not_fixable', 'uncertain')`,
    ),
    attributionCheck: check(
      "code_review_findings_attribution_check",
      sql`${table.changeAttribution} IN ('repository_scope', 'introduced', 'exposed', 'worsened', 'pre_existing_context')`,
    ),
  }),
);

export type CodeReviewFindingRow = typeof codeReviewFindings.$inferSelect;
export type NewCodeReviewFindingRow = typeof codeReviewFindings.$inferInsert;

export const codeReviewReports = pgTable(
  "code_review_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    finalizedBySessionId: uuid("finalized_by_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    executiveSummary: text("executive_summary").notNull(),
    scopeSummary: text("scope_summary").notNull(),
    markdown: text("markdown").notNull(),
    findingIds: uuid("finding_ids").array().notNull().default([]),
    limitations: text("limitations").array().notNull().default([]),
    completeness: text("completeness").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUnq: uniqueIndex("code_review_reports_run_unq").on(table.runId),
    orgScopeIdx: index("code_review_reports_org_scope_idx").on(
      table.organizationId,
      table.scopeId,
      table.createdAt,
    ),
    completenessCheck: check(
      "code_review_reports_completeness_check",
      sql`${table.completeness} IN ('complete', 'partial', 'blocked')`,
    ),
  }),
);

export type CodeReviewReportRow = typeof codeReviewReports.$inferSelect;
export type NewCodeReviewReportRow = typeof codeReviewReports.$inferInsert;

export const codeReviewRunMemorySnapshots = pgTable(
  "code_review_run_memory_snapshots",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    promptText: text("prompt_text").notNull().default(""),
    counts: jsonb("counts").$type<CodeReviewMemorySnapshotCounts>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgRepositoryIdx: index("code_review_run_memory_snapshots_org_repository_idx").on(
      table.organizationId,
      table.repositoryId,
      table.createdAt,
    ),
  }),
);

export type CodeReviewRunMemorySnapshotRow = typeof codeReviewRunMemorySnapshots.$inferSelect;
export type NewCodeReviewRunMemorySnapshotRow = typeof codeReviewRunMemorySnapshots.$inferInsert;

export const codeReviewFixRequests = pgTable(
  "code_review_fix_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => codeReviewFindings.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    findingVersion: integer("finding_version").notNull(),
    vulnerableCommitSha: text("vulnerable_commit_sha").notNull(),
    status: text("status").notNull().default("requested"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    findingVersionUnq: uniqueIndex("code_review_fix_requests_finding_version_unq").on(
      table.findingId,
      table.findingVersion,
    ),
    statusCheck: check(
      "code_review_fix_requests_status_check",
      sql`${table.status} IN ('requested', 'generating', 'preview_ready', 'approved', 'published', 'failed', 'cancelled')`,
    ),
  }),
);

export type CodeReviewFixRequestRow = typeof codeReviewFixRequests.$inferSelect;
export type NewCodeReviewFixRequestRow = typeof codeReviewFixRequests.$inferInsert;
