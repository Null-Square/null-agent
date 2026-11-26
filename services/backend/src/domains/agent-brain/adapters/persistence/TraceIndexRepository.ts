import { db } from '@/db/client';
import { traceIndex, type NewTraceIndexRow, type TraceIndexRow } from '@/db/schema';
import { eq } from 'drizzle-orm';

export class TraceIndexRepository {
  constructor(private readonly database = db) {}

  async upsert(entry: NewTraceIndexRow): Promise<void> {
    // Postgres upsert
    await this.database
      .insert(traceIndex)
      .values(entry)
      .onConflictDoUpdate({
        target: traceIndex.sessionId,
        set: {
          traceKey: entry.traceKey,
          markdownKey: entry.markdownKey,
          costKey: entry.costKey,
          artifactsPrefix: entry.artifactsPrefix,
          acceptedHighWater: entry.acceptedHighWater,
          persistedHighWater: entry.persistedHighWater,
          integrityStatus: entry.integrityStatus,
          integrityDetails: entry.integrityDetails,
          updatedAt: new Date(),
        },
      });
  }

  async find(sessionId: string): Promise<TraceIndexRow | null> {
    const [row] = await this.database.select().from(traceIndex).where(eq(traceIndex.sessionId, sessionId)).limit(1);
    return row ?? null;
  }

  async list(offset = 0, limit = 100): Promise<TraceIndexRow[]> {
    return this.database
      .select()
      .from(traceIndex)
      .orderBy(traceIndex.createdAt)
      .offset(offset)
      .limit(limit);
  }
}
