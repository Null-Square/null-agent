/**
 * Sync services for each entity type.
 * These functions load seed data and upsert to the database.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '@/db/client';
import {
    componentAliases,
    models,
} from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/shared/logger';
import { loadSeedJson, loadSeedJsonValue } from './SeedRegistry';
import {
    ComponentAliasCatalogSeedSchema,
    ModelSeedSchema,
    SandboxSettingsSeedSchema,
    RuntimeSettingsSeedSchema,
    TraceSettingsSeedSchema,
    AutomationSettingsSeedSchema,
    ThreatWatchSettingsSeedSchema,
    NetworkSettingsSeedSchema,
    HttpSettingsSeedSchema,
    WebSearchSettingsSeedSchema,
    TokenGuardSettingsSeedSchema,
    SessionLifecycleSettingsSeedSchema,
} from './schemas';
import { z } from 'zod';
import { SettingsRepository } from '@/domains/platform/settings/SettingsRepository';
import { resolveModelApiKey } from './modelSeedSecrets';
import { ModelRateRepository } from '@/domains/platform/models/ModelRateRepository';
import { validateModelRequestProfile } from '@/domains/platform/models/modelRequestProfile';
import {
    isModelProvider,
    isModelUsable,
    runsOnOwnServer,
    type ModelProvider,
} from '@/domains/platform/models/modelProviders';
import { ModelService } from '@/domains/platform/models/ModelService';

// Base paths
const SEEDS_DIR = path.resolve(__dirname, '../../../config/seeds');

type SeedRateCard = NonNullable<z.input<typeof ModelSeedSchema>['rateCards']>[number];
type StoredRateCard = Awaited<ReturnType<ModelRateRepository['listByModel']>>[number];

const normalizeSeedRate = (rate: SeedRateCard) => ({
    effectiveTo: rate.effectiveTo ? new Date(rate.effectiveTo).toISOString() : null,
    currency: (rate.currency ?? 'usd').trim().toLowerCase(),
    cacheHitInputPer1m: rate.cacheHitInputPer1m,
    cacheMissInputPer1m: rate.cacheMissInputPer1m,
    outputPer1m: rate.outputPer1m,
    sourceUrl: rate.sourceUrl ?? null,
    sourceNote: rate.sourceNote ?? null,
    windows: [...(rate.windows ?? [])]
        .sort((left, right) => left.startMinuteUtc - right.startMinuteUtc)
        .map((window) => ({ ...window })),
});

const normalizeStoredRate = ({ card, windows }: StoredRateCard) => ({
    effectiveTo: card.effectiveTo?.toISOString() ?? null,
    currency: card.currency,
    cacheHitInputPer1m: Number(card.baseCacheHitInputPer1m),
    cacheMissInputPer1m: Number(card.baseCacheMissInputPer1m),
    outputPer1m: Number(card.baseOutputPer1m),
    sourceUrl: card.sourceUrl,
    sourceNote: card.sourceNote,
    windows: windows.map((window) => ({
        name: window.name,
        startMinuteUtc: window.startMinuteUtc,
        endMinuteUtc: window.endMinuteUtc,
        cacheHitInputPer1m: Number(window.cacheHitInputPer1m),
        cacheMissInputPer1m: Number(window.cacheMissInputPer1m),
        outputPer1m: Number(window.outputPer1m),
    })),
});

export const assertSeedRateCardMatches = (
    modelName: string,
    stored: StoredRateCard,
    seeded: SeedRateCard,
): void => {
    if (JSON.stringify(normalizeStoredRate(stored)) !== JSON.stringify(normalizeSeedRate(seeded))) {
        throw new Error(
            `Seeded rate card drift for ${modelName} at ${seeded.effectiveFrom}; publish a new effectiveFrom instead of changing immutable history`,
        );
    }
};

// ============================================================================
// Models Sync
// ============================================================================

/**
 * The models configuration file (config/seeds/models.seed.json; see config/seeds/README.md).
 *
 * Its rows are the catalogue: prices for usage records, and any model the screen does not offer,
 * such as an OpenAI-compatible server (Ollama, vLLM, LM Studio, a router) by base URL. The person
 * connects ONE model (ModelService); the seed never changes that connection. With none yet, it
 * connects the entry marked `isDefault`, else the first provider key found in .env, on that
 * provider's newest chat model.
 */
export async function syncModels(): Promise<void> {
    return syncModelsFromSeed('models.seed.json', { scope: 'syncModels', connect: true });
}

type ModelSeed = z.input<typeof ModelSeedSchema>;

/**
 * A configured entry's key: its own `apiKeyEnv` or `apiKey`. A model on a server of its own never
 * takes its provider's .env key, which would hand, say, OPENAI_API_KEY to that server.
 */
