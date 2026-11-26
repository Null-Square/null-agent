import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db, type DatabaseClient } from "@/db/client";
import {
  modelRateCards,
  modelRateWindows,
  models,
  type ModelRateCardRow,
  type ModelRateWindowRow,
} from "@/db/schema";
import { ErrorFactory } from "@/shared/errors";

export type RateWindowInput = {
  name: string;
  startMinuteUtc: number;
  endMinuteUtc: number;
  cacheHitInputPer1m: number;
  cacheMissInputPer1m: number;
  outputPer1m: number;
};

export type PublishRateCardInput = {
  modelId: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  currency: string;
  baseCacheHitInputPer1m: number;
  baseCacheMissInputPer1m: number;
  baseOutputPer1m: number;
  sourceUrl?: string | null;
  sourceNote?: string | null;
  windows?: RateWindowInput[];
};

export type ModelRateQuote = {
  modelId: string;
  modelName: string;
  provider: string;
  rateCardId: string;
  rateWindowId: string | null;
  rateWindowName: string | null;
  currency: string;
  cacheHitInputPer1m: number;
  cacheMissInputPer1m: number;
  outputPer1m: number;
  maxOutputTokens: number | null;
  requestStartedAt: Date;
};

export type ModelRateCardBundle = {
  card: ModelRateCardRow;
  windows: ModelRateWindowRow[];
};

const assertFiniteRate = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    const message = `${field} must be a finite non-negative number`;
    throw ErrorFactory.validation.constraintViolated(message, {
      userMessage: message,
    });
  }
};

const rateConstraint = (message: string): never => {
  throw ErrorFactory.validation.constraintViolated(message, {
    userMessage: message,
  });
};

const normalizeCard = (card: ModelRateCardRow): ModelRateCardRow => ({
  ...card,
  baseCacheHitInputPer1m: Number(card.baseCacheHitInputPer1m),
  baseCacheMissInputPer1m: Number(card.baseCacheMissInputPer1m),
  baseOutputPer1m: Number(card.baseOutputPer1m),
});

const normalizeWindow = (window: ModelRateWindowRow): ModelRateWindowRow => ({
  ...window,
  cacheHitInputPer1m: Number(window.cacheHitInputPer1m),
  cacheMissInputPer1m: Number(window.cacheMissInputPer1m),
  outputPer1m: Number(window.outputPer1m),
});

export const validateRateWindows = (windows: RateWindowInput[]): void => {
  const ordered = [...windows].sort(
    (left, right) => left.startMinuteUtc - right.startMinuteUtc,
  );
  ordered.forEach((window, index) => {
    if (
      !Number.isInteger(window.startMinuteUtc) ||
      !Number.isInteger(window.endMinuteUtc)
    ) {
      rateConstraint("Rate window minutes must be integers");
    }
    if (
      window.startMinuteUtc < 0 ||
      window.endMinuteUtc > 1440 ||
      window.endMinuteUtc <= window.startMinuteUtc
    ) {
      rateConstraint(
        `Invalid UTC rate window ${window.startMinuteUtc}..${window.endMinuteUtc}`,
      );
    }
    if (index > 0 && ordered[index - 1]!.endMinuteUtc > window.startMinuteUtc) {
      rateConstraint("Rate windows must not overlap");
    }
    assertFiniteRate(window.cacheHitInputPer1m, "cacheHitInputPer1m");
    assertFiniteRate(window.cacheMissInputPer1m, "cacheMissInputPer1m");
    assertFiniteRate(window.outputPer1m, "outputPer1m");
  });
};

export const selectRateWindow = (
  windows: ModelRateWindowRow[],
  at: Date,
): ModelRateWindowRow | null => {
  const minuteUtc = at.getUTCHours() * 60 + at.getUTCMinutes();
  return (
    windows.find(
      (window) =>
        minuteUtc >= window.startMinuteUtc && minuteUtc < window.endMinuteUtc,
    ) ?? null
  );
};

export const isRateCardEffective = (
  card: Pick<ModelRateCardRow, "effectiveFrom" | "effectiveTo">,
  at: Date,
): boolean =>
  card.effectiveFrom <= at && (!card.effectiveTo || card.effectiveTo > at);

