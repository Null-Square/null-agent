import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ContextMeasurement,
  ContextMeasurementSnapshot,
} from "@/domains/agent-brain/domain/context";
import { modelRateCards, modelRateWindows, models, organizations, users } from "./platform";

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    mode: text("mode").notNull().default("automated"),
    agentType: text("agent_type").notNull().default("chat"),
    title: text("title"),
    workspaceDir: text("workspace_dir").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    plan: jsonb("plan").$type<unknown>().notNull().default([]),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Durable retry backoff (Phase 2)
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    executionClaimToken: text("execution_claim_token"),
    executionClaimExpiresAt: timestamp("execution_claim_expires_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    // Session completion tracking (for notification deduplication)
    completed: boolean("completed").notNull().default(false),
    // Phase 2: Scope binding for SecurityOps runs
    scopeId: uuid("scope_id"),
  },
  (table) => ({
    userIdx: index("agent_sessions_user_id_idx").on(table.userId),
    recoveryDueIdx: index("agent_sessions_recovery_due_idx").on(
      table.nextAttemptAt,
      table.executionClaimExpiresAt,
    ),
  }),
);

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;

/**
 * Canonical semantic history for an agent session.
 *
 * Runtime snapshots and read models may be rebuilt from this ordered journal. The
 * timestamp is audit data only; `sequence` is the sole execution ordering key.
 */
export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    eventId: uuid("event_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    causationEventId: uuid("causation_event_id"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionSequenceUnique: uniqueIndex("agent_session_events_session_sequence_uq").on(
      table.sessionId,
      table.sequence,
    ),
  }),
);

export type AgentSessionEventRow = typeof agentSessionEvents.$inferSelect;
export type NewAgentSessionEventRow = typeof agentSessionEvents.$inferInsert;

export const agentMessages = pgTable(
  "agent_messages",
  {
    // Canonical/provider/synthetic message identities are opaque strings. A
    // UUID column made valid compaction and recovery IDs fail at projection.
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_messages_session_idx").on(table.sessionId),
    createdIdx: index("agent_messages_created_idx").on(table.createdAt),
  }),
);

export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type NewAgentMessageRow = typeof agentMessages.$inferInsert;

export const agentArtifacts = pgTable(
  "agent_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    originalName: text("original_name").notNull(),
    fileType: text("file_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_artifacts_session_idx").on(table.sessionId),
  }),
);

export type AgentArtifactRow = typeof agentArtifacts.$inferSelect;
export type NewAgentArtifactRow = typeof agentArtifacts.$inferInsert;

export const agentCheckpoints = pgTable(
  "agent_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_checkpoints_session_idx").on(table.sessionId),
  }),
);

export type AgentCheckpointRow = typeof agentCheckpoints.$inferSelect;
export type NewAgentCheckpointRow = typeof agentCheckpoints.$inferInsert;

// ============================================================================
// Tool Execution Records (idempotency layer for tool executions)
// ============================================================================

export const toolExecutionRecords = pgTable(
  "tool_execution_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(), // e.g. "turn-5"
    toolCallId: text("tool_call_id").notNull(), // LLM's tool_call.id - idempotency key
    toolName: text("tool_name").notNull(),
    modelRequestId: uuid("model_request_id"),
    args: jsonb("args").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<unknown>(),
    status: text("status").notNull().default("claimed"),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  (table) => ({
    sessionIdx: index("tool_exec_session_idx").on(table.sessionId),
    toolCallIdx: index("tool_exec_tool_call_idx").on(table.toolCallId),
    uniqueToolCall: uniqueIndex("tool_exec_unique_tool_call").on(
      table.sessionId,
      table.toolCallId,
    ),
  }),
);

export type ToolExecutionRecordRow = typeof toolExecutionRecords.$inferSelect;
export type NewToolExecutionRecordRow =
  typeof toolExecutionRecords.$inferInsert;

