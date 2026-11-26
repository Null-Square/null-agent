export const NotificationKinds = {
  TASK_COMPLETED: 'task_completed',
  ACTION_REQUIRED: 'action_required',
  CREDITS_LOW: 'credits_low',
  SESSION_ERROR: 'session_error',
} as const;

export type NotificationKind = typeof NotificationKinds[keyof typeof NotificationKinds];

export interface NotificationPort {
  notify(input: {
    userId: string;
    type: NotificationKind;
    title: string;
    message: string;
    link?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}
