import type { ComplianceFrameworkKey, ModelCategory } from "@null-ai/contracts";
import {
  sql,
} from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-brain";
import { models, organizations, users } from "./platform";
import { scopes } from "./security-ops-foundation";
import { findings, type RiskState } from "./security-ops-inventory";
export type ComplianceEvidenceSourceType =
  | "user_upload"
  | "user_attestation"
  | "agent_finding"
  | "integration";

export type ComplianceEvidenceType =
  | "policy"
  | "access_review"
  | "risk_register"
  | "incident_record"
  | "continuity_exercise"
  | "vendor_review"
  | "change_approval"
  | "training_record"
  | "system_export"
  | "other";

export type ComplianceEvidenceReviewStatus =
  | "unreviewed"
  | "expired";

export type ComplianceEvidenceMappingSource =
  | "user_declared"
  | "system_suggested";

export type ComplianceEvidenceMappingConfidence = "low" | "medium" | "high";

export type ComplianceAcceptedRiskStatus = "active" | "expired" | "revoked";
export type ComplianceControlCheckVerdict = "pass" | "fail" | "needs_context" | "not_attempted";
export type ComplianceControlCheckBasis = "agent_tested" | "agent_reviewed_user_evidence" | "agent_reviewed_integration";
export type ComplianceControlCheckActorType = "agent" | "system" | "operator";
export type ComplianceControlCheckReviewDecision = "confirmed" | "rejected" | "retest_required";
export type ComplianceControlMonitoringState = "monitored" | "excluded";
export type ComplianceControlRequestStatus =
  | "open"
  | "fulfilled"
  | "reviewed"
  | "insufficient"
  | "contradicted"
  | "cancelled";
export type ComplianceControlRequestType = "evidence" | "access" | "context" | "remediation";
export type ComplianceControlRequestPriority = "low" | "medium" | "high";
export type ComplianceReadinessProjectStatus = "active" | "completed" | "archived";
export type ComplianceIntegrationSyncStatus = "running" | "completed" | "partial" | "failed";
export type IdentityIntegrationProvider = "microsoft_entra" | "google_workspace";
export type IdentityIntegrationConnectionStatus = "connected" | "error" | "revoked";
export type RunWorkflowDiscipline = "pentest" | "compliance" | "code_review";
export type RunnerOwnership = "organization" | "platform";
export type RunnerSchedulingMode = "accepting" | "hold" | "draining";
export type RunAdmissionPurpose = "planning" | "execution";
export type RunSchedulingClass = "free" | "paid" | "pro" | "internal";
export type CapacityProfileKey = "control" | "standard" | "heavy";
export type CapacityLeasePurpose = "control" | "execution_base" | "minimum_worker" | "optional_worker";
export type CapacityLeaseState = "held" | "active" | "releasing" | "released";
export type CodeReviewOperation = "repository_review" | "pull_request_review" | "finding_fix";
export type CodeReviewRepositoryVisibility = "private" | "public" | "internal" | "unknown";
export type CodeReviewScopeMode = "repository" | "paths" | "pull_request";
export type CodeReviewCompleteness = "complete" | "partial" | "blocked";
export type CodeReviewContext = {
  operation: CodeReviewOperation;
  repository: {
    /** `local`: the scope's code source (a local folder or a git clone on this computer). */
    provider: "github" | "local";
    installationId: string;
    repositoryId: string;
    fullName: string;
    visibility: CodeReviewRepositoryVisibility;
    immutableCommitSha: string;
    requestedRef?: string;
    defaultBranch: string;
  };
  reviewScope: {
    mode: CodeReviewScopeMode;
    allowedPaths: string[];
    excludedPaths: string[];
    contextReadPolicy: string;
    manifestHash: string;
    completeness: CodeReviewCompleteness;
  };
  pullRequest?: {
    number: number;
    url: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    diffManifestHash: string;
    deliveryId?: string;
  };
  findingFix?: {
    findingId: string;
    findingVersion: number;
    vulnerableCommitSha: string;
    approvedPatchHash?: string;
    parentReviewRunId: string;
  };
  policySnapshot: {
    version: string;
    toolProfile: string;
    pathPolicy: string;
    networkPolicy: string;
    publicationPolicy: string;
  };
};
export type PerformanceSummaryStatus = "ready" | "partial" | "unavailable";
export type PerformanceSummarySource = "prometheus" | "docker_stats" | "trace_only" | "mixed";
export type ScopeDocumentKind = "policy" | "roe" | "access_list" | "network" | "prior_report" | "other";
export type ScopeDocumentParseStatus = "parsed" | "empty" | "unsupported" | "error";
export type SetupRecommendationDismissalSurface = "home" | "assistant" | "onboarding";

export const complianceEvidenceItems = pgTable(
  "compliance_evidence_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    sourceType: text("source_type").$type<ComplianceEvidenceSourceType>().notNull().default("user_upload"),
    evidenceType: text("evidence_type").$type<ComplianceEvidenceType>().notNull().default("other"),
    owner: text("owner"),
    status: text("status").$type<ComplianceEvidenceReviewStatus>().notNull().default("unreviewed"),
    artifact: jsonb("artifact")
      .$type<{
        fileName?: string | null;
        mimeType?: string | null;
        sizeBytes?: number | null;
        sha256?: string | null;
        storageRef?: string | null;
        sourceRef?: string | null;
      }>()
      .notNull()
      .default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    observationStartedAt: timestamp("observation_started_at", { withTimezone: true }),
    observationEndedAt: timestamp("observation_ended_at", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeStatusIdx: index("compliance_evidence_items_org_scope_status_idx").on(
      table.organizationId,
      table.scopeId,
      table.status,
    ),
    validUntilIdx: index("compliance_evidence_items_valid_until_idx").on(table.validUntil),
    sourceTypeCheck: check(
      "compliance_evidence_items_source_type_check",
      sql`${table.sourceType} IN ('user_upload', 'user_attestation', 'agent_finding', 'integration')`,
    ),
    evidenceTypeCheck: check(
      "compliance_evidence_items_evidence_type_check",
      sql`${table.evidenceType} IN ('policy', 'access_review', 'risk_register', 'incident_record', 'continuity_exercise', 'vendor_review', 'change_approval', 'training_record', 'system_export', 'other')`,
    ),
    statusCheck: check(
      "compliance_evidence_items_status_check",
      sql`${table.status} IN ('unreviewed', 'expired')`,
    ),
  }),
);

