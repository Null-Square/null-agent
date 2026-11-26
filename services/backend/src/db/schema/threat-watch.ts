import { sql } from "drizzle-orm";
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
  uuid,
} from "drizzle-orm/pg-core";

import { agentSessions } from "./agent-brain";
import { organizations, users } from "./platform";
import { assets, findings, inventoryServices } from "./security-ops-inventory";
import { runs } from "./security-ops-core";
import { scopes } from "./security-ops-foundation";

/**
 * Threat Watch — continuous CVE exposure.
 *
 * Design contract, in one place, because every table below depends on it:
 *
 *   1. Narrative belongs in `inventory_notes`; facts belong here. Agent-written
 *      jsonb cannot be indexed, constrained, or joined, and this feature is a
 *      reverse-index join ("given advisory X, who is affected?").
 *   2. The organization owns inventory. Scope is a relation and user is
 *      provenance — never ownership. Deleting a user must not delete an
 *      organization's inventory.
 *   3. Advisories are canonical records with per-feed source rows. Wordfence and
 *      Patchstack advisories frequently carry no CVE id, so keying on CVE alone
 *      breaks on the second feed.
 *   4. Silence beats a wrong alert. Anything we cannot identify or compare
 *      confidently produces no match at all.
 */

/* -------------------------------------------------------------------------- */
/* Asset scope membership                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One asset can legitimately appear in several scopes. `assets.scope_id`
 * records only the scope that first observed it, and the ingestion writer used
 * to *move* the asset when another scope saw it. Membership makes the relation
 * explicit and additive: existing readers keep using `assets.scope_id`, and
 * everything new reads this table.
 */
export const assetScopeMemberships = pgTable(
  "asset_scope_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetScopeUnq: uniqueIndex("asset_scope_memberships_asset_scope_unq").on(
      table.assetId,
      table.scopeId,
    ),
    scopeIdx: index("asset_scope_memberships_scope_idx").on(table.scopeId),
    orgIdx: index("asset_scope_memberships_org_idx").on(table.organizationId),
  }),
);

export type AssetScopeMembershipRow = typeof assetScopeMemberships.$inferSelect;
export type NewAssetScopeMembershipRow = typeof assetScopeMemberships.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Component identity                                                         */
/* -------------------------------------------------------------------------- */

export const COMPONENT_ECOSYSTEMS = [
  "cpe",
  "wordpress_core",
  "wordpress_plugin",
  "wordpress_theme",
  // Populated only once repository dependency ingestion lands (PRD Appendix A).
  // Declared now so that work needs no schema change.
  "npm",
  "pypi",
  "composer",
  "go",
  "maven",
  "cargo",
  "rubygems",
  "oci",
] as const;

export type ComponentEcosystem = (typeof COMPONENT_ECOSYSTEMS)[number];

export const VERSION_SCHEMES = ["semver", "cpe", "dotted", "unknown"] as const;
export type VersionScheme = (typeof VERSION_SCHEMES)[number];

export const COMPONENT_OBSERVATION_SOURCES = [
  "httpx",
  "agent",
  "scan_preview",
  "connected_site",
  "lockfile",
] as const;

export type ComponentObservationSource = (typeof COMPONENT_OBSERVATION_SOURCES)[number];

/**
 * Concrete ways the product can try to read a component version.
 *
 * The first five values form the bounded active-acquisition ladder used by an
 * agent run. The remaining values describe evidence that arrived through a
 * manifest, a passive refresh, or an older generic agent observation. Keeping
 * this separate from `ComponentObservationSource` records both where evidence
 * came from and what read method was actually attempted.
 */
export const COMPONENT_VERSION_READ_METHODS = [
  "http_banner",
  "service_probe",
  "application_fingerprint",
  "error_behavior",
  "tls_fingerprint",
  "connected_manifest",
  "dependency_manifest",
  "passive_fingerprint",
  "agent_observation",
] as const;

export type ComponentVersionReadMethod = (typeof COMPONENT_VERSION_READ_METHODS)[number];

