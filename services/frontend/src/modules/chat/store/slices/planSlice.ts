import type { PlanItem } from '@/types/chat';

export interface PlanState {
  items: PlanItem[];
}

export type PlanAction =
  | { type: 'plan/set'; payload: PlanItem[] }
  | { type: 'plan/clear' }
  | { type: 'plan/stepStarted'; payload: { id: string; startedAt?: number } }
  | { type: 'plan/stepUpdated'; payload: { id: string } & Partial<PlanItem> };

export const initialPlanState: PlanState = {
  items: [],
};

export const planReducer = (
  state: PlanState = initialPlanState,
  action: PlanAction
): PlanState => {
  switch (action.type) {
    case 'plan/set':
      return { ...state, items: action.payload };
    case 'plan/clear':
      return { ...state, items: [] };
    case 'plan/stepStarted': {
      const { id, startedAt } = action.payload;
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'running',
                startedAt: item.startedAt ?? startedAt ?? Date.now(),
              }
            : item
        ),
      };
    }
    case 'plan/stepUpdated': {
      const { id, ...updates } = action.payload;
      if (!id) {
        return state;
      }
      const index = state.items.findIndex((item) => item.id === id);
      if (index === -1) {
        const created: PlanItem = {
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
          items: [...state.items, created],
        };
      }
      const current = state.items[index];
      const next: PlanItem = {
        ...current,
        ...updates,
        title: updates.title ?? current.title,
        status: updates.status ?? current.status,
      };
      return {
        ...state,
        items: [
          ...state.items.slice(0, index),
          next,
          ...state.items.slice(index + 1),
        ],
      };
    }
    default:
      return state;
  }
};

export const planSelectors = {
  all: (state: PlanState) => state.items,
  byId: (state: PlanState, id: string) =>
    state.items.find((item) => item.id === id),
};
