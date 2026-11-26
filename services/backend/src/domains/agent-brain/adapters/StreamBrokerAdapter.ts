import type { StreamPort } from '../ports';
import type { StreamEvent, PlanItem } from '../domain/types';
import type { SessionEventPublisher } from '../ports';

type StreamBrokerLike = {
  emit?: (sessionId: string, event: StreamEvent) => void;
  subscribe?: (sessionId: string, callback: (event: StreamEvent) => void) => () => void;
  emitPlan?: (sessionId: string, plan: PlanItem[]) => void;
  cleanup?: (sessionId: string) => void;
  cleanupSession?: (sessionId: string) => void;
  forward?: (event: StreamEvent) => void;
};

export class StreamBrokerAdapter implements StreamPort, SessionEventPublisher {
  constructor(private readonly broker: StreamBrokerLike) {}

  emit(sessionId: string, event: StreamEvent): void {
    if (typeof this.broker.emit === 'function') {
      this.broker.emit(sessionId, event);
      return;
    }
    if (typeof this.broker.forward === 'function') {
      this.broker.forward(event);
    }
  }

  subscribe(sessionId: string, callback: (event: StreamEvent) => void): () => void {
    if (typeof this.broker.subscribe === 'function') {
      return this.broker.subscribe(sessionId, callback);
    }
    return () => undefined;
  }

  emitPlan(sessionId: string, plan: PlanItem[]): void {
    if (typeof this.broker.emitPlan === 'function') {
      this.broker.emitPlan(sessionId, plan);
    } else if (typeof this.broker.emit === 'function') {
      this.broker.emit(sessionId, { type: 'plan_update', data: plan });
    } else if (typeof this.broker.forward === 'function') {
      this.broker.forward({ type: 'plan_update', data: plan });
    }
  }

  cleanup(sessionId: string): void {
    if (typeof this.broker.cleanup === 'function') {
      this.broker.cleanup(sessionId);
    } else if (typeof this.broker.cleanupSession === 'function') {
      this.broker.cleanupSession(sessionId);
    }
  }
}