export type ComplianceEvidenceItemRow = typeof complianceEvidenceItems.$inferSelect;
export type NewComplianceEvidenceItemRow = typeof complianceEvidenceItems.$inferInsert;

export const complianceEvidenceMappings = pgTable(
  "compliance_evidence_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evidenceItemId: uuid("evidence_item_id")
      .notNull()
      .references(() => complianceEvidenceItems.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    mappingSource: text("mapping_source")
      .$type<ComplianceEvidenceMappingSource>()
      .notNull()
      .default("user_declared"),
    confidence: text("confidence").$type<ComplianceEvidenceMappingConfidence>().notNull().default("medium"),
    rationale: text("rationale"),
    citationAnchors: jsonb("citation_anchors")
      .$type<Array<{
        page?: number | null;
        section?: string | null;
        line?: number | null;
        chunkId?: string | null;
        excerpt?: string | null;
        excerptSha256?: string | null;
      }>>()
      .notNull()
      .default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemFrameworkControlUnq: uniqueIndex("compliance_evidence_mappings_item_framework_control_unq").on(
      table.evidenceItemId,
      table.frameworkKey,
      table.controlId,
    ),
    orgControlIdx: index("compliance_evidence_mappings_org_control_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.controlId,
    ),
    sourceCheck: check(
      "compliance_evidence_mappings_source_check",
      sql`${table.mappingSource} IN ('user_declared', 'system_suggested')`,
    ),
    confidenceCheck: check(
      "compliance_evidence_mappings_confidence_check",
      sql`${table.confidence} IN ('low', 'medium', 'high')`,
    ),
  }),
);

export type ComplianceEvidenceMappingRow = typeof complianceEvidenceMappings.$inferSelect;
export type NewComplianceEvidenceMappingRow = typeof complianceEvidenceMappings.$inferInsert;

export const complianceAcceptedRisks = pgTable(
  "compliance_accepted_risks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    evidenceItemId: uuid("evidence_item_id").references(() => complianceEvidenceItems.id, { onDelete: "set null" }),
    owner: text("owner").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").$type<ComplianceAcceptedRiskStatus>().notNull().default("active"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgControlIdx: index("compliance_accepted_risks_org_control_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.controlId,
      table.status,
    ),
    expiresIdx: index("compliance_accepted_risks_expires_idx").on(table.expiresAt),
    statusCheck: check(
      "compliance_accepted_risks_status_check",
      sql`${table.status} IN ('active', 'expired', 'revoked')`,
    ),
  }),
);

export type ComplianceAcceptedRiskRow = typeof complianceAcceptedRisks.$inferSelect;
export type NewComplianceAcceptedRiskRow = typeof complianceAcceptedRisks.$inferInsert;

export const complianceIntegrationSyncs = pgTable(
  "compliance_integration_syncs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    accountRef: text("account_ref"),
    status: text("status").$type<ComplianceIntegrationSyncStatus>().notNull().default("running"),
    evidenceCreated: integer("evidence_created").notNull().default(0),
    evidenceUpdated: integer("evidence_updated").notNull().default(0),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProviderStartedIdx: index("compliance_integration_syncs_org_provider_started_idx").on(
      table.organizationId,
      table.provider,
      table.startedAt,
    ),
    scopeProviderStartedIdx: index("compliance_integration_syncs_scope_provider_started_idx").on(
      table.scopeId,
      table.provider,
      table.startedAt,
    ),
    statusCheck: check(
      "compliance_integration_syncs_status_check",
      sql`${table.status} IN ('running', 'completed', 'partial', 'failed')`,
    ),
  }),
);

export type ComplianceIntegrationSyncRow = typeof complianceIntegrationSyncs.$inferSelect;
export type NewComplianceIntegrationSyncRow = typeof complianceIntegrationSyncs.$inferInsert;

export const complianceReadinessProjects = pgTable(
  "compliance_readiness_projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    frameworkKey: text("framework_key").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<ComplianceReadinessProjectStatus>().notNull().default("active"),
    observationStartedAt: timestamp("observation_started_at", { withTimezone: true }),
    observationEndedAt: timestamp("observation_ended_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeIdx: index("compliance_readiness_projects_org_scope_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.status,
    ),
    statusCheck: check(
      "compliance_readiness_projects_status_check",
      sql`${table.status} IN ('active', 'completed', 'archived')`,
    ),
  }),
);

export type ComplianceReadinessProjectRow = typeof complianceReadinessProjects.$inferSelect;
export type NewComplianceReadinessProjectRow = typeof complianceReadinessProjects.$inferInsert;

export const complianceControlStatusSnapshots = pgTable(
  "compliance_control_status_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").references(() => complianceReadinessProjects.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    status: text("status").notNull(),
    score: integer("score").notNull().default(0),
    evidenceItemIds: jsonb("evidence_item_ids").$type<string[]>().notNull().default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("compliance_control_status_snapshots_project_idx").on(
      table.projectId,
      table.frameworkKey,
      table.controlId,
    ),
    orgGeneratedIdx: index("compliance_control_status_snapshots_org_generated_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.generatedAt,
    ),
  }),
);

