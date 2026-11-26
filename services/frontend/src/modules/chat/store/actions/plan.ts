import type { PlanItem } from '@/types/chat';
import type { PlanAction } from '../slices/planSlice';

export const setPlan = (items: PlanItem[]): PlanAction => ({
  type: 'plan/set',
  payload: items,
});

export const clearPlan = (): PlanAction => ({
  type: 'plan/clear',
});

export const planStepStarted = (id: string, startedAt?: number): PlanAction => ({
  type: 'plan/stepStarted',
  payload: { id, startedAt },
});

export const planStepUpdated = (
  update: { id: string } & Partial<PlanItem>
): PlanAction => ({
  type: 'plan/stepUpdated',
  payload: update,
});
