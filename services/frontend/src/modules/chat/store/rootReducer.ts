import {
  messageReducer,
  initialMessageState,
  type MessageAction,
} from './slices/messageSlice';
import {
  planReducer,
  initialPlanState,
  type PlanAction,
} from './slices/planSlice';
import {
  toolReducer,
  initialToolState,
  type ToolAction,
} from './slices/toolSlice';
import {
  activityReducer,
  initialActivityState,
  type ActivityAction,
} from './slices/activitySlice';
import {
  sessionReducer,
  initialSessionState,
  type SessionAction,
} from './slices/sessionSlice';
import {
  configReducer,
  initialConfigState,
  type ConfigAction,
} from './slices/configSlice';
import {
  taskReducer,
  initialTaskState,
  type TaskAction,
} from './slices/taskSlice';
import type { RootAction, RootState } from './types';

export const initialRootState: RootState = {
  messages: initialMessageState,
  plan: initialPlanState,
  tools: initialToolState,
  activity: initialActivityState,
  session: initialSessionState,
  config: initialConfigState,
  task: initialTaskState,
};

export const rootReducer = (
  state: RootState = initialRootState,
  action: RootAction
): RootState => {
  if (action.type === 'feature/reset') {
    return {
      ...state,
      messages: { ...initialMessageState, items: [] },
      plan: { ...initialPlanState, items: [] },
      tools: { ...initialToolState, streams: {} },
      activity: { ...initialActivityState, entries: [] },
      session: { ...initialSessionState },
      task: { ...initialTaskState },
    };
  }

  return {
    messages: messageReducer(state.messages, action as MessageAction),
    plan: planReducer(state.plan, action as PlanAction),
    tools: toolReducer(state.tools, action as ToolAction),
    activity: activityReducer(state.activity, action as ActivityAction),
    session: sessionReducer(state.session, action as SessionAction),
    config: configReducer(state.config, action as ConfigAction),
    task: taskReducer(state.task, action as TaskAction),
  };
};