export type ComplianceControlStatusSnapshotRow = typeof complianceControlStatusSnapshots.$inferSelect;
export type NewComplianceControlStatusSnapshotRow = typeof complianceControlStatusSnapshots.$inferInsert;

export const scopeTargets = pgTable(
  "scope_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: text("value").notNull(),
    verified: boolean("verified").notNull().default(false),
    verificationMethod: text("verification_method"),
    verificationToken: text("verification_token"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeTypeValueUnq: uniqueIndex("scope_targets_scope_type_value_unq").on(
      table.scopeId,
      table.type,
      table.value,
    ),
    scopeIdx: index("scope_targets_scope_idx").on(table.scopeId),
    verificationMethodCheck: check(
      "scope_targets_verification_method_check",
      sql`${table.verificationMethod} IS NULL OR ${table.verificationMethod} IN ('dns_txt', 'http_well_known', 'manual_review', 'legacy_auto', 'none', 'connected_site', 'wordpress_plugin', 'lab')`,
    ),
  }),
);

export type ScopeTargetRow = typeof scopeTargets.$inferSelect;
export type NewScopeTargetRow = typeof scopeTargets.$inferInsert;

export const scopeDocuments = pgTable(
  "scope_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ScopeDocumentKind>().notNull().default("other"),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    parsedText: text("parsed_text"),
    parseStatus: text("parse_status").$type<ScopeDocumentParseStatus>().notNull().default("unsupported"),
    parseError: text("parse_error"),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeCreatedIdx: index("scope_documents_org_scope_created_idx").on(
      table.organizationId,
      table.scopeId,
      table.createdAt,
    ),
    scopeKindIdx: index("scope_documents_scope_kind_idx").on(table.scopeId, table.kind),
    kindCheck: check(
      "scope_documents_kind_check",
      sql`${table.kind} IN ('policy', 'roe', 'access_list', 'network', 'prior_report', 'other')`,
    ),
    parseStatusCheck: check(
      "scope_documents_parse_status_check",
      sql`${table.parseStatus} IN ('parsed', 'empty', 'unsupported', 'error')`,
    ),
  }),
);

export type ScopeDocumentRow = typeof scopeDocuments.$inferSelect;
export type NewScopeDocumentRow = typeof scopeDocuments.$inferInsert;

export const setupRecommendationDismissals = pgTable(
  "setup_recommendation_dismissals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    actionId: text("action_id").notNull(),
    stateSignature: text("state_signature").notNull(),
    surface: text("surface").$type<SetupRecommendationDismissalSurface>().notNull().default("home"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userScopeActionSignatureUnq: uniqueIndex("setup_rec_dismissals_user_scope_action_sig_unq").on(
      table.userId,
      table.scopeId,
      table.actionId,
      table.stateSignature,
    ),
    orgScopeIdx: index("setup_rec_dismissals_org_scope_idx").on(
      table.organizationId,
      table.scopeId,
      table.dismissedAt,
    ),
    surfaceCheck: check(
      "setup_rec_dismissals_surface_check",
      sql`${table.surface} IN ('home', 'assistant', 'onboarding')`,
    ),
  }),
);

export type SetupRecommendationDismissalRow = typeof setupRecommendationDismissals.$inferSelect;
export type NewSetupRecommendationDismissalRow = typeof setupRecommendationDismissals.$inferInsert;

export const runners = pgTable(
  "runners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().default("private"),
    ownership: text("ownership").$type<RunnerOwnership>().notNull().default("organization"),
    status: text("status").notNull().default("offline"),
    schedulingMode: text("scheduling_mode").$type<RunnerSchedulingMode>().notNull().default("hold"),
    platform: text("platform"),
    architecture: text("architecture"),
    ipAddress: text("ip_address"),
    version: text("version"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    hostFingerprint: text("host_fingerprint"),
    capacityPolicyVersion: integer("capacity_policy_version").notNull().default(1),
    detectedMemoryMb: integer("detected_memory_mb"),
    detectedContainerSlots: integer("detected_container_slots"),
    derivedActiveRunLimit: integer("derived_active_run_limit"),
    capacitySource: text("capacity_source"),
    healthSnapshot: jsonb("health_snapshot").$type<Record<string, unknown>>(),
    heartbeatSequence: bigint("heartbeat_sequence", { mode: "number" }).notNull().default(0),
    schedulingReason: text("scheduling_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("runners_org_idx").on(table.organizationId),
    statusIdx: index("runners_status_idx").on(table.organizationId, table.status),
    platformNameUnq: uniqueIndex("runners_platform_name_unq")
      .on(table.name)
      .where(sql`${table.ownership} = 'platform'`),
    statusCheck: check(
      "runners_status_check",
      sql`${table.status} IN ('online', 'busy', 'offline', 'quarantined')`,
    ),
    ownershipCheck: check(
      "runners_ownership_check",
      sql`(
        (${table.ownership} = 'platform' AND ${table.organizationId} IS NULL AND ${table.type} = 'cloud')
        OR
        (${table.ownership} = 'organization' AND ${table.organizationId} IS NOT NULL AND ${table.type} = 'private')
      )`,
    ),
    schedulingModeCheck: check(
      "runners_scheduling_mode_check",
      sql`${table.schedulingMode} IN ('accepting', 'hold', 'draining')`,
    ),
    capacityValuesCheck: check(
      "runners_capacity_values_check",
      sql`(
        (${table.detectedMemoryMb} IS NULL OR ${table.detectedMemoryMb} > 0)
        AND (${table.detectedContainerSlots} IS NULL OR ${table.detectedContainerSlots} > 0)
        AND (${table.derivedActiveRunLimit} IS NULL OR ${table.derivedActiveRunLimit} > 0)
      )`,
    ),
  }),
);

