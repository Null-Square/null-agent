import type {
  AIChatConfig,
  AIChatMessage,
  AIChatMessageInput,
  PlanItem,
  ToolStreamState,
  ActivityEntry,
  TaskSummary,
} from '@/types/chat';
import { generateMessageId } from '@modules/chat/store/utils';

const ensureDate = (value?: Date | string | number): Date =>
  value instanceof Date ? value : new Date(value ?? Date.now());

type MessageInput = AIChatMessageInput;

export type AIChatState = {
  messages: AIChatMessage[];
  plan: PlanItem[];
  toolStreams: Record<string, ToolStreamState>;
  activity: ActivityEntry[];
  isLoading: boolean;
  isAborting: boolean;
  sessionStatus:
    | 'idle'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'error';
  config: AIChatConfig;
  task?: TaskSummary;
  starterPrompt?: string;
};

export type AIChatAction =
  | { type: 'ADD_MESSAGE'; payload: MessageInput }
  | { type: 'UPDATE_MESSAGE_STATUS'; id: string; status: 'sending' | 'sent' | 'error' }
  | { type: 'APPEND_MESSAGE_CONTENT'; id: string; content: string }
  | { type: 'MERGE_MESSAGE'; targetId: string; nextId?: string; patch: Partial<AIChatMessage> }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_CONFIG'; payload: AIChatConfig }
  | { type: 'SET_MESSAGES'; payload: AIChatMessage[] }
  | { type: 'SET_PLAN'; payload: PlanItem[] }
  | { type: 'RESET_TOOL_STREAM'; tool: string; command?: string }
  | { type: 'APPEND_TOOL_STREAM'; tool: string; chunk: string }
  | {
    type: 'COMPLETE_TOOL_STREAM';
    tool: string;
    status: ToolStreamState['status'];
    result?: ToolStreamState['result'];
  }
  | { type: 'PUSH_ACTIVITY'; payload: ActivityEntry }
  | { type: 'SET_SESSION_STATUS'; payload: AIChatState['sessionStatus'] }
  | { type: 'SET_ABORTING'; payload: boolean }
  | { type: 'PLAN_STEP_STARTED'; payload: { stepId: string } }
  | { type: 'PLAN_STEP_UPDATED'; payload: { id: string } & Partial<PlanItem> }
  | { type: 'SET_TASK'; payload?: TaskSummary }
  | { type: 'SET_STARTER_PROMPT'; payload?: string };

export const initialState: AIChatState = {
  messages: [],
  plan: [],
  toolStreams: {},
  activity: [],
  isLoading: false,
  isAborting: false,
  sessionStatus: 'idle',
  config: {
    title: 'NULL AI.',
    subtitle: 'Your AI Security Assistant. Analyze, detect, and protect your digital assets',
    placeholder: 'Analyze my',
    conversationPlaceholder:
      'Ask NULL AI anything about your security or infrastructure concerns...',
  },
  task: undefined,
  starterPrompt: undefined,
};

