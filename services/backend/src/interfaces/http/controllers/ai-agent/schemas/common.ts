import { z } from 'zod';

export const sessionIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Session id is required'),
});

export const sessionStreamQuerySchema = z.object({
  lastEventId: z.string().trim().optional(),
});

export const actionIdBodySchema = z.object({
  actionId: z.string().trim().min(1, 'actionId is required'),
  reason: z
    .string()
    .trim()
    .max(512)
    .optional(),
});

export const checkpointIdParamSchema = sessionIdParamSchema.extend({
  checkpointId: z.string().trim().min(1, 'checkpointId is required'),
});

export const taskIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Task id is required'),
});