export type RunnerRow = typeof runners.$inferSelect;
export type NewRunnerRow = typeof runners.$inferInsert;

export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    gracePeriodUntil: timestamp("grace_period_until", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runnerIdx: index("runner_tokens_runner_idx").on(table.runnerId),
    hashIdx: uniqueIndex("runner_tokens_hash_unq").on(table.tokenHash),
  }),
);

export type RunnerTokenRow = typeof runnerTokens.$inferSelect;
export type NewRunnerTokenRow = typeof runnerTokens.$inferInsert;

export const runnerScopeAssignments = pgTable(
  "runner_scope_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runnerScopeUnq: uniqueIndex("runner_scope_unq").on(table.runnerId, table.scopeId),
    scopeUnq: uniqueIndex("runner_scope_scope_unq").on(table.scopeId),
    scopeIdx: index("runner_scope_scope_idx").on(table.scopeId),
  }),
);

export type RunnerScopeAssignmentRow = typeof runnerScopeAssignments.$inferSelect;
export type NewRunnerScopeAssignmentRow = typeof runnerScopeAssignments.$inferInsert;

/**
 * What caused a run to start.
 *
 * Declared once, next to the column it describes, because the union was
 * previously copied into four services and two router casts — and a value added
 * in one place but not the others fails at a cast rather than at the compiler.
 *
 * `exposure_verification` is deliberately separate from `event`: those runs are
 * narrowly scoped to one advisory against one asset, and keeping them
 * distinguishable is what makes cost per verification measurable rather than
 * lost inside general automation spend.
 */
export const RUN_TRIGGERS = [
  'manual',
  'scheduled',
  'watch_scheduled',
  'event',
  'exposure_verification',
] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    displayId: serial("display_id"),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    plannerSessionId: uuid("planner_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    executorSessionId: uuid("executor_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    modelId: uuid("model_id").references(() => models.id, {
      onDelete: "set null",
    }),
    modelCategory: text("model_category").$type<ModelCategory>(),
    title: text("title"),
    goal: text("goal").notNull(),
    plan: text("plan"),
    missionEnvelope: jsonb("mission_envelope").$type<unknown>(),
    assignedSkillSlugs: text("assigned_skill_slugs").array(),
    idempotencyKey: text("idempotency_key"),
    workflowDiscipline: text("workflow_discipline").$type<RunWorkflowDiscipline>().notNull().default("pentest"),
    codeReviewOperation: text("code_review_operation").$type<CodeReviewOperation>(),
    codeReviewContext: jsonb("code_review_context").$type<CodeReviewContext>(),
    // Compliance framework this run targets. Null for pentest runs; set for compliance runs so
    // reporting can scope to the run's framework instead of every framework configured on the scope.
    complianceFrameworkKey: text("compliance_framework_key").$type<ComplianceFrameworkKey>(),
    executionTarget: text("execution_target").notNull().default("cloud"),
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").$type<RunTrigger>().notNull().default("manual"),
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    admissionEpoch: integer("admission_epoch").notNull().default(0),
    admissionPurpose: text("admission_purpose").$type<RunAdmissionPurpose>(),
    schedulingClass: text("scheduling_class").$type<RunSchedulingClass>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    notBeforeAt: timestamp("not_before_at", { withTimezone: true }),
    capacityWaitReason: text("capacity_wait_reason"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    admissionAttemptCount: integer("admission_attempt_count").notNull().default(0),
    admissionLastError: text("admission_last_error"),
    capacityProfile: text("capacity_profile").$type<CapacityProfileKey>(),
    capacityProfileVersion: integer("capacity_profile_version"),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    epochStartedAt: timestamp("epoch_started_at", { withTimezone: true }),
    launchPayload: jsonb("launch_payload").$type<Record<string, unknown>>(),
    findingsCount: integer("findings_count").notNull().default(0),
    inventoryAdded: integer("inventory_added").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("runs_org_idx").on(table.organizationId),
    scopeIdx: index("runs_scope_idx").on(table.scopeId),
    sessionIdx: index("runs_session_idx").on(table.sessionId),
    plannerSessionIdx: index("runs_planner_session_idx").on(table.plannerSessionId),
    executorSessionIdx: index("runs_executor_session_idx").on(table.executorSessionId),
    statusIdx: index("runs_status_idx").on(table.status),
    admissionQueueIdx: index("runs_admission_queue_idx").on(
      table.status,
      table.notBeforeAt,
      table.eligibleAt,
      table.queuedAt,
    ),
    admissionClaimIdx: index("runs_admission_claim_idx").on(table.claimExpiresAt, table.claimOwner),
    workflowDisciplineIdx: index("runs_workflow_discipline_idx").on(table.workflowDiscipline),
    userIdx: index("runs_user_idx").on(table.userId),
    orgIdempotencyUnq: uniqueIndex("runs_org_idempotency_key_unq").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    statusCheck: check(
      "runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'credits_exhausted', 'user_paused', 'awaiting_user', 'awaiting_approval', 'runner_unavailable', 'system_paused', 'completed', 'failed', 'cancelled')`,
    ),
    workflowDisciplineCheck: check(
      "runs_workflow_discipline_check",
      sql`${table.workflowDiscipline} IN ('pentest', 'compliance', 'code_review')`,
    ),
    admissionPurposeCheck: check(
      "runs_admission_purpose_check",
      sql`${table.admissionPurpose} IS NULL OR ${table.admissionPurpose} IN ('planning', 'execution')`,
    ),
    schedulingClassCheck: check(
      "runs_scheduling_class_check",
      sql`${table.schedulingClass} IS NULL OR ${table.schedulingClass} IN ('free', 'paid', 'pro', 'internal')`,
    ),
    capacityProfileCheck: check(
      "runs_capacity_profile_check",
      sql`${table.capacityProfile} IS NULL OR ${table.capacityProfile} IN ('control', 'standard', 'heavy')`,
    ),
    codeReviewIdentityCheck: check(
      "runs_code_review_identity_check",
      sql`(
        (
          ${table.workflowDiscipline} = 'code_review'
          AND ${table.codeReviewOperation} IN ('repository_review', 'pull_request_review', 'finding_fix')
          AND ${table.codeReviewContext} IS NOT NULL
          AND ${table.codeReviewContext}->>'operation' = ${table.codeReviewOperation}
          AND ${table.complianceFrameworkKey} IS NULL
        )
        OR
        (
          ${table.workflowDiscipline} <> 'code_review'
          AND ${table.codeReviewOperation} IS NULL
          AND ${table.codeReviewContext} IS NULL
        )
      )`,
    ),
  }),
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;

