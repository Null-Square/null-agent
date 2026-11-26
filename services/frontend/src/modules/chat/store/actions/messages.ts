import type { AIChatMessage } from '@/types/chat';
import type { MessageAction } from '../slices/messageSlice';

export const addMessage = (message: AIChatMessage): MessageAction => ({
  type: 'messages/add',
  payload: {
    id: message.id ?? crypto.randomUUID(),
    role: message.role,
    content: message.content ?? '',
    status: message.status,
    timestamp:
      message.timestamp instanceof Date
        ? message.timestamp
        : message.timestamp
        ? new Date(message.timestamp)
        : new Date(),
  },
});

export const updateMessageStatus = (
  id: string,
  status: 'sending' | 'sent' | 'error'
): MessageAction => ({
  type: 'messages/updateStatus',
  payload: { id, status },
});

export const appendMessageContent = (id: string, content: string): MessageAction => ({
  type: 'messages/appendContent',
  payload: { id, content },
});

export const mergeMessage = (
  targetId: string,
  patch: Partial<AIChatMessage>,
  nextId?: string
): MessageAction => ({
  type: 'messages/merge',
  payload: { targetId, patch, nextId },
});

export const setMessages = (messages: AIChatMessage[]): MessageAction => ({
  type: 'messages/set',
  payload: messages,
});

export const clearMessages = (): MessageAction => ({
  type: 'messages/clear',
});