export type ComponentVersionReadAttempt = {
  method: ComponentVersionReadMethod;
  outcome: "version_observed" | "version_absent";
  attemptedAt: string;
  source: ComponentObservationSource;
};

/** One latest result per method; object keys keep the ledger bounded. */
export type ComponentVersionReadAttempts = Partial<
  Record<ComponentVersionReadMethod, ComponentVersionReadAttempt>
>;

/**
 * Strength of the version evidence used by the matcher.
 *
 * `observed_exact` is authoritative machine-readable inventory (for example a
 * connected-site manifest or lockfile). `attested_exact` is a time-bounded
 * customer correction. `reported_exact` is a banner/scanner report: useful for
 * creating a candidate, but not strong enough to interrupt a customer on its
 * own. `absent` makes the lack of a version explicit and can never match.
 */
export const COMPONENT_EVIDENCE_TIERS = [
  "observed_exact",
  "attested_exact",
  "reported_exact",
  "absent",
] as const;

export type ComponentEvidenceTier = (typeof COMPONENT_EVIDENCE_TIERS)[number];

export const EXPOSURE_EVIDENCE_SOURCES = [
  ...COMPONENT_OBSERVATION_SOURCES,
  "customer_override",
] as const;

export type ExposureEvidenceSource = (typeof EXPOSURE_EVIDENCE_SOURCES)[number];

/**
 * The resolved answer to "what does this organization run on this asset".
 *
 * Resolved fields are derived from `component_observations` — highest
 * confidence, most recent as tiebreak — and are the only thing the matcher
 * reads. When live observations disagree on version, `version_conflict` is set
 * and the component is barred from interrupt-grade alerting: we would rather
 * say nothing than guess which sighting was right.
 */
export const inventoryComponents = pgTable(
  "inventory_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").$type<ComponentEcosystem>().notNull(),
    /** Canonical identity, e.g. 'cpe:f5:nginx' or 'pkg:npm/lodash'. */
    componentKey: text("component_key").notNull(),
    displayName: text("display_name").notNull(),
    /** Normalized and comparable. Null means no confident version — never guess. */
    resolvedVersion: text("resolved_version"),
    resolvedVersionScheme: text("resolved_version_scheme")
      .$type<VersionScheme>()
      .notNull()
      .default("unknown"),
    resolvedConfidence: real("resolved_confidence"),
    /** Provenance of the winning resolved observation. Null on legacy rows. */
    resolvedObservationSource: text("resolved_observation_source")
      .$type<ComponentObservationSource>(),
    /**
     * When the observation that supplied `resolvedVersion` was made.
     *
     * This deliberately differs from `lastConfirmedAt`: a later sighting can
     * confirm that the product still exists without successfully reading its
     * version. Such a sighting must never make an older exact version look
     * fresh enough to alert on.
     */
    resolvedVersionObservedAt: timestamp("resolved_version_observed_at", {
      withTimezone: true,
    }),
    /** Evidence strength derived from the winning observation. */
    resolvedEvidenceTier: text("resolved_evidence_tier")
      .$type<ComponentEvidenceTier>()
      .notNull()
      .default("absent"),
    /** Latest result for each version read method attempted on this component. */
    versionReadAttempts: jsonb("version_read_attempts")
      .$type<ComponentVersionReadAttempts>()
      .notNull()
      .default({}),
    /** Observations disagree; bars interrupt alerts (PRD R2). */
    versionConflict: boolean("version_conflict").notNull().default(false),
    /** Distro-packaged: the version string may hide a backported fix (PRD R5). */
    backportRisk: boolean("backport_risk").notNull().default(false),
    observationCount: integer("observation_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** When we last *looked* and still found it — distinct from lastSeenAt. */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgAssetComponentUnq: uniqueIndex("inventory_components_org_asset_component_unq").on(
      table.organizationId,
      table.assetId,
      table.ecosystem,
      table.componentKey,
    ),
    // The reverse index: the matcher enters from the advisory side.
    ecosystemKeyIdx: index("inventory_components_ecosystem_key_idx").on(
      table.ecosystem,
      table.componentKey,
    ),
    orgConfirmedIdx: index("inventory_components_org_confirmed_idx").on(
      table.organizationId,
      table.lastConfirmedAt,
    ),
    evidenceObservedIdx: index("inventory_components_evidence_observed_idx").on(
      table.resolvedEvidenceTier,
      table.resolvedVersionObservedAt,
    ),
    assetIdx: index("inventory_components_asset_idx").on(table.assetId),
    versionSchemeCheck: check(
      "inventory_components_version_scheme_check",
      sql`${table.resolvedVersionScheme} IN ('semver', 'cpe', 'dotted', 'unknown')`,
    ),
    confidenceCheck: check(
      "inventory_components_confidence_check",
      sql`${table.resolvedConfidence} IS NULL OR (${table.resolvedConfidence} >= 0 AND ${table.resolvedConfidence} <= 1)`,
    ),
    resolvedSourceCheck: check(
      "inventory_components_resolved_source_check",
      sql`${table.resolvedObservationSource} IS NULL OR ${table.resolvedObservationSource} IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile')`,
    ),
    evidenceTierCheck: check(
      "inventory_components_evidence_tier_check",
      sql`${table.resolvedEvidenceTier} IN ('observed_exact', 'attested_exact', 'reported_exact', 'absent')`,
    ),
    versionReadAttemptsObjectCheck: check(
      "inventory_components_version_read_attempts_object_check",
      sql`jsonb_typeof(${table.versionReadAttempts}) = 'object'`,
    ),
  }),
);

