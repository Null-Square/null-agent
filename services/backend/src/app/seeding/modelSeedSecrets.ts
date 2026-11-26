import { MODEL_API_KEY_ENV_BY_PROVIDER } from '@/domains/platform/models/modelProviders';

export type ModelApiKeySeed = {
    provider: string;
    apiKeyEnv?: string;
    apiKey?: string;
};

export { MODEL_API_KEY_ENV_BY_PROVIDER };

const readOptionalEnv = (
    env: NodeJS.ProcessEnv,
    name?: string,
): string | undefined => {
    const value = name ? env[name] : undefined;
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};

export const resolveModelApiKey = (
    model: ModelApiKeySeed,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
    const envName = model.apiKeyEnv
        ?? (MODEL_API_KEY_ENV_BY_PROVIDER as Record<string, string>)[model.provider.toUpperCase()];
    return readOptionalEnv(env, envName) ?? model.apiKey;
};
