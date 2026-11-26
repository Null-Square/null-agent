/**
 * StreamPort - Interface for event streaming
 * 
 * Used by adapters to emit and subscribe to session events.
 */
import type { StreamEvent, PlanItem } from '../domain/types';

export interface StreamPort {
  emit(sessionId: string, event: StreamEvent): void;
  subscribe(sessionId: string, callback: (event: StreamEvent) => void): () => void;
  emitPlan(sessionId: string, plan: PlanItem[]): void;
  cleanup(sessionId: string): void;
}
