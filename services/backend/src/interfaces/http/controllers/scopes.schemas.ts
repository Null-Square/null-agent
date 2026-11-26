import { z } from 'zod';

export const ScopeIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

/**
 * Point a scope at its code: an absolute folder path (read in place, never
 * written) or a public https:// or ssh git URL (cloned shallow). A private
 * repository is cloned by the person and added as a folder.
 */
export const CodeSourceBodySchema = z.object({
  kind: z.enum(['folder', 'git']),
  location: z.string().trim().min(1, 'location is required').max(2_048),
  ref: z.string().trim().min(1).max(200).nullable().optional(),
  reviewBrief: z.string().max(4_000).nullable().optional(),
});

export const CodeSourceSchema = z.object({
  kind: z.enum(['folder', 'git']),
  location: z.string(),
  ref: z.string().nullable(),
  status: z.enum(['ready', 'cloning', 'failed']),
  /** A clone's commit SHA, or a folder's content hash: what a Code Review would pin. */
  headCommit: z.string().nullable(),
  error: z.string().nullable(),
  reviewBrief: z.string().nullable(),
});

export const CodeSourceResponseSchema = z.object({
  codeSource: CodeSourceSchema.nullable(),
});
