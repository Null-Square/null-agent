import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentMessages, type AgentMessageRow, type NewAgentMessageRow } from '@/db/schema';
import { encodeCursor, decodeCursor, clampLimit } from '@/shared/pagination';
import type { CursorPage } from '@null-ai/contracts';

export type MessageRow = Omit<AgentMessageRow, 'toolName' | 'toolCallId'> & {
  toolName?: string;
  toolCallId?: string;
};

const normalizeMessageRow = (row: AgentMessageRow): MessageRow => ({
  ...row,
  toolName: row.toolName ?? undefined,
  toolCallId: row.toolCallId ?? undefined,
});

export class MessageRepository {
  constructor(private readonly database = db) {}

  async append(message: NewAgentMessageRow): Promise<MessageRow> {
    const [row] = await this.database.insert(agentMessages).values(message).returning();
    if (!row) {
      throw new Error('Failed to insert message');
    }
    return normalizeMessageRow(row);
  }

  async appendMany(messages: NewAgentMessageRow[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.database.insert(agentMessages).values(messages);
  }

  async listBySession(sessionId: string): Promise<MessageRow[]> {
    const rows = await this.database
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .orderBy(agentMessages.createdAt);
    return rows.map(normalizeMessageRow);
  }

  /**
   * List messages with cursor-based pagination.
   * Uses shared pagination utilities from @/shared/pagination.
   */
  async listBySessionPaged(
    sessionId: string,
    options: { limit?: number; cursor?: string; direction?: 'forward' | 'backward' } = {},
  ): Promise<CursorPage<MessageRow>> {
    const limit = clampLimit(options.limit, 100, 500);
    const direction = options.direction ?? 'forward';
    const cursor = decodeCursor(options.cursor);
    const conditions = [eq(agentMessages.sessionId, sessionId)];

    if (cursor) {
      const cmp =
        direction === 'backward'
          ? sql`(${agentMessages.createdAt} < ${cursor.createdAt} OR (${agentMessages.createdAt} = ${cursor.createdAt} AND ${agentMessages.id} < ${cursor.id}))`
          : sql`(${agentMessages.createdAt} > ${cursor.createdAt} OR (${agentMessages.createdAt} = ${cursor.createdAt} AND ${agentMessages.id} > ${cursor.id}))`;
      conditions.push(cmp);
    }

    const order =
      direction === 'backward'
        ? [desc(agentMessages.createdAt), desc(agentMessages.id)]
        : [agentMessages.createdAt, agentMessages.id];

    const rows = await this.database
      .select()
      .from(agentMessages)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(limit + 1);

    // Build cursor page using limit+1 pattern
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const data = direction === 'backward' ? slice.reverse() : slice;

    const cursorRow = direction === 'backward' ? data[0] : data[data.length - 1];
    const nextCursor = cursorRow ? encodeCursor(cursorRow) : undefined;

    return {
      data: data.map(normalizeMessageRow),
      meta: { hasMore, nextCursor },
    };
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.database.delete(agentMessages).where(eq(agentMessages.sessionId, sessionId));
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.database.delete(agentMessages).where(eq(agentMessages.id, messageId));
  }
}