export const configuredApiKey = (model: ModelSeed, env: NodeJS.ProcessEnv = process.env): string | null => {
    if (runsOnOwnServer(model.provider, model.apiBaseUrl)) {
        const named = model.apiKeyEnv ? env[model.apiKeyEnv]?.trim() : undefined;
        return named || model.apiKey?.trim() || null;
    }
    return resolveModelApiKey(model, env) ?? null;
};

async function syncModelsFromSeed(
    fileName: string,
    options: { scope: string; connect: boolean },
): Promise<void> {
    const { scope } = options;
    const seedPath = path.join(SEEDS_DIR, fileName);
    const seedData = await loadSeedJson(seedPath, z.array(ModelSeedSchema));

    if (seedData.length === 0) {
        logger.info(`[${scope}] No models to seed`);
    }

    const rateRepo = new ModelRateRepository();
    const storedIdByModelName = new Map<string, string>();
    for (const model of seedData) {
        const requestProfile = validateModelRequestProfile(model.provider, model.requestProfile ?? {});
        const sameModel = and(eq(models.provider, model.provider), eq(models.modelName, model.modelName));
        const [existing] = await db.select().from(models).where(sameModel).limit(1);
        // Catalogue fields only: whether a row is the connection, and its credential, belong to
        // ModelService.
        const catalogue = {
            name: model.name,
            description: model.description,
            selectionCategory: model.selectionCategory,
            selectionPriority: model.selectionPriority,
            requestProfile,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            apiBaseUrl: model.apiBaseUrl ?? null,
        };
        if (!existing) {
            logger.info({ model: model.name }, `[${scope}] Inserting new model`);
            await db.insert(models).values({
                id: model.id,
                provider: model.provider,
                modelName: model.modelName,
                ...catalogue,
                isDefault: false,
                isActive: false,
                apiKey: null,
            });
        } else {
            logger.info({ model: model.name }, `[${scope}] Updating existing model`);
            await db.update(models).set({ ...catalogue, updatedAt: new Date() }).where(eq(models.id, existing.id));
        }

        const [storedModel] = await db.select().from(models).where(sameModel).limit(1);
        if (!storedModel) throw new Error(`Failed to seed model ${model.modelName}`);
        storedIdByModelName.set(model.modelName, storedModel.id);
        const storedRatesBeforeSeed = await rateRepo.listByModel(storedModel.id);
        for (const rateCard of model.rateCards ?? []) {
            const effectiveFrom = new Date(rateCard.effectiveFrom);
            const existingCard = storedRatesBeforeSeed.find(
                ({ card }) => card.effectiveFrom.getTime() === effectiveFrom.getTime(),
            );
            if (existingCard) {
                assertSeedRateCardMatches(model.modelName, existingCard, rateCard);
                continue;
            }
            await rateRepo.publish({
                modelId: storedModel.id,
                effectiveFrom,
                effectiveTo: rateCard.effectiveTo ? new Date(rateCard.effectiveTo) : null,
                currency: rateCard.currency ?? 'usd',
                baseCacheHitInputPer1m: rateCard.cacheHitInputPer1m,
                baseCacheMissInputPer1m: rateCard.cacheMissInputPer1m,
                baseOutputPer1m: rateCard.outputPer1m,
                sourceUrl: rateCard.sourceUrl,
                sourceNote: rateCard.sourceNote,
                windows: rateCard.windows,
            });
        }
    }

    if (options.connect) await connectWhenUnconnected(seedData, storedIdByModelName, scope);
    logger.info({ count: seedData.length }, `[${scope}] Models synced`);
}

/** With no connection yet: the configured default entry if it can answer, else a key from .env. */
async function connectWhenUnconnected(
    seedData: ModelSeed[],
    storedIdByModelName: Map<string, string>,
    scope: string,
): Promise<void> {
    const service = new ModelService();
    if (await service.getConnection()) return;

    const configured = seedData.find((model) => model.isDefault);
    const configuredId = configured ? storedIdByModelName.get(configured.modelName) : undefined;
    if (configured && configuredId) {
        const apiKey = configuredApiKey(configured);
        if (isModelUsable({ provider: configured.provider, apiBaseUrl: configured.apiBaseUrl, hasKey: Boolean(apiKey) })) {
            await service.connectConfigured(configuredId, apiKey);
            logger.info({ modelName: configured.modelName }, `[${scope}] Connected the configured default model`);
            return;
        }
        logger.warn(
            { modelName: configured.modelName },
            `[${scope}] The configured default model has no key and no server of its own; skipping it`,
        );
    }

    // When a provider cannot be reached, its first catalogue entry stands in for "newest".
    const fallback: Partial<Record<ModelProvider, string>> = {};
    for (const model of seedData) {
        const provider = model.provider.toUpperCase();
        if (isModelProvider(provider) && !runsOnOwnServer(provider, model.apiBaseUrl)) {
            fallback[provider] ??= model.modelName;
        }
    }
    const connection = await service.connectFromEnv(process.env, fallback);
    if (!connection) {
        logger.warn(`[${scope}] No model is connected: no usable key in .env and no configured default model`);
    }
}

