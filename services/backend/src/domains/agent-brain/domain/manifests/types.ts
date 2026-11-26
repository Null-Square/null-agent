import { z } from 'zod';

const jsonSchema = z.record(z.unknown());

export const toolManifestSchema = z.object({
  id: z.string().min(1, 'tool id required'),
  summary: z.string().min(1, 'tool summary required'),
  argsSchema: z.union([jsonSchema, z.instanceof(Object)]).optional(),
  meta: z.object({
    category: z.string().min(1, 'tool meta.category required'),
    risk: z.string().optional(),
    isCapability: z.boolean().optional(),
    requires: z.array(z.string().min(1)).optional(),
    returns: z.enum(['markdown', 'text', 'json']).optional(),
    progressKind: z.enum(['canonical', 'evidence']).optional(),
  }),
});

export type ToolManifest = z.infer<typeof toolManifestSchema>;
