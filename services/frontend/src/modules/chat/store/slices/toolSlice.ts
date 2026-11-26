import type { ToolStreamState } from '@/types/chat';

export interface ToolState {
  streams: Record<string, ToolStreamState>;
}

export type ToolAction =
  | { type: 'tools/reset'; payload: { tool: string; command?: string } }
  | { type: 'tools/append'; payload: { tool: string; chunk: string } }
  | { type: 'tools/hydrate'; payload: Record<string, ToolStreamState> }
  | {
      type: 'tools/complete';
      payload: {
        tool: string;
        status: ToolStreamState['status'];
        result?: ToolStreamState['result'];
      };
    }
  | { type: 'tools/clear' };

export const initialToolState: ToolState = {
  streams: {},
};

const ensureState = (
  existing: ToolStreamState | undefined,
  tool: string
): ToolStreamState => ({
  name: existing?.name ?? tool,
  chunks: existing?.chunks ?? [],
  status: existing?.status ?? 'idle',
  command: existing?.command,
  result: existing?.result,
  lastUpdated: existing?.lastUpdated ?? Date.now(),
});

export const toolReducer = (
  state: ToolState = initialToolState,
  action: ToolAction
): ToolState => {
  switch (action.type) {
    case 'tools/reset': {
      const next: ToolStreamState = {
        name: action.payload.tool,
        chunks: [],
        status: 'running',
        command: action.payload.command,
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        streams: {
          ...state.streams,
          [action.payload.tool]: next,
        },
      };
    }
    case 'tools/append': {
      const previous = ensureState(state.streams[action.payload.tool], action.payload.tool);
      const next: ToolStreamState = {
        ...previous,
        status: previous.status === 'idle' ? 'running' : previous.status,
        chunks: [...previous.chunks, action.payload.chunk],
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        streams: {
          ...state.streams,
          [action.payload.tool]: next,
        },
      };
    }
    case 'tools/hydrate':
      return {
        ...state,
        streams: action.payload,
      };
    case 'tools/complete': {
      const previous = ensureState(state.streams[action.payload.tool], action.payload.tool);
      const next: ToolStreamState = {
        ...previous,
        status: action.payload.status,
        result: action.payload.result ?? previous.result,
        lastUpdated: Date.now(),
      };
      return {
        ...state,
        streams: {
          ...state.streams,
          [action.payload.tool]: next,
        },
      };
    }
    case 'tools/clear':
      return { ...state, streams: {} };
    default:
      return state;
  }
};

export const toolSelectors = {
  all: (state: ToolState) => state.streams,
  byName: (state: ToolState, tool: string) => state.streams[tool],
};