export class ModelRateRepository {
  constructor(private readonly database: DatabaseClient = db) {}

  async resolveQuote(
    modelId: string,
    requestStartedAt: Date,
  ): Promise<ModelRateQuote> {
    const [row] = await this.database
      .select({ model: models, card: modelRateCards })
      .from(models)
      .innerJoin(modelRateCards, eq(modelRateCards.modelId, models.id))
      .where(
        and(
          eq(models.id, modelId),
          lte(modelRateCards.effectiveFrom, requestStartedAt),
          or(
            isNull(modelRateCards.effectiveTo),
            gt(modelRateCards.effectiveTo, requestStartedAt),
          ),
        ),
      )
      .orderBy(desc(modelRateCards.effectiveFrom))
      .limit(1);

    if (!row) {
      throw new Error(
        `No active rate card for model deployment "${modelId}" at ${requestStartedAt.toISOString()}`,
      );
    }

    const windows = await this.database
      .select()
      .from(modelRateWindows)
      .where(eq(modelRateWindows.rateCardId, row.card.id))
      .orderBy(asc(modelRateWindows.startMinuteUtc));
    const window = selectRateWindow(windows, requestStartedAt);

    return {
      modelId: row.model.id,
      modelName: row.model.modelName,
      provider: row.model.provider,
      rateCardId: row.card.id,
      rateWindowId: window?.id ?? null,
      rateWindowName: window?.name ?? null,
      currency: row.card.currency,
      cacheHitInputPer1m: Number(
        window?.cacheHitInputPer1m ?? row.card.baseCacheHitInputPer1m,
      ),
      cacheMissInputPer1m: Number(
        window?.cacheMissInputPer1m ?? row.card.baseCacheMissInputPer1m,
      ),
      outputPer1m: Number(window?.outputPer1m ?? row.card.baseOutputPer1m),
      maxOutputTokens: row.model.maxOutputTokens ?? null,
      requestStartedAt,
    };
  }

  /**
   * Quote the model that **ran**, identified by its wire name rather than by a pinned deployment.
   *
   * An execution backend may answer with a model other than the one the session selected — a
   * Codex process serves every session with its pinned model. Pricing such a call against the
   * selected deployment would attribute one model's tokens to another model's rate card and
   * report the result as a cost. That is worse than reporting nothing, because it looks like an
   * answer. So the ledger prices what actually answered, and fails loudly when it cannot.
   */
  async resolveQuoteByModelName(
    modelName: string,
    requestStartedAt: Date,
  ): Promise<ModelRateQuote> {
    // Deliberately NOT filtered on `isActive`.
    //
    // Pricing an attempt is a statement about what *ran*; `isActive` is a statement about what may
    // be *selected now*. Those are different questions, and conflating them breaks two real cases:
    // deactivating a model would make every past attempt that named it unpriceable, and a model
    // reachable only over an external execution backend — no API key, so `isActive` stays false by
    // design — could never be costed at all: gating on `isActive` made every such session throw
    // "cannot be priced" the moment the pinned model was not also an API deployment.
    //
    // Active rows still win when a name has more than one deployment, so nothing about ordinary
    // selection changes.
    const [row] = await this.database
      .select({ id: models.id })
      .from(models)
      .where(eq(models.modelName, modelName))
      .orderBy(desc(models.isActive), asc(models.selectionPriority))
      .limit(1);

    if (!row) {
      throw new Error(
        `No model deployment named "${modelName}", so the call that ran cannot be priced. ` +
          'Seed the model with a rate card before running it.',
      );
    }
    return this.resolveQuote(row.id, requestStartedAt);
  }

  async listByModel(modelId: string): Promise<ModelRateCardBundle[]> {
    return (await this.listByModels([modelId])).get(modelId) ?? [];
  }

