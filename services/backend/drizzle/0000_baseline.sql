CREATE TABLE "model_rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"currency" text NOT NULL,
	"base_cache_hit_input_per_1m" numeric(18, 8) NOT NULL,
	"base_cache_miss_input_per_1m" numeric(18, 8) NOT NULL,
	"base_output_per_1m" numeric(18, 8) NOT NULL,
	"source_url" text,
	"source_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_rate_cards_range_check" CHECK ("model_rate_cards"."effective_to" IS NULL OR "model_rate_cards"."effective_to" > "model_rate_cards"."effective_from"),
	CONSTRAINT "model_rate_cards_currency_check" CHECK (length(trim("model_rate_cards"."currency")) > 0),
	CONSTRAINT "model_rate_cards_rates_check" CHECK ("model_rate_cards"."base_cache_hit_input_per_1m" >= 0 AND "model_rate_cards"."base_cache_miss_input_per_1m" >= 0 AND "model_rate_cards"."base_output_per_1m" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_rate_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_minute_utc" integer NOT NULL,
	"end_minute_utc" integer NOT NULL,
	"cache_hit_input_per_1m" numeric(18, 8) NOT NULL,
	"cache_miss_input_per_1m" numeric(18, 8) NOT NULL,
	"output_per_1m" numeric(18, 8) NOT NULL,
	CONSTRAINT "model_rate_windows_minute_range_check" CHECK ("model_rate_windows"."start_minute_utc" >= 0 AND "model_rate_windows"."end_minute_utc" <= 1440 AND "model_rate_windows"."end_minute_utc" > "model_rate_windows"."start_minute_utc"),
	CONSTRAINT "model_rate_windows_rates_check" CHECK ("model_rate_windows"."cache_hit_input_per_1m" >= 0 AND "model_rate_windows"."cache_miss_input_per_1m" >= 0 AND "model_rate_windows"."output_per_1m" >= 0)
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"provider" text NOT NULL,
	"model_name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"selection_category" text DEFAULT 'medium' NOT NULL,
	"selection_priority" integer DEFAULT 100 NOT NULL,
	"request_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"api_key" text,
	"api_base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"link" text,
	"data" jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"operational_context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "seed_status" (
	"seed_name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"full_name" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"oauth_provider" text,
	"oauth_id" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "agent_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"original_name" text NOT NULL,
	"file_type" text,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"causation_event_id" uuid,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"mode" text DEFAULT 'automated' NOT NULL,
	"agent_type" text DEFAULT 'chat' NOT NULL,
	"title" text,
	"workspace_dir" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"execution_claim_token" text,
	"execution_claim_expires_at" timestamp with time zone,
	"blocked_reason" text,
	"completed" boolean DEFAULT false NOT NULL,
	"scope_id" uuid
);
--> statement-breakpoint
CREATE TABLE "history_transformation_records" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text,
	"step_id" text,
	"turn" integer NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"reducer_profile" text NOT NULL,
	"reason" text NOT NULL,
	"intent" text NOT NULL,
	"input_history_version" integer NOT NULL,
	"output_history_version" integer NOT NULL,
	"input_message_ids" jsonb NOT NULL,
	"input_start_message_id" text NOT NULL,
	"input_end_message_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"configuration_digest" text NOT NULL,
	"before_measurement" jsonb NOT NULL,
	"replacement_summary" text,
	"replacement_message_id" text,
	"after_measurement" jsonb,
	"trigger_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replacement_persisted_at" timestamp with time zone,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_request_records" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 2 NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text,
	"step_id" text,
	"turn" integer NOT NULL,
	"call_ordinal" integer NOT NULL,
	"route_reason" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"routed_context_capacity" integer NOT NULL,
	"messages" jsonb NOT NULL,
	"system_content" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"tool_choice" jsonb,
	"generation_settings" jsonb NOT NULL,
	"context_measurement_refs" jsonb NOT NULL,
	"transformation_refs" jsonb NOT NULL,
	"context_measurement" jsonb,
	"envelope" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_execution_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"model_request_id" uuid,
	"args" jsonb,
	"result" jsonb,
	"status" text DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "trace_index" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"trace_key" text NOT NULL,
	"markdown_key" text NOT NULL,
	"cost_key" text NOT NULL,
	"artifacts_prefix" text NOT NULL,
	"accepted_high_water" integer DEFAULT 0 NOT NULL,
	"persisted_high_water" integer DEFAULT 0 NOT NULL,
	"integrity_status" text DEFAULT 'degraded' NOT NULL,
	"integrity_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"organization_id" uuid,
	"turn" integer,
	"logical_call_key" text NOT NULL,
	"model_request_id" uuid,
	"attempt_schema_version" integer DEFAULT 1 NOT NULL,
	"attempt_ordinal" integer NOT NULL,
	"call_ordinal" integer NOT NULL,
	"provider_request_id" text,
	"provider" text NOT NULL,
	"model_id" uuid,
	"reported_model" text,
	"execution_backend" text DEFAULT 'api' NOT NULL,
	"requested_category" text,
	"route_reason" text NOT NULL,
	"fallback_ordinal" integer DEFAULT 0 NOT NULL,
	"request_started_at" timestamp with time zone NOT NULL,
	"request_completed_at" timestamp with time zone,
	"status" text DEFAULT 'started' NOT NULL,
	"error_class" text,
	"retry_decision" text,
	"backoff_ms" integer,
	"circuit_state" text,
	"circuit_decision" text,
	"rate_card_id" uuid,
	"rate_window_id" uuid,
	"cache_hit_rate_per_1m" numeric(18, 8) NOT NULL,
	"cache_miss_rate_per_1m" numeric(18, 8) NOT NULL,
	"output_rate_per_1m" numeric(18, 8) NOT NULL,
	"quoted_platform_margin" numeric(18, 8) NOT NULL,
	"quoted_overhead_multiplier" numeric(18, 8) NOT NULL,
	"quoted_credit_rate_per_usd" numeric(18, 8) NOT NULL,
	"credit_exempt" boolean DEFAULT false NOT NULL,
	"debit_status" text DEFAULT 'pending' NOT NULL,
	"debited_credits" numeric(18, 8) DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_source" text DEFAULT 'unavailable' NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"model" text,
	"cost" numeric(18, 8) DEFAULT 0,
	"overhead" numeric(18, 8) DEFAULT 0,
	"platform_cost" numeric(18, 8) DEFAULT 0,
	"platform_price" numeric(18, 8) DEFAULT 0,
	"credits" numeric(18, 8) DEFAULT 0,
	"currency" text DEFAULT 'usd' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_attempt_status_check" CHECK ("usage_records"."status" IN ('started', 'completed', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "usage_records_attempt_schema_check" CHECK ("usage_records"."attempt_schema_version" IN (1, 2) AND ("usage_records"."attempt_schema_version" = 1 OR "usage_records"."model_request_id" IS NOT NULL)),
	CONSTRAINT "usage_records_retry_decision_check" CHECK ("usage_records"."retry_decision" IS NULL OR "usage_records"."retry_decision" IN ('retry', 'stop', 'overflow_recovery')),
	CONSTRAINT "usage_records_backoff_check" CHECK ("usage_records"."backoff_ms" IS NULL OR "usage_records"."backoff_ms" >= 0),
	CONSTRAINT "usage_records_circuit_state_check" CHECK ("usage_records"."circuit_state" IS NULL OR "usage_records"."circuit_state" IN ('closed', 'open', 'half_open')),
	CONSTRAINT "usage_records_circuit_decision_check" CHECK ("usage_records"."circuit_decision" IS NULL OR "usage_records"."circuit_decision" IN ('allow', 'reject')),
	CONSTRAINT "usage_records_reasoning_source_check" CHECK ("usage_records"."reasoning_source" IN ('reported', 'estimated', 'unavailable')),
	CONSTRAINT "usage_records_debit_status_check" CHECK ("usage_records"."debit_status" IN ('pending', 'applied', 'exempt', 'not_applicable', 'failed')),
	CONSTRAINT "usage_records_ordinal_check" CHECK ("usage_records"."attempt_ordinal" > 0 AND "usage_records"."call_ordinal" > 0 AND "usage_records"."fallback_ordinal" >= 0),
	CONSTRAINT "usage_records_rate_check" CHECK ("usage_records"."cache_hit_rate_per_1m" >= 0 AND "usage_records"."cache_miss_rate_per_1m" >= 0 AND "usage_records"."output_rate_per_1m" >= 0),
	CONSTRAINT "usage_records_pricing_policy_check" CHECK ("usage_records"."quoted_platform_margin" >= 0 AND "usage_records"."quoted_platform_margin" < 1 AND "usage_records"."quoted_overhead_multiplier" >= 0 AND "usage_records"."quoted_credit_rate_per_usd" >= 0),
	CONSTRAINT "usage_records_token_check" CHECK ("usage_records"."prompt_tokens" >= 0 AND "usage_records"."cached_prompt_tokens" >= 0 AND "usage_records"."cache_write_tokens" >= 0 AND "usage_records"."completion_tokens" >= 0 AND "usage_records"."reasoning_tokens" >= 0 AND "usage_records"."reasoning_tokens" <= "usage_records"."completion_tokens" AND "usage_records"."total_tokens" = "usage_records"."prompt_tokens" + "usage_records"."cached_prompt_tokens" + "usage_records"."cache_write_tokens" + "usage_records"."completion_tokens")
);
--> statement-breakpoint
CREATE TABLE "code_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"location" text NOT NULL,
	"ref" text,
	"review_brief" text,
	"status" text NOT NULL,
	"error" text,
	"head_commit" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_sources_kind_check" CHECK ("code_sources"."kind" IN ('folder', 'git')),
	CONSTRAINT "code_sources_status_check" CHECK ("code_sources"."status" IN ('ready', 'cloning', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "scope_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_exclusions_type_check" CHECK ("scope_exclusions"."type" IN ('domain', 'cidr'))
);
--> statement-breakpoint
CREATE TABLE "scope_legacy_roe_archives" (
	"scope_id" uuid PRIMARY KEY NOT NULL,
	"safe_mode" boolean NOT NULL,
	"stealth_posture" text NOT NULL,
	"rate_limit_rps" integer,
	"blast_window" text,
	"roe_document" text,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archive_reason" text DEFAULT 'pentest_result_recovery_remove_dead_roe' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"execution_network" text DEFAULT 'external' NOT NULL,
	"mission" text,
	"impact_tolerance" text DEFAULT 'poc' NOT NULL,
	"compliance_frameworks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scopes_execution_network_check" CHECK ("scopes"."execution_network" IN ('external', 'internal')),
	CONSTRAINT "scopes_impact_tolerance_check" CHECK ("scopes"."impact_tolerance" IN ('non_destructive', 'poc', 'full'))
);
--> statement-breakpoint
CREATE TABLE "asset_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"user_id" uuid,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"tags" text[],
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parent_asset_id" uuid,
	"last_scanned_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"kind" text DEFAULT 'artifact' NOT NULL,
	"path" text NOT NULL,
	"display_path" text,
	"label" text,
	"excerpt" text,
	"file_missing" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_evidence_kind_check" CHECK ("finding_evidence"."kind" IN ('artifact', 'http_exchange'))
);
--> statement-breakpoint
CREATE TABLE "finding_validation_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"worker_session_id" uuid,
	"run_id" uuid,
	"disposition_verification_id" uuid,
	"outcome" text NOT NULL,
	"reason" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_validation_audit_outcome_check" CHECK ("finding_validation_audit"."outcome" IN ('validated', 'false_positive', 'inconclusive', 'fixed', 'still_present'))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"user_id" uuid,
	"asset_id" uuid,
	"repository_id" text,
	"source_kind" text DEFAULT 'assessment' NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"state" text DEFAULT 'potential' NOT NULL,
	"summary" text NOT NULL,
	"business_impact" text,
	"technical_analysis" text,
	"poc_description" text,
	"poc_script_code" text,
	"assumptions" text,
	"fix_effort" text,
	"remediation" text,
	"cvss_vector" text,
	"cvss_score" real,
	"confidence_score" real,
	"lifecycle_version" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"cwe_id" text,
	"cve_id" text,
	"cwe_ids" text[],
	"cve_ids" text[],
	"owasp_category" text,
	"assigned_to" uuid,
	"endpoint_id" uuid,
	"service_id" uuid,
	"code_locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_severity_check" CHECK ("findings"."severity" IN ('critical', 'high', 'medium', 'low', 'info')),
	CONSTRAINT "findings_source_kind_check" CHECK ("findings"."source_kind" IN ('assessment', 'code_review', 'advisory_verification')),
	CONSTRAINT "findings_state_check" CHECK ("findings"."state" IN ('potential', 'verifying', 'confirmed', 'not_reproduced', 'dismissed', 'resolved', 'accepted')),
	CONSTRAINT "findings_cvss_score_check" CHECK ("findings"."cvss_score" IS NULL OR ("findings"."cvss_score" >= 0 AND "findings"."cvss_score" <= 10)),
	CONSTRAINT "findings_fix_effort_check" CHECK ("findings"."fix_effort" IS NULL OR "findings"."fix_effort" IN ('trivial', 'low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "inventory_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid,
	"scope_id" uuid NOT NULL,
	"session_id" uuid,
	"ntype" text NOT NULL,
	"title" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"confidence" real,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_notes_dedupe_unq" UNIQUE NULLS NOT DISTINCT("user_id","organization_id","asset_id","ntype","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "inventory_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"port" integer NOT NULL,
	"service_name" text,
	"product" text,
	"version" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oob_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"user_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"token" text NOT NULL,
	"run_id" uuid,
	"session_id" uuid,
	"ts" timestamp with time zone NOT NULL,
	"protocol" text DEFAULT 'unknown' NOT NULL,
	"source_ip" text,
	"hostname" text,
	"method" text,
	"path" text,
	"payload_preview" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oob_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"session_id" uuid,
	"label" text,
	"hostname" text NOT NULL,
	"url" text NOT NULL,
	"dns" text NOT NULL,
	"correlation_id" text,
	"secret_key" text,
	"private_key_pem" text,
	"mode" text DEFAULT 'interactsh' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scanner_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"session_id" uuid,
	"asset_id" uuid,
	"finding_id" uuid,
	"parser" text NOT NULL,
	"source_tool" text NOT NULL,
	"source_version" text,
	"artifact_path" text NOT NULL,
	"observation_type" text NOT NULL,
	"title" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"confidence" real,
	"dedupe_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_observations_severity_check" CHECK ("scanner_observations"."severity" IN ('critical', 'high', 'medium', 'low', 'info'))
);
--> statement-breakpoint
CREATE TABLE "capacity_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"admission_epoch" integer NOT NULL,
	"parent_lease_id" uuid,
	"bundle_key" text NOT NULL,
	"purpose" text NOT NULL,
	"profile_key" text NOT NULL,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"memory_mb" integer NOT NULL,
	"container_slots" integer NOT NULL,
	"cpu_millis" integer,
	"pid_limit" integer,
	"sidecar_snapshot" jsonb,
	"state" text DEFAULT 'held' NOT NULL,
	"session_id" uuid,
	"worker_task_id" uuid,
	"runtime_identities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_leases_state_check" CHECK ("capacity_leases"."state" IN ('held', 'active', 'releasing', 'released')),
	CONSTRAINT "capacity_leases_purpose_check" CHECK ("capacity_leases"."purpose" IN ('control', 'execution_base', 'minimum_worker', 'optional_worker')),
	CONSTRAINT "capacity_leases_profile_check" CHECK ("capacity_leases"."profile_key" IN ('control', 'standard', 'heavy')),
	CONSTRAINT "capacity_leases_resource_check" CHECK ("capacity_leases"."memory_mb" >= 0 AND "capacity_leases"."container_slots" >= 0 AND ("capacity_leases"."cpu_millis" IS NULL OR "capacity_leases"."cpu_millis" > 0) AND ("capacity_leases"."pid_limit" IS NULL OR "capacity_leases"."pid_limit" > 0))
);
--> statement-breakpoint
CREATE TABLE "compliance_accepted_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"evidence_item_id" uuid,
	"owner" text NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_accepted_risks_status_check" CHECK ("compliance_accepted_risks"."status" IN ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "compliance_control_check_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reviewer_user_id" uuid,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_control_check_reviews_decision_check" CHECK ("compliance_control_check_reviews"."decision" IN ('confirmed', 'rejected', 'retest_required'))
);
--> statement-breakpoint
CREATE TABLE "compliance_control_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"catalog_ref" text NOT NULL,
	"basis" text DEFAULT 'agent_tested' NOT NULL,
	"verdict" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text NOT NULL,
	"proof_obligation_id" text NOT NULL,
	"method" text NOT NULL,
	"tool_name" text,
	"skill_slug" text,
	"target_ref" text NOT NULL,
	"evidence_refs" text[] DEFAULT '{}' NOT NULL,
	"finding_ids" uuid[] DEFAULT '{}' NOT NULL,
	"artifact_ids" text[] DEFAULT '{}' NOT NULL,
	"proof" jsonb NOT NULL,
	"limitations" text[] DEFAULT '{}' NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_control_checks_verdict_check" CHECK ("compliance_control_checks"."verdict" IN ('pass', 'fail', 'needs_context', 'not_attempted')),
	CONSTRAINT "compliance_control_checks_basis_check" CHECK ("compliance_control_checks"."basis" IN ('agent_tested', 'agent_reviewed_user_evidence', 'agent_reviewed_integration')),
	CONSTRAINT "compliance_control_checks_actor_type_check" CHECK ("compliance_control_checks"."created_by_actor_type" IN ('agent', 'system', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "compliance_control_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"request_type" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"requested_evidence" text[] DEFAULT '{}' NOT NULL,
	"remediation_hint" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to_user_id" uuid,
	"due_at" timestamp with time zone,
	"created_by_actor_type" text DEFAULT 'agent' NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"fulfillment_evidence_item_id" uuid,
	"fulfillment_note" text,
	"fulfilled_by_user_id" uuid,
	"fulfilled_at" timestamp with time zone,
	"review_control_check_id" uuid,
	"review_note" text,
	"reviewed_by_actor_type" text,
	"reviewed_by_actor_id" text,
	"reviewed_at" timestamp with time zone,
	"next_reverification_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_control_requests_type_check" CHECK ("compliance_control_requests"."request_type" IN ('evidence', 'access', 'context', 'remediation')),
	CONSTRAINT "compliance_control_requests_priority_check" CHECK ("compliance_control_requests"."priority" IN ('low', 'medium', 'high')),
	CONSTRAINT "compliance_control_requests_status_check" CHECK ("compliance_control_requests"."status" IN ('open', 'fulfilled', 'reviewed', 'insufficient', 'contradicted', 'cancelled')),
	CONSTRAINT "compliance_control_requests_actor_type_check" CHECK ("compliance_control_requests"."created_by_actor_type" IN ('agent', 'system', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "compliance_control_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"state" text DEFAULT 'monitored' NOT NULL,
	"exclusion_reason" text,
	"assigned_to_user_id" uuid,
	"assigned_by_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_control_states_state_check" CHECK ("compliance_control_states"."state" IN ('monitored', 'excluded')),
	CONSTRAINT "compliance_control_states_exclusion_reason_check" CHECK ("compliance_control_states"."state" <> 'excluded' OR length(trim(coalesce("compliance_control_states"."exclusion_reason", ''))) >= 5)
);
--> statement-breakpoint
CREATE TABLE "compliance_control_status_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"status" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"evidence_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"source_type" text DEFAULT 'user_upload' NOT NULL,
	"evidence_type" text DEFAULT 'other' NOT NULL,
	"owner" text,
	"status" text DEFAULT 'unreviewed' NOT NULL,
	"artifact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observation_started_at" timestamp with time zone,
	"observation_ended_at" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"uploaded_by" uuid,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_evidence_items_source_type_check" CHECK ("compliance_evidence_items"."source_type" IN ('user_upload', 'user_attestation', 'agent_finding', 'integration')),
	CONSTRAINT "compliance_evidence_items_evidence_type_check" CHECK ("compliance_evidence_items"."evidence_type" IN ('policy', 'access_review', 'risk_register', 'incident_record', 'continuity_exercise', 'vendor_review', 'change_approval', 'training_record', 'system_export', 'other')),
	CONSTRAINT "compliance_evidence_items_status_check" CHECK ("compliance_evidence_items"."status" IN ('unreviewed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "compliance_evidence_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"framework_key" text NOT NULL,
	"control_id" text NOT NULL,
	"mapping_source" text DEFAULT 'user_declared' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"rationale" text,
	"citation_anchors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_evidence_mappings_source_check" CHECK ("compliance_evidence_mappings"."mapping_source" IN ('user_declared', 'system_suggested')),
	CONSTRAINT "compliance_evidence_mappings_confidence_check" CHECK ("compliance_evidence_mappings"."confidence" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "compliance_integration_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"provider" text NOT NULL,
	"account_ref" text,
	"status" text DEFAULT 'running' NOT NULL,
	"evidence_created" integer DEFAULT 0 NOT NULL,
	"evidence_updated" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_integration_syncs_status_check" CHECK ("compliance_integration_syncs"."status" IN ('running', 'completed', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "compliance_readiness_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"framework_key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"observation_started_at" timestamp with time zone,
	"observation_ended_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_readiness_projects_status_check" CHECK ("compliance_readiness_projects"."status" IN ('active', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "finding_disposition_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"previous_verification_id" uuid,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"cancelled_by_user_id" uuid,
	"request_key" text NOT NULL,
	"requested_state" text NOT NULL,
	"reason" text,
	"snapshot" jsonb NOT NULL,
	"prior_state" text NOT NULL,
	"finding_lifecycle_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wait_reason" text,
	"failure_code" text,
	"failure_reason" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"launch_attempt_count" integer DEFAULT 0 NOT NULL,
	"max_launch_attempts" integer DEFAULT 3 NOT NULL,
	"automatic_attempt" boolean DEFAULT false NOT NULL,
	"launch_key" text NOT NULL,
	"run_id" uuid,
	"session_id" uuid,
	"outcome" text,
	"outcome_reason" text,
	"blocker_code" text,
	"proof" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_disposition_verifications_requested_state_check" CHECK ("finding_disposition_verifications"."requested_state" IN ('resolved', 'dismissed')),
	CONSTRAINT "finding_disposition_verifications_status_check" CHECK ("finding_disposition_verifications"."status" IN ('queued', 'waiting', 'launching', 'running', 'completed', 'failed', 'cancelled', 'superseded')),
	CONSTRAINT "finding_disposition_verifications_outcome_check" CHECK ("finding_disposition_verifications"."outcome" IS NULL OR "finding_disposition_verifications"."outcome" IN ('fixed', 'still_present', 'false_positive', 'validated', 'inconclusive')),
	CONSTRAINT "finding_disposition_verifications_outcome_disposition_check" CHECK ("finding_disposition_verifications"."outcome" IS NULL OR ("finding_disposition_verifications"."requested_state" = 'resolved' AND "finding_disposition_verifications"."outcome" IN ('fixed', 'still_present', 'inconclusive')) OR ("finding_disposition_verifications"."requested_state" = 'dismissed' AND "finding_disposition_verifications"."outcome" IN ('false_positive', 'validated', 'inconclusive'))),
	CONSTRAINT "finding_disposition_verifications_attempts_check" CHECK ("finding_disposition_verifications"."attempt_number" > 0 AND "finding_disposition_verifications"."launch_attempt_count" >= 0 AND "finding_disposition_verifications"."max_launch_attempts" > 0 AND "finding_disposition_verifications"."launch_attempt_count" <= "finding_disposition_verifications"."max_launch_attempts")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_performance_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"source" text DEFAULT 'trace_only' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" bigint,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_performance_summaries_status_check" CHECK ("run_performance_summaries"."status" IN ('ready', 'partial', 'unavailable')),
	CONSTRAINT "run_performance_summaries_source_check" CHECK ("run_performance_summaries"."source" IN ('prometheus', 'docker_stats', 'trace_only', 'mixed'))
);
--> statement-breakpoint
CREATE TABLE "run_phase_replans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_phase_status" text NOT NULL,
	"handoff_ref" text,
	"reason" text,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"last_dispatch_at" timestamp with time zone,
	"last_dispatch_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_phase_replans_status_check" CHECK ("run_phase_replans"."status" IN ('open', 'applied', 'failed', 'cancelled', 'superseded')),
	CONSTRAINT "run_phase_replans_requested_phase_status_check" CHECK ("run_phase_replans"."requested_phase_status" IN ('completed', 'blocked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "run_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"phase_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"session_id" uuid,
	"step_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_skill_slugs" text[],
	"phase_profile" text NOT NULL,
	"tool_profile" text NOT NULL,
	"prompt_profile" text NOT NULL,
	"delegation_mode" text DEFAULT 'solo' NOT NULL,
	"handoff_in_ref" text,
	"handoff_out_ref" text,
	"checkpoint_ref" text,
	"handoff_schema_version" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_phases_phase_key_check" CHECK ("run_phases"."phase_key" IN ('planning', 'recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting')),
	CONSTRAINT "run_phases_status_check" CHECK ("run_phases"."status" IN ('pending', 'active', 'handoff_submitted', 'completed', 'blocked', 'failed', 'timed_out', 'aborted')),
	CONSTRAINT "run_phases_delegation_mode_check" CHECK ("run_phases"."delegation_mode" IN ('solo', 'coordinator'))
);
--> statement-breakpoint
CREATE TABLE "run_validation_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase_id" uuid,
	"finding_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"rationale" text,
	"requested_by_session_id" uuid,
	"validator_session_id" uuid,
	"outcome" text,
	"result_ref" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "run_validation_queue_status_check" CHECK ("run_validation_queue"."status" IN ('queued', 'in_progress', 'validated', 'false_positive', 'inconclusive', 'failed', 'cancelled')),
	CONSTRAINT "run_validation_queue_outcome_check" CHECK ("run_validation_queue"."outcome" IS NULL OR "run_validation_queue"."outcome" IN ('validated', 'false_positive', 'inconclusive'))
);
--> statement-breakpoint
CREATE TABLE "runner_scope_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"grace_period_until" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"type" text DEFAULT 'private' NOT NULL,
	"ownership" text DEFAULT 'organization' NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"scheduling_mode" text DEFAULT 'hold' NOT NULL,
	"platform" text,
	"architecture" text,
	"ip_address" text,
	"version" text,
	"last_heartbeat_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"host_fingerprint" text,
	"capacity_policy_version" integer DEFAULT 1 NOT NULL,
	"detected_memory_mb" integer,
	"detected_container_slots" integer,
	"derived_active_run_limit" integer,
	"capacity_source" text,
	"health_snapshot" jsonb,
	"heartbeat_sequence" bigint DEFAULT 0 NOT NULL,
	"scheduling_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_status_check" CHECK ("runners"."status" IN ('online', 'busy', 'offline', 'quarantined')),
	CONSTRAINT "runners_ownership_check" CHECK ((
        ("runners"."ownership" = 'platform' AND "runners"."organization_id" IS NULL AND "runners"."type" = 'cloud')
        OR
        ("runners"."ownership" = 'organization' AND "runners"."organization_id" IS NOT NULL AND "runners"."type" = 'private')
      )),
	CONSTRAINT "runners_scheduling_mode_check" CHECK ("runners"."scheduling_mode" IN ('accepting', 'hold', 'draining')),
	CONSTRAINT "runners_capacity_values_check" CHECK ((
        ("runners"."detected_memory_mb" IS NULL OR "runners"."detected_memory_mb" > 0)
        AND ("runners"."detected_container_slots" IS NULL OR "runners"."detected_container_slots" > 0)
        AND ("runners"."derived_active_run_limit" IS NULL OR "runners"."derived_active_run_limit" > 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_id" serial NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"planner_session_id" uuid,
	"executor_session_id" uuid,
	"model_id" uuid,
	"model_category" text,
	"title" text,
	"goal" text NOT NULL,
	"plan" text,
	"mission_envelope" jsonb,
	"assigned_skill_slugs" text[],
	"idempotency_key" text,
	"workflow_discipline" text DEFAULT 'pentest' NOT NULL,
	"code_review_operation" text,
	"code_review_context" jsonb,
	"compliance_framework_key" text,
	"execution_target" text DEFAULT 'cloud' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"runner_id" uuid,
	"admission_epoch" integer DEFAULT 0 NOT NULL,
	"admission_purpose" text,
	"scheduling_class" text,
	"queued_at" timestamp with time zone,
	"eligible_at" timestamp with time zone,
	"not_before_at" timestamp with time zone,
	"capacity_wait_reason" text,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"admission_attempt_count" integer DEFAULT 0 NOT NULL,
	"admission_last_error" text,
	"capacity_profile" text,
	"capacity_profile_version" integer,
	"admitted_at" timestamp with time zone,
	"epoch_started_at" timestamp with time zone,
	"launch_payload" jsonb,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"inventory_added" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('queued', 'running', 'credits_exhausted', 'user_paused', 'awaiting_user', 'awaiting_approval', 'runner_unavailable', 'system_paused', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_workflow_discipline_check" CHECK ("runs"."workflow_discipline" IN ('pentest', 'compliance', 'code_review')),
	CONSTRAINT "runs_admission_purpose_check" CHECK ("runs"."admission_purpose" IS NULL OR "runs"."admission_purpose" IN ('planning', 'execution')),
	CONSTRAINT "runs_scheduling_class_check" CHECK ("runs"."scheduling_class" IS NULL OR "runs"."scheduling_class" IN ('free', 'paid', 'pro', 'internal')),
	CONSTRAINT "runs_capacity_profile_check" CHECK ("runs"."capacity_profile" IS NULL OR "runs"."capacity_profile" IN ('control', 'standard', 'heavy')),
	CONSTRAINT "runs_code_review_identity_check" CHECK ((
        (
          "runs"."workflow_discipline" = 'code_review'
          AND "runs"."code_review_operation" IN ('repository_review', 'pull_request_review', 'finding_fix')
          AND "runs"."code_review_context" IS NOT NULL
          AND "runs"."code_review_context"->>'operation' = "runs"."code_review_operation"
          AND "runs"."compliance_framework_key" IS NULL
        )
        OR
        (
          "runs"."workflow_discipline" <> 'code_review'
          AND "runs"."code_review_operation" IS NULL
          AND "runs"."code_review_context" IS NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "scope_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"parsed_text" text,
	"parse_status" text DEFAULT 'unsupported' NOT NULL,
	"parse_error" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_documents_kind_check" CHECK ("scope_documents"."kind" IN ('policy', 'roe', 'access_list', 'network', 'prior_report', 'other')),
	CONSTRAINT "scope_documents_parse_status_check" CHECK ("scope_documents"."parse_status" IN ('parsed', 'empty', 'unsupported', 'error'))
);
--> statement-breakpoint
CREATE TABLE "scope_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verification_method" text,
	"verification_token" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_targets_verification_method_check" CHECK ("scope_targets"."verification_method" IS NULL OR "scope_targets"."verification_method" IN ('dns_txt', 'http_well_known', 'manual_review', 'legacy_auto', 'none', 'connected_site', 'wordpress_plugin', 'lab'))
);
--> statement-breakpoint
CREATE TABLE "session_performance_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'ready' NOT NULL,
	"source" text DEFAULT 'trace_only' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" bigint,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_performance_summaries_status_check" CHECK ("session_performance_summaries"."status" IN ('ready', 'partial', 'unavailable')),
	CONSTRAINT "session_performance_summaries_source_check" CHECK ("session_performance_summaries"."source" IN ('prometheus', 'docker_stats', 'trace_only', 'mixed'))
);
--> statement-breakpoint
CREATE TABLE "setup_recommendation_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"state_signature" text NOT NULL,
	"surface" text DEFAULT 'home' NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_rec_dismissals_surface_check" CHECK ("setup_recommendation_dismissals"."surface" IN ('home', 'assistant', 'onboarding'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"changes" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_reason" text
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope_id" uuid NOT NULL,
	"model_id" uuid,
	"model_category" text,
	"workflow_discipline" text DEFAULT 'pentest' NOT NULL,
	"compliance_framework_key" text,
	"execution_target" text DEFAULT 'cloud' NOT NULL,
	"goal" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"deferred_reason" text,
	"deferred_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_workflow_discipline_check" CHECK ("automations"."workflow_discipline" IN ('pentest', 'compliance')),
	CONSTRAINT "automations_compliance_framework_check" CHECK ((
        ("automations"."workflow_discipline" = 'pentest' AND "automations"."compliance_framework_key" IS NULL)
        OR
        ("automations"."workflow_discipline" = 'compliance' AND "automations"."compliance_framework_key" IN ('soc2', 'gdpr', 'hipaa', 'pci_dss', 'iso27001', 'nist_csf'))
      ))
);
--> statement-breakpoint
CREATE TABLE "failed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scope_access_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"username" text,
	"header_name" text,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"notes" text,
	"applies_to_hosts" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scope_test_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"label" text NOT NULL,
	"role_label" text,
	"kind" text NOT NULL,
	"username" text,
	"header_name" text,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"applies_to_hosts" text[] DEFAULT '{}' NOT NULL,
	"refresh_procedure" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_test_personas_kind_check" CHECK ("scope_test_personas"."kind" IN ('custom_header', 'bearer_token', 'cookie_session', 'storage_state'))
);
--> statement-breakpoint
CREATE TABLE "code_review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_by_session_id" uuid,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"commit_sha" text NOT NULL,
	"first_seen_commit_sha" text NOT NULL,
	"last_seen_commit_sha" text NOT NULL,
	"supersedes_finding_id" uuid,
	"risk_id" uuid,
	"fingerprint" text NOT NULL,
	"fingerprint_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"severity" text NOT NULL,
	"confidence" real NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"impact" text NOT NULL,
	"remediation" text NOT NULL,
	"locations" jsonb NOT NULL,
	"change_attribution" text DEFAULT 'repository_scope' NOT NULL,
	"attribution_rationale" text,
	"validation" jsonb,
	"fixability" text DEFAULT 'uncertain' NOT NULL,
	"fixability_rationale" text,
	"expected_files" text[] DEFAULT '{}' NOT NULL,
	"validation_plan" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_findings_state_check" CHECK ("code_review_findings"."state" IN ('candidate', 'validated', 'rejected')),
	CONSTRAINT "code_review_findings_severity_check" CHECK ("code_review_findings"."severity" IN ('critical', 'high', 'medium', 'low', 'info')),
	CONSTRAINT "code_review_findings_confidence_check" CHECK ("code_review_findings"."confidence" >= 0 AND "code_review_findings"."confidence" <= 1),
	CONSTRAINT "code_review_findings_fixability_check" CHECK ("code_review_findings"."fixability" IN ('fixable', 'not_fixable', 'uncertain')),
	CONSTRAINT "code_review_findings_attribution_check" CHECK ("code_review_findings"."change_attribution" IN ('repository_scope', 'introduced', 'exposed', 'worsened', 'pre_existing_context'))
);
--> statement-breakpoint
CREATE TABLE "code_review_fix_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"finding_version" integer NOT NULL,
	"vulnerable_commit_sha" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_fix_requests_status_check" CHECK ("code_review_fix_requests"."status" IN ('requested', 'generating', 'preview_ready', 'approved', 'published', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "code_review_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalized_by_session_id" uuid,
	"executive_summary" text NOT NULL,
	"scope_summary" text NOT NULL,
	"markdown" text NOT NULL,
	"finding_ids" uuid[] DEFAULT '{}' NOT NULL,
	"limitations" text[] DEFAULT '{}' NOT NULL,
	"completeness" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_reports_completeness_check" CHECK ("code_review_reports"."completeness" IN ('complete', 'partial', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "code_review_run_memory_snapshots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"prompt_text" text DEFAULT '' NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_id" text NOT NULL,
	"canonical_source" text NOT NULL,
	"cve_id" text,
	"title" text,
	"summary" text,
	"published_at" timestamp with time zone,
	"last_modified_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"severity" text,
	"cvss_v31_vector" text,
	"cvss_v31_score" real,
	"epss_score" real,
	"epss_percentile" real,
	"kev_listed" boolean DEFAULT false NOT NULL,
	"kev_added_at" timestamp with time zone,
	"cwe_ids" text[],
	"applicability" text DEFAULT 'absent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisories_state_check" CHECK ("advisories"."state" IN ('active', 'withdrawn', 'disputed', 'superseded')),
	CONSTRAINT "advisories_applicability_check" CHECK ("advisories"."applicability" IN ('simple', 'complex', 'absent')),
	CONSTRAINT "advisories_cvss_score_check" CHECK ("advisories"."cvss_v31_score" IS NULL OR ("advisories"."cvss_v31_score" >= 0 AND "advisories"."cvss_v31_score" <= 10))
);
--> statement-breakpoint
CREATE TABLE "advisory_affected_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advisory_id" uuid NOT NULL,
	"source" text NOT NULL,
	"ecosystem" text NOT NULL,
	"component_key" text NOT NULL,
	"version_scheme" text DEFAULT 'unknown' NOT NULL,
	"introduced_version" text,
	"introduced_inclusive" boolean DEFAULT true NOT NULL,
	"fixed_version" text,
	"fixed_inclusive" boolean DEFAULT false NOT NULL,
	"raw_constraint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisory_affected_ranges_version_scheme_check" CHECK ("advisory_affected_ranges"."version_scheme" IN ('semver', 'cpe', 'dotted', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "advisory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advisory_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_advisory_id" text NOT NULL,
	"source_modified_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisory_sync_state" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor_mode" text DEFAULT 'publication' NOT NULL,
	"cursor_window_start" timestamp with time zone,
	"cursor_window_end" timestamp with time zone,
	"cursor_page_offset" integer DEFAULT 0 NOT NULL,
	"backfill_started_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"records_ingested" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_scope_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias_text" text NOT NULL,
	"ecosystem" text NOT NULL,
	"component_key" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"mapping_source" text DEFAULT 'seed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_aliases_mapping_source_check" CHECK ("component_aliases"."mapping_source" IN ('seed', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "component_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_id" uuid,
	"observed_by_user_id" uuid,
	"session_id" uuid,
	"source" text NOT NULL,
	"port" integer,
	"service_id" uuid,
	"version_raw" text,
	"version_normalized" text,
	"version_scheme" text DEFAULT 'unknown' NOT NULL,
	"confidence" real,
	"source_anchor" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_observations_component_source_port_version_unq" UNIQUE NULLS NOT DISTINCT("component_id","source","port","version_raw"),
	CONSTRAINT "component_observations_source_check" CHECK ("component_observations"."source" IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile')),
	CONSTRAINT "component_observations_port_check" CHECK ("component_observations"."port" IS NULL OR ("component_observations"."port" >= -1 AND "component_observations"."port" <= 65535))
);
--> statement-breakpoint
CREATE TABLE "component_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"ecosystem" text NOT NULL,
	"component_key" text NOT NULL,
	"action" text NOT NULL,
	"corrected_version" text,
	"reason" text,
	"actor_user_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_overrides_action_check" CHECK ("component_overrides"."action" IN ('not_present', 'version_correction')),
	CONSTRAINT "component_overrides_corrected_version_check" CHECK (("component_overrides"."action" = 'version_correction' AND "component_overrides"."corrected_version" IS NOT NULL)
          OR ("component_overrides"."action" = 'not_present'))
);
--> statement-breakpoint
CREATE TABLE "component_unmapped" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias_text" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exposure_match_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exposure_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"advisory_id" uuid NOT NULL,
	"match_confidence" text NOT NULL,
	"version_evaluated" text,
	"priority_score" real DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"inventory_observed_at" timestamp with time zone NOT NULL,
	"evidence_tier" text,
	"evidence_source" text,
	"verification_run_id" uuid,
	"risk_id" uuid,
	"dedupe_key" text NOT NULL,
	"state_reason" text,
	"notified_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_matches_state_check" CHECK ("exposure_matches"."state" IN ('candidate', 'notified', 'verifying', 'confirmed', 'not_reproduced', 'inconclusive', 'resolved', 'dismissed', 'stale')),
	CONSTRAINT "exposure_matches_confidence_check" CHECK ("exposure_matches"."match_confidence" IN ('exact_version')),
	CONSTRAINT "exposure_matches_evidence_tier_check" CHECK ("exposure_matches"."evidence_tier" IS NULL OR "exposure_matches"."evidence_tier" IN ('observed_exact', 'attested_exact', 'reported_exact', 'absent')),
	CONSTRAINT "exposure_matches_evidence_source_check" CHECK ("exposure_matches"."evidence_source" IS NULL OR "exposure_matches"."evidence_source" IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile', 'customer_override'))
);
--> statement-breakpoint
CREATE TABLE "inventory_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"ecosystem" text NOT NULL,
	"component_key" text NOT NULL,
	"display_name" text NOT NULL,
	"resolved_version" text,
	"resolved_version_scheme" text DEFAULT 'unknown' NOT NULL,
	"resolved_confidence" real,
	"resolved_observation_source" text,
	"resolved_version_observed_at" timestamp with time zone,
	"resolved_evidence_tier" text DEFAULT 'absent' NOT NULL,
	"version_read_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version_conflict" boolean DEFAULT false NOT NULL,
	"backport_risk" boolean DEFAULT false NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_components_version_scheme_check" CHECK ("inventory_components"."resolved_version_scheme" IN ('semver', 'cpe', 'dotted', 'unknown')),
	CONSTRAINT "inventory_components_confidence_check" CHECK ("inventory_components"."resolved_confidence" IS NULL OR ("inventory_components"."resolved_confidence" >= 0 AND "inventory_components"."resolved_confidence" <= 1)),
	CONSTRAINT "inventory_components_resolved_source_check" CHECK ("inventory_components"."resolved_observation_source" IS NULL OR "inventory_components"."resolved_observation_source" IN ('httpx', 'agent', 'scan_preview', 'connected_site', 'lockfile')),
	CONSTRAINT "inventory_components_evidence_tier_check" CHECK ("inventory_components"."resolved_evidence_tier" IN ('observed_exact', 'attested_exact', 'reported_exact', 'absent')),
	CONSTRAINT "inventory_components_version_read_attempts_object_check" CHECK (jsonb_typeof("inventory_components"."version_read_attempts") = 'object')
);
--> statement-breakpoint
ALTER TABLE "model_rate_cards" ADD CONSTRAINT "model_rate_cards_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_rate_windows" ADD CONSTRAINT "model_rate_windows_rate_card_id_model_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."model_rate_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_transformation_records" ADD CONSTRAINT "history_transformation_records_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_request_records" ADD CONSTRAINT "model_request_records_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_execution_records" ADD CONSTRAINT "tool_execution_records_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_index" ADD CONSTRAINT "trace_index_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_model_request_id_model_request_records_request_id_fk" FOREIGN KEY ("model_request_id") REFERENCES "public"."model_request_records"("request_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_rate_card_id_model_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."model_rate_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_rate_window_id_model_rate_windows_id_fk" FOREIGN KEY ("rate_window_id") REFERENCES "public"."model_rate_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sources" ADD CONSTRAINT "code_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sources" ADD CONSTRAINT "code_sources_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_exclusions" ADD CONSTRAINT "scope_exclusions_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_exclusions" ADD CONSTRAINT "scope_exclusions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_legacy_roe_archives" ADD CONSTRAINT "scope_legacy_roe_archives_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_observations" ADD CONSTRAINT "asset_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_observations" ADD CONSTRAINT "asset_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_observations" ADD CONSTRAINT "asset_observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_observations" ADD CONSTRAINT "asset_observations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_audit" ADD CONSTRAINT "finding_validation_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_audit" ADD CONSTRAINT "finding_validation_audit_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_audit" ADD CONSTRAINT "finding_validation_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_audit" ADD CONSTRAINT "finding_validation_audit_worker_session_id_agent_sessions_id_fk" FOREIGN KEY ("worker_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_endpoint_id_inventory_notes_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."inventory_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_service_id_inventory_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."inventory_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_notes" ADD CONSTRAINT "inventory_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_notes" ADD CONSTRAINT "inventory_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_notes" ADD CONSTRAINT "inventory_notes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_notes" ADD CONSTRAINT "inventory_notes_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_notes" ADD CONSTRAINT "inventory_notes_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_services" ADD CONSTRAINT "inventory_services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_services" ADD CONSTRAINT "inventory_services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_services" ADD CONSTRAINT "inventory_services_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_interactions" ADD CONSTRAINT "oob_interactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_interactions" ADD CONSTRAINT "oob_interactions_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_interactions" ADD CONSTRAINT "oob_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_interactions" ADD CONSTRAINT "oob_interactions_token_id_oob_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."oob_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_interactions" ADD CONSTRAINT "oob_interactions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_tokens" ADD CONSTRAINT "oob_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_tokens" ADD CONSTRAINT "oob_tokens_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_tokens" ADD CONSTRAINT "oob_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oob_tokens" ADD CONSTRAINT "oob_tokens_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_observations" ADD CONSTRAINT "scanner_observations_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_leases" ADD CONSTRAINT "capacity_leases_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_leases" ADD CONSTRAINT "capacity_leases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_leases" ADD CONSTRAINT "capacity_leases_parent_lease_id_capacity_leases_id_fk" FOREIGN KEY ("parent_lease_id") REFERENCES "public"."capacity_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_leases" ADD CONSTRAINT "capacity_leases_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_accepted_risks" ADD CONSTRAINT "compliance_accepted_risks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_accepted_risks" ADD CONSTRAINT "compliance_accepted_risks_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_accepted_risks" ADD CONSTRAINT "compliance_accepted_risks_evidence_item_id_compliance_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."compliance_evidence_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_accepted_risks" ADD CONSTRAINT "compliance_accepted_risks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_check_reviews" ADD CONSTRAINT "compliance_control_check_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_check_reviews" ADD CONSTRAINT "compliance_control_check_reviews_check_id_compliance_control_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."compliance_control_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_check_reviews" ADD CONSTRAINT "compliance_control_check_reviews_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_check_reviews" ADD CONSTRAINT "compliance_control_check_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_checks" ADD CONSTRAINT "compliance_control_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_checks" ADD CONSTRAINT "compliance_control_checks_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_checks" ADD CONSTRAINT "compliance_control_checks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_checks" ADD CONSTRAINT "compliance_control_checks_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_fulfillment_evidence_item_id_compliance_evidence_items_id_fk" FOREIGN KEY ("fulfillment_evidence_item_id") REFERENCES "public"."compliance_evidence_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_fulfilled_by_user_id_users_id_fk" FOREIGN KEY ("fulfilled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_requests" ADD CONSTRAINT "compliance_control_requests_review_control_check_id_compliance_control_checks_id_fk" FOREIGN KEY ("review_control_check_id") REFERENCES "public"."compliance_control_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_states" ADD CONSTRAINT "compliance_control_states_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_status_snapshots" ADD CONSTRAINT "compliance_control_status_snapshots_project_id_compliance_readiness_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."compliance_readiness_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_status_snapshots" ADD CONSTRAINT "compliance_control_status_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_status_snapshots" ADD CONSTRAINT "compliance_control_status_snapshots_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_items" ADD CONSTRAINT "compliance_evidence_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_items" ADD CONSTRAINT "compliance_evidence_items_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_items" ADD CONSTRAINT "compliance_evidence_items_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_mappings" ADD CONSTRAINT "compliance_evidence_mappings_evidence_item_id_compliance_evidence_items_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."compliance_evidence_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_mappings" ADD CONSTRAINT "compliance_evidence_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_mappings" ADD CONSTRAINT "compliance_evidence_mappings_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_evidence_mappings" ADD CONSTRAINT "compliance_evidence_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_integration_syncs" ADD CONSTRAINT "compliance_integration_syncs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_integration_syncs" ADD CONSTRAINT "compliance_integration_syncs_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_readiness_projects" ADD CONSTRAINT "compliance_readiness_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_readiness_projects" ADD CONSTRAINT "compliance_readiness_projects_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_readiness_projects" ADD CONSTRAINT "compliance_readiness_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_previous_verification_id_finding_disposition_verifications_id_fk" FOREIGN KEY ("previous_verification_id") REFERENCES "public"."finding_disposition_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_disposition_verifications" ADD CONSTRAINT "finding_disposition_verifications_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_performance_summaries" ADD CONSTRAINT "run_performance_summaries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_phase_replans" ADD CONSTRAINT "run_phase_replans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_phase_replans" ADD CONSTRAINT "run_phase_replans_phase_id_run_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."run_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_queue" ADD CONSTRAINT "run_validation_queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_queue" ADD CONSTRAINT "run_validation_queue_phase_id_run_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."run_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_queue" ADD CONSTRAINT "run_validation_queue_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_queue" ADD CONSTRAINT "run_validation_queue_requested_by_session_id_agent_sessions_id_fk" FOREIGN KEY ("requested_by_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_queue" ADD CONSTRAINT "run_validation_queue_validator_session_id_agent_sessions_id_fk" FOREIGN KEY ("validator_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_scope_assignments" ADD CONSTRAINT "runner_scope_assignments_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_scope_assignments" ADD CONSTRAINT "runner_scope_assignments_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_planner_session_id_agent_sessions_id_fk" FOREIGN KEY ("planner_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_executor_session_id_agent_sessions_id_fk" FOREIGN KEY ("executor_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_documents" ADD CONSTRAINT "scope_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_documents" ADD CONSTRAINT "scope_documents_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_documents" ADD CONSTRAINT "scope_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_targets" ADD CONSTRAINT "scope_targets_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_performance_summaries" ADD CONSTRAINT "session_performance_summaries_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_performance_summaries" ADD CONSTRAINT "session_performance_summaries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_recommendation_dismissals" ADD CONSTRAINT "setup_recommendation_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_recommendation_dismissals" ADD CONSTRAINT "setup_recommendation_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_recommendation_dismissals" ADD CONSTRAINT "setup_recommendation_dismissals_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failed_events" ADD CONSTRAINT "failed_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_access_materials" ADD CONSTRAINT "scope_access_materials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_access_materials" ADD CONSTRAINT "scope_access_materials_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_access_materials" ADD CONSTRAINT "scope_access_materials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_test_personas" ADD CONSTRAINT "scope_test_personas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_test_personas" ADD CONSTRAINT "scope_test_personas_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_test_personas" ADD CONSTRAINT "scope_test_personas_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_created_by_session_id_agent_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_supersedes_finding_id_code_review_findings_id_fk" FOREIGN KEY ("supersedes_finding_id") REFERENCES "public"."code_review_findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_findings" ADD CONSTRAINT "code_review_findings_risk_id_findings_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_fix_requests" ADD CONSTRAINT "code_review_fix_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_fix_requests" ADD CONSTRAINT "code_review_fix_requests_finding_id_code_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."code_review_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_fix_requests" ADD CONSTRAINT "code_review_fix_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_reports" ADD CONSTRAINT "code_review_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_reports" ADD CONSTRAINT "code_review_reports_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_reports" ADD CONSTRAINT "code_review_reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_reports" ADD CONSTRAINT "code_review_reports_finalized_by_session_id_agent_sessions_id_fk" FOREIGN KEY ("finalized_by_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_run_memory_snapshots" ADD CONSTRAINT "code_review_run_memory_snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_run_memory_snapshots" ADD CONSTRAINT "code_review_run_memory_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_review_run_memory_snapshots" ADD CONSTRAINT "code_review_run_memory_snapshots_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisory_affected_ranges" ADD CONSTRAINT "advisory_affected_ranges_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisory_sources" ADD CONSTRAINT "advisory_sources_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_scope_memberships" ADD CONSTRAINT "asset_scope_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_scope_memberships" ADD CONSTRAINT "asset_scope_memberships_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_scope_memberships" ADD CONSTRAINT "asset_scope_memberships_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_component_id_inventory_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."inventory_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_observed_by_user_id_users_id_fk" FOREIGN KEY ("observed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_observations" ADD CONSTRAINT "component_observations_service_id_inventory_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."inventory_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_overrides" ADD CONSTRAINT "component_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_overrides" ADD CONSTRAINT "component_overrides_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_overrides" ADD CONSTRAINT "component_overrides_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_match_events" ADD CONSTRAINT "exposure_match_events_match_id_exposure_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."exposure_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_match_events" ADD CONSTRAINT "exposure_match_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_match_events" ADD CONSTRAINT "exposure_match_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_component_id_inventory_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."inventory_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_verification_run_id_runs_id_fk" FOREIGN KEY ("verification_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_matches" ADD CONSTRAINT "exposure_matches_risk_id_findings_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_components" ADD CONSTRAINT "inventory_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_components" ADD CONSTRAINT "inventory_components_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_rate_cards_model_effective_idx" ON "model_rate_cards" USING btree ("model_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "model_rate_windows_card_start_unq" ON "model_rate_windows" USING btree ("rate_card_id","start_minute_utc");--> statement-breakpoint
CREATE UNIQUE INDEX "models_one_default_unq" ON "models" USING btree ("is_default") WHERE "models"."is_default" = true;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_org_user_unq" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_artifacts_session_idx" ON "agent_artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_checkpoints_session_idx" ON "agent_checkpoints" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_messages_session_idx" ON "agent_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_messages_created_idx" ON "agent_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_events_session_sequence_uq" ON "agent_session_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_sessions_user_id_idx" ON "agent_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_recovery_due_idx" ON "agent_sessions" USING btree ("next_attempt_at","execution_claim_expires_at");--> statement-breakpoint
CREATE INDEX "history_transformation_session_idx" ON "history_transformation_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "history_transformation_run_idx" ON "history_transformation_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "history_transformation_session_status_idx" ON "history_transformation_records" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "model_request_session_idx" ON "model_request_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "model_request_run_idx" ON "model_request_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "model_request_session_turn_idx" ON "model_request_records" USING btree ("session_id","turn","call_ordinal");--> statement-breakpoint
CREATE INDEX "tool_exec_session_idx" ON "tool_execution_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tool_exec_tool_call_idx" ON "tool_execution_records" USING btree ("tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_exec_unique_tool_call" ON "tool_execution_records" USING btree ("session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "trace_index_trace_key_idx" ON "trace_index" USING btree ("trace_key");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_attempt_unq" ON "usage_records" USING btree ("logical_call_key","attempt_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_request_attempt_unq" ON "usage_records" USING btree ("model_request_id","attempt_ordinal");--> statement-breakpoint
CREATE INDEX "usage_records_session_idx" ON "usage_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "usage_records_org_idx" ON "usage_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_records_org_recorded_idx" ON "usage_records" USING btree ("organization_id","recorded_at");--> statement-breakpoint
CREATE INDEX "usage_records_recorded_idx" ON "usage_records" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "usage_records_status_started_idx" ON "usage_records" USING btree ("status","request_started_at");--> statement-breakpoint
CREATE INDEX "usage_records_execution_backend_idx" ON "usage_records" USING btree ("execution_backend");--> statement-breakpoint
CREATE UNIQUE INDEX "code_sources_scope_unq" ON "code_sources" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "code_sources_org_idx" ON "code_sources" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scope_exclusions_scope_idx" ON "scope_exclusions" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_exclusions_scope_type_value_unq" ON "scope_exclusions" USING btree ("scope_id","type","value");--> statement-breakpoint
CREATE INDEX "scopes_org_idx" ON "scopes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_observations_asset_session_unq" ON "asset_observations" USING btree ("asset_id","session_id");--> statement-breakpoint
CREATE INDEX "asset_observations_asset_idx" ON "asset_observations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_observations_session_idx" ON "asset_observations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "asset_observations_user_last_seen_idx" ON "asset_observations" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_kind_value_unq" ON "assets" USING btree ("organization_id","kind","value");--> statement-breakpoint
CREATE INDEX "assets_user_last_seen_idx" ON "assets" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "assets_org_idx" ON "assets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "assets_scope_idx" ON "assets" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "assets_scope_last_seen_idx" ON "assets" USING btree ("scope_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "finding_events_finding_idx" ON "finding_events" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "finding_events_finding_created_idx" ON "finding_events" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_evidence_finding_path_unq" ON "finding_evidence" USING btree ("finding_id","path");--> statement-breakpoint
CREATE INDEX "finding_evidence_finding_idx" ON "finding_evidence" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "finding_evidence_session_idx" ON "finding_evidence" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "finding_validation_audit_finding_idx" ON "finding_validation_audit" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "finding_validation_audit_worker_session_idx" ON "finding_validation_audit" USING btree ("worker_session_id");--> statement-breakpoint
CREATE INDEX "finding_validation_audit_run_idx" ON "finding_validation_audit" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "finding_validation_audit_disposition_verification_idx" ON "finding_validation_audit" USING btree ("disposition_verification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_source_dedupe_key_unq" ON "findings" USING btree ("organization_id","source_kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "findings_asset_idx" ON "findings" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "findings_repository_idx" ON "findings" USING btree ("organization_id","repository_id");--> statement-breakpoint
CREATE INDEX "findings_user_last_seen_idx" ON "findings" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "findings_org_idx" ON "findings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "findings_scope_idx" ON "findings" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "findings_severity_state_idx" ON "findings" USING btree ("severity","state");--> statement-breakpoint
CREATE INDEX "findings_cvss_score_idx" ON "findings" USING btree ("cvss_score");--> statement-breakpoint
CREATE INDEX "findings_confidence_score_idx" ON "findings" USING btree ("confidence_score");--> statement-breakpoint
CREATE INDEX "findings_owasp_category_idx" ON "findings" USING btree ("owasp_category");--> statement-breakpoint
CREATE INDEX "findings_org_owasp_idx" ON "findings" USING btree ("organization_id","owasp_category");--> statement-breakpoint
CREATE INDEX "inventory_notes_org_scope_ntype_idx" ON "inventory_notes" USING btree ("organization_id","scope_id","ntype");--> statement-breakpoint
CREATE INDEX "inventory_notes_asset_ntype_idx" ON "inventory_notes" USING btree ("asset_id","ntype");--> statement-breakpoint
CREATE INDEX "inventory_notes_user_last_seen_idx" ON "inventory_notes" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_services_asset_proto_port_unq" ON "inventory_services" USING btree ("asset_id","protocol","port");--> statement-breakpoint
CREATE INDEX "inventory_services_asset_idx" ON "inventory_services" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "inventory_services_user_last_seen_idx" ON "inventory_services" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oob_interactions_dedupe_unq" ON "oob_interactions" USING btree ("organization_id","token","dedupe_key");--> statement-breakpoint
CREATE INDEX "oob_interactions_token_idx" ON "oob_interactions" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "oob_interactions_org_scope_idx" ON "oob_interactions" USING btree ("organization_id","scope_id");--> statement-breakpoint
CREATE INDEX "oob_interactions_ts_idx" ON "oob_interactions" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "oob_tokens_token_unq" ON "oob_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "oob_tokens_correlation_idx" ON "oob_tokens" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "oob_tokens_org_scope_idx" ON "oob_tokens" USING btree ("organization_id","scope_id");--> statement-breakpoint
CREATE INDEX "oob_tokens_run_idx" ON "oob_tokens" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "oob_tokens_expires_idx" ON "oob_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_observations_dedupe_unq" ON "scanner_observations" USING btree ("user_id","organization_id","parser","dedupe_key");--> statement-breakpoint
CREATE INDEX "scanner_observations_org_scope_idx" ON "scanner_observations" USING btree ("organization_id","scope_id");--> statement-breakpoint
CREATE INDEX "scanner_observations_asset_idx" ON "scanner_observations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "scanner_observations_finding_idx" ON "scanner_observations" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "capacity_leases_live_runner_idx" ON "capacity_leases" USING btree ("runner_id","state");--> statement-breakpoint
CREATE INDEX "capacity_leases_run_epoch_idx" ON "capacity_leases" USING btree ("run_id","admission_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_leases_live_bundle_unq" ON "capacity_leases" USING btree ("run_id","admission_epoch","bundle_key") WHERE "capacity_leases"."state" IN ('held', 'active', 'releasing');--> statement-breakpoint
CREATE INDEX "compliance_accepted_risks_org_control_idx" ON "compliance_accepted_risks" USING btree ("organization_id","scope_id","framework_key","control_id","status");--> statement-breakpoint
CREATE INDEX "compliance_accepted_risks_expires_idx" ON "compliance_accepted_risks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "compliance_control_check_reviews_check_created_idx" ON "compliance_control_check_reviews" USING btree ("check_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_control_check_reviews_run_created_idx" ON "compliance_control_check_reviews" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_control_checks_org_scope_control_idx" ON "compliance_control_checks" USING btree ("organization_id","scope_id","framework_key","control_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_control_checks_run_idx" ON "compliance_control_checks" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_control_checks_session_idx" ON "compliance_control_checks" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_control_checks_idempotency_unq" ON "compliance_control_checks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "compliance_control_requests_org_scope_control_status_idx" ON "compliance_control_requests" USING btree ("organization_id","scope_id","framework_key","control_id","status");--> statement-breakpoint
CREATE INDEX "compliance_control_requests_run_idx" ON "compliance_control_requests" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_control_requests_assignee_idx" ON "compliance_control_requests" USING btree ("organization_id","assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "compliance_control_requests_reverification_idx" ON "compliance_control_requests" USING btree ("organization_id","scope_id","next_reverification_at") WHERE "compliance_control_requests"."next_reverification_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_control_requests_idempotency_unq" ON "compliance_control_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_control_states_org_scope_control_unq" ON "compliance_control_states" USING btree ("organization_id","scope_id","framework_key","control_id");--> statement-breakpoint
CREATE INDEX "compliance_control_states_org_scope_framework_state_idx" ON "compliance_control_states" USING btree ("organization_id","scope_id","framework_key","state");--> statement-breakpoint
CREATE INDEX "compliance_control_states_assignee_idx" ON "compliance_control_states" USING btree ("organization_id","assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "compliance_control_status_snapshots_project_idx" ON "compliance_control_status_snapshots" USING btree ("project_id","framework_key","control_id");--> statement-breakpoint
CREATE INDEX "compliance_control_status_snapshots_org_generated_idx" ON "compliance_control_status_snapshots" USING btree ("organization_id","scope_id","framework_key","generated_at");--> statement-breakpoint
CREATE INDEX "compliance_evidence_items_org_scope_status_idx" ON "compliance_evidence_items" USING btree ("organization_id","scope_id","status");--> statement-breakpoint
CREATE INDEX "compliance_evidence_items_valid_until_idx" ON "compliance_evidence_items" USING btree ("valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_evidence_mappings_item_framework_control_unq" ON "compliance_evidence_mappings" USING btree ("evidence_item_id","framework_key","control_id");--> statement-breakpoint
CREATE INDEX "compliance_evidence_mappings_org_control_idx" ON "compliance_evidence_mappings" USING btree ("organization_id","scope_id","framework_key","control_id");--> statement-breakpoint
CREATE INDEX "compliance_integration_syncs_org_provider_started_idx" ON "compliance_integration_syncs" USING btree ("organization_id","provider","started_at");--> statement-breakpoint
CREATE INDEX "compliance_integration_syncs_scope_provider_started_idx" ON "compliance_integration_syncs" USING btree ("scope_id","provider","started_at");--> statement-breakpoint
CREATE INDEX "compliance_readiness_projects_org_scope_idx" ON "compliance_readiness_projects" USING btree ("organization_id","scope_id","framework_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_disposition_verifications_active_finding_unq" ON "finding_disposition_verifications" USING btree ("finding_id") WHERE "finding_disposition_verifications"."status" IN ('queued', 'waiting', 'launching', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "finding_disposition_verifications_org_request_key_unq" ON "finding_disposition_verifications" USING btree ("organization_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_disposition_verifications_series_attempt_unq" ON "finding_disposition_verifications" USING btree ("series_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_disposition_verifications_launch_key_unq" ON "finding_disposition_verifications" USING btree ("launch_key");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_disposition_verifications_run_unq" ON "finding_disposition_verifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "finding_disposition_verifications_due_idx" ON "finding_disposition_verifications" USING btree ("next_attempt_at","organization_id") WHERE "finding_disposition_verifications"."status" IN ('queued', 'waiting', 'launching');--> statement-breakpoint
CREATE INDEX "finding_disposition_verifications_finding_created_idx" ON "finding_disposition_verifications" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "finding_disposition_verifications_org_status_idx" ON "finding_disposition_verifications" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_events_run_created_idx" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_performance_summaries_run_unq" ON "run_performance_summaries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_performance_summaries_generated_idx" ON "run_performance_summaries" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "run_phase_replans_run_idx" ON "run_phase_replans" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_phase_replans_phase_status_idx" ON "run_phase_replans" USING btree ("phase_id","status");--> statement-breakpoint
CREATE INDEX "run_phase_replans_due_idx" ON "run_phase_replans" USING btree ("status","next_attempt_at","claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_phase_replans_open_phase_unq" ON "run_phase_replans" USING btree ("run_id","phase_id") WHERE "run_phase_replans"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "run_phases_run_ordinal_unq" ON "run_phases" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "run_phases_run_status_idx" ON "run_phases" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "run_phases_session_idx" ON "run_phases" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "run_validation_queue_run_status_idx" ON "run_validation_queue" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "run_validation_queue_phase_status_idx" ON "run_validation_queue" USING btree ("phase_id","status");--> statement-breakpoint
CREATE INDEX "run_validation_queue_finding_idx" ON "run_validation_queue" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_validation_queue_run_finding_unq" ON "run_validation_queue" USING btree ("run_id","finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_scope_unq" ON "runner_scope_assignments" USING btree ("runner_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_scope_scope_unq" ON "runner_scope_assignments" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "runner_scope_scope_idx" ON "runner_scope_assignments" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "runner_tokens_runner_idx" ON "runner_tokens" USING btree ("runner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tokens_hash_unq" ON "runner_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "runners_org_idx" ON "runners" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runners_status_idx" ON "runners" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_platform_name_unq" ON "runners" USING btree ("name") WHERE "runners"."ownership" = 'platform';--> statement-breakpoint
CREATE INDEX "runs_org_idx" ON "runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runs_scope_idx" ON "runs" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "runs_planner_session_idx" ON "runs" USING btree ("planner_session_id");--> statement-breakpoint
CREATE INDEX "runs_executor_session_idx" ON "runs" USING btree ("executor_session_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_admission_queue_idx" ON "runs" USING btree ("status","not_before_at","eligible_at","queued_at");--> statement-breakpoint
CREATE INDEX "runs_admission_claim_idx" ON "runs" USING btree ("claim_expires_at","claim_owner");--> statement-breakpoint
CREATE INDEX "runs_workflow_discipline_idx" ON "runs" USING btree ("workflow_discipline");--> statement-breakpoint
CREATE INDEX "runs_user_idx" ON "runs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_org_idempotency_key_unq" ON "runs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "scope_documents_org_scope_created_idx" ON "scope_documents" USING btree ("organization_id","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "scope_documents_scope_kind_idx" ON "scope_documents" USING btree ("scope_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_targets_scope_type_value_unq" ON "scope_targets" USING btree ("scope_id","type","value");--> statement-breakpoint
CREATE INDEX "scope_targets_scope_idx" ON "scope_targets" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_performance_summaries_session_unq" ON "session_performance_summaries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_performance_summaries_run_idx" ON "session_performance_summaries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "session_performance_summaries_generated_idx" ON "session_performance_summaries" USING btree ("generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_rec_dismissals_user_scope_action_sig_unq" ON "setup_recommendation_dismissals" USING btree ("user_id","scope_id","action_id","state_signature");--> statement-breakpoint
CREATE INDEX "setup_rec_dismissals_org_scope_idx" ON "setup_recommendation_dismissals" USING btree ("organization_id","scope_id","dismissed_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_run_idx" ON "automation_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automations_org_idx" ON "automations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automations_scope_idx" ON "automations" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "automations_workflow_discipline_idx" ON "automations" USING btree ("workflow_discipline");--> statement-breakpoint
CREATE INDEX "automations_next_run_idx" ON "automations" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "failed_events_org_next_retry_idx" ON "failed_events" USING btree ("organization_id","next_retry_at");--> statement-breakpoint
CREATE INDEX "failed_events_retry_due_idx" ON "failed_events" USING btree ("next_retry_at","retry_count");--> statement-breakpoint
CREATE INDEX "scope_access_materials_org_scope_idx" ON "scope_access_materials" USING btree ("organization_id","scope_id");--> statement-breakpoint
CREATE INDEX "scope_access_materials_scope_label_idx" ON "scope_access_materials" USING btree ("scope_id","label");--> statement-breakpoint
CREATE INDEX "scope_test_personas_org_scope_idx" ON "scope_test_personas" USING btree ("organization_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_test_personas_scope_label_unq" ON "scope_test_personas" USING btree ("scope_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_findings_run_fingerprint_unq" ON "code_review_findings" USING btree ("run_id","fingerprint");--> statement-breakpoint
CREATE INDEX "code_review_findings_run_state_idx" ON "code_review_findings" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX "code_review_findings_org_scope_idx" ON "code_review_findings" USING btree ("organization_id","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "code_review_findings_repository_fingerprint_idx" ON "code_review_findings" USING btree ("organization_id","repository_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "code_review_findings_risk_idx" ON "code_review_findings" USING btree ("risk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_fix_requests_finding_version_unq" ON "code_review_fix_requests" USING btree ("finding_id","finding_version");--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_reports_run_unq" ON "code_review_reports" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "code_review_reports_org_scope_idx" ON "code_review_reports" USING btree ("organization_id","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "code_review_run_memory_snapshots_org_repository_idx" ON "code_review_run_memory_snapshots" USING btree ("organization_id","repository_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "advisories_canonical_unq" ON "advisories" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "advisories_cve_idx" ON "advisories" USING btree ("cve_id");--> statement-breakpoint
CREATE INDEX "advisories_last_modified_idx" ON "advisories" USING btree ("last_modified_at");--> statement-breakpoint
CREATE INDEX "advisories_kev_idx" ON "advisories" USING btree ("kev_listed");--> statement-breakpoint
CREATE INDEX "advisories_severity_published_idx" ON "advisories" USING btree ("severity","published_at");--> statement-breakpoint
CREATE INDEX "advisory_affected_ranges_ecosystem_key_idx" ON "advisory_affected_ranges" USING btree ("ecosystem","component_key");--> statement-breakpoint
CREATE INDEX "advisory_affected_ranges_advisory_idx" ON "advisory_affected_ranges" USING btree ("advisory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "advisory_sources_source_advisory_unq" ON "advisory_sources" USING btree ("source","source_advisory_id");--> statement-breakpoint
CREATE INDEX "advisory_sources_advisory_idx" ON "advisory_sources" USING btree ("advisory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_scope_memberships_asset_scope_unq" ON "asset_scope_memberships" USING btree ("asset_id","scope_id");--> statement-breakpoint
CREATE INDEX "asset_scope_memberships_scope_idx" ON "asset_scope_memberships" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "asset_scope_memberships_org_idx" ON "asset_scope_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "component_aliases_alias_ecosystem_unq" ON "component_aliases" USING btree ("alias_text","ecosystem");--> statement-breakpoint
CREATE INDEX "component_aliases_component_key_idx" ON "component_aliases" USING btree ("component_key");--> statement-breakpoint
CREATE INDEX "component_observations_component_observed_idx" ON "component_observations" USING btree ("component_id","observed_at");--> statement-breakpoint
CREATE INDEX "component_observations_org_idx" ON "component_observations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "component_overrides_org_asset_component_unq" ON "component_overrides" USING btree ("organization_id","asset_id","ecosystem","component_key");--> statement-breakpoint
CREATE INDEX "component_overrides_org_idx" ON "component_overrides" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "component_overrides_ecosystem_key_idx" ON "component_overrides" USING btree ("ecosystem","component_key");--> statement-breakpoint
CREATE UNIQUE INDEX "component_unmapped_alias_unq" ON "component_unmapped" USING btree ("alias_text");--> statement-breakpoint
CREATE INDEX "component_unmapped_count_idx" ON "component_unmapped" USING btree ("observation_count");--> statement-breakpoint
CREATE INDEX "exposure_match_events_match_created_idx" ON "exposure_match_events" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exposure_matches_org_dedupe_unq" ON "exposure_matches" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "exposure_matches_org_state_priority_idx" ON "exposure_matches" USING btree ("organization_id","state","priority_score");--> statement-breakpoint
CREATE INDEX "exposure_matches_advisory_idx" ON "exposure_matches" USING btree ("advisory_id");--> statement-breakpoint
CREATE INDEX "exposure_matches_component_idx" ON "exposure_matches" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "exposure_matches_state_created_idx" ON "exposure_matches" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_components_org_asset_component_unq" ON "inventory_components" USING btree ("organization_id","asset_id","ecosystem","component_key");--> statement-breakpoint
CREATE INDEX "inventory_components_ecosystem_key_idx" ON "inventory_components" USING btree ("ecosystem","component_key");--> statement-breakpoint
CREATE INDEX "inventory_components_org_confirmed_idx" ON "inventory_components" USING btree ("organization_id","last_confirmed_at");--> statement-breakpoint
CREATE INDEX "inventory_components_evidence_observed_idx" ON "inventory_components" USING btree ("resolved_evidence_tier","resolved_version_observed_at");--> statement-breakpoint
CREATE INDEX "inventory_components_asset_idx" ON "inventory_components" USING btree ("asset_id");--> statement-breakpoint
-- Drizzle models the final table state. This is the one database-owned behavior that cannot be
-- expressed in the TypeScript schema: the Risk lifecycle version must advance exactly once when
-- its state changes, regardless of which trusted writer performs the update.
CREATE OR REPLACE FUNCTION increment_finding_lifecycle_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.state IS DISTINCT FROM OLD.state THEN
		NEW.lifecycle_version := OLD.lifecycle_version + 1;
	ELSE
		NEW.lifecycle_version := OLD.lifecycle_version;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER findings_lifecycle_version_trigger
BEFORE UPDATE OF state, lifecycle_version ON findings
FOR EACH ROW
EXECUTE FUNCTION increment_finding_lifecycle_version();
