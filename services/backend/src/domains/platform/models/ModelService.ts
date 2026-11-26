import { ModelRepository } from './ModelRepository';
import type { ModelRow } from '@/db/schema';
import { logger } from '@/shared/logger';
import { decryptModelApiKey, encryptModelApiKey } from './modelApiKeyCipher';
import {
  DEFAULT_MODEL_CATEGORY,
  MODEL_CATEGORIES,
  MODEL_CATEGORY_DESCRIPTIONS,
  MODEL_CATEGORY_LABELS,
  type ModelCategory,
} from '@null-ai/contracts';
import { validateModelRequestProfile } from './modelRequestProfile';
import {
  CHATGPT_PROVIDER,
  isModelProvider,
  MODEL_API_KEY_ENV_BY_PROVIDER,
  MODEL_PROVIDERS,
  runsOnOwnServer,
  type ModelProvider,
} from './modelProviders';
import { listChatGptPlanModels, listProviderModels, type CatalogModel } from './modelCatalog';
import { ChatGptCredentials, encryptCredentialRecord, hasPlanTokens, readCredentialRecord } from './chatGptCredentials';
import type { ChatGptCredentialRecord } from './chatGptAuth';
import { ErrorFactory, isAppError } from '@/shared/errors';

const modelConstraint = (message: string, httpStatus?: number): never => {
  throw ErrorFactory.validation.constraintViolated(message, { userMessage: message, httpStatus });
};

/** Until the person picks a plan model, the ChatGPT row needs a name; it is never active then. */
export const CHATGPT_MODEL_NOT_CHOSEN = 'chatgpt-model-not-chosen';

/** The model the agent uses. Never carries a key or a token. */
export type ModelConnection = {
  modelId: string;
  method: 'chatgpt' | 'api_key';
  /** The model's maker: OPENAI for the ChatGPT plan. */
  provider: string;
  model: string;
  label: string;
  /** The ChatGPT account's email. */
  account: string | null;
  /** For a model from the configuration file that runs on a server of its own: that server's address. */
  server: string | null;
};

export type ModelCategoryOption = {
  id: ModelCategory;
  category: ModelCategory;
  displayName: string;
  description: string;
  isDefault: boolean;
  availableCount: number;
};

type CatalogSource = {
  listProviderModels: typeof listProviderModels;
  listChatGptPlanModels: typeof listChatGptPlanModels;
};

const toConnection = (row: ModelRow): ModelConnection => {
  const chatgpt = row.provider === CHATGPT_PROVIDER;
  let server: string | null = null;
  if (!chatgpt && runsOnOwnServer(row.provider, row.apiBaseUrl)) {
    try {
      server = new URL(row.apiBaseUrl as string).host;
    } catch {
      server = row.apiBaseUrl;
    }
  }
  return {
    modelId: row.id,
    method: chatgpt ? 'chatgpt' : 'api_key',
    provider: chatgpt ? 'OPENAI' : row.provider,
    model: row.modelName,
    label: row.displayName ?? row.name,
    account: chatgpt ? readCredentialRecord(row.apiKey)?.email ?? null : null,
    server,
  };
};

/**
 * The one owner of the connection: the person connects ONE model, and it is the models table's only
 * active row and its default. Every write here keeps that true, and only the connection holds a
 * credential: connecting clears the keys of every other row and signs a ChatGPT plan out.
 */
export class ModelService {
  private readonly repo: ModelRepository;
  private readonly credentials: ChatGptCredentials;
  private readonly catalog: CatalogSource;

  constructor(
    deps: { repo?: ModelRepository; credentials?: ChatGptCredentials; catalog?: CatalogSource } = {},
  ) {
    this.repo = deps.repo ?? new ModelRepository();
    this.credentials = deps.credentials ?? new ChatGptCredentials({ repo: this.repo });
    this.catalog = deps.catalog ?? { listProviderModels, listChatGptPlanModels };
  }

