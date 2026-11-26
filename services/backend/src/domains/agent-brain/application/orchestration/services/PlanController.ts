export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'error';

export interface PlanControllerDeps {
  transition(stepId: string, status: PlanStepStatus, metadata?: Record<string, unknown>): Promise<void>;
  emitSnapshot(): Promise<void>;
}

export class PlanController {
  constructor(private readonly deps: PlanControllerDeps) {}

  async startStep(stepId: string): Promise<void> {
    await this.deps.transition(stepId, 'running', { startedAt: Date.now() });
    await this.deps.emitSnapshot();
  }

  async completeStep(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.deps.transition(stepId, 'completed', {
      ...(metadata ?? {}),
      completedAt: Date.now(),
    });
    await this.deps.emitSnapshot();
  }
}
