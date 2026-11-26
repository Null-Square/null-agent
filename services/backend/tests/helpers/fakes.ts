export class FakeJobQueue {
  public jobs: Array<{ type: string; executeAt: number; payload: any; idempotencyKey?: string }> = [];

  async schedule<T>(job: { type: string; executeAt: number; idempotencyKey?: string; payload: T }): Promise<string> {
    this.jobs.push(job as any);
    return `job-${this.jobs.length}`;
  }
}

export class FakeS3 {
  mode: 'exists' | 'not_found' | 's3_error' = 'exists';

  async objectExistsWithReason(_key: string) {
    if (this.mode === 'exists') return { exists: true as const };
    if (this.mode === 'not_found') return { exists: false as const, reason: 'not_found' as const };
    return { exists: false as const, reason: 's3_error' as const, error: new Error('s3 down') };
  }
}