  async getConnection(): Promise<ModelConnection | null> {
    const row = await this.repo.getDefault();
    return row?.isActive ? toConnection(row) : null;
  }

  async listActive(): Promise<ModelRow[]> {
    try {
      return (await this.repo.listActive()).map((row) => ({ ...row, apiKey: null }));
    } catch (error) {
      logger.warn({ err: error }, '[ModelService] Failed to list active models; returning empty list');
      return [];
    }
  }

  async getDefaultMetadataOrNull(): Promise<ModelRow | null> {
    try {
      const row = await this.repo.getDefault();
      return row ? { ...row, apiKey: null } : null;
    } catch (error) {
      logger.warn({ err: error }, '[ModelService] Failed to load default model metadata; returning null');
      return null;
    }
  }

  /** Every tier the run composer offers is served by the connected model. */
  async listAvailableCategories(): Promise<ModelCategoryOption[]> {
    const activeModels = await this.listActive();
    const connection = activeModels.find((model) => model.isDefault) ?? activeModels[0];
    const defaultCategory = connection?.selectionCategory ?? DEFAULT_MODEL_CATEGORY;
    return MODEL_CATEGORIES.map((category) => ({
      id: category,
      category,
      displayName: MODEL_CATEGORY_LABELS[category],
      description: MODEL_CATEGORY_DESCRIPTIONS[category],
      isDefault: category === defaultCategory,
      availableCount: activeModels.length,
    }));
  }

  /** Validates a key by listing the provider's chat models with it (free), newest first. Saves nothing. */
  async listModelsForKey(provider: string, apiKey: string): Promise<CatalogModel[]> {
    return this.catalog.listProviderModels(this.normalizeProvider(provider), apiKey.trim());
  }

  /** The models the signed-in ChatGPT plan offers. */
  async listChatGptModels(): Promise<CatalogModel[]> {
    const loaded = await this.credentials.load();
    if (!loaded || !hasPlanTokens(loaded.record)) modelConstraint('Sign in with ChatGPT first', 409);
    return this.catalog.listChatGptPlanModels(await this.credentials.accessToken());
  }

  /**
   * Connects a provider model with an API key. The key is checked again by listing, and the model
   * must be one it can use. Without a key, the connected key of the same provider is kept (a model
   * change only).
   */
  async connectWithKey(input: { provider: string; model: string; apiKey?: string | null }): Promise<ModelConnection> {
    const provider = this.normalizeProvider(input.provider);
    const modelName = input.model.trim();
    const apiKey = input.apiKey?.trim() || (await this.connectedKeyFor(provider));
    if (!apiKey) modelConstraint('Paste the API key for this provider');
    const catalog = await this.catalog.listProviderModels(provider, apiKey as string);
    const entry = catalog.find((model) => model.id === modelName);
    if (!entry) modelConstraint(`"${modelName}" is not among the models this key can use`);
    return this.connectRow({ provider, modelName, label: (entry as CatalogModel).label, apiKey: apiKey as string });
  }

  /** Switches the ChatGPT connection to another model of the plan. */
  async connectChatGpt(input: { model: string }): Promise<ModelConnection> {
    const catalog = await this.listChatGptModels();
    const entry = catalog.find((model) => model.id === input.model.trim());
    if (!entry) modelConstraint(`"${input.model}" is not among the models your ChatGPT plan offers`);
    const loaded = await this.credentials.load();
    const row = await this.repo.transaction(async (repository) => {
      await repository.update(loaded!.row.id, { modelName: entry!.id, name: entry!.label, displayName: entry!.label });
      await this.clearOtherCredentials(repository, loaded!.row.id);
      await repository.makeOnlyConnection(loaded!.row.id);
      return repository.getById(loaded!.row.id);
    });
    return toConnection(row as ModelRow);
  }