export type InventoryComponentRow = typeof inventoryComponents.$inferSelect;
export type NewInventoryComponentRow = typeof inventoryComponents.$inferInsert;

/**
 * Every individual sighting. Never overwritten, so disagreements stay visible
 * and a customer can be shown why we believe what we believe.
 *
 * `port` carries multi-instance reality — the same product can run twice on one
 * host at different versions. `sourceAnchor` carries content identity where the
 * source has one (a Git blob SHA for a lockfile, a response hash for HTTP),
 * which is what lets a component set prove it is current without re-parsing.
 */
export const componentObservations = pgTable(
  "component_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    componentId: uuid("component_id")
      .notNull()
      .references(() => inventoryComponents.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").references(() => scopes.id, { onDelete: "set null" }),
    /**
     * Provenance, not ownership. Nullable with ON DELETE SET NULL: removing a
     * user must never remove the organization's inventory.
     */
    observedByUserId: uuid("observed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    source: text("source").$type<ComponentObservationSource>().notNull(),
    /** Null when the observation is not port-bound (a lockfile entry, say). */
    port: integer("port"),
    serviceId: uuid("service_id").references(() => inventoryServices.id, { onDelete: "set null" }),
    versionRaw: text("version_raw"),
    versionNormalized: text("version_normalized"),
    versionScheme: text("version_scheme").$type<VersionScheme>().notNull().default("unknown"),
    confidence: real("confidence"),
    sourceAnchor: text("source_anchor"),
    evidence: jsonb("evidence")
      .$type<Array<{ path: string; label?: string; excerpt?: string }>>()
      .notNull()
      .default([]),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A unique CONSTRAINT with NULLS NOT DISTINCT, not a unique index: an
    // observation with no readable version has `version_raw` NULL, and NULLs
    // are distinct in a Postgres unique index — so every re-observation of a
    // versionless component would insert another row, unbounded. The writer
    // normalizes a missing port to -1 for the same reason.
    componentSourcePortVersionUnq: unique(
      "component_observations_component_source_port_version_unq",
    )
      .on(table.componentId, table.source, table.port, table.versionRaw)
      .nullsNotDistinct(),
    componentObservedIdx: index("component_observations_component_observed_idx").on(
      table.componentId,
      table.observedAt,
    ),
    orgIdx: index("component_observations_org_idx").on(table.organizationId),
    sourceCheck: check(
      "component_observations_source_check",
      sql`${table.source} IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile')`,
    ),
    portCheck: check(
      "component_observations_port_check",
      sql`${table.port} IS NULL OR (${table.port} >= -1 AND ${table.port} <= 65535)`,
    ),
  }),
);