export const capacityLeases = pgTable(
  "capacity_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    admissionEpoch: integer("admission_epoch").notNull(),
    parentLeaseId: uuid("parent_lease_id").references((): AnyPgColumn => capacityLeases.id, {
      onDelete: "set null",
    }),
    bundleKey: text("bundle_key").notNull(),
    purpose: text("purpose").$type<CapacityLeasePurpose>().notNull(),
    profileKey: text("profile_key").$type<CapacityProfileKey>().notNull(),
    profileVersion: integer("profile_version").notNull().default(1),
    memoryMb: integer("memory_mb").notNull(),
    containerSlots: integer("container_slots").notNull(),
    cpuMillis: integer("cpu_millis"),
    pidLimit: integer("pid_limit"),
    sidecarSnapshot: jsonb("sidecar_snapshot").$type<Record<string, unknown>>(),
    state: text("state").$type<CapacityLeaseState>().notNull().default("held"),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    workerTaskId: uuid("worker_task_id"),
    runtimeIdentities: jsonb("runtime_identities").$type<string[]>().notNull().default([]),
    reason: text("reason"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    liveRunnerIdx: index("capacity_leases_live_runner_idx")
      .on(table.runnerId, table.state),
    runEpochIdx: index("capacity_leases_run_epoch_idx")
      .on(table.runId, table.admissionEpoch),
    liveBundleUnq: uniqueIndex("capacity_leases_live_bundle_unq")
      .on(table.runId, table.admissionEpoch, table.bundleKey)
      .where(sql`${table.state} IN ('held', 'active', 'releasing')`),
    stateCheck: check(
      "capacity_leases_state_check",
      sql`${table.state} IN ('held', 'active', 'releasing', 'released')`,
    ),
    purposeCheck: check(
      "capacity_leases_purpose_check",
      sql`${table.purpose} IN ('control', 'execution_base', 'minimum_worker', 'optional_worker')`,
    ),
    profileCheck: check(
      "capacity_leases_profile_check",
      sql`${table.profileKey} IN ('control', 'standard', 'heavy')`,
    ),
    resourceCheck: check(
      "capacity_leases_resource_check",
      sql`${table.memoryMb} >= 0 AND ${table.containerSlots} >= 0 AND (${table.cpuMillis} IS NULL OR ${table.cpuMillis} > 0) AND (${table.pidLimit} IS NULL OR ${table.pidLimit} > 0)`,
    ),
  }),
);

export type CapacityLeaseRow = typeof capacityLeases.$inferSelect;
export type NewCapacityLeaseRow = typeof capacityLeases.$inferInsert;

export type FindingDispositionRequestedState = "resolved" | "dismissed";
export type FindingDispositionVerificationStatus =
  | "queued"
  | "waiting"
  | "launching"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";
export type FindingDispositionVerificationOutcome =
  | "fixed"
  | "still_present"
  | "false_positive"
  | "validated"
  | "inconclusive";

export type FindingDispositionSnapshot = {
  schemaVersion: 1;
  finding: {
    id: string;
    title: string;
    summary: string;
    severity: string;
    state: RiskState;
    lifecycleVersion: number;
    assetId: string | null;
    endpointId?: string | null;
    serviceId?: string | null;
    pocDescription?: string | null;
    assumptions?: string | null;
  };
  asset: {
    id: string;
    kind: string;
    value: string;
  } | null;
  targets: Array<{
    id: string;
    type: string;
    value: string;
    verified: boolean;
  }>;
  capturedAt: string;
};

/**
 * One immutable, durable attempt to verify an operator-proposed finding
 * disposition. Long-running execution remains owned by the linked product Run.
 */
