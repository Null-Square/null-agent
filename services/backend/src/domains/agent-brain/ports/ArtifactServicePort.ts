import type { StreamBroker } from '../application/orchestration/streaming/StreamBroker';
import type { SessionState } from '../domain/types';
import type { SessionTraceRecorder } from '../infrastructure/telemetry';

export interface ArtifactServicePort {
  saveArtifacts(session: SessionState): Promise<void>;
  getArtifactContent(sessionId: string, targetName: string): Promise<string | null>;
  ensureReportForCompletion(sessionId: string): Promise<void>;
  getStorageRoot(): string;
  flush(
    sessionId: string,
    turnNumber: number,
    stream: StreamBroker,
    recorder?: SessionTraceRecorder,
  ): Promise<{ hasSummary: boolean; hasReport: boolean }>;
}
