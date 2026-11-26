import type { ChatProvider } from './ChatProvider';
import { createProviderByType, isProviderTypeSupported, getSupportedProviderTypes, type ProviderType } from './ProviderRegistry';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import type { ModelConfigPort } from '../../ports';
import { validateModelRequestProfile } from '@/domains/platform/models/modelRequestProfile';
import { isModelUsable, resolveModelBaseUrl } from '@/domains/platform/models/modelProviders';

const log = logger.child({ scope: 'ProviderFactory' });

/**
 * Sent to a server of the person's own that takes no key. Both SDKs refuse to start without a
 * key and would otherwise read OPENAI_API_KEY or ANTHROPIC_API_KEY from the environment, which
 * would hand the person's provider key to that server.
 */
export const KEYLESS_SERVER_API_KEY = 'no-key';

export class ProviderFactory {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly modelConfigPort: ModelConfigPort,
  ) {}

  /**
   * Create a chat provider using DB-backed configuration.
   * 
   * Provider selection is entirely DB-driven via the `provider` column.
   * No hardcoded inference - the DB is the single source of truth.
   * 
   * @param modelName - Model name to use (must exist in DB)
   */
  async create(modelName: string, modelId?: string): Promise<ChatProvider> {
    const trimmedModelName = modelName?.trim();
    if (!trimmedModelName) {
      throw new Error('ProviderFactory requires a valid modelName from the database.');
    }

    const model = modelId
      ? await this.modelConfigPort.getModel(modelId)
      : await this.modelConfigPort.getByModelName(trimmedModelName);

    if (!model) {
      throw new Error(
        modelId
          ? `Model deployment "${modelId}" not found in database`
          : `Model "${trimmedModelName}" not found in database`,
      );
    }
    if (model.modelName !== trimmedModelName) {
      throw new Error(
        `Pinned model deployment "${modelId}" does not match model "${trimmedModelName}"`,
      );
    }

    // Normalize provider to uppercase for matching
    const providerType = model.provider.toUpperCase() as ProviderType;
    
    if (!isProviderTypeSupported(providerType)) {
      throw new Error(
        `Provider "${model.provider}" for model "${model.modelName}" is not supported. ` +
        `Supported providers: ${getSupportedProviderTypes().join(', ')}`
      );
    }

    log.info(
      { 
        requestedModel: trimmedModelName, 
        resolvedModel: model.modelName,
        provider: providerType,
        isDefault: model.isDefault 
      },
      'Creating provider from DB config'
    );

    // Inject model's API credentials into config
    const apiKey = typeof model.apiKey === 'string' && model.apiKey.trim().length > 0
      ? model.apiKey.trim()
      : undefined;
    if (!isModelUsable({ provider: providerType, apiBaseUrl: model.apiBaseUrl, hasKey: Boolean(apiKey) })) {
      throw new Error(`Model "${model.modelName}" is missing apiKey in database`);
    }

    const configWithApiKey: ResolvedConfig = {
      ...this.config,
      runtime: {
        ...this.config.runtime,
        // The ChatGPT plan's credential is its OAuth token set; its provider asks for a fresh token per request.
        apiKey: providerType === 'CHATGPT' ? KEYLESS_SERVER_API_KEY : apiKey ?? KEYLESS_SERVER_API_KEY,
        // Always explicit: left undefined, the SDKs would fall back to OPENAI_BASE_URL and friends.
        apiBaseUrl: resolveModelBaseUrl(providerType, model.apiBaseUrl),
      },
    };

    const requestProfile = validateModelRequestProfile(providerType, model.requestProfile ?? {});
    return createProviderByType(providerType, configWithApiKey, requestProfile);
  }
}