// ============================================================================
// Tiers Sync
// ============================================================================

async function loadSettingsSeed<T>(filePath: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const rawData = JSON.parse(content);
        return schema.parse(rawData);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.debug({ filePath }, '[loadSettingsSeed] File not found');
            return undefined;
        }
        throw error;
    }
}

/**
 * Sync settings from seed files to database.
 * Seeds are applied only if DB settings are empty (upsert semantics).
 */
export async function syncSettings(): Promise<void> {
    // Import settings services
    const { setNetworkSettings } = await import('@/domains/platform/settings/networkSettings');
    const { setSandboxSettings } = await import('@/domains/platform/settings/sandboxSettings');
    const { setRuntimeSettings } = await import('@/domains/platform/settings/runtimeSettings');
    const { setTraceSettings } = await import('@/domains/platform/settings/traceSettings');
    const { setAutomationSettings } = await import('@/domains/platform/settings/automationSettings');
    const { setThreatWatchSettings } = await import('@/domains/platform/settings/threatWatchSettings');
    const { setHttpSettings } = await import('@/domains/platform/settings/httpSettings');
    const { setWebSearchSettings } = await import('@/domains/platform/settings/webSearchSettings');
    const { setTokenGuardSettings } = await import('@/domains/platform/settings/tokenGuardSettings');
    const { setSessionLifecycleSettings } = await import('@/domains/platform/settings/sessionLifecycleSettings');
    const settingsRepo = new SettingsRepository();
    const hasSettingsRow = async (key: string) => Boolean(await settingsRepo.get(key));

    // Remove legacy settings rows that no longer have runtime consumers.
    for (const obsoleteKey of ['guardrails', 'platform', 'billing', 'email', 'urls', 'code_review']) {
        try {
            if (await hasSettingsRow(obsoleteKey)) {
                await settingsRepo.delete(obsoleteKey);
                logger.info({ key: obsoleteKey }, '[syncSettings] Removed obsolete settings row');
            }
        } catch (err) {
            logger.warn({ err, key: obsoleteKey }, '[syncSettings] Failed to remove obsolete settings row');
        }
    }

    // Sync sandbox settings
    try {
        const seedPath = path.join(SEEDS_DIR, 'settings', 'sandbox-settings.seed.json');
        const seedData = await loadSettingsSeed(seedPath, SandboxSettingsSeedSchema);
        const hasRow = await hasSettingsRow('sandbox');
        if (seedData && !hasRow) {
            await setSandboxSettings(seedData);
            logger.info('[syncSettings] Sandbox settings seeded from file');
        } else {
            logger.debug('[syncSettings] Sandbox settings already exist, skipping seed');
        }
    } catch (err) {
        logger.warn({ err }, '[syncSettings] Failed to sync sandbox settings');
    }

    // Sync runtime settings
    try {
        const seedPath = path.join(SEEDS_DIR, 'settings', 'runtime-settings.seed.json');
        const seedData = await loadSettingsSeed(seedPath, RuntimeSettingsSeedSchema);
        const hasRow = await hasSettingsRow('runtime');
        if (seedData && !hasRow) {
            await setRuntimeSettings(seedData);
            logger.info('[syncSettings] Runtime settings seeded from file');
        } else {
            logger.debug('[syncSettings] Runtime settings already exist, skipping seed');
        }
    } catch (err) {
        logger.warn({ err }, '[syncSettings] Failed to sync runtime settings');
    }

      // Sync trace settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'trace-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, TraceSettingsSeedSchema);
          const hasRow = await hasSettingsRow('trace');
        if (seedData && !hasRow) {
            await setTraceSettings(seedData);
            logger.info('[syncSettings] Trace settings seeded from file');
        } else {
            logger.debug('[syncSettings] Trace settings already exist, skipping seed');
        }
      } catch (err) {
          logger.warn({ err }, '[syncSettings] Failed to sync trace settings');
      }

      // Sync automation settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'automation-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, AutomationSettingsSeedSchema);
          const hasRow = await hasSettingsRow('automation');
        if (seedData && !hasRow) {
            await setAutomationSettings(seedData);
            logger.info('[syncSettings] Automation settings seeded from file');
        } else {
            logger.debug('[syncSettings] Automation settings already exist, skipping seed');
        }
    } catch (err) {
        logger.warn({ err }, '[syncSettings] Failed to sync automation settings');
    }

      // Sync threat watch settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'threat-watch-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, ThreatWatchSettingsSeedSchema);
          const hasRow = await hasSettingsRow('threat_watch');
          if (seedData && !hasRow) {
              // Seeded once, never overwritten: an operator who pauses the
              // watcher must not have it switched back on by a deploy.
              await setThreatWatchSettings(seedData);
              logger.info('[syncSettings] Threat watch settings seeded from file');
          } else {
              logger.debug('[syncSettings] Threat watch settings already exist, skipping seed');
          }
      } catch (err) {
          logger.warn({ err }, '[syncSettings] Failed to sync threat watch settings');
      }

      // Sync network settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'network-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, NetworkSettingsSeedSchema);
          if (seedData) {
              await setNetworkSettings(seedData);
              logger.info('[syncSettings] Network settings seeded/updated from file');
          }
      } catch (err) {
          logger.warn({ err }, '[syncSettings] Failed to sync network settings');
      }

      // Sync http settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'http-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, HttpSettingsSeedSchema);
          const hasRow = await hasSettingsRow('http');
          if (seedData && !hasRow) {
              await setHttpSettings(seedData);
              logger.info('[syncSettings] Http settings seeded from file');
          } else {
              logger.debug('[syncSettings] Http settings already exist, skipping seed');
          }
      } catch (err) {
          logger.warn({ err }, '[syncSettings] Failed to sync http settings');
      }

      // Sync web search settings
      try {
          const seedPath = path.join(SEEDS_DIR, 'settings', 'web-search-settings.seed.json');
          const seedData = await loadSettingsSeed(seedPath, WebSearchSettingsSeedSchema);
          const hasRow = await hasSettingsRow('web_search');
          if (seedData && !hasRow) {
              await setWebSearchSettings({
                  ...seedData,
                  tavilyApiKey: seedData.tavilyApiKey ?? undefined,
              });
              logger.info('[syncSettings] Web search settings seeded from file');
          } else {
              logger.debug('[syncSettings] Web search settings already exist, skipping seed');
          }
      } catch (err) {
          logger.warn({ err }, '[syncSettings] Failed to sync web search settings');
      }

    // Sync token guard settings
    try {
        const seedPath = path.join(SEEDS_DIR, 'settings', 'token-guard-settings.seed.json');
        const seedData = await loadSettingsSeed(seedPath, TokenGuardSettingsSeedSchema);
        const hasRow = await hasSettingsRow('token_guard');
        if (seedData && !hasRow) {
            await setTokenGuardSettings(seedData);
            logger.info('[syncSettings] Token guard settings seeded from file');
        } else {
            logger.debug('[syncSettings] Token guard settings already exist, skipping seed');
        }
    } catch (err) {
        logger.warn({ err }, '[syncSettings] Failed to sync token guard settings');
    }

    // Sync session lifecycle settings
    try {
        const seedPath = path.join(SEEDS_DIR, 'settings', 'session-lifecycle-settings.seed.json');
        const seedData = await loadSettingsSeed(seedPath, SessionLifecycleSettingsSeedSchema);
        const hasRow = await hasSettingsRow('session_lifecycle');
        if (seedData && !hasRow) {
            await setSessionLifecycleSettings(seedData);
            logger.info('[syncSettings] Session lifecycle settings seeded from file');
        } else {
            logger.debug('[syncSettings] Session lifecycle settings already exist, skipping seed');
        }
    } catch (err) {
        logger.warn({ err }, '[syncSettings] Failed to sync session lifecycle settings');
    }

    logger.info('[syncSettings] Settings sync complete');
}

