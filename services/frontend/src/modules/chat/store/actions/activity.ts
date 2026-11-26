import type { ActivityEntry } from '@/types/chat';
import type { ActivityAction } from '../slices/activitySlice';

export const pushActivity = (entry: ActivityEntry): ActivityAction => ({
  type: 'activity/push',
  payload: entry,
});

export const hydrateActivity = (entries: ActivityEntry[]): ActivityAction => ({
  type: 'activity/hydrate',
  payload: entries,
});

export const clearActivity = (): ActivityAction => ({
  type: 'activity/clear',
});
