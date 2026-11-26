import { z } from 'zod';

/** The API-key providers. ModelService owns the list; this mirrors it for request shapes and the docs. */
export const MODEL_KEY_PROVIDER_IDS = ['ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'QWEN', 'MOONSHOT'] as const;

const providerSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.enum(MODEL_KEY_PROVIDER_IDS, {
    errorMap: () => ({ message: `provider must be one of ${MODEL_KEY_PROVIDER_IDS.join(', ')}` }),
  }),
);

const apiKeySchema = z
  .string()
  .trim()
  .min(1, 'apiKey must not be empty')
  .max(4096, 'apiKey is too long')
  .refine((value) => !value.startsWith('enc:v1:'), 'Paste the key itself, not a stored (encrypted) value');

const modelIdSchema = z.string().trim().min(1, 'model is required').max(200, 'model is too long');

export const ModelKeyBodySchema = z.object({ provider: providerSchema, apiKey: apiKeySchema }).strict();

export const ModelConnectBodySchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('api_key'),
      provider: providerSchema,
      model: modelIdSchema,
      /** Omit to keep the connected key of the same provider (a model change only). */
      apiKey: apiKeySchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal('chatgpt'),
      /** Always OPENAI when sent; the plan's models are OpenAI's. */
      provider: z.literal('OPENAI').optional(),
      model: modelIdSchema,
    })
    .strict(),
]);

export const ChatGptStartBodySchema = z
  .object({
    /** A path in the app to come back to after the sign-in, such as /settings/models. */
    returnTo: z
      .string()
      .max(500)
      .refine((value) => value.startsWith('/') && !value.startsWith('//'), 'returnTo must be a path in the app')
      .optional(),
  })
  .strict();

export const CatalogModelSchema = z.object({ id: z.string(), label: z.string() });

export const ModelConnectionSchema = z.object({
  method: z.enum(['chatgpt', 'api_key']),
  provider: z.string(),
  model: z.string(),
  label: z.string(),
  account: z.string().nullable(),
  server: z.string().nullable(),
});

export const ModelStateResponseSchema = z.object({
  connection: ModelConnectionSchema.nullable(),
  providers: z.array(z.object({ id: z.string(), label: z.string(), keyUrl: z.string() })),
});

export const ModelCatalogResponseSchema = z.object({ models: z.array(CatalogModelSchema) });
export const ModelConnectResponseSchema = z.object({ connection: ModelConnectionSchema });
export const ChatGptStartResponseSchema = z.object({ url: z.string() });
export const ModelTestResponseSchema = z.object({ ok: z.boolean(), latencyMs: z.number(), message: z.string() });
export const ModelDisconnectResponseSchema = z.object({
  disconnected: z.boolean(),
  /** ChatGPT only: whether OpenAI confirmed the revocation; null for an API key. */
  revocationConfirmed: z.boolean().nullable(),
});
