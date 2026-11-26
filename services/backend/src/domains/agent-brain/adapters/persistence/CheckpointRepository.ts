import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentCheckpoints, type AgentCheckpointRow, type NewAgentCheckpointRow } from '@/db/schema';

export class CheckpointRepository {
  constructor(private readonly database = db) {}

  async create(input: NewAgentCheckpointRow): Promise<AgentCheckpointRow> {
    const [row] = await this.database.insert(agentCheckpoints).values(input).returning();
    if (!row) {
      throw new Error('Failed to insert checkpoint');
    }
    return row;
  }

  async findById(id: string): Promise<AgentCheckpointRow | null> {
    const [row] = await this.database.select().from(agentCheckpoints).where(eq(agentCheckpoints.id, id)).limit(1);
    return row ?? null;
  }

  async listBySession(sessionId: string): Promise<AgentCheckpointRow[]> {
    return this.database.select().from(agentCheckpoints).where(eq(agentCheckpoints.sessionId, sessionId));
  }

  async delete(id: string): Promise<void> {
    await this.database.delete(agentCheckpoints).where(eq(agentCheckpoints.id, id));
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.database.delete(agentCheckpoints).where(eq(agentCheckpoints.sessionId, sessionId));
  }
}