export const modelRequestRecords = pgTable(
  "model_request_records",
  {
    requestId: uuid("request_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    stepId: text("step_id"),
    turn: integer("turn").notNull(),
    callOrdinal: integer("call_ordinal").notNull(),
    routeReason: text("route_reason").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    routedContextCapacity: integer("routed_context_capacity").notNull(),
    messages: jsonb("messages").$type<unknown[]>().notNull(),
    systemContent: jsonb("system_content").$type<unknown[]>().notNull(),
    tools: jsonb("tools").$type<unknown[]>().notNull(),
    toolChoice: jsonb("tool_choice").$type<unknown>(),
    generationSettings: jsonb("generation_settings")
      .$type<Record<string, unknown>>()
      .notNull(),
    contextMeasurementRefs: jsonb("context_measurement_refs").$type<string[]>().notNull(),
    transformationRefs: jsonb("transformation_refs").$type<string[]>().notNull(),
    contextMeasurement: jsonb("context_measurement").$type<ContextMeasurement>(),
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("model_request_session_idx").on(table.sessionId),
    runIdx: index("model_request_run_idx").on(table.runId),
    sessionTurnIdx: index("model_request_session_turn_idx").on(
      table.sessionId,
      table.turn,
      table.callOrdinal,
    ),
  }),
);

export type ModelRequestRecordRow = typeof modelRequestRecords.$inferSelect;
export type NewModelRequestRecordRow = typeof modelRequestRecords.$inferInsert;

