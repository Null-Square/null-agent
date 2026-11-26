import type { AIChatMessage } from '@/types/chat';

export interface MessageState {
  items: AIChatMessage[];
}

export type MessageAction =
  | { type: 'messages/add'; payload: AIChatMessage }
  | { type: 'messages/updateStatus'; payload: { id: string; status: 'sending' | 'sent' | 'error' } }
  | { type: 'messages/appendContent'; payload: { id: string; content: string } }
  | {
      type: 'messages/merge';
      payload: { targetId: string; nextId?: string; patch: Partial<AIChatMessage> };
    }
  | { type: 'messages/set'; payload: AIChatMessage[] }
  | { type: 'messages/clear' };

export const initialMessageState: MessageState = {
  items: [],
};

export const messageReducer = (
  state: MessageState = initialMessageState,
  action: MessageAction
): MessageState => {
  switch (action.type) {
    case 'messages/add': {
      return {
        ...state,
        items: [...state.items, action.payload],
      };
    }
    case 'messages/updateStatus': {
      return {
        ...state,
        items: state.items.map((message) =>
          message.id === action.payload.id
            ? { ...message, status: action.payload.status }
            : message
        ),
      };
    }
    case 'messages/appendContent': {
      return {
        ...state,
        items: state.items.map((message) =>
          message.id === action.payload.id
            ? {
                ...message,
                content: `${message.content ?? ''}${action.payload.content}`,
              }
            : message
        ),
      };
    }
    case 'messages/merge': {
      let found = false;
      const nextItems = state.items.map((message) => {
        if (message.id !== action.payload.targetId) {
          return message;
        }
        found = true;
        const merged: AIChatMessage = {
          ...message,
          ...action.payload.patch,
        };
        if (action.payload.nextId) {
          merged.id = action.payload.nextId;
        }
        return merged;
      });

      if (!found) {
        const fallbackId = action.payload.nextId ?? action.payload.targetId;
        const fallback: AIChatMessage = {
          id: fallbackId,
          role: (action.payload.patch.role as AIChatMessage['role']) ?? 'assistant',
          content: action.payload.patch.content ?? '',
          timestamp:
            action.payload.patch.timestamp instanceof Date
              ? action.payload.patch.timestamp
              : new Date(),
          status: action.payload.patch.status ?? 'sent',
        };
        return {
          ...state,
          items: [...nextItems, fallback],
        };
      }

      return {
        ...state,
        items: nextItems,
      };
    }
    case 'messages/set':
      return {
        ...state,
        items: action.payload,
      };
    case 'messages/clear':
      return {
        ...state,
        items: [],
      };
    default:
      return state;
  }
};

export const messageSelectors = {
  all: (state: MessageState) => state.items,
  byId: (state: MessageState, id: string) =>
    state.items.find((message) => message.id === id),
};
