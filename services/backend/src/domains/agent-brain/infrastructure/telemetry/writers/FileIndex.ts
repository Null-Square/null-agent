import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/shared/logger';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export interface IndexEntry {
  sessionId: string;
  createdAt: string;
  model?: string;
  containerId?: string;
  status?: string;
  turns?: number;
  toolErrors?: number;
  bytes?: number;
  lastEventAt?: string;
  acceptedHighWater?: number;
  persistedHighWater?: number;
  integrityStatus?: 'complete' | 'degraded' | 'failed';
  storage?: {
    s3TraceFlushes?: number;
    s3TraceObjectsUploaded?: number;
    s3TraceBytesUploaded?: number;
  };
}

type IndexShape = Record<string, IndexEntry>;

export class FileIndex {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '{}', 'utf8');
    }
  }

  read(): IndexShape {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      if (!content.trim()) {
        return {};
      }
      return JSON.parse(content) as IndexShape;
    } catch (error) {
      logger.warn({ err: error }, 'Session trace index read failed; resetting file.');
      return {};
    }
  }

  update(sessionId: string, entry: IndexEntry): void {
    const index = this.read();
    index[sessionId] = entry;

    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));

    const maxRetries = 5;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        fs.renameSync(tempPath, this.filePath);
        return;
      } catch (error: unknown) {
        const record = isRecord(error) ? error : undefined;
        const code = typeof record?.['code'] === 'string' ? record['code'] : undefined;
        if (code === 'EPERM' || code === 'EBUSY') {
          retryCount++;
          if (retryCount === maxRetries) {
            logger.error({ err: error }, `Failed to rename index file after ${maxRetries} attempts`);
            // Try to clean up temp file
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            throw error;
          }
          // Wait with exponential backoff: 10ms, 40ms, 90ms, 160ms, 250ms
          const delay = retryCount * retryCount * 10;
          const start = Date.now();
          while (Date.now() - start < delay) { /* busy wait */ }
        } else {
          throw error;
        }
      }
    }
  }
}
