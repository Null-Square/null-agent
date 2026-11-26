import type { TaskSummary } from '@/types/chat';
import type { TaskAction } from '../slices/taskSlice';

export const setTask = (task?: TaskSummary): TaskAction => ({
  type: 'task/set',
  payload: task,
});

export const setStarterPrompt = (prompt?: string): TaskAction => ({
  type: 'task/setStarterPrompt',
  payload: prompt,
});

export const clearTask = (): TaskAction => ({
  type: 'task/clear',
});