export const findingDispositionVerifications = pgTable(
  "finding_disposition_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id").notNull(),
    previousVerificationId: uuid("previous_verification_id").references(
      (): AnyPgColumn => findingDispositionVerifications.id,
      { onDelete: "set null" },
    ),
    attemptNumber: integer("attempt_number").notNull().default(1),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    requestKey: text("request_key").notNull(),
    requestedState: text("requested_state")
      .$type<FindingDispositionRequestedState>()
      .notNull(),
    reason: text("reason"),
    snapshot: jsonb("snapshot").$type<FindingDispositionSnapshot>().notNull(),
    priorState: text("prior_state").$type<RiskState>().notNull(),
    findingLifecycleVersion: integer("finding_lifecycle_version").notNull(),
    status: text("status")
      .$type<FindingDispositionVerificationStatus>()
      .notNull()
      .default("queued"),
    waitReason: text("wait_reason"),
    failureCode: text("failure_code"),
    failureReason: text("failure_reason"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    launchAttemptCount: integer("launch_attempt_count").notNull().default(0),
    maxLaunchAttempts: integer("max_launch_attempts").notNull().default(3),
    automaticAttempt: boolean("automatic_attempt").notNull().default(false),
    launchKey: text("launch_key").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome").$type<FindingDispositionVerificationOutcome>(),
    outcomeReason: text("outcome_reason"),
    blockerCode: text("blocker_code"),
    proof: jsonb("proof").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeFindingUnq: uniqueIndex("finding_disposition_verifications_active_finding_unq")
      .on(table.findingId)
      .where(sql`${table.status} IN ('queued', 'waiting', 'launching', 'running')`),
    orgRequestKeyUnq: uniqueIndex("finding_disposition_verifications_org_request_key_unq").on(
      table.organizationId,
      table.requestKey,
    ),
    seriesAttemptUnq: uniqueIndex("finding_disposition_verifications_series_attempt_unq").on(
      table.seriesId,
      table.attemptNumber,
    ),
    launchKeyUnq: uniqueIndex("finding_disposition_verifications_launch_key_unq").on(
      table.launchKey,
    ),
    runUnq: uniqueIndex("finding_disposition_verifications_run_unq").on(table.runId),
    dueIdx: index("finding_disposition_verifications_due_idx")
      .on(table.nextAttemptAt, table.organizationId)
      .where(sql`${table.status} IN ('queued', 'waiting', 'launching')`),
    findingCreatedIdx: index("finding_disposition_verifications_finding_created_idx").on(
      table.findingId,
      table.createdAt,
    ),
    organizationStatusIdx: index("finding_disposition_verifications_org_status_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    requestedStateCheck: check(
      "finding_disposition_verifications_requested_state_check",
      sql`${table.requestedState} IN ('resolved', 'dismissed')`,
    ),
    statusCheck: check(
      "finding_disposition_verifications_status_check",
      sql`${table.status} IN ('queued', 'waiting', 'launching', 'running', 'completed', 'failed', 'cancelled', 'superseded')`,
    ),
    outcomeCheck: check(
      "finding_disposition_verifications_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('fixed', 'still_present', 'false_positive', 'validated', 'inconclusive')`,
    ),
    outcomeDispositionCheck: check(
      "finding_disposition_verifications_outcome_disposition_check",
      sql`${table.outcome} IS NULL OR (${table.requestedState} = 'resolved' AND ${table.outcome} IN ('fixed', 'still_present', 'inconclusive')) OR (${table.requestedState} = 'dismissed' AND ${table.outcome} IN ('false_positive', 'validated', 'inconclusive'))`,
    ),
    attemptsCheck: check(
      "finding_disposition_verifications_attempts_check",
      sql`${table.attemptNumber} > 0 AND ${table.launchAttemptCount} >= 0 AND ${table.maxLaunchAttempts} > 0 AND ${table.launchAttemptCount} <= ${table.maxLaunchAttempts}`,
    ),
  }),
);

export type FindingDispositionVerificationRow =
  typeof findingDispositionVerifications.$inferSelect;
export type NewFindingDispositionVerificationRow =
  typeof findingDispositionVerifications.$inferInsert;

export const complianceControlChecks = pgTable(
  "compliance_control_checks",
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
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    catalogRef: text("catalog_ref").notNull(),
    basis: text("basis").$type<ComplianceControlCheckBasis>().notNull().default("agent_tested"),
    verdict: text("verdict").$type<ComplianceControlCheckVerdict>().notNull(),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    proofObligationId: text("proof_obligation_id").notNull(),
    method: text("method").notNull(),
    toolName: text("tool_name"),
    skillSlug: text("skill_slug"),
    targetRef: text("target_ref").notNull(),
    evidenceRefs: text("evidence_refs").array().notNull().default([]),
    findingIds: uuid("finding_ids").array().notNull().default([]),
    artifactIds: text("artifact_ids").array().notNull().default([]),
    proof: jsonb("proof").$type<{
      claim: string;
      evidenceIds: string[];
      replayAttempted: boolean;
      replayArtifact?: string;
      replayReproduced?: boolean;
      notReplayedReason?: string;
    }>().notNull(),
    limitations: text("limitations").array().notNull().default([]),
    freshUntil: timestamp("fresh_until", { withTimezone: true }).notNull(),
    createdByActorType: text("created_by_actor_type").$type<ComplianceControlCheckActorType>().notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeControlIdx: index("compliance_control_checks_org_scope_control_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.controlId,
      table.createdAt,
    ),
    runIdx: index("compliance_control_checks_run_idx").on(table.runId, table.createdAt),
    sessionIdx: index("compliance_control_checks_session_idx").on(table.sessionId),
    idempotencyUnq: uniqueIndex("compliance_control_checks_idempotency_unq").on(table.idempotencyKey),
    verdictCheck: check(
      "compliance_control_checks_verdict_check",
      sql`${table.verdict} IN ('pass', 'fail', 'needs_context', 'not_attempted')`,
    ),
    basisCheck: check(
      "compliance_control_checks_basis_check",
      sql`${table.basis} IN ('agent_tested', 'agent_reviewed_user_evidence', 'agent_reviewed_integration')`,
    ),
    actorTypeCheck: check(
      "compliance_control_checks_actor_type_check",
      sql`${table.createdByActorType} IN ('agent', 'system', 'operator')`,
    ),
  }),
);

export type ComplianceControlCheckRow = typeof complianceControlChecks.$inferSelect;
export type NewComplianceControlCheckRow = typeof complianceControlChecks.$inferInsert;