export type ComponentObservationRow = typeof componentObservations.$inferSelect;
export type NewComponentObservationRow = typeof componentObservations.$inferInsert;

/** Observed product string → canonical component key. Seeded, admin-extensible. */
export const componentAliases = pgTable(
  "component_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Lowercased, trimmed, exactly as the scanner reported it. */
    aliasText: text("alias_text").notNull(),
    ecosystem: text("ecosystem").$type<ComponentEcosystem>().notNull(),
    componentKey: text("component_key").notNull(),
    confidence: real("confidence").notNull().default(1),
    mappingSource: text("mapping_source").notNull().default("seed"), // 'seed' | 'admin'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aliasEcosystemUnq: uniqueIndex("component_aliases_alias_ecosystem_unq").on(
      table.aliasText,
      table.ecosystem,
    ),
    componentKeyIdx: index("component_aliases_component_key_idx").on(table.componentKey),
    mappingSourceCheck: check(
      "component_aliases_mapping_source_check",
      sql`${table.mappingSource} IN ('seed', 'admin')`,
    ),
  }),
);

export type ComponentAliasRow = typeof componentAliases.$inferSelect;
export type NewComponentAliasRow = typeof componentAliases.$inferInsert;

/**
 * GLOBAL alias coverage gaps — product strings we saw and could not resolve.
 *
 * This is our backlog, not customer feedback. A customer telling us we are
 * wrong about their site belongs in `component_overrides`: different owner,
 * different lifetime, different meaning. Conflating the two was a real bug in
 * an earlier revision of this design.
 */
export const componentUnmapped = pgTable(
  "component_unmapped",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aliasText: text("alias_text").notNull(),
    observationCount: integer("observation_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aliasUnq: uniqueIndex("component_unmapped_alias_unq").on(table.aliasText),
    countIdx: index("component_unmapped_count_idx").on(table.observationCount),
  }),
);

export type ComponentUnmappedRow = typeof componentUnmapped.$inferSelect;
export type NewComponentUnmappedRow = typeof componentUnmapped.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Advisories                                                                 */
/* -------------------------------------------------------------------------- */

export const ADVISORY_STATES = ["active", "withdrawn", "disputed", "superseded"] as const;
export type AdvisoryState = (typeof ADVISORY_STATES)[number];

export const ADVISORY_APPLICABILITY = ["simple", "complex", "absent"] as const;
export type AdvisoryApplicability = (typeof ADVISORY_APPLICABILITY)[number];

export const ADVISORY_SOURCES = [
  "nvd",
  "kev",
  "epss",
  "osv",
  "ghsa",
  "wordfence",
  "patchstack",
] as const;

export type AdvisorySourceKey = (typeof ADVISORY_SOURCES)[number];

/**
 * One row per real-world vulnerability, regardless of how many feeds describe it.
 *
 * `cveId` is nullable on purpose: WordPress plugin advisories from Wordfence and
 * Patchstack frequently have no CVE at all, and those are precisely the
 * advisories that matter most to our primary segment.
 *
 * `applicability` records whether we could flatten the advisory's affected-range
 * expression confidently. NVD applicability is a tree with AND/OR nodes and
 * negation; flattening an AND node ("product X only when on platform Y") into
 * independent ranges overmatches. Rather than build an expression evaluator up
 * front, anything we cannot flatten is marked `complex` and never auto-matches.
 * The count of `complex` advisories that matter is what would justify building
 * the evaluator later.
 */
