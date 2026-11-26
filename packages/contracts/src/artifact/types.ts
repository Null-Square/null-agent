/**
 * Artifact-related Zod schemas and inferred types.
 * Single source of truth for session artifact data structures.
 */

import { z } from 'zod';

// ============================================================================
// Storage Type
// ============================================================================

export const storageTypeSchema = z.enum(['local', 's3']);
export type StorageType = z.infer<typeof storageTypeSchema>;

// ============================================================================
// Session Artifact
// ============================================================================

export const sessionArtifactSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  originalName: z.string(),
  fileType: z.string().optional(),
  sizeBytes: z.number(),
  createdAt: z.number(),
  downloadUrl: z.string().optional(),
  storage: storageTypeSchema.optional(),
  bucket: z.string().optional(),
});

export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate an array of session artifacts.
 */
export const validateArtifacts = (data: unknown): SessionArtifact[] => {
  const parsed = z.array(sessionArtifactSchema).safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }
  console.warn('[validateArtifacts] Invalid:', parsed.error.message);
  if (Array.isArray(data)) return data as SessionArtifact[];
  return [];
};
