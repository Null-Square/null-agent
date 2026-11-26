import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentArtifacts, type AgentArtifactRow, type NewAgentArtifactRow } from '@/db/schema';

export type ArtifactRow = Omit<AgentArtifactRow, 'fileType'> & { fileType?: string };

const normalizeArtifactRow = (row: AgentArtifactRow): ArtifactRow => ({
  ...row,
  fileType: row.fileType ?? undefined,
});

export class ArtifactRepository {
  constructor(private readonly database = db) {}

  async create(artifact: NewAgentArtifactRow): Promise<ArtifactRow> {
    const [row] = await this.database.insert(agentArtifacts).values(artifact).returning();
    if (!row) {
      throw new Error('Failed to insert artifact');
    }
    return normalizeArtifactRow(row);
  }

  async bulkInsert(artifacts: NewAgentArtifactRow[]): Promise<void> {
    if (artifacts.length === 0) {
      return;
    }
    await this.database.insert(agentArtifacts).values(artifacts);
  }

  async listBySession(sessionId: string): Promise<ArtifactRow[]> {
    const rows = await this.database.select().from(agentArtifacts).where(eq(agentArtifacts.sessionId, sessionId));
    return rows.map(normalizeArtifactRow);
  }

  async findById(id: string): Promise<ArtifactRow | null> {
    const [row] = await this.database.select().from(agentArtifacts).where(eq(agentArtifacts.id, id)).limit(1);
    return row ? normalizeArtifactRow(row) : null;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.database.delete(agentArtifacts).where(eq(agentArtifacts.sessionId, sessionId));
  }
}