export const advisories = pgTable(
  "advisories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 'CVE-2026-4834', or the owning feed's identifier when no CVE exists. */
    canonicalId: text("canonical_id").notNull(),
    canonicalSource: text("canonical_source").$type<AdvisorySourceKey>().notNull(),
    cveId: text("cve_id"),
    title: text("title"),
    summary: text("summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }).notNull(),
    state: text("state").$type<AdvisoryState>().notNull().default("active"),
    severity: text("severity"),
    cvssV31Vector: text("cvss_v31_vector"),
    cvssV31Score: real("cvss_v31_score"),
    epssScore: real("epss_score"),
    epssPercentile: real("epss_percentile"),
    kevListed: boolean("kev_listed").notNull().default(false),
    kevAddedAt: timestamp("kev_added_at", { withTimezone: true }),
    cweIds: text("cwe_ids").array(),
    applicability: text("applicability")
      .$type<AdvisoryApplicability>()
      .notNull()
      .default("absent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalUnq: uniqueIndex("advisories_canonical_unq").on(table.canonicalId),
    cveIdx: index("advisories_cve_idx").on(table.cveId),
    lastModifiedIdx: index("advisories_last_modified_idx").on(table.lastModifiedAt),
    kevIdx: index("advisories_kev_idx").on(table.kevListed),
    severityPublishedIdx: index("advisories_severity_published_idx").on(
      table.severity,
      table.publishedAt,
    ),
    stateCheck: check(
      "advisories_state_check",
      sql`${table.state} IN ('active', 'withdrawn', 'disputed', 'superseded')`,
    ),
    applicabilityCheck: check(
      "advisories_applicability_check",
      sql`${table.applicability} IN ('simple', 'complex', 'absent')`,
    ),
    cvssScoreCheck: check(
      "advisories_cvss_score_check",
      sql`${table.cvssV31Score} IS NULL OR (${table.cvssV31Score} >= 0 AND ${table.cvssV31Score} <= 10)`,
    ),
  }),
);

export type AdvisoryRow = typeof advisories.$inferSelect;
export type NewAdvisoryRow = typeof advisories.$inferInsert;

/**
 * One row per feed describing an advisory. `raw` is retained so the normalizer
 * can be improved and every advisory reprocessed without re-downloading
 * hundreds of thousands of records.
 */
export const advisorySources = pgTable(
  "advisory_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    advisoryId: uuid("advisory_id")
      .notNull()
      .references(() => advisories.id, { onDelete: "cascade" }),
    source: text("source").$type<AdvisorySourceKey>().notNull(),
    sourceAdvisoryId: text("source_advisory_id").notNull(),
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceAdvisoryUnq: uniqueIndex("advisory_sources_source_advisory_unq").on(
      table.source,
      table.sourceAdvisoryId,
    ),
    advisoryIdx: index("advisory_sources_advisory_idx").on(table.advisoryId),
  }),
);

export type AdvisorySourceRow = typeof advisorySources.$inferSelect;
export type NewAdvisorySourceRow = typeof advisorySources.$inferInsert;

/**
 * The matchable projection. Pure derivation of `advisory_sources.raw`:
 * deleted and re-derived whenever any source for the advisory changes, and
 * generated only for advisories classified `simple`.
 *
 * Boundaries carry explicit inclusivity because NVD distinguishes all four
 * (versionStartIncluding/Excluding, versionEndIncluding/Excluding) and collapsing
 * them silently shifts range edges by one release.
 */
export const advisoryAffectedRanges = pgTable(
  "advisory_affected_ranges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    advisoryId: uuid("advisory_id")
      .notNull()
      .references(() => advisories.id, { onDelete: "cascade" }),
    source: text("source").$type<AdvisorySourceKey>().notNull(),
    ecosystem: text("ecosystem").$type<ComponentEcosystem>().notNull(),
    componentKey: text("component_key").notNull(),
    versionScheme: text("version_scheme").$type<VersionScheme>().notNull().default("unknown"),
    introducedVersion: text("introduced_version"),
    introducedInclusive: boolean("introduced_inclusive").notNull().default(true),
    fixedVersion: text("fixed_version"),
    fixedInclusive: boolean("fixed_inclusive").notNull().default(false),
    rawConstraint: text("raw_constraint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The reverse index. Everything about matcher performance rests here.
    ecosystemKeyIdx: index("advisory_affected_ranges_ecosystem_key_idx").on(
      table.ecosystem,
      table.componentKey,
    ),
    advisoryIdx: index("advisory_affected_ranges_advisory_idx").on(table.advisoryId),
    versionSchemeCheck: check(
      "advisory_affected_ranges_version_scheme_check",
      sql`${table.versionScheme} IN ('semver', 'cpe', 'dotted', 'unknown')`,
    ),
  }),
);

