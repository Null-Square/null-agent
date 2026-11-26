import { ErrorFactory } from '@/shared/errors';

export type ModelRequestProfile = Record<string, unknown>;

const configurationError = (message: string): never => {
  throw ErrorFactory.validation.constraintViolated(message, { userMessage: message });
};

const allowedKeys: Record<string, ReadonlySet<string>> = {
  QWEN: new Set(['thinkingMode']),
  DEEPSEEK: new Set(['thinking', 'reasoningEffort']),
  OPENAI: new Set(['reasoningEffort']),
  CHATGPT: new Set(['reasoningEffort']),
  ANTHROPIC: new Set(),
  MOONSHOT: new Set(['thinking', 'keep']),
};

export const validateModelRequestProfile = (
  provider: string,
  value: unknown,
): ModelRequestProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError('Model requestProfile must be an object');
  }
  const profile = value as ModelRequestProfile;
  const normalizedProvider = provider.trim().toUpperCase();
  const allowed = allowedKeys[normalizedProvider];
  if (!allowed) configurationError(`Unsupported model provider "${provider}"`);
  const unknown = Object.keys(profile).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    configurationError(`Unsupported ${normalizedProvider} requestProfile field(s): ${unknown.join(', ')}`);
  }

  if (normalizedProvider === 'QWEN') {
    const mode = profile.thinkingMode;
    if (mode !== undefined && !['planning_only', 'always', 'disabled'].includes(String(mode))) {
      configurationError('QWEN thinkingMode must be planning_only, always, or disabled');
    }
  }
  if (normalizedProvider === 'DEEPSEEK') {
    if (profile.thinking !== undefined && !['enabled', 'disabled'].includes(String(profile.thinking))) {
      configurationError('DEEPSEEK thinking must be enabled or disabled');
    }
    if (profile.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(String(profile.reasoningEffort))) {
      configurationError('DEEPSEEK reasoningEffort must be low, medium, or high');
    }
  }
  if (normalizedProvider === 'OPENAI' || normalizedProvider === 'CHATGPT') {
    if (profile.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(String(profile.reasoningEffort))) {
      configurationError(`${normalizedProvider} reasoningEffort must be low, medium, or high`);
    }
  }
  if (normalizedProvider === 'MOONSHOT') {
    if (profile.thinking !== undefined && !['enabled', 'disabled'].includes(String(profile.thinking))) {
      configurationError('MOONSHOT thinking must be enabled or disabled');
    }
    if (profile.keep !== undefined && profile.keep !== 'all') {
      configurationError('MOONSHOT keep must be all');
    }
    if (profile.keep !== undefined && profile.thinking !== 'enabled') {
      configurationError('MOONSHOT keep requires thinking=enabled');
    }
  }
  return { ...profile };
};
