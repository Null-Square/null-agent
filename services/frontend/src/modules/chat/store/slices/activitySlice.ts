import type { TimelineEntry } from '@/types/chat';

export interface ActivityState {
  entries: TimelineEntry[];
}

export type ActivityAction =
  | { type: 'activity/push'; payload: TimelineEntry }
  | { type: 'activity/hydrate'; payload: TimelineEntry[] }
  | { type: 'activity/clear' };

const MAX_ACTIVITY = 150;

const upsertEntry = (entries: TimelineEntry[], incoming: TimelineEntry): TimelineEntry[] => {
  const next = [...entries];
  const replaceIndex =
    typeof incoming.replaceKey === 'string' && incoming.replaceKey.length > 0
      ? next.findIndex((entry) => entry.replaceKey === incoming.replaceKey)
      : -1;
  const idIndex = replaceIndex === -1 ? next.findIndex((entry) => entry.id === incoming.id) : -1;

  if (replaceIndex !== -1) {
    next[replaceIndex] = incoming;
  } else if (idIndex !== -1) {
    next[idIndex] = incoming;
  } else {
    next.push(incoming);
  }

  next.sort((left, right) => left.ts - right.ts);
  return next.slice(Math.max(0, next.length - MAX_ACTIVITY));
};

export const initialActivityState: ActivityState = {
  entries: [],
};

export const activityReducer = (
  state: ActivityState = initialActivityState,
  action: ActivityAction
): ActivityState => {
  switch (action.type) {
    case 'activity/push':
      return { ...state, entries: upsertEntry(state.entries, action.payload) };
    case 'activity/hydrate':
      return {
        ...state,
        entries: (action.payload ?? [])
          .slice()
          .sort((left, right) => left.ts - right.ts)
          .slice(Math.max(0, (action.payload ?? []).length - MAX_ACTIVITY)),
      };
    case 'activity/clear':
      return { ...state, entries: [] };
    default:
      return state;
  }
};

export const activitySelectors = {
  all: (state: ActivityState) => state.entries,
  latest: (state: ActivityState) => state.entries[state.entries.length - 1],
};
