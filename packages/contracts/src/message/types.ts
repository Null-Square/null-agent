/**
 * Message-related Zod schemas and inferred types.
 * Single source of truth for chat message data structures.
 */

import { z } from 'zod';

// ============================================================================
// Message Role
// ============================================================================

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

// ============================================================================
// Message Status
// ============================================================================

export const messageStatusSchema = z.enum(['sending', 'sent', 'error']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

// ============================================================================
// Chat Message
// ============================================================================

export const chatMessageSchema = z
  .object({
    id: z.string(),
    role: messageRoleSchema,
    content: z.string().optional(),
    timestamp: z.union([z.date(), z.number(), z.string()]).optional(),
    createdAt: z.union([z.date(), z.number(), z.string()]).optional(),
    metadata: z.record(z.any()).optional(),
    toolName: z.string().nullable().optional(),
    toolCallId: z.string().nullable().optional(),
    status: messageStatusSchema.optional(),
  })
  .passthrough();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate an array of chat messages.
 */
export const validateMessages = <T = ChatMessage>(data: unknown): T[] => {
  const parsed = z.array(chatMessageSchema).safeParse(data);
  if (parsed.success) {
    return parsed.data.map((msg) => ({
      ...msg,
      role: msg.role === 'system' ? 'assistant' : msg.role,
      timestamp: msg.timestamp instanceof Date 
        ? msg.timestamp 
        : new Date((msg.timestamp ?? msg.createdAt ?? Date.now()) as number | string),
      createdAt: msg.createdAt ?? msg.timestamp ?? Date.now(),
    })) as T[];
  }

  if (Array.isArray(data)) {
    const valid: T[] = [];
    data.forEach((raw) => {
      const single = chatMessageSchema.safeParse(raw);
      if (single.success) {
        const msg = single.data;
        valid.push({
          ...msg,
          role: msg.role === 'system' ? 'assistant' : msg.role,
          timestamp: msg.timestamp instanceof Date 
            ? msg.timestamp 
            : new Date((msg.timestamp ?? msg.createdAt ?? Date.now()) as number | string),
          createdAt: msg.createdAt ?? msg.timestamp ?? Date.now(),
        } as T);
      } else {
        console.warn('[validateMessages] Invalid message:', single.error.message);
      }
    });
    return valid;
  }

  console.warn('[validateMessages] Invalid data:', data);
  return [];
};
