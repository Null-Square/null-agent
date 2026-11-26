import { type TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { type S3StorageService } from '@/shared/storage/S3StorageService';
import { opsMetrics } from '@/shared/metrics/opsMetrics';

export class TraceRetentionService {
  constructor(
    private readonly repo: TraceIndexRepository,
    private readonly s3?: S3StorageService,
    private readonly retentionDays: number = 14,
  ) {}

  async cleanup(): Promise<void> {
    if (!this.s3) return;
    const start = Date.now();
    let cleaned = 0;
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const batch = await this.repo.list(0, 1000); // simple batch
      const expired = batch.filter((row) => row.updatedAt && row.updatedAt.getTime() < cutoff);
      for (const row of expired) {
        await Promise.allSettled([
          this.s3.deleteObject(row.traceKey),
          this.s3.deleteObject(row.markdownKey),
          this.s3.deleteObject(row.costKey),
          this.s3.deletePrefix(row.artifactsPrefix),
        ]);
        cleaned += 1;
      }
    } catch (error) {
      opsMetrics.recordRetention(Date.now() - start, cleaned, 'error');
      throw error;
    }
    opsMetrics.recordRetention(Date.now() - start, cleaned, 'ok');
  }
}