export type AdvisoryAffectedRangeRow = typeof advisoryAffectedRanges.$inferSelect;
export type NewAdvisoryAffectedRangeRow = typeof advisoryAffectedRanges.$inferInsert;

/**
 * Sync cursor, per feed.
 *
 * A single timestamp cannot resume a paginated backfill: NVD enforces
 * pagination and a 120-day maximum window, so a crash halfway through a window
 * would otherwise restart it. The page offset advances per successful page and
 * the window advances only on completion.
 */
export const advisorySyncState = pgTable("advisory_sync_state", {
  source: text("source").$type<AdvisorySourceKey>().primaryKey(),
  /** Publication for the initial corpus, then modification for steady state. */
  cursorMode: text("cursor_mode")
    .$type<"publication" | "modification">()
    .notNull()
    .default("publication"),
  cursorWindowStart: timestamp("cursor_window_start", { withTimezone: true }),
  cursorWindowEnd: timestamp("cursor_window_end", { withTimezone: true }),
  cursorPageOffset: integer("cursor_page_offset").notNull().default(0),
  /**
   * Watermark captured when publication backfill begins. Once that corpus is
   * complete, modification catch-up starts here so changes made while the
   * backfill was running cannot fall through the handoff.
   */
  backfillStartedAt: timestamp("backfill_started_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** Last attempt that made trustworthy progress or applied a complete feed. */
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastStatus: text("last_status"), // 'ok' | 'partial' | 'failed'
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  recordsIngested: integer("records_ingested").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdvisorySyncStateRow = typeof advisorySyncState.$inferSelect;
export type NewAdvisorySyncStateRow = typeof advisorySyncState.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Exposure                                                                   */
/* -------------------------------------------------------------------------- */

export const EXPOSURE_MATCH_STATES = [
  "candidate",
  "notified",
  "verifying",
  "confirmed",
  /**
   * Deliberately not "not_exploitable". A bounded test that fails to reproduce
   * does not prove the absence of exploitability, and claiming otherwise would
   * contradict the honesty rule the rest of this feature is built on.
   */
  "not_reproduced",
  "inconclusive",
  "resolved",
  "dismissed",
  "stale",
] as const;

export type ExposureMatchState = (typeof EXPOSURE_MATCH_STATES)[number];

export const EXPOSURE_MATCH_CONFIDENCE = ["exact_version"] as const;
export type ExposureMatchConfidence = (typeof EXPOSURE_MATCH_CONFIDENCE)[number];

export const exposureMatches = pgTable(
  "exposure_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => inventoryComponents.id, { onDelete: "cascade" }),
    advisoryId: uuid("advisory_id")
      .notNull()
      .references(() => advisories.id, { onDelete: "cascade" }),
    matchConfidence: text("match_confidence").$type<ExposureMatchConfidence>().notNull(),
    /** Exact version evaluated against the advisory range. */
    versionEvaluated: text("version_evaluated"),
    priorityScore: real("priority_score").notNull().default(0),
    state: text("state").$type<ExposureMatchState>().notNull().default("candidate"),
    /** Snapshot of evidence age at match time, so alerts can disclose it (R3). */
    inventoryObservedAt: timestamp("inventory_observed_at", { withTimezone: true }).notNull(),
    /** Snapshot provenance; legacy nulls are deliberately ineligible to notify. */
    evidenceTier: text("evidence_tier").$type<ComponentEvidenceTier>(),
    evidenceSource: text("evidence_source").$type<ExposureEvidenceSource>(),
    verificationRunId: uuid("verification_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    riskId: uuid("risk_id").references(() => findings.id, { onDelete: "set null" }),
    /** organization + asset + componentKey + advisory canonical id. */
    dedupeKey: text("dedupe_key").notNull(),
    stateReason: text("state_reason"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDedupeUnq: uniqueIndex("exposure_matches_org_dedupe_unq").on(
      table.organizationId,
      table.dedupeKey,
    ),
    orgStatePriorityIdx: index("exposure_matches_org_state_priority_idx").on(
      table.organizationId,
      table.state,
      table.priorityScore,
    ),
    advisoryIdx: index("exposure_matches_advisory_idx").on(table.advisoryId),
    componentIdx: index("exposure_matches_component_idx").on(table.componentId),
    stateCreatedIdx: index("exposure_matches_state_created_idx").on(table.state, table.createdAt),
    stateCheck: check(
      "exposure_matches_state_check",
      sql`${table.state} IN ('candidate', 'notified', 'verifying', 'confirmed', 'not_reproduced', 'inconclusive', 'resolved', 'dismissed', 'stale')`,
    ),
    confidenceCheck: check(
      "exposure_matches_confidence_check",
      sql`${table.matchConfidence} IN ('exact_version')`,
    ),
    evidenceTierCheck: check(
      "exposure_matches_evidence_tier_check",
      sql`${table.evidenceTier} IS NULL OR ${table.evidenceTier} IN ('observed_exact', 'attested_exact', 'reported_exact', 'absent')`,
    ),
    evidenceSourceCheck: check(
      "exposure_matches_evidence_source_check",
      sql`${table.evidenceSource} IS NULL OR ${table.evidenceSource} IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile', 'customer_override')`,
    ),
  }),
);

export type ExposureMatchRow = typeof exposureMatches.$inferSelect;
export type NewExposureMatchRow = typeof exposureMatches.$inferInsert;

/** Append-only transition log, mirroring `finding_events`. */
export const exposureMatchEvents = pgTable(
  "exposure_match_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => exposureMatches.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromState: text("from_state").$type<ExposureMatchState>(),
    toState: text("to_state").$type<ExposureMatchState>(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    matchCreatedIdx: index("exposure_match_events_match_created_idx").on(
      table.matchId,
      table.createdAt,
    ),
  }),
);

export type ExposureMatchEventRow = typeof exposureMatchEvents.$inferSelect;
export type NewExposureMatchEventRow = typeof exposureMatchEvents.$inferInsert;

export const COMPONENT_OVERRIDE_ACTIONS = ["not_present", "version_correction"] as const;
export type ComponentOverrideAction = (typeof COMPONENT_OVERRIDE_ACTIONS)[number];

/**
 * The customer telling us our picture of their system is wrong.
 *
 * Per-organization, attributed, reasoned, and expiring — deliberately unlike
 * `component_unmapped`, which is our own global coverage backlog. An override
 * suppresses matching for that component until it expires.
 */
export const componentOverrides = pgTable(
  "component_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").$type<ComponentEcosystem>().notNull(),
    componentKey: text("component_key").notNull(),
    action: text("action").$type<ComponentOverrideAction>().notNull(),
    correctedVersion: text("corrected_version"),
    reason: text("reason"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgAssetComponentUnq: uniqueIndex("component_overrides_org_asset_component_unq").on(
      table.organizationId,
      table.assetId,
      table.ecosystem,
      table.componentKey,
    ),
    orgIdx: index("component_overrides_org_idx").on(table.organizationId),
    ecosystemKeyIdx: index("component_overrides_ecosystem_key_idx").on(
      table.ecosystem,
      table.componentKey,
    ),
    actionCheck: check(
      "component_overrides_action_check",
      sql`${table.action} IN ('not_present', 'version_correction')`,
    ),
    correctedVersionCheck: check(
      "component_overrides_corrected_version_check",
      sql`(${table.action} = 'version_correction' AND ${table.correctedVersion} IS NOT NULL)
          OR (${table.action} = 'not_present')`,
    ),
  }),
);

export type ComponentOverrideRow = typeof componentOverrides.$inferSelect;
export type NewComponentOverrideRow = typeof componentOverrides.$inferInsert;