export const complianceControlStates = pgTable(
  "compliance_control_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    state: text("state").$type<ComplianceControlMonitoringState>().notNull().default("monitored"),
    exclusionReason: text("exclusion_reason"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeControlUnq: uniqueIndex("compliance_control_states_org_scope_control_unq").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.controlId,
    ),
    orgScopeFrameworkStateIdx: index("compliance_control_states_org_scope_framework_state_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.state,
    ),
    assigneeIdx: index("compliance_control_states_assignee_idx").on(
      table.organizationId,
      table.assignedToUserId,
    ),
    stateCheck: check(
      "compliance_control_states_state_check",
      sql`${table.state} IN ('monitored', 'excluded')`,
    ),
    exclusionReasonCheck: check(
      "compliance_control_states_exclusion_reason_check",
      sql`${table.state} <> 'excluded' OR length(trim(coalesce(${table.exclusionReason}, ''))) >= 5`,
    ),
  }),
);

export type ComplianceControlStateRow = typeof complianceControlStates.$inferSelect;
export type NewComplianceControlStateRow = typeof complianceControlStates.$inferInsert;

export const complianceControlRequests = pgTable(
  "compliance_control_requests",
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
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    frameworkKey: text("framework_key").notNull(),
    controlId: text("control_id").notNull(),
    requestType: text("request_type").$type<ComplianceControlRequestType>().notNull(),
    priority: text("priority").$type<ComplianceControlRequestPriority>().notNull().default("medium"),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    requestedEvidence: text("requested_evidence").array().notNull().default([]),
    remediationHint: text("remediation_hint"),
    status: text("status").$type<ComplianceControlRequestStatus>().notNull().default("open"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type").$type<ComplianceControlCheckActorType>().notNull().default("agent"),
    createdByActorId: text("created_by_actor_id").notNull(),
    fulfillmentEvidenceItemId: uuid("fulfillment_evidence_item_id").references(() => complianceEvidenceItems.id, { onDelete: "set null" }),
    fulfillmentNote: text("fulfillment_note"),
    fulfilledByUserId: uuid("fulfilled_by_user_id").references(() => users.id, { onDelete: "set null" }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    reviewControlCheckId: uuid("review_control_check_id").references(() => complianceControlChecks.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    reviewedByActorType: text("reviewed_by_actor_type").$type<ComplianceControlCheckActorType>(),
    reviewedByActorId: text("reviewed_by_actor_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    nextReverificationAt: timestamp("next_reverification_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeControlStatusIdx: index("compliance_control_requests_org_scope_control_status_idx").on(
      table.organizationId,
      table.scopeId,
      table.frameworkKey,
      table.controlId,
      table.status,
    ),
    runIdx: index("compliance_control_requests_run_idx").on(table.runId, table.createdAt),
    assigneeIdx: index("compliance_control_requests_assignee_idx").on(table.organizationId, table.assignedToUserId),
    reverificationIdx: index("compliance_control_requests_reverification_idx")
      .on(table.organizationId, table.scopeId, table.nextReverificationAt)
      .where(sql`${table.nextReverificationAt} IS NOT NULL`),
    idempotencyUnq: uniqueIndex("compliance_control_requests_idempotency_unq").on(table.idempotencyKey),
    requestTypeCheck: check(
      "compliance_control_requests_type_check",
      sql`${table.requestType} IN ('evidence', 'access', 'context', 'remediation')`,
    ),
    priorityCheck: check(
      "compliance_control_requests_priority_check",
      sql`${table.priority} IN ('low', 'medium', 'high')`,
    ),
    statusCheck: check(
      "compliance_control_requests_status_check",
      sql`${table.status} IN ('open', 'fulfilled', 'reviewed', 'insufficient', 'contradicted', 'cancelled')`,
    ),
    actorTypeCheck: check(
      "compliance_control_requests_actor_type_check",
      sql`${table.createdByActorType} IN ('agent', 'system', 'operator')`,
    ),
  }),
);

export type ComplianceControlRequestRow = typeof complianceControlRequests.$inferSelect;
export type NewComplianceControlRequestRow = typeof complianceControlRequests.$inferInsert;

export const complianceControlCheckReviews = pgTable(
  "compliance_control_check_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    checkId: uuid("check_id")
      .notNull()
      .references(() => complianceControlChecks.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    decision: text("decision").$type<ComplianceControlCheckReviewDecision>().notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    checkCreatedIdx: index("compliance_control_check_reviews_check_created_idx").on(
      table.checkId,
      table.createdAt,
    ),
    runCreatedIdx: index("compliance_control_check_reviews_run_created_idx").on(
      table.runId,
      table.createdAt,
    ),
    decisionCheck: check(
      "compliance_control_check_reviews_decision_check",
      sql`${table.decision} IN ('confirmed', 'rejected', 'retest_required')`,
    ),
  }),
);

export type ComplianceControlCheckReviewRow = typeof complianceControlCheckReviews.$inferSelect;
export type NewComplianceControlCheckReviewRow = typeof complianceControlCheckReviews.$inferInsert;

export const runPhases = pgTable(
  "run_phases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    phaseKey: text("phase_key").notNull(),
    status: text("status").notNull().default("pending"),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    stepIds: jsonb("step_ids").$type<string[]>().notNull().default([]),
    assignedSkillSlugs: text("assigned_skill_slugs").array(),
    phaseProfile: text("phase_profile").notNull(),
    toolProfile: text("tool_profile").notNull(),
    promptProfile: text("prompt_profile").notNull(),
    // Inert V2.1.5 compatibility column retained for existing migrations.
    // Runtime no longer reads this as a behavior switch.
    delegationMode: text("delegation_mode").notNull().default("solo"),
    handoffInRef: text("handoff_in_ref"),
    handoffOutRef: text("handoff_out_ref"),
    checkpointRef: text("checkpoint_ref"),
    handoffSchemaVersion: integer("handoff_schema_version").notNull().default(1),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(1),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runOrdinalUnq: uniqueIndex("run_phases_run_ordinal_unq").on(table.runId, table.ordinal),
    runStatusIdx: index("run_phases_run_status_idx").on(table.runId, table.status),
    sessionIdx: index("run_phases_session_idx").on(table.sessionId),
    phaseKeyCheck: check(
      "run_phases_phase_key_check",
      sql`${table.phaseKey} IN ('planning', 'recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting')`,
    ),
    statusCheck: check(
      "run_phases_status_check",
      sql`${table.status} IN ('pending', 'active', 'handoff_submitted', 'completed', 'blocked', 'failed', 'timed_out', 'aborted')`,
    ),
    delegationModeCheck: check(
      "run_phases_delegation_mode_check",
      sql`${table.delegationMode} IN ('solo', 'coordinator')`,
    ),
  }),
);

