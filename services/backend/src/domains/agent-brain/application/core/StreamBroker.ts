import { type StreamEvent } from '../../domain/types';
import { logger } from '@/shared/logger';

export interface StreamCallback {
  (event: StreamEvent): void;
}

export interface StreamObserver {
  (sessionId: string, event: StreamEvent): void;
}

export class StreamBroker {
  private subscribers: Map<string, Set<StreamCallback>> = new Map();
  private observers: Set<StreamObserver> = new Set();
  private secretRegex =
    /(?<!\w)(?:(?:API|ACCESS)_?KEY|_?TOKEN|_?SECRET|PASSWORD)\s*[:=]\s*["']?([A-Za-z0-9_\-+=/]{10,})["']?/gi;

  subscribe(sessionId: string, callback: StreamCallback): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    return () => {
      const sessionSubscribers = this.subscribers.get(sessionId);
      if (sessionSubscribers) {
        sessionSubscribers.delete(callback);
        if (sessionSubscribers.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    };
  }

  emit(sessionId: string, event: StreamEvent): void {
    const redactedEvent = this.redactSecrets(event);

    if (this.observers.size > 0) {
      for (const observer of this.observers) {
        try {
          observer(sessionId, redactedEvent);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Error in stream observer');
        }
      }
    }

    const sessionSubscribers = this.subscribers.get(sessionId);
    if (sessionSubscribers) {
      for (const callback of sessionSubscribers) {
        try {
          callback(redactedEvent);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Error in stream callback');
          sessionSubscribers.delete(callback);
        }
      }
    }
  }

  cleanupSession(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  observe(callback: StreamObserver): () => void {
    this.observers.add(callback);
    return () => {
      this.observers.delete(callback);
    };
  }

  private redactSecrets<T extends StreamEvent>(event: T): T {
    const eventCopy = JSON.parse(JSON.stringify(event));

    if ('data' in eventCopy) {
      const dataString = JSON.stringify(eventCopy.data);
      const redactedDataString = dataString.replace(this.secretRegex, (match, secret) =>
        match.replace(secret, '*'.repeat(secret.length)),
      );
      eventCopy.data = JSON.parse(redactedDataString);
    }

    return eventCopy;
  }
}