  /** The registration a new sign-in reuses: host id, issued client id, account. */
  async chatGptRegistration(): Promise<ChatGptCredentialRecord | null> {
    return (await this.credentials.load())?.record ?? null;
  }

  /**
   * Stores a completed ChatGPT sign-in. With plan permission and at least one plan model it becomes
   * the connection, on the model already chosen if the plan still offers it, else the plan's first.
   * Without them the registration is kept, so the next sign-in reuses it, and nothing is connected.
   */
  async saveChatGptSignIn(record: ChatGptCredentialRecord, catalog: CatalogModel[]): Promise<ModelConnection | null> {
    const existing = await this.repo.getByProvider(CHATGPT_PROVIDER);
    const kept = catalog.find((model) => model.id === existing?.modelName);
    const chosen = kept ?? catalog[0];
    const connect = hasPlanTokens(record) && Boolean(chosen);
    const row = await this.repo.transaction(async (repository) => {
      const fields = {
        apiKey: encryptCredentialRecord(record),
        modelName: chosen?.id ?? existing?.modelName ?? CHATGPT_MODEL_NOT_CHOSEN,
        name: chosen?.label ?? existing?.name ?? 'ChatGPT',
        displayName: chosen?.label ?? existing?.displayName ?? null,
      };
      const saved = existing
        ? await repository.update(existing.id, fields)
        : await repository.create({
            ...fields,
            provider: CHATGPT_PROVIDER,
            isActive: false,
            isDefault: false,
            selectionCategory: DEFAULT_MODEL_CATEGORY,
            requestProfile: validateModelRequestProfile(CHATGPT_PROVIDER, {}),
          });
      if (!saved) return null;
      if (connect) {
        await this.clearOtherCredentials(repository, saved.id);
        await repository.makeOnlyConnection(saved.id);
      } else {
        await repository.update(saved.id, { isActive: false, isDefault: false });
      }
      return repository.getById(saved.id);
    });
    return connect && row ? toConnection(row) : null;
  }

  /**
   * Disconnects: the agent has no model until the person connects one (or the next seed connects a
   * key from .env). A ChatGPT plan is signed out: its refresh token revoked, its tokens forgotten.
   */
  async disconnect(): Promise<{ disconnected: boolean; revocationConfirmed: boolean | null }> {
    const row = await this.repo.getDefault();
    if (!row?.isActive) return { disconnected: false, revocationConfirmed: null };
    let revocationConfirmed: boolean | null = null;
    if (row.provider === CHATGPT_PROVIDER) {
      const record = readCredentialRecord(row.apiKey);
      if (record) revocationConfirmed = (await this.credentials.signOut(row, record)).revoked;
      await this.repo.update(row.id, { isActive: false, isDefault: false });
    } else {
      await this.repo.update(row.id, { apiKey: null, isActive: false, isDefault: false });
    }
    logger.info({ modelId: row.id, provider: row.provider, revocationConfirmed }, '[ModelService] Model disconnected');
    return { disconnected: true, revocationConfirmed };
  }

  /**
   * Keys in .env still work: with no connection yet, the first provider (in MODEL_PROVIDERS order)
   * whose *_API_KEY is set becomes the connection, on that provider's newest chat model. A refused
   * key is skipped; an unreachable provider falls back to the configured model for it, if any.
   */
  async connectFromEnv(
    env: NodeJS.ProcessEnv,
    fallbackModelByProvider: Partial<Record<ModelProvider, string>> = {},
  ): Promise<ModelConnection | null> {
    if (await this.getConnection()) return null;
    for (const provider of MODEL_PROVIDERS) {
      const apiKey = env[MODEL_API_KEY_ENV_BY_PROVIDER[provider]]?.trim();
      if (!apiKey) continue;
      let modelName: string | undefined;
      let label: string | undefined;
      try {
        const [newest] = await this.catalog.listProviderModels(provider, apiKey);
        modelName = newest?.id;
        label = newest?.label;
      } catch (error) {
        const unreachable = isAppError(error) && error.httpStatus >= 500;
        logger.warn(
          { provider, envVar: MODEL_API_KEY_ENV_BY_PROVIDER[provider], unreachable },
          unreachable
            ? '[ModelService] Could not list models for the .env key; using the configured model'
            : '[ModelService] The provider refused the .env key; skipping it',
        );
        if (unreachable) modelName = fallbackModelByProvider[provider];
      }
      if (!modelName) continue;
      const connection = await this.connectRow({ provider, modelName, label: label ?? modelName, apiKey });
      logger.info({ provider, model: modelName }, '[ModelService] Connected the model from the .env key');
      return connection;
    }
    return null;
  }

