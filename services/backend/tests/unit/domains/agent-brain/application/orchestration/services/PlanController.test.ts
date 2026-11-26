import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlanController } from '@/domains/agent-brain/application/orchestration/services/PlanController';

afterEach(() => {
  vi.useRealTimers();
});

describe('PlanController', () => {
  it('starts steps and emits snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const deps = {
      transition: vi.fn().mockResolvedValue(undefined),
      emitSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlanController(deps);

    await controller.startStep('step-1');

    expect(deps.transition).toHaveBeenCalledWith('step-1', 'running', {
      startedAt: 1735689600000,
    });
    expect(deps.emitSnapshot).toHaveBeenCalledTimes(1);
  });

  it('completes steps and merges metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:05Z'));
    const deps = {
      transition: vi.fn().mockResolvedValue(undefined),
      emitSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlanController(deps);

    await controller.completeStep('step-2', { outputSnippet: 'done' });

    expect(deps.transition).toHaveBeenCalledWith('step-2', 'completed', {
      outputSnippet: 'done',
      completedAt: 1735689605000,
    });
    expect(deps.emitSnapshot).toHaveBeenCalledTimes(1);
  });
});
