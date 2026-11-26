import type { AIChatMessage } from '@/types/chat';

export type RawChatMessage = {
  id?: string;
  role?: string;
  content?: string;
  createdAt?: number | string;
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
  toolName?: string | null;
  toolCallId?: string | null;
  tool_calls?: unknown;
};

const toTimestamp = (message: RawChatMessage): Date => {
  const candidate = message.createdAt ?? message.timestamp ?? Date.now();
  const raw =
    typeof candidate === 'string' ? Date.parse(candidate) : candidate;
  const resolved =
    typeof raw === 'number' && !Number.isNaN(raw) ? raw : Date.now();
  return new Date(resolved);
};

export const isToolMessage = (message: RawChatMessage): boolean => {
  if (message.role === 'tool') return true;
  if (message.toolName) return true;
  if (message.toolCallId) return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  return false;
};

export const toHydratedMessages = (rawMessages: RawChatMessage[]): AIChatMessage[] => {
  return rawMessages
    .filter((message) => message.metadata?.visibility !== 'internal')
    .filter((message) => !isToolMessage(message))
    .map((message) => {
      const role = ['user', 'assistant', 'system'].includes(message.role ?? '')
        ? (message.role as AIChatMessage['role'])
        : 'assistant';
      return {
        id: message.id ?? '',
        role,
        content: message.content ?? '',
        metadata: message.metadata,
        status: 'sent' as const,
        timestamp: toTimestamp(message),
      };
    })
    .filter((message) => message.id);
};