  /** Makes a configured row (from the models configuration file) the connection, with its key if any. */
  async connectConfigured(rowId: string, apiKey: string | null): Promise<ModelConnection | null> {
    if (await this.getConnection()) return null;
    await this.signOutChatGpt();
    const row = await this.repo.transaction(async (repository) => {
      await repository.update(rowId, { apiKey: encryptModelApiKey(apiKey) });
      await this.clearOtherCredentials(repository, rowId);
      await repository.makeOnlyConnection(rowId);
      return repository.getById(rowId);
    });
    return row ? toConnection(row) : null;
  }

  private async connectRow(input: {
    provider: ModelProvider;
    modelName: string;
    label: string;
    apiKey: string;
  }): Promise<ModelConnection> {
    await this.signOutChatGpt();
    const row = await this.repo.transaction(async (repository) => {
      const existing = await repository.getByProviderAndModelName(input.provider, input.modelName);
      const saved = existing
        ? await repository.update(existing.id, { apiKey: encryptModelApiKey(input.apiKey), displayName: input.label })
        : await repository.create({
            name: input.label,
            displayName: input.label,
            provider: input.provider,
            modelName: input.modelName,
            isActive: false,
            isDefault: false,
            selectionCategory: DEFAULT_MODEL_CATEGORY,
            requestProfile: validateModelRequestProfile(input.provider, {}),
            apiKey: encryptModelApiKey(input.apiKey),
            apiBaseUrl: null,
          });
      await this.clearOtherCredentials(repository, (saved as ModelRow).id);
      await repository.makeOnlyConnection((saved as ModelRow).id);
      return repository.getById((saved as ModelRow).id);
    });
    logger.info({ modelId: row?.id, provider: input.provider }, '[ModelService] Model connected');
    return toConnection(row as ModelRow);
  }

  /**
   * Only the connection keeps a credential: other rows lose their API keys. The ChatGPT row keeps
   * its registration (host id, client id), which a later sign-in reuses; its tokens go in
   * `signOutChatGpt`.
   */
  private async clearOtherCredentials(repository: ModelRepository, keepId: string): Promise<void> {
    for (const row of await repository.list()) {
      if (row.id === keepId || !row.apiKey || row.provider === CHATGPT_PROVIDER) continue;
      await repository.update(row.id, { apiKey: null });
    }
  }

  /** A ChatGPT plan that another connection replaces is signed out: revoked, its tokens forgotten. */
  private async signOutChatGpt(): Promise<void> {
    const loaded = await this.credentials.load();
    if (loaded && hasPlanTokens(loaded.record)) await this.credentials.signOut(loaded.row, loaded.record);
  }

  private async connectedKeyFor(provider: ModelProvider): Promise<string | null> {
    const row = await this.repo.getDefault();
    if (!row?.isActive || row.provider !== provider) return null;
    try {
      return decryptModelApiKey(row.apiKey);
    } catch {
      return null;
    }
  }

  private normalizeProvider(provider: string): ModelProvider {
    const normalized = provider.trim().toUpperCase();
    if (!isModelProvider(normalized)) {
      return modelConstraint(`Choose one of ${MODEL_PROVIDERS.join(', ')}`);
    }
    return normalized;
  }
}
