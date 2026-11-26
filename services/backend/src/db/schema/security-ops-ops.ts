import type { ComplianceFrameworkKey, ModelCategory } from "@null-ai/contracts";
import {
  sql,
} from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { models, organizations, users } from "./platform";
import {
  runs,
  type RunWorkflowDiscipline,
} from "./security-ops-core";
import { scopes } from "./security-ops-foundation";
export type OpsAlertSeverity = "info" | "warning" | "critical";
export type OpsAlertStatus = "active" | "acknowledged" | "resolved";
export type AutomationWorkflowDiscipline = Exclude<RunWorkflowDiscipline, "code_review">;

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    // Polymorphic resource identifier: may be a UUID or a composite key such as
    // `soc2:CC6.1` (compliance control) — stored as text, not a strict uuid.
    resourceId: text("resource_id"),
    changes: jsonb("changes").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCreatedIdx: index("audit_logs_org_created_idx").on(table.organizationId, table.createdAt),
    orgResourceIdx: index("audit_logs_org_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
  }),
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;

export const failedEvents = pgTable(
  "failed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNextRetryIdx: index("failed_events_org_next_retry_idx").on(table.organizationId, table.nextRetryAt),
    retryDueIdx: index("failed_events_retry_due_idx").on(table.nextRetryAt, table.retryCount),
  }),
);

export type FailedEventRow = typeof failedEvents.$inferSelect;
export type NewFailedEventRow = typeof failedEvents.$inferInsert;

// ============================================================================
// Phase 6: SecurityOps Automations + Integrations
// ============================================================================

export type AutomationEventType =
  | "finding_created"
  | "risk_state_changed"
  | "run_completed"
  | "asset_discovered"
  | "runner_offline";

export type AutomationEventFilter = Record<string, unknown> & {
  goal_contains?: string;
  confidence_below?: number;
};

export type TriggerConfig =
  | { type: "scheduled"; cron: string; timezone: string }
  | { type: "continuous"; intervalMinutes: number }
  | { type: "event"; eventType: AutomationEventType; filter?: AutomationEventFilter };

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    modelId: uuid("model_id").references(() => models.id, {
      onDelete: "set null",
    }),
    modelCategory: text("model_category").$type<ModelCategory>(),
    // Code Review automation remains disabled until the PR-review child workflow is locked.
    workflowDiscipline: text("workflow_discipline").$type<AutomationWorkflowDiscipline>().notNull().default("pentest"),
    complianceFrameworkKey: text("compliance_framework_key").$type<ComplianceFrameworkKey>(),
    executionTarget: text("execution_target").notNull().default("cloud"),
    goal: text("goal").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: jsonb("trigger_config").$type<TriggerConfig>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    deferredReason: text("deferred_reason"),
    deferredAt: timestamp("deferred_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("automations_org_idx").on(table.organizationId),
    scopeIdx: index("automations_scope_idx").on(table.scopeId),
    workflowDisciplineIdx: index("automations_workflow_discipline_idx").on(table.workflowDiscipline),
    nextRunIdx: index("automations_next_run_idx").on(table.isActive, table.nextRunAt),
    workflowDisciplineCheck: check(
      "automations_workflow_discipline_check",
      sql`${table.workflowDiscipline} IN ('pentest', 'compliance')`,
    ),
    complianceFrameworkCheck: check(
      "automations_compliance_framework_check",
      sql`(
        (${table.workflowDiscipline} = 'pentest' AND ${table.complianceFrameworkKey} IS NULL)
        OR
        (${table.workflowDiscipline} = 'compliance' AND ${table.complianceFrameworkKey} IN ('soc2', 'gdpr', 'hipaa', 'pci_dss', 'iso27001', 'nist_csf'))
      )`,
    ),
  }),
);

export type AutomationRow = typeof automations.$inferSelect;
export type NewAutomationRow = typeof automations.$inferInsert;

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    triggerReason: text("trigger_reason"),
  },
  (table) => ({
    automationIdx: index("automation_runs_automation_idx").on(table.automationId),
    runIdx: index("automation_runs_run_idx").on(table.runId),
  }),
);

export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type NewAutomationRunRow = typeof automationRuns.$inferInsert;

export const scopeAccessMaterials = pgTable(
  "scope_access_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    username: text("username"),
    headerName: text("header_name"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    notes: text("notes"),
    appliesToHosts: text("applies_to_hosts").array().notNull().default([]),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeIdx: index("scope_access_materials_org_scope_idx").on(table.organizationId, table.scopeId),
    scopeLabelIdx: index("scope_access_materials_scope_label_idx").on(table.scopeId, table.label),
  }),
);

export type ScopeAccessMaterialRow = typeof scopeAccessMaterials.$inferSelect;
export type NewScopeAccessMaterialRow = typeof scopeAccessMaterials.$inferInsert;

export const scopeTestPersonas = pgTable(
  "scope_test_personas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    roleLabel: text("role_label"),
    kind: text("kind").notNull(),
    username: text("username"),
    headerName: text("header_name"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    appliesToHosts: text("applies_to_hosts").array().notNull().default([]),
    refreshProcedure: jsonb("refresh_procedure").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgScopeIdx: index("scope_test_personas_org_scope_idx").on(table.organizationId, table.scopeId),
    scopeLabelUnq: uniqueIndex("scope_test_personas_scope_label_unq").on(table.scopeId, table.label),
    kindCheck: check(
      "scope_test_personas_kind_check",
      sql`${table.kind} IN ('custom_header', 'bearer_token', 'cookie_session', 'storage_state')`,
    ),
  }),
);

export type ScopeTestPersonaRow = typeof scopeTestPersonas.$inferSelect;
export type NewScopeTestPersonaRow = typeof scopeTestPersonas.$inferInsert;
