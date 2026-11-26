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
import { organizations, users } from "./platform";

export const scopes = pgTable(
  "scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    executionNetwork: text("execution_network").notNull().default("external"),
    mission: text("mission"),
    impactTolerance: text("impact_tolerance").notNull().default("poc"),
    complianceFrameworks: jsonb("compliance_frameworks").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("scopes_org_idx").on(table.organizationId),
    executionNetworkCheck: check(
      "scopes_execution_network_check",
      sql`${table.executionNetwork} IN ('external', 'internal')`,
    ),
    impactToleranceCheck: check(
      "scopes_impact_tolerance_check",
      sql`${table.impactTolerance} IN ('non_destructive', 'poc', 'full')`,
    ),
  }),
);

export type ScopeRow = typeof scopes.$inferSelect;
export type NewScopeRow = typeof scopes.$inferInsert;

/**
 * One-time archive for product fields that previously looked like enforceable
 * RoE controls but were not honored across all execution paths. Runtime and
 * customer APIs never read this table; it exists only to preserve migration
 * history before the misleading columns are dropped from `scopes`.
 */
export const scopeLegacyRoeArchives = pgTable("scope_legacy_roe_archives", {
  scopeId: uuid("scope_id")
    .primaryKey()
    .references(() => scopes.id, { onDelete: "cascade" }),
  safeMode: boolean("safe_mode").notNull(),
  stealthPosture: text("stealth_posture").notNull(),
  rateLimitRps: integer("rate_limit_rps"),
  blastWindow: text("blast_window"),
  roeDocument: text("roe_document"),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  archiveReason: text("archive_reason").notNull().default("pentest_result_recovery_remove_dead_roe"),
});

export type ScopeLegacyRoeArchiveRow = typeof scopeLegacyRoeArchives.$inferSelect;
export type NewScopeLegacyRoeArchiveRow = typeof scopeLegacyRoeArchives.$inferInsert;

export const scopeExclusions = pgTable(
  "scope_exclusions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: text("value").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeIdx: index("scope_exclusions_scope_idx").on(table.scopeId),
    scopeTypeValueUnq: uniqueIndex("scope_exclusions_scope_type_value_unq").on(
      table.scopeId,
      table.type,
      table.value,
    ),
    typeCheck: check(
      "scope_exclusions_type_check",
      sql`${table.type} IN ('domain', 'cidr')`,
    ),
  }),
);

export type ScopeExclusionRow = typeof scopeExclusions.$inferSelect;
export type NewScopeExclusionRow = typeof scopeExclusions.$inferInsert;

export type CodeSourceKind = "folder" | "git";
export type CodeSourceStatus = "ready" | "cloning" | "failed";

/**
 * The one place a scope's code comes from: a local folder the backend only
 * reads, or a public git URL it clones. One row per scope. A clone lives at
 * `${WORKSPACE_ROOT}/code-sources/<id>`; that path is derived, never stored.
 */
export const codeSources = pgTable(
  "code_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CodeSourceKind>().notNull(),
    location: text("location").notNull(),
    ref: text("ref"),
    reviewBrief: text("review_brief"),
    status: text("status").$type<CodeSourceStatus>().notNull(),
    error: text("error"),
    headCommit: text("head_commit"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUnq: uniqueIndex("code_sources_scope_unq").on(table.scopeId),
    orgIdx: index("code_sources_org_idx").on(table.organizationId),
    kindCheck: check("code_sources_kind_check", sql`${table.kind} IN ('folder', 'git')`),
    statusCheck: check(
      "code_sources_status_check",
      sql`${table.status} IN ('ready', 'cloning', 'failed')`,
    ),
  }),
);

export type CodeSourceRow = typeof codeSources.$inferSelect;
export type NewCodeSourceRow = typeof codeSources.$inferInsert;