export type RunPhaseRow = typeof runPhases.$inferSelect;
export type NewRunPhaseRow = typeof runPhases.$inferInsert;

export const runPhaseReplans = pgTable(
  "run_phase_replans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => runPhases.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("open"),
    requestedPhaseStatus: text("requested_phase_status").notNull(),
    handoffRef: text("handoff_ref"),
    reason: text("reason"),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastDispatchAt: timestamp("last_dispatch_at", { withTimezone: true }),
    lastDispatchError: text("last_dispatch_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("run_phase_replans_run_idx").on(table.runId),
    phaseStatusIdx: index("run_phase_replans_phase_status_idx").on(table.phaseId, table.status),
    dueIdx: index("run_phase_replans_due_idx").on(table.status, table.nextAttemptAt, table.claimExpiresAt),
    openPhaseUnq: uniqueIndex("run_phase_replans_open_phase_unq")
      .on(table.runId, table.phaseId)
      .where(sql`${table.status} = 'open'`),
    statusCheck: check(
      "run_phase_replans_status_check",
      sql`${table.status} IN ('open', 'applied', 'failed', 'cancelled', 'superseded')`,
    ),
    requestedPhaseStatusCheck: check(
      "run_phase_replans_requested_phase_status_check",
      sql`${table.requestedPhaseStatus} IN ('completed', 'blocked', 'failed')`,
    ),
  }),
);

export type RunPhaseReplanRow = typeof runPhaseReplans.$inferSelect;
export type NewRunPhaseReplanRow = typeof runPhaseReplans.$inferInsert;

export const runValidationQueue = pgTable(
  "run_validation_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id").references(() => runPhases.id, {
      onDelete: "set null",
    }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    rationale: text("rationale"),
    requestedBySessionId: uuid("requested_by_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    validatorSessionId: uuid("validator_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome"),
    resultRef: text("result_ref"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    runStatusIdx: index("run_validation_queue_run_status_idx").on(table.runId, table.status),
    phaseStatusIdx: index("run_validation_queue_phase_status_idx").on(table.phaseId, table.status),
    findingIdx: index("run_validation_queue_finding_idx").on(table.findingId),
    runFindingUnq: uniqueIndex("run_validation_queue_run_finding_unq").on(table.runId, table.findingId),
    statusCheck: check(
      "run_validation_queue_status_check",
      sql`${table.status} IN ('queued', 'in_progress', 'validated', 'false_positive', 'inconclusive', 'failed', 'cancelled')`,
    ),
    outcomeCheck: check(
      "run_validation_queue_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('validated', 'false_positive', 'inconclusive')`,
    ),
  }),
);

export type RunValidationQueueRow = typeof runValidationQueue.$inferSelect;
export type NewRunValidationQueueRow = typeof runValidationQueue.$inferInsert;

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("run_events_run_idx").on(table.runId),
    runCreatedIdx: index("run_events_run_created_idx").on(table.runId, table.createdAt),
  }),
);

export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;

export const runPerformanceSummaries = pgTable(
  'run_performance_summaries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    status: text('status').$type<PerformanceSummaryStatus>().notNull().default('ready'),
    source: text('source').$type<PerformanceSummarySource>().notNull().default('trace_only'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    summary: jsonb('summary').$type<unknown>().notNull().default({}),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUnq: uniqueIndex('run_performance_summaries_run_unq').on(table.runId),
    generatedIdx: index('run_performance_summaries_generated_idx').on(table.generatedAt),
    statusCheck: check(
      'run_performance_summaries_status_check',
      sql`${table.status} IN ('ready', 'partial', 'unavailable')`,
    ),
    sourceCheck: check(
      'run_performance_summaries_source_check',
      sql`${table.source} IN ('prometheus', 'docker_stats', 'trace_only', 'mixed')`,
    ),
  }),
);

export type RunPerformanceSummaryRow = typeof runPerformanceSummaries.$inferSelect;
export type NewRunPerformanceSummaryRow = typeof runPerformanceSummaries.$inferInsert;

export const sessionPerformanceSummaries = pgTable(
  'session_performance_summaries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    status: text('status').$type<PerformanceSummaryStatus>().notNull().default('ready'),
    source: text('source').$type<PerformanceSummarySource>().notNull().default('trace_only'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    summary: jsonb('summary').$type<unknown>().notNull().default({}),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionUnq: uniqueIndex('session_performance_summaries_session_unq').on(table.sessionId),
    runIdx: index('session_performance_summaries_run_idx').on(table.runId),
    generatedIdx: index('session_performance_summaries_generated_idx').on(table.generatedAt),
    statusCheck: check(
      'session_performance_summaries_status_check',
      sql`${table.status} IN ('ready', 'partial', 'unavailable')`,
    ),
    sourceCheck: check(
      'session_performance_summaries_source_check',
      sql`${table.source} IN ('prometheus', 'docker_stats', 'trace_only', 'mixed')`,
    ),
  }),
);

export type SessionPerformanceSummaryRow = typeof sessionPerformanceSummaries.$inferSelect;
export type NewSessionPerformanceSummaryRow = typeof sessionPerformanceSummaries.$inferInsert;
