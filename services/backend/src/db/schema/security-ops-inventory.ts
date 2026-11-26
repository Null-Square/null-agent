import type {
  FindingCodeLocation,
  FindingEvidenceKind,
  FindingHttpExchange,
  FindingValidationEvidenceRef,
} from "@/domains/security-ops/findings/findingContracts";
import type { AttackResultV1 } from "@/domains/agent-brain/domain/workers/attackContracts";
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
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-brain";
import { organizations, users } from "./platform";
import { scopes } from "./security-ops-foundation";
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * The scope that first observed this asset, kept for compatibility with
     * readers that predate `asset_scope_memberships`. It is provenance, not
     * ownership: `SET NULL` because deleting one scope must not delete an asset
     * the organization still owns and other scopes may still be watching.
     */
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    /**
     * The user who first observed this asset. Provenance only — the same
     * reasoning applies. Cascading from here would let one departing employee
     * delete an organization's inventory, and with it every component and
     * exposure match hanging off it.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // 'domain' | 'ip' | 'cloud_resource' | 'repository'
    value: text("value").notNull(), // normalized (service enforces)
    tags: text("tags").array(),
    evidence: jsonb("evidence")
      .$type<Array<{ path: string; label?: string }>>()
      .notNull()
      .default([]),
    parentAssetId: uuid("parent_asset_id"), // self-ref: subdomain → parent domain
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Identity is the organization, not the user. Keying on user_id let the
    // same real-world asset exist twice inside one org, and — because the
    // ingestion writer looked up without an org filter and then overwrote
    // organization_id — let an asset change tenancy when a user active in two
    // organizations observed it. Scope membership is a relation now
    // (asset_scope_memberships); assets.scope_id records only the originating
    // scope, and assets.user_id is retained as provenance, never ownership.
    orgKindValueUnq: uniqueIndex("assets_org_kind_value_unq").on(
      table.organizationId,
      table.kind,
      table.value,
    ),
    userLastSeenIdx: index("assets_user_last_seen_idx").on(
      table.userId,
      table.lastSeenAt,
    ),
    orgIdx: index("assets_org_idx").on(table.organizationId),
    scopeIdx: index("assets_scope_idx").on(table.scopeId),
    scopeLastSeenIdx: index("assets_scope_last_seen_idx").on(table.scopeId, table.lastSeenAt),
  }),
);

export type AssetRow = typeof assets.$inferSelect;
export type NewAssetRow = typeof assets.$inferInsert;

export const assetObservations = pgTable(
  "asset_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    assetSessionUnq: uniqueIndex("asset_observations_asset_session_unq").on(
      table.assetId,
      table.sessionId,
    ),
    assetIdx: index("asset_observations_asset_idx").on(table.assetId),
    sessionIdx: index("asset_observations_session_idx").on(table.sessionId),
    userLastSeenIdx: index("asset_observations_user_last_seen_idx").on(
      table.userId,
      table.lastSeenAt,
    ),
  }),
);

export type AssetObservationRow = typeof assetObservations.$inferSelect;
export type NewAssetObservationRow = typeof assetObservations.$inferInsert;

export const inventoryServices = pgTable(
  "inventory_services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    protocol: text("protocol").notNull(), // 'tcp' | 'udp' | 'http' | 'https'
    port: integer("port").notNull(),
    serviceName: text("service_name"),
    product: text("product"),
    version: text("version"),
    evidence: jsonb("evidence")
      .$type<Array<{ path: string; label?: string }>>()
      .notNull()
      .default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    assetProtoPortUnq: uniqueIndex("inventory_services_asset_proto_port_unq").on(
      table.assetId,
      table.protocol,
      table.port,
    ),
    assetIdx: index("inventory_services_asset_idx").on(table.assetId),
    userLastSeenIdx: index("inventory_services_user_last_seen_idx").on(
      table.userId,
      table.lastSeenAt,
    ),
  }),
);

export type InventoryServiceRow = typeof inventoryServices.$inferSelect;
export type NewInventoryServiceRow = typeof inventoryServices.$inferInsert;

export const inventoryNotes = pgTable(
  "inventory_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    ntype: text("ntype").notNull(),
    title: text("title"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    confidence: real("confidence"),
    evidence: jsonb("evidence")
      .$type<Array<{ path: string; label?: string; excerpt?: string; fileMissing?: boolean }>>()
      .notNull()
      .default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // A unique CONSTRAINT rather than a unique index, because only the
    // constraint form can declare NULLS NOT DISTINCT — and `asset_id` is
    // nullable. Postgres treats NULLs as distinct by default, so as a plain
    // index this enforced nothing at all for asset-less notes: two concurrent
    // writers could both miss the application-level lookup and both insert.
    dedupeUnq: unique("inventory_notes_dedupe_unq")
      .on(
        table.userId,
        table.organizationId,
        table.assetId,
        table.ntype,
        table.dedupeKey,
      )
      .nullsNotDistinct(),
    orgScopeNtypeIdx: index("inventory_notes_org_scope_ntype_idx").on(
      table.organizationId,
      table.scopeId,
      table.ntype,
    ),
    assetNtypeIdx: index("inventory_notes_asset_ntype_idx").on(table.assetId, table.ntype),
    userLastSeenIdx: index("inventory_notes_user_last_seen_idx").on(table.userId, table.lastSeenAt),
  }),
);

export type InventoryNoteRow = typeof inventoryNotes.$inferSelect;
export type NewInventoryNoteRow = typeof inventoryNotes.$inferInsert;

export const RISK_SOURCE_KINDS = [
  "assessment",
  "code_review",
  "advisory_verification",
] as const;
export type RiskSourceKind = (typeof RISK_SOURCE_KINDS)[number];

export const RISK_STATES = [
  "potential",
  "verifying",
  "confirmed",
  "not_reproduced",
  "dismissed",
  "resolved",
  "accepted",
] as const;
export type RiskState = (typeof RISK_STATES)[number];

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    assetId: uuid("asset_id")
      .references(() => assets.id, { onDelete: "set null" }),
    repositoryId: text("repository_id"),
    sourceKind: text("source_kind")
      .$type<RiskSourceKind>()
      .notNull()
      .default("assessment"),
    title: text("title").notNull(),
    severity: text("severity").notNull(), // 'critical' | 'high' | 'medium' | 'low' | 'info'
    state: text("state").$type<RiskState>().notNull().default("potential"),
    summary: text("summary").notNull(),
    businessImpact: text("business_impact"),
    technicalAnalysis: text("technical_analysis"),
    pocDescription: text("poc_description"),
    pocScriptCode: text("poc_script_code"),
    assumptions: text("assumptions"),
    fixEffort: text("fix_effort"),
    remediation: text("remediation"),
    cvssVector: text("cvss_vector"), // e.g. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H
    cvssScore: real("cvss_score"), // 0.0 - 10.0
    confidenceScore: real("confidence_score"), // 0.0 - 1.0
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    cweId: text("cwe_id"), // e.g. 'CWE-79'
    cveId: text("cve_id"), // e.g. 'CVE-2024-1234'
    cweIds: text("cwe_ids").array(), // e.g. ['CWE-79', 'CWE-89']
    cveIds: text("cve_ids").array(), // e.g. ['CVE-2024-1234']
    owaspCategory: text("owasp_category"), // e.g. 'A03:2021-Injection'
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    endpointId: uuid("endpoint_id").references(() => inventoryNotes.id, {
      onDelete: "set null",
    }),
    serviceId: uuid("service_id").references(() => inventoryServices.id, {
      onDelete: "set null",
    }),
    codeLocations: jsonb("code_locations")
      .$type<FindingCodeLocation[]>()
      .notNull()
      .default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceDedupeKeyUnq: uniqueIndex("findings_source_dedupe_key_unq").on(
      table.organizationId,
      table.sourceKind,
      table.dedupeKey,
    ),
    assetIdx: index("findings_asset_idx").on(table.assetId),
    repositoryIdx: index("findings_repository_idx").on(table.organizationId, table.repositoryId),
    userLastSeenIdx: index("findings_user_last_seen_idx").on(
      table.userId,
      table.lastSeenAt,
    ),
    orgIdx: index("findings_org_idx").on(table.organizationId),
    scopeIdx: index("findings_scope_idx").on(table.scopeId),
    severityStateIdx: index("findings_severity_state_idx").on(
      table.severity,
      table.state,
    ),
    cvssScoreIdx: index("findings_cvss_score_idx").on(table.cvssScore),
    confidenceScoreIdx: index("findings_confidence_score_idx").on(table.confidenceScore),
    owaspCategoryIdx: index("findings_owasp_category_idx").on(table.owaspCategory),
    orgOwaspIdx: index("findings_org_owasp_idx").on(table.organizationId, table.owaspCategory),
    severityCheck: check(
      "findings_severity_check",
      sql`${table.severity} IN ('critical', 'high', 'medium', 'low', 'info')`,
    ),
    sourceKindCheck: check(
      "findings_source_kind_check",
      sql`${table.sourceKind} IN ('assessment', 'code_review', 'advisory_verification')`,
    ),
    stateCheck: check(
      "findings_state_check",
      sql`${table.state} IN ('potential', 'verifying', 'confirmed', 'not_reproduced', 'dismissed', 'resolved', 'accepted')`,
    ),
    cvssScoreCheck: check(
      "findings_cvss_score_check",
      sql`${table.cvssScore} IS NULL OR (${table.cvssScore} >= 0 AND ${table.cvssScore} <= 10)`,
    ),
    fixEffortCheck: check(
      "findings_fix_effort_check",
      sql`${table.fixEffort} IS NULL OR ${table.fixEffort} IN ('trivial', 'low', 'medium', 'high')`,
    ),
  }),
);

export type FindingRow = typeof findings.$inferSelect;
export type NewFindingRow = typeof findings.$inferInsert;

export const findingEvidence = pgTable(
  "finding_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<FindingEvidenceKind>().notNull().default("artifact"),
    path: text("path").notNull(),
    displayPath: text("display_path"),
    label: text("label"),
    excerpt: text("excerpt"),
    fileMissing: boolean("file_missing").notNull().default(false),
    data: jsonb("data").$type<FindingHttpExchange | AttackResultV1 | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    findingPathUnq: uniqueIndex("finding_evidence_finding_path_unq").on(
      table.findingId,
      table.path,
    ),
    findingIdx: index("finding_evidence_finding_idx").on(table.findingId),
    sessionIdx: index("finding_evidence_session_idx").on(table.sessionId),
    kindCheck: check(
      "finding_evidence_kind_check",
      sql`${table.kind} IN ('artifact', 'http_exchange')`,
    ),
  }),
);

export type FindingEvidenceRow = typeof findingEvidence.$inferSelect;
export type NewFindingEvidenceRow = typeof findingEvidence.$inferInsert;

export const scannerObservations = pgTable(
  "scanner_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
    parser: text("parser").notNull(),
    sourceTool: text("source_tool").notNull(),
    sourceVersion: text("source_version"),
    artifactPath: text("artifact_path").notNull(),
    observationType: text("observation_type").notNull(),
    title: text("title").notNull(),
    severity: text("severity").notNull().default("info"),
    confidence: real("confidence"),
    dedupeKey: text("dedupe_key").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb("evidence")
      .$type<Array<{ path: string; label?: string; excerpt?: string; fileMissing?: boolean }>>()
      .notNull()
      .default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupeUnq: uniqueIndex("scanner_observations_dedupe_unq").on(
      table.userId,
      table.organizationId,
      table.parser,
      table.dedupeKey,
    ),
    orgScopeIdx: index("scanner_observations_org_scope_idx").on(table.organizationId, table.scopeId),
    assetIdx: index("scanner_observations_asset_idx").on(table.assetId),
    findingIdx: index("scanner_observations_finding_idx").on(table.findingId),
    severityCheck: check(
      "scanner_observations_severity_check",
      sql`${table.severity} IN ('critical', 'high', 'medium', 'low', 'info')`,
    ),
  }),
);

export type ScannerObservationRow = typeof scannerObservations.$inferSelect;
export type NewScannerObservationRow = typeof scannerObservations.$inferInsert;

export const findingValidationAudit = pgTable(
  "finding_validation_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerSessionId: uuid("worker_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id"),
    dispositionVerificationId: uuid("disposition_verification_id"),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    evidenceRefs: jsonb("evidence_refs")
      .$type<FindingValidationEvidenceRef[]>()
      .notNull()
      .default([]),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    findingIdx: index("finding_validation_audit_finding_idx").on(table.findingId),
    workerSessionIdx: index("finding_validation_audit_worker_session_idx").on(table.workerSessionId),
    runIdx: index("finding_validation_audit_run_idx").on(table.runId),
    dispositionVerificationIdx: index("finding_validation_audit_disposition_verification_idx").on(
      table.dispositionVerificationId,
    ),
    outcomeCheck: check(
      "finding_validation_audit_outcome_check",
      sql`${table.outcome} IN ('validated', 'false_positive', 'inconclusive', 'fixed', 'still_present')`,
    ),
  }),
);

export type FindingValidationAuditRow = typeof findingValidationAudit.$inferSelect;
export type NewFindingValidationAuditRow = typeof findingValidationAudit.$inferInsert;

export const oobTokens = pgTable(
  "oob_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    label: text("label"),
    hostname: text("hostname").notNull(),
    url: text("url").notNull(),
    dns: text("dns").notNull(),
    correlationId: text("correlation_id"),
    secretKey: text("secret_key"),
    privateKeyPem: text("private_key_pem"),
    mode: text("mode").notNull().default("interactsh"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenUnq: uniqueIndex("oob_tokens_token_unq").on(table.token),
    correlationIdx: index("oob_tokens_correlation_idx").on(table.correlationId),
    orgScopeIdx: index("oob_tokens_org_scope_idx").on(table.organizationId, table.scopeId),
    runIdx: index("oob_tokens_run_idx").on(table.runId),
    expiresIdx: index("oob_tokens_expires_idx").on(table.expiresAt),
  }),
);

export type OobTokenRow = typeof oobTokens.$inferSelect;
export type NewOobTokenRow = typeof oobTokens.$inferInsert;

export const oobInteractions = pgTable(
  "oob_interactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => oobTokens.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    runId: uuid("run_id"),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    protocol: text("protocol").notNull().default("unknown"),
    sourceIp: text("source_ip"),
    hostname: text("hostname"),
    method: text("method"),
    path: text("path"),
    payloadPreview: text("payload_preview"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupeUnq: uniqueIndex("oob_interactions_dedupe_unq").on(
      table.organizationId,
      table.token,
      table.dedupeKey,
    ),
    tokenIdx: index("oob_interactions_token_idx").on(table.tokenId),
    orgScopeIdx: index("oob_interactions_org_scope_idx").on(table.organizationId, table.scopeId),
    tsIdx: index("oob_interactions_ts_idx").on(table.ts),
  }),
);

export type OobInteractionRow = typeof oobInteractions.$inferSelect;
export type NewOobInteractionRow = typeof oobInteractions.$inferInsert;

export const findingEvents = pgTable(
  "finding_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'created' | 'seen' | 'state_changed' | etc.
    fromState: text("from_state").$type<RiskState>(),
    toState: text("to_state").$type<RiskState>(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    findingIdx: index("finding_events_finding_idx").on(table.findingId),
    findingCreatedIdx: index("finding_events_finding_created_idx").on(
      table.findingId,
      table.createdAt,
    ),
  }),
);

export type FindingEventRow = typeof findingEvents.$inferSelect;
export type NewFindingEventRow = typeof findingEvents.$inferInsert;