export const historyTransformationRecords = pgTable(
  "history_transformation_records",
  {
    transactionId: text("transaction_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    stepId: text("step_id"),
    turn: integer("turn").notNull(),
    status: text("status").notNull().default("prepared"),
    reducerProfile: text("reducer_profile").notNull(),
    reason: text("reason").notNull(),
    intent: text("intent").notNull(),
    inputHistoryVersion: integer("input_history_version").notNull(),
    outputHistoryVersion: integer("output_history_version").notNull(),
    inputMessageIds: jsonb("input_message_ids").$type<string[]>().notNull(),
    inputStartMessageId: text("input_start_message_id").notNull(),
    inputEndMessageId: text("input_end_message_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    configurationDigest: text("configuration_digest").notNull(),
    beforeMeasurement: jsonb("before_measurement").$type<ContextMeasurementSnapshot>().notNull(),
    replacementSummary: text("replacement_summary"),
    replacementMessageId: text("replacement_message_id"),
    afterMeasurement: jsonb("after_measurement").$type<ContextMeasurementSnapshot>(),
    triggerRequestId: text("trigger_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    replacementPersistedAt: timestamp("replacement_persisted_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => ({
    sessionIdx: index("history_transformation_session_idx").on(table.sessionId),
    runIdx: index("history_transformation_run_idx").on(table.runId),
    sessionStatusIdx: index("history_transformation_session_status_idx").on(
      table.sessionId,
      table.status,
    ),
  }),
);

export type HistoryTransformationRecordRow = typeof historyTransformationRecords.$inferSelect;
export type NewHistoryTransformationRecordRow = typeof historyTransformationRecords.$inferInsert;

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Session retention may remove the operational session, but not the recorded attempt.
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    turn: integer("turn"),
    logicalCallKey: text("logical_call_key").notNull(),
    modelRequestId: uuid("model_request_id").references(() => modelRequestRecords.requestId, {
      onDelete: "set null",
    }),
    attemptSchemaVersion: integer("attempt_schema_version").notNull().default(1),
    attemptOrdinal: integer("attempt_ordinal").notNull(),
    callOrdinal: integer("call_ordinal").notNull(),
    providerRequestId: text("provider_request_id"),
    provider: text("provider").notNull(),
    // Nullable: usage is recorded for cost visibility, and a call with no pinned deployment or no
    // rate card is still recorded (at zero rates) rather than refused.
    modelId: uuid("model_id").references(() => models.id, { onDelete: "restrict" }),
    reportedModel: text("reported_model"),
    /**
     * Which backend carried the wire: `api`, or a dev runtime such as `codex-app-server`.
     *
     * Descriptive only. It selects no behaviour and gates no branch, so a subscription batch and an
     * API batch are summed by the same query and differ only in this label.
     */
    executionBackend: text("execution_backend").notNull().default("api"),
    requestedCategory: text("requested_category"),
    routeReason: text("route_reason").notNull(),
    fallbackOrdinal: integer("fallback_ordinal").notNull().default(0),
    requestStartedAt: timestamp("request_started_at", { withTimezone: true }).notNull(),
    requestCompletedAt: timestamp("request_completed_at", { withTimezone: true }),
    status: text("status").notNull().default("started"),
    errorClass: text("error_class"),
    retryDecision: text("retry_decision"),
    backoffMs: integer("backoff_ms"),
    circuitState: text("circuit_state"),
    circuitDecision: text("circuit_decision"),
    rateCardId: uuid("rate_card_id").references(() => modelRateCards.id, { onDelete: "restrict" }),
    rateWindowId: uuid("rate_window_id").references(() => modelRateWindows.id, { onDelete: "restrict" }),
    cacheHitRatePer1m: numeric("cache_hit_rate_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    cacheMissRatePer1m: numeric("cache_miss_rate_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    outputRatePer1m: numeric("output_rate_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    quotedPlatformMargin: numeric("quoted_platform_margin", { precision: 18, scale: 8 }).$type<number>().notNull(),
    quotedOverheadMultiplier: numeric("quoted_overhead_multiplier", { precision: 18, scale: 8 }).$type<number>().notNull(),
    quotedCreditRatePerUsd: numeric("quoted_credit_rate_per_usd", { precision: 18, scale: 8 }).$type<number>().notNull(),
    creditExempt: boolean("credit_exempt").notNull().default(false),
    debitStatus: text("debit_status").notNull().default("pending"),
    debitedCredits: numeric("debited_credits", { precision: 18, scale: 8 }).$type<number>().notNull().default(0),
    promptTokens: bigint("prompt_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cachedPromptTokens: bigint("cached_prompt_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" })
      .notNull()
      .default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" })
      .notNull()
      .default(0),
    reasoningSource: text("reasoning_source").notNull().default("unavailable"),
    totalTokens: bigint("total_tokens", { mode: "number" })
      .notNull()
      .default(0),
    model: text("model"),
    cost: numeric("cost", { precision: 18, scale: 8 })
      .$type<number>()
      .default(0),
    overhead: numeric("overhead", { precision: 18, scale: 8 })
      .$type<number>()
      .default(0),
    platformCost: numeric("platform_cost", { precision: 18, scale: 8 })
      .$type<number>()
      .default(0),
    platformPrice: numeric("platform_price", { precision: 18, scale: 8 })
      .$type<number>()
      .default(0),
    credits: numeric("credits", { precision: 18, scale: 8 })
      .$type<number>()
      .default(0),
    currency: text("currency").notNull().default("usd"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    attemptUnq: uniqueIndex("usage_records_attempt_unq").on(table.logicalCallKey, table.attemptOrdinal),
    requestAttemptUnq: uniqueIndex("usage_records_request_attempt_unq").on(table.modelRequestId, table.attemptOrdinal),
    sessionIdx: index("usage_records_session_idx").on(table.sessionId),
    orgIdx: index("usage_records_org_idx").on(table.organizationId),
    orgRecordedIdx: index("usage_records_org_recorded_idx").on(table.organizationId, table.recordedAt),
    recordedIdx: index("usage_records_recorded_idx").on(table.recordedAt),
    statusStartedIdx: index("usage_records_status_started_idx").on(table.status, table.requestStartedAt),
    attemptStatusCheck: check("usage_records_attempt_status_check", sql`${table.status} IN ('started', 'completed', 'failed', 'uncertain', 'cancelled')`),
    attemptSchemaCheck: check("usage_records_attempt_schema_check", sql`${table.attemptSchemaVersion} IN (1, 2) AND (${table.attemptSchemaVersion} = 1 OR ${table.modelRequestId} IS NOT NULL)`),
    retryDecisionCheck: check("usage_records_retry_decision_check", sql`${table.retryDecision} IS NULL OR ${table.retryDecision} IN ('retry', 'stop', 'overflow_recovery')`),
    backoffCheck: check("usage_records_backoff_check", sql`${table.backoffMs} IS NULL OR ${table.backoffMs} >= 0`),
    circuitStateCheck: check("usage_records_circuit_state_check", sql`${table.circuitState} IS NULL OR ${table.circuitState} IN ('closed', 'open', 'half_open')`),
    circuitDecisionCheck: check("usage_records_circuit_decision_check", sql`${table.circuitDecision} IS NULL OR ${table.circuitDecision} IN ('allow', 'reject')`),
    reasoningSourceCheck: check("usage_records_reasoning_source_check", sql`${table.reasoningSource} IN ('reported', 'estimated', 'unavailable')`),
    debitStatusCheck: check("usage_records_debit_status_check", sql`${table.debitStatus} IN ('pending', 'applied', 'exempt', 'not_applicable', 'failed')`),
    ordinalCheck: check("usage_records_ordinal_check", sql`${table.attemptOrdinal} > 0 AND ${table.callOrdinal} > 0 AND ${table.fallbackOrdinal} >= 0`),
    // Declared here so the baseline migration creates it. It was once missing here,
    // so `drizzle-kit generate` proposed DROPPING a live index — the schema file quietly disagreeing
    // with the database is how a "no-op" migration deletes something.
    executionBackendIdx: index("usage_records_execution_backend_idx").on(table.executionBackend),
    rateCheck: check("usage_records_rate_check", sql`${table.cacheHitRatePer1m} >= 0 AND ${table.cacheMissRatePer1m} >= 0 AND ${table.outputRatePer1m} >= 0`),
    pricingPolicyCheck: check("usage_records_pricing_policy_check", sql`${table.quotedPlatformMargin} >= 0 AND ${table.quotedPlatformMargin} < 1 AND ${table.quotedOverheadMultiplier} >= 0 AND ${table.quotedCreditRatePerUsd} >= 0`),
    tokenCheck: check(
      "usage_records_token_check",
      sql`${table.promptTokens} >= 0 AND ${table.cachedPromptTokens} >= 0 AND ${table.cacheWriteTokens} >= 0 AND ${table.completionTokens} >= 0 AND ${table.reasoningTokens} >= 0 AND ${table.reasoningTokens} <= ${table.completionTokens} AND ${table.totalTokens} = ${table.promptTokens} + ${table.cachedPromptTokens} + ${table.cacheWriteTokens} + ${table.completionTokens}`,
    ),
  }),
);

export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;

// ============================================================================
// Support Tickets (unified customer support system)
// ============================================================================

export const traceIndex = pgTable(
  "trace_index",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    traceKey: text("trace_key").notNull(),
    markdownKey: text("markdown_key").notNull(),
    costKey: text("cost_key").notNull(),
    artifactsPrefix: text("artifacts_prefix").notNull(),
    acceptedHighWater: integer("accepted_high_water").notNull().default(0),
    persistedHighWater: integer("persisted_high_water").notNull().default(0),
    integrityStatus: text("integrity_status").notNull().default("degraded"),
    integrityDetails: jsonb("integrity_details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    traceIdx: index("trace_index_trace_key_idx").on(table.traceKey),
  }),
);

export type TraceIndexRow = typeof traceIndex.$inferSelect;
export type NewTraceIndexRow = typeof traceIndex.$inferInsert;
