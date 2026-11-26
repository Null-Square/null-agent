export const PROVIDER_REASONING_METADATA_KEY = 'provider_reasoning';
export const PROVIDER_REASONING_SYMBOL = Symbol.for('null-ai.provider_reasoning');

export type ProviderReasoningFormat = 'reasoning_content';

export type ProviderReasoningMetadata = {
  provider: string;
  model?: string;
  format: ProviderReasoningFormat;
  content: string;
  capturedAt: string;
};

export type ProviderReasoningCarrier = {
  [PROVIDER_REASONING_SYMBOL]?: ProviderReasoningMetadata;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const buildProviderReasoningMetadata = (params: {
  provider: string;
  model?: string;
  format?: ProviderReasoningFormat;
  content: string;
}): ProviderReasoningMetadata | undefined => {
  const content = params.content;
  if (typeof content !== 'string' || content.length === 0) {
    return undefined;
  }

  return {
    provider: params.provider,
    model: params.model,
    format: params.format ?? 'reasoning_content',
    content,
    capturedAt: new Date().toISOString(),
  };
};

export const isProviderReasoningMetadata = (value: unknown): value is ProviderReasoningMetadata => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === 'string' &&
    (value.model === undefined || typeof value.model === 'string') &&
    value.format === 'reasoning_content' &&
    typeof value.content === 'string' &&
    typeof value.capturedAt === 'string'
  );
};

export const getProviderReasoningFromMetadata = (
  metadata?: Record<string, unknown> | null,
): ProviderReasoningMetadata | undefined => {
  if (!metadata) {
    return undefined;
  }
  const value = metadata[PROVIDER_REASONING_METADATA_KEY];
  return isProviderReasoningMetadata(value) ? value : undefined;
};

export const metadataWithProviderReasoning = (
  metadata: Record<string, unknown> | undefined,
  reasoning?: ProviderReasoningMetadata,
): Record<string, unknown> | undefined => {
  if (!reasoning) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    [PROVIDER_REASONING_METADATA_KEY]: reasoning,
  };
};

export const redactProviderReasoningMetadata = <T extends Record<string, unknown> | null | undefined>(
  metadata: T,
): T | Record<string, unknown> | undefined => {
  if (!metadata || !isRecord(metadata)) {
    return metadata;
  }
  if (!(PROVIDER_REASONING_METADATA_KEY in metadata)) {
    return metadata;
  }
  const { [PROVIDER_REASONING_METADATA_KEY]: _providerReasoning, ...publicMetadata } = metadata;
  return Object.keys(publicMetadata).length > 0 ? publicMetadata : undefined;
};

export const attachProviderReasoning = <T extends object>(
  message: T,
  reasoning?: ProviderReasoningMetadata,
): T => {
  if (!reasoning) {
    return message;
  }
  Object.defineProperty(message, PROVIDER_REASONING_SYMBOL, {
    value: reasoning,
    enumerable: false,
    configurable: true,
  });
  return message;
};

export const getProviderReasoning = (message: unknown): ProviderReasoningMetadata | undefined => {
  if (!isRecord(message)) {
    return undefined;
  }
  return (message as ProviderReasoningCarrier)[PROVIDER_REASONING_SYMBOL];
};
