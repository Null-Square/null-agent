import { type SessionTraceRecorder } from '../infrastructure/telemetry';
import type { TelemetryPort } from '../ports';
import type {
  SessionTraceSeed,
  TraceEvent,
  SessionTraceCloseMeta,
  TraceWriteResult,
} from '../infrastructure/telemetry';

export class TelemetryRecorderAdapter implements TelemetryPort {
  constructor(private readonly recorder: SessionTraceRecorder) {}

  async init(sessionId: string, seed: SessionTraceSeed): Promise<void> {
    await this.recorder.init(sessionId, seed);
  }

  async write(sessionId: string, turn: number, event: TraceEvent): Promise<TraceWriteResult> {
    return this.recorder.write(sessionId, turn, event);
  }

  async close(sessionId: string, meta: SessionTraceCloseMeta): Promise<void> {
    await this.recorder.close(sessionId, meta);
  }
}
