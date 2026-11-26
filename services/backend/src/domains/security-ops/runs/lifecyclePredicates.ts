import type { WorkerTaskRecord } from '@/domains/agent-brain/domain/types';

export const RUN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const RUN_REPLAN_BLOCKED_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'credits_exhausted',
]);

export const LIVE_WORKER_TASK_STATUSES = new Set([
  'pending',
  'running',
  'blocked',
  'awaiting_input',
  'awaiting_approval',
]);

export const isRunTerminalStatus = (status: string | null | undefined): boolean =>
  typeof status === 'string' && RUN_TERMINAL_STATUSES.has(status);

export const isRunReplanBlockedStatus = (status: string | null | undefined): boolean =>
  typeof status === 'string' && RUN_REPLAN_BLOCKED_STATUSES.has(status);

export const isLiveWorkerTaskStatus = (status: string | null | undefined): boolean =>
  typeof status === 'string' && LIVE_WORKER_TASK_STATUSES.has(status);

export const isLiveWorkerTask = (task: Pick<WorkerTaskRecord, 'status'>): boolean =>
  isLiveWorkerTaskStatus(task.status);

export const listLiveWorkerTasks = <T extends Pick<WorkerTaskRecord, 'status'>>(
  tasks: readonly T[] | null | undefined,
): T[] => (Array.isArray(tasks) ? tasks.filter(isLiveWorkerTask) : []);

export const childrenSettled = (
  tasks: readonly Pick<WorkerTaskRecord, 'status'>[] | null | undefined,
): boolean => listLiveWorkerTasks(tasks).length === 0;
