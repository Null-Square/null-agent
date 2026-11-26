import { describe, expect, it } from 'vitest';
import {
  childrenSettled,
  isRunReplanBlockedStatus,
  isRunTerminalStatus,
  listLiveWorkerTasks,
} from '@/domains/security-ops/runs/lifecyclePredicates';

describe('security ops lifecycle predicates', () => {
  it('identifies terminal and replan-blocking run statuses from one source', () => {
    expect(isRunTerminalStatus('completed')).toBe(true);
    expect(isRunTerminalStatus('cancelled')).toBe(true);
    expect(isRunTerminalStatus('running')).toBe(false);
    expect(isRunReplanBlockedStatus('credits_exhausted')).toBe(true);
    expect(isRunReplanBlockedStatus('awaiting_approval')).toBe(false);
  });

  it('treats pending/running/blocked worker tasks as live children', () => {
    const tasks = [
      { taskId: 't1', status: 'completed' },
      { taskId: 't2', status: 'running' },
      { taskId: 't3', status: 'awaiting_approval' },
      { taskId: 't4', status: 'cancelled' },
    ] as any[];

    expect(listLiveWorkerTasks(tasks).map((task) => task.taskId)).toEqual(['t2', 't3']);
    expect(childrenSettled(tasks)).toBe(false);
    expect(childrenSettled(tasks.filter((task) => task.status !== 'running' && task.status !== 'awaiting_approval'))).toBe(true);
  });
});
