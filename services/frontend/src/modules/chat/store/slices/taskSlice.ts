import type { TaskSummary } from '@/types/chat';

export interface TaskState {
  current?: TaskSummary;
  starterPrompt?: string;
}

export type TaskAction =
  | { type: 'task/set'; payload?: TaskSummary }
  | { type: 'task/setStarterPrompt'; payload?: string }
  | { type: 'task/clear' };

export const initialTaskState: TaskState = {
  current: undefined,
  starterPrompt: undefined,
};

export const taskReducer = (
  state: TaskState = initialTaskState,
  action: TaskAction
): TaskState => {
  switch (action.type) {
    case 'task/set':
      return { ...state, current: action.payload };
    case 'task/setStarterPrompt':
      return { ...state, starterPrompt: action.payload };
    case 'task/clear':
      return initialTaskState;
    default:
      return state;
  }
};

export const taskSelectors = {
  current: (state: TaskState) => state.current,
  starterPrompt: (state: TaskState) => state.starterPrompt,
};