  async listByModels(
    modelIds: string[],
  ): Promise<Map<string, ModelRateCardBundle[]>> {
    const result = new Map<string, ModelRateCardBundle[]>();
    for (const modelId of modelIds) result.set(modelId, []);
    if (modelIds.length === 0) return result;

    const cards = (
      await this.database
        .select()
        .from(modelRateCards)
        .where(inArray(modelRateCards.modelId, modelIds))
        .orderBy(asc(modelRateCards.effectiveFrom))
    ).map(normalizeCard);
    const cardIds = cards.map((card) => card.id);
    const windows =
      cardIds.length === 0
        ? []
        : (
            await this.database
              .select()
              .from(modelRateWindows)
              .where(inArray(modelRateWindows.rateCardId, cardIds))
              .orderBy(asc(modelRateWindows.startMinuteUtc))
          ).map(normalizeWindow);
    const windowsByCard = new Map<string, ModelRateWindowRow[]>();
    for (const window of windows) {
      const group = windowsByCard.get(window.rateCardId) ?? [];
      group.push(window);
      windowsByCard.set(window.rateCardId, group);
    }
    for (const card of cards) {
      result.get(card.modelId)?.push({
        card,
        windows: windowsByCard.get(card.id) ?? [],
      });
    }
    return result;
  }

  async publish(input: PublishRateCardInput): Promise<ModelRateCardRow> {
    return this.database.transaction(async (tx) => {
      const repository = new ModelRateRepository(
        tx as unknown as DatabaseClient,
      );
      return repository.publishInTransaction(input);
    });
  }

  async publishInTransaction(
    input: PublishRateCardInput,
  ): Promise<ModelRateCardRow> {
    const currency = input.currency.trim().toLowerCase();
    if (!currency) rateConstraint("Rate card currency is required");
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      rateConstraint("Rate card effectiveTo must be after effectiveFrom");
    }
    assertFiniteRate(input.baseCacheHitInputPer1m, "baseCacheHitInputPer1m");
    assertFiniteRate(input.baseCacheMissInputPer1m, "baseCacheMissInputPer1m");
    assertFiniteRate(input.baseOutputPer1m, "baseOutputPer1m");
    validateRateWindows(input.windows ?? []);

    const locked = await this.database.execute(
      sql`SELECT ${models.id} FROM ${models} WHERE ${models.id} = ${input.modelId} FOR UPDATE`,
    );
    if (locked.rowCount === 0) rateConstraint("Model not found");

    const overlaps = await this.database
      .select({
        id: modelRateCards.id,
        effectiveFrom: modelRateCards.effectiveFrom,
        effectiveTo: modelRateCards.effectiveTo,
      })
      .from(modelRateCards)
      .where(
        and(
          eq(modelRateCards.modelId, input.modelId),
          or(
            isNull(modelRateCards.effectiveTo),
            gt(modelRateCards.effectiveTo, input.effectiveFrom),
          ),
          input.effectiveTo
            ? lt(modelRateCards.effectiveFrom, input.effectiveTo)
            : sql`TRUE`,
        ),
      );

    if (overlaps.length > 0) {
      const [predecessor] = overlaps;
      if (overlaps.length !== 1 || !predecessor) {
        rateConstraint("Rate card effective ranges must not overlap");
      }
      if (
        predecessor.effectiveTo !== null ||
        predecessor.effectiveFrom >= input.effectiveFrom
      ) {
        rateConstraint("Rate card effective ranges must not overlap");
      }
      await this.database
        .update(modelRateCards)
        .set({ effectiveTo: input.effectiveFrom })
        .where(eq(modelRateCards.id, predecessor.id));
    }

    const [card] = await this.database
      .insert(modelRateCards)
      .values({
        modelId: input.modelId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        currency,
        baseCacheHitInputPer1m: input.baseCacheHitInputPer1m,
        baseCacheMissInputPer1m: input.baseCacheMissInputPer1m,
        baseOutputPer1m: input.baseOutputPer1m,
        sourceUrl: input.sourceUrl ?? null,
        sourceNote: input.sourceNote ?? null,
      })
      .returning();
    if (!card) throw new Error("Failed to publish model rate card");
    if (input.windows?.length) {
      await this.database.insert(modelRateWindows).values(
        input.windows.map((window) => ({
          rateCardId: card.id,
          ...window,
        })),
      );
    }
    return normalizeCard(card);
  }
}
