import type { ModelCategory } from "@null-ai/contracts";
import {
  sql,
} from "drizzle-orm";
import {
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

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  email_verified: boolean("email_verified").notNull().default(false),
  disabled: boolean("disabled").notNull().default(false),
  role: text("role").notNull().default("user"),
  full_name: text("full_name"),
  preferences: jsonb("preferences")
    .$type<{
      theme?: "light" | "dark" | "system";
      pushNotifications?: boolean;
      emailNotifications?: boolean;
      cookieConsent?: boolean;
      language?: string;
      onboardingWelcomeSeenAt?: string;
      onboardingCompletedAt?: string;
      /**
       * When this person last opened each nav destination, keyed by
       * `NavItem.id`. Drives the "something new here" mark: a destination is
       * marked when rows exist that are newer than its entry.
       *
       * Here rather than in a table of its own because it is exactly what this
       * column is for — one small fact per person about the UI, like
       * `onboardingWelcomeSeenAt` above — and because the row is already read
       * to resolve the fallback date for somebody who has never looked.
       */
      navSeenAt?: Record<string, string>;
      onboardingProgress?: {
        version: 1;
        lastCompletedStep: number;
        formData: Record<string, unknown>;
        scopeId: string | null;
        targetId: string | null;
        targetSnapshot: string;
        updatedAt: string;
      };
      communicationPreferences?: Record<string, {
        email?: boolean;
        push?: boolean;
        inApp?: boolean;
      }>;
    }>()
    .notNull()
    .default({}),
  oauth_provider: text("oauth_provider"), // 'google' | 'github' | null
  oauth_id: text("oauth_id"), // Provider's user ID
  last_login_at: timestamp("last_login_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const models = pgTable(
  "models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    displayName: text("display_name"), // User-friendly name shown in UI (e.g., "High Performance")
    provider: text("provider").notNull(), // 'QWEN' | 'OPENAI' | 'ANTHROPIC' | 'DEEPSEEK' | 'MOONSHOT'
    modelName: text("model_name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false), // Only the connection is active (and the default); ModelService keeps it so.
    selectionCategory: text("selection_category").$type<ModelCategory>().notNull().default("medium"),
    selectionPriority: integer("selection_priority").notNull().default(100),
    requestProfile: jsonb("request_profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    apiKey: text("api_key"),
    apiBaseUrl: text("api_base_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    oneDefaultUnq: uniqueIndex("models_one_default_unq")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
  }),
);

export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;

export const modelRateCards = pgTable(
  "model_rate_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    modelId: uuid("model_id").notNull().references(() => models.id, { onDelete: "cascade" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    currency: text("currency").notNull(),
    baseCacheHitInputPer1m: numeric("base_cache_hit_input_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    baseCacheMissInputPer1m: numeric("base_cache_miss_input_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    baseOutputPer1m: numeric("base_output_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    sourceUrl: text("source_url"),
    sourceNote: text("source_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    modelEffectiveIdx: index("model_rate_cards_model_effective_idx").on(table.modelId, table.effectiveFrom),
    rangeCheck: check("model_rate_cards_range_check", sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`),
    currencyCheck: check("model_rate_cards_currency_check", sql`length(trim(${table.currency})) > 0`),
    ratesCheck: check("model_rate_cards_rates_check", sql`${table.baseCacheHitInputPer1m} >= 0 AND ${table.baseCacheMissInputPer1m} >= 0 AND ${table.baseOutputPer1m} >= 0`),
  }),
);

export type ModelRateCardRow = typeof modelRateCards.$inferSelect;
export type NewModelRateCardRow = typeof modelRateCards.$inferInsert;

export const modelRateWindows = pgTable(
  "model_rate_windows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rateCardId: uuid("rate_card_id").notNull().references(() => modelRateCards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startMinuteUtc: integer("start_minute_utc").notNull(),
    endMinuteUtc: integer("end_minute_utc").notNull(),
    cacheHitInputPer1m: numeric("cache_hit_input_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    cacheMissInputPer1m: numeric("cache_miss_input_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
    outputPer1m: numeric("output_per_1m", { precision: 18, scale: 8 }).$type<number>().notNull(),
  },
  (table) => ({
    cardStartUnq: uniqueIndex("model_rate_windows_card_start_unq").on(table.rateCardId, table.startMinuteUtc),
    minuteRangeCheck: check("model_rate_windows_minute_range_check", sql`${table.startMinuteUtc} >= 0 AND ${table.endMinuteUtc} <= 1440 AND ${table.endMinuteUtc} > ${table.startMinuteUtc}`),
    ratesCheck: check("model_rate_windows_rates_check", sql`${table.cacheHitInputPer1m} >= 0 AND ${table.cacheMissInputPer1m} >= 0 AND ${table.outputPer1m} >= 0`),
  }),
);

export type ModelRateWindowRow = typeof modelRateWindows.$inferSelect;
export type NewModelRateWindowRow = typeof modelRateWindows.$inferInsert;

// ============================================================================
// Notifications
// ============================================================================

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'task_completed' | 'credits_low' | 'session_error' | 'action_required' | 'system'
    title: text("title").notNull(),
    message: text("message").notNull(),
    link: text("link"), // Optional deep link to related resource
    data: jsonb("data"), // Optional additional data
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete
  },
  (table) => ({
    userIdx: index("notifications_user_idx").on(table.userId),
    userReadIdx: index("notifications_user_read_idx").on(
      table.userId,
      table.read,
    ),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

// ============================================================================
// Seed Status (tracks which seeds have been applied - industry standard pattern)
// ============================================================================

export const seedStatus = pgTable("seed_status", {
  seedName: text("seed_name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  version: text("version"),
});

export type SeedStatusRow = typeof seedStatus.$inferSelect;
export type NewSeedStatusRow = typeof seedStatus.$inferInsert;

// ============================================================================
// Phase 2: Organizations, Scopes, Runs
// ============================================================================

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  operationalContext: text("operational_context"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserUnq: uniqueIndex("org_members_org_user_unq").on(
      table.organizationId,
      table.userId,
    ),
    userIdx: index("org_members_user_idx").on(table.userId),
  }),
);

export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type NewOrganizationMemberRow = typeof organizationMembers.$inferInsert;
