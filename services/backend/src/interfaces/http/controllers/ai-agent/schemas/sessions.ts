import { z } from 'zod';
import { MODEL_CATEGORIES } from '@null-ai/contracts';

export const createSessionBodySchema = z
  .object({
    modelId: z
      .string()
      .uuid()
      .optional(),
    modelCategory: z
      .enum(MODEL_CATEGORIES)
      .optional(),
    profileKey: z
      .string()
      .trim()
      .max(256)
      .optional(),
    extraContext: z
      .string()
      .trim()
      .max(10_000)
      .optional(),
    scopeId: z
      .string()
      .uuid()
      .optional(),
    vars: z.record(z.unknown()).optional(),
    mode: z.enum(['interactive', 'automated']).optional(),
  })
  .strict();

export const sessionMessageBodySchema = z
  .object({
    text: z.string().trim().min(1, 'text is required'),
    isRetry: z.boolean().optional(),
    profileKey: z
      .string()
      .trim()
      .max(256)
      .optional(),
    extraContext: z
      .string()
      .trim()
      .max(10_000)
      .optional(),
  })
  .strict();

export const sessionStopBodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(500)
      .optional(),
  })
  .strict()
  .optional();


