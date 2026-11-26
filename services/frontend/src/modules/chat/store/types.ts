import type { MessageAction, MessageState } from './slices/messageSlice';
import type { PlanAction, PlanState } from './slices/planSlice';
import type { ToolAction, ToolState } from './slices/toolSlice';
import type { ActivityAction, ActivityState } from './slices/activitySlice';
import type { SessionAction, SessionState } from './slices/sessionSlice';
import type { ConfigAction, ConfigState } from './slices/configSlice';
import type { TaskAction, TaskState } from './slices/taskSlice';

export type FeatureResetAction = { type: 'feature/reset' };

export interface RootState {
  messages: MessageState;
  plan: PlanState;
  tools: ToolState;
  activity: ActivityState;
  session: SessionState;
  config: ConfigState;
  task: TaskState;
}

export type RootAction =
  | MessageAction
  | PlanAction
  | ToolAction
  | ActivityAction
  | SessionAction
  | ConfigAction
  | TaskAction
  | FeatureResetAction;