export const aiChatReducer = (state: AIChatState, action: AIChatAction): AIChatState => {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const timestamp = ensureDate(action.payload.timestamp);
      const message: AIChatMessage = {
        ...action.payload,
        id: action.payload.id ?? generateMessageId(),
        timestamp,
      };
      return {
        ...state,
        messages: [...state.messages, message],
      };
    }
    case 'UPDATE_MESSAGE_STATUS':
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg.id === action.id ? { ...msg, status: action.status } : msg
        ),
      };
    case 'APPEND_MESSAGE_CONTENT':
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg.id === action.id
            ? {
              ...msg,
              content: `${msg.content || ''}${action.content}`,
            }
            : msg
        ),
      };
    case 'MERGE_MESSAGE': {
      let found = false;
      const messages = state.messages.map((msg) => {
        if (msg.id !== action.targetId) {
          return msg;
        }
        found = true;
        const merged: AIChatMessage = {
          ...msg,
          ...action.patch,
        };
        if (action.nextId) {
          merged.id = action.nextId;
        }
        if (action.patch.timestamp) {
          merged.timestamp = ensureDate(action.patch.timestamp);
        }
        return merged;
      });
      if (!found) {
        const fallbackId = action.nextId ?? action.targetId;
        const fallback: AIChatMessage = {
          id: fallbackId,
          content: action.patch.content ?? '',
          role: (action.patch.role as AIChatMessage['role']) ?? 'assistant',
          timestamp: ensureDate(action.patch.timestamp),
          status: action.patch.status ?? 'sent',
        };
        return {
          ...state,
          messages: [...state.messages, fallback],
        };
      }
      return {
        ...state,
        messages,
      };
    }
    case 'SET_LOADING':
      return {
        ...state,
        isLoading: action.payload,
      };
    case 'CLEAR_MESSAGES':
      return {
        ...state,
        messages: [],
        plan: [],
        toolStreams: {},
        activity: [],
        sessionStatus: 'idle',
        task: undefined,
        starterPrompt: undefined,
      };
    case 'SET_CONFIG':
      return {
        ...state,
        config: { ...state.config, ...action.payload },
      };
    case 'SET_MESSAGES':
      return {
        ...state,
        messages: action.payload.map((msg) => ({
          ...msg,
          timestamp: ensureDate(msg.timestamp),
        })),
      };
    case 'SET_PLAN':
      return {
        ...state,
        plan: action.payload,
      };
    case 'RESET_TOOL_STREAM': {
      const next: ToolStreamState = {
        name: action.tool,
        chunks: [],
        status: 'running',
        command: action.command,
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        toolStreams: {
          ...state.toolStreams,
          [action.tool]: next,
        },
      };
    }
    case 'APPEND_TOOL_STREAM': {
      const previous = state.toolStreams[action.tool] ?? {
        name: action.tool,
        chunks: [],
        status: 'idle' as ToolStreamState['status'],
        lastUpdated: Date.now(),
      };
      const next: ToolStreamState = {
        ...previous,
        status: previous.status === 'idle' ? 'running' : previous.status,
        chunks: [...previous.chunks, action.chunk],
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        toolStreams: {
          ...state.toolStreams,
          [action.tool]: next,
        },
      };
    }
    case 'COMPLETE_TOOL_STREAM': {
      const previous = state.toolStreams[action.tool] ?? {
        name: action.tool,
        chunks: [],
        status: 'idle' as ToolStreamState['status'],
        lastUpdated: Date.now(),
      };
      const next: ToolStreamState = {
        ...previous,
        status: action.status,
        result: action.result ?? previous.result,
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        toolStreams: {
          ...state.toolStreams,
          [action.tool]: next,
        },
      };
    }
    case 'PUSH_ACTIVITY': {
      const next = [...state.activity, action.payload];
      const trimmed = next.slice(Math.max(0, next.length - 25));
      return {
        ...state,
        activity: trimmed,
      };
    }
    case 'SET_SESSION_STATUS':
      return {
        ...state,
        sessionStatus: action.payload,
      };
    case 'SET_ABORTING':
      return {
        ...state,
        isAborting: action.payload,
      };
    case 'PLAN_STEP_STARTED':
      return {
        ...state,
        plan: state.plan.map((item) =>
          item.id === action.payload.stepId
            ? {
              ...item,
              status: 'running',
              startedAt: item.startedAt ?? Date.now(),
            }
            : item
        ),
      };
    case 'PLAN_STEP_UPDATED': {
      const { id, ...updates } = action.payload;
      if (!id) {
        return state;
      }
      const index = state.plan.findIndex((item) => item.id === id);
      if (index === -1) {
        const newItem: PlanItem = {
          id,
          title: updates.title ?? id,
          status: updates.status ?? 'pending',
          notes: updates.notes,
          blockedReason: updates.blockedReason,
          startedAt: updates.startedAt,
          completedAt: updates.completedAt,
          lastTool: updates.lastTool,
          outputSnippet: updates.outputSnippet,
          artifactLinks: updates.artifactLinks,
          checkpointId: updates.checkpointId,
        };
        return {
          ...state,
          plan: [...state.plan, newItem],
        };
      }

      const current = state.plan[index];
      const next: PlanItem = {
        ...current,
        ...updates,
        title: updates.title ?? current.title,
        status: updates.status ?? current.status,
      };

      return {
        ...state,
        plan: [
          ...state.plan.slice(0, index),
          next,
          ...state.plan.slice(index + 1),
        ],
      };
    }
    case 'SET_TASK':
      return {
        ...state,
        task: action.payload,
      };
    case 'SET_STARTER_PROMPT':
      return {
        ...state,
        starterPrompt: action.payload,
      };
    default:
      return state;
  }
};
