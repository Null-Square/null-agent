import type { Message, StreamEvent } from '../../../domain/types';

type EmitFn = (event: StreamEvent) => void;

type TraceLogger = {
  event(type: string, data?: unknown): void;
};
import { logger } from '@/shared/logger';

export class StreamBroker {
  constructor(private readonly emitFn: EmitFn, private readonly trace?: TraceLogger, private readonly log = logger.child({ scope: 'StreamBroker' })) {}

  private dispatch(type: StreamEvent['type'], data?: unknown): void {
    const event = (data === undefined ? { type } : { type, data }) as StreamEvent;
    this.emitFn(event);
    this.emitTrace(type, data);
  }

  private emitTrace(type: string, data?: unknown): void {
    if (!this.trace) {
      return;
    }
    try {
      this.trace.event(type, data);
    } catch (error) {
      this.log.warn({ err: error }, 'StreamBroker trace emission failed');
    }
  }

  forward(event: StreamEvent): void {
    this.emitFn(event);
    this.emitTrace(event.type, 'data' in event ? event.data : undefined);
  }

  messageStart(payload: Record<string, unknown> = { role: 'assistant' }): void {
    this.dispatch('message_start', payload);
  }

  token(delta: string): void {
    this.dispatch('token', delta);
  }

  message(data: Pick<Message, 'role' | 'content'> & Partial<Message>): void {
    const payload: Message = {
      id: typeof data.id === 'string' ? data.id : '',
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      ...data,
    };
    this.dispatch('message', payload);
  }

  messageEnd(payload: Record<string, unknown> = {}): void {
    this.dispatch('message_end', payload);
  }

  toolStarted(name: string, args: unknown, toolCallId?: string): void {
    this.dispatch('tool_started', { name, args, ...(toolCallId ? { toolCallId } : {}) });
  }

  toolOutput(chunk: string, name?: string): void {
    this.dispatch('tool_output', { chunk, name });
  }

  toolResult(name: string, result: unknown, toolCallId?: string): void {
    this.dispatch('tool_result', { name, result, ...(toolCallId ? { toolCallId } : {}) });
  }

  planUpdate(payload: unknown): void {
    this.dispatch('plan_update', payload);
  }

  aborted(reason?: string): void {
    this.dispatch('aborted', reason !== undefined ? { reason } : {});
  }

  done(): void {
    this.dispatch('done');
  }

  raw(type: StreamEvent['type'], data?: unknown): void {
    this.dispatch(type, data);
  }
}

