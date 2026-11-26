import { asc, desc, eq, and, ne, sql } from 'drizzle-orm';
import { db, type DatabaseClient } from '@/db/client';
import { models, type ModelRow, type NewModelRow } from '@/db/schema';
import type { ModelCategory } from '@null-ai/contracts';

export class ModelRepository {
  constructor(private readonly database: DatabaseClient = db) {}

  async transaction<T>(
    operation: (repository: ModelRepository, database: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const transaction = tx as unknown as DatabaseClient;
      return operation(new ModelRepository(transaction), transaction);
    });
  }

  async list(): Promise<ModelRow[]> {
    return this.database.select().from(models).orderBy(asc(models.createdAt), asc(models.id));
  }

  async listActive(): Promise<ModelRow[]> {
    return this.database
      .select()
      .from(models)
      .where(eq(models.isActive, true))
      .orderBy(asc(models.selectionCategory), asc(models.selectionPriority), desc(models.updatedAt));
  }

  async getById(id: string): Promise<ModelRow | null> {
    const [row] = await this.database.select().from(models).where(eq(models.id, id));
    return row ?? null;
  }

  /** Locks the row until the transaction ends, so two refreshes cannot race a rotating token. */
  async getByIdForUpdate(id: string): Promise<ModelRow | null> {
    const [row] = await this.database.select().from(models).where(eq(models.id, id)).for('update');
    return row ?? null;
  }

  /** The connection answers to its name first, so a catalogue row of the same name never shadows it. */
  async getByModelName(name: string): Promise<ModelRow | null> {
    const [row] = await this.database
      .select()
      .from(models)
      .where(eq(models.modelName, name))
      .orderBy(desc(models.isActive), desc(models.updatedAt))
      .limit(1);
    return row ?? null;
  }

  async getByProviderAndModelName(provider: string, modelName: string): Promise<ModelRow | null> {
    const [row] = await this.database
      .select()
      .from(models)
      .where(and(eq(models.provider, provider), eq(models.modelName, modelName)))
      .limit(1);
    return row ?? null;
  }

  async getByProvider(provider: string): Promise<ModelRow | null> {
    const [row] = await this.database
      .select()
      .from(models)
      .where(eq(models.provider, provider))
      .orderBy(desc(models.updatedAt))
      .limit(1);
    return row ?? null;
  }

  async getDefault(): Promise<ModelRow | null> {
    const [row] = await this.database.select().from(models).where(eq(models.isDefault, true)).limit(1);
    return row ?? null;
  }

  async getActiveByCategory(category: ModelCategory): Promise<ModelRow | null> {
    const [row] = await this.listActiveByCategory(category);
    return row ?? null;
  }

  /**
   * Every effort tier (low … extra high) is served by the connected model: the person connects one
   * model, and a tier no longer narrows the choice. The category is accepted so callers keep asking
   * the question they mean.
   */
  async listActiveByCategory(_category: ModelCategory): Promise<ModelRow[]> {
    return this.database
      .select()
      .from(models)
      .where(eq(models.isActive, true))
      .orderBy(desc(models.isDefault), desc(models.updatedAt));
  }

  async create(data: NewModelRow): Promise<ModelRow> {
    const [row] = await this.database.insert(models).values(data).returning();
    return row;
  }

  async update(id: string, data: Partial<NewModelRow>): Promise<ModelRow | null> {
    const [row] = await this.database.update(models).set({ ...data, updatedAt: new Date() }).where(eq(models.id, id)).returning();
    return row ?? null;
  }

  /** Makes one row the connection: active and the default, and every other row neither. */
  async makeOnlyConnection(id: string): Promise<void> {
    await this.lockDefaultSelection();
    await this.database
      .update(models)
      .set({ isActive: false, isDefault: false, updatedAt: new Date() })
      .where(and(ne(models.id, id), sql`(${models.isActive} OR ${models.isDefault})`));
    await this.database
      .update(models)
      .set({ isActive: true, isDefault: true, updatedAt: new Date() })
      .where(eq(models.id, id));
  }

  async lockDefaultSelection(): Promise<void> {
    await this.database.execute(sql`SELECT ${models.id} FROM ${models} ORDER BY ${models.id} FOR UPDATE`);
  }
}