/**
 * Component alias catalog — observed product strings mapped to canonical
 * component keys.
 *
 * Coverage here is the difference between a Threat Watch alert and silence: an
 * unmapped product never matches, by design (PRD R1), because guessing a vendor
 * is how you report another project's CVEs against someone's server.
 */
export async function syncComponentAliases(): Promise<void> {
    const seedPath = path.join(SEEDS_DIR, 'component-aliases.seed.json');
    const seedData = await loadSeedJsonValue(seedPath, ComponentAliasCatalogSeedSchema);

    if (!seedData) {
        throw new Error('[syncComponentAliases] Missing component alias seed data');
    }

    const now = new Date();

    for (const alias of seedData.aliases) {
        await db
            .insert(componentAliases)
            .values({
                aliasText: alias.aliasText.trim().toLowerCase(),
                ecosystem: alias.ecosystem,
                componentKey: alias.componentKey,
                confidence: alias.confidence ?? 1,
                mappingSource: 'seed',
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: [componentAliases.aliasText, componentAliases.ecosystem],
                set: {
                    componentKey: alias.componentKey,
                    confidence: alias.confidence ?? 1,
                    // Admin-authored mappings are not downgraded by a reseed.
                    updatedAt: now,
                },
            });
    }

    logger.info(
        { aliases: seedData.aliases.length, catalogVersion: seedData.catalogVersion },
        '[syncComponentAliases] Component alias catalog synced',
    );
}
