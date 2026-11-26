import { and, desc, eq, like, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { assets, inventoryNotes } from '@/db/schema';
import { assetTenancyClause } from '@/domains/security-ops/assets/assetScopeFilter';

const AssetRefSchema = z.object({
  kind: z.enum(['domain', 'ip']),
  value: z.string().min(1),
});

export const QueryNotesSchema = z.object({
  assetRef: AssetRefSchema.optional(),
  ntype: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

type InventoryNoteQueryContext = {
  organizationId: string;
  scopeId: string;
  workflowDiscipline?: string;
  activeComplianceFrameworkKey?: string;
};

type InventoryNoteQueryHelpers = {
  normalizeAssetValue: (kind: z.infer<typeof AssetRefSchema>['kind'], rawValue: string) => string;
  validateIpAssetRefOrThrow: (value: string, toolName: 'query_notes') => void;
  normalizeNtype: (raw: string) => string;
};

export type QueryNotesResult = {
  notes: Array<{
    id: string;
    assetId: string | null;
    ntype: string;
    title: string | null;
    data: Record<string, unknown>;
    confidence: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  totalCount: number;
};

const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> =>
  clause !== undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const STRATEGIC_NOTE_TYPES = new Set(['run.digest', 'approach.tried', 'approach.blocker', 'scan.coverage']);

const noteWorkflowDiscipline = (data: Record<string, unknown>): string => {
  const raw = typeof data.workflowDiscipline === 'string'
    ? data.workflowDiscipline
    : typeof data.discipline === 'string'
      ? data.discipline
      : '';
  return raw.trim().toLowerCase();
};

const noteClosesComplianceFramework = (
  data: Record<string, unknown>,
  frameworkKey: string,
): boolean =>
  Array.isArray(data.closesCompliance) &&
  data.closesCompliance.some((entry) =>
    isRecord(entry) && entry.frameworkKey === frameworkKey,
  );

const noteMatchesActiveComplianceFramework = (
  row: { ntype: string; data: unknown },
  frameworkKey: string | undefined,
): boolean => {
  if (!frameworkKey || !STRATEGIC_NOTE_TYPES.has(row.ntype)) {
    return true;
  }
  if (row.ntype === 'scan.coverage') {
    return true;
  }
  const data = isRecord(row.data) ? row.data : {};
  const noteDiscipline = noteWorkflowDiscipline(data);
  if (noteDiscipline && noteDiscipline !== 'compliance') {
    return false;
  }
  const rawFramework = typeof data.frameworkKey === 'string'
    ? data.frameworkKey
    : typeof data.framework === 'string'
      ? data.framework
      : '';
  if (rawFramework) {
    return rawFramework === frameworkKey;
  }
  return noteClosesComplianceFramework(data, frameworkKey);
};

export class InventoryNoteQueryService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly helpers: InventoryNoteQueryHelpers,
  ) {}

  async queryNotes(params: {
    userId: string;
    context: InventoryNoteQueryContext;
    input: unknown;
  }): Promise<QueryNotesResult> {
    const parsed = QueryNotesSchema.parse(params.input);

    let assetId: string | undefined;
    if (parsed.assetRef) {
      const normalizedValue = this.helpers.normalizeAssetValue(parsed.assetRef.kind, parsed.assetRef.value);
      if (parsed.assetRef.kind === 'ip') {
        this.helpers.validateIpAssetRefOrThrow(normalizedValue, 'query_notes');
      }
      const [asset] = await this.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            assetTenancyClause({
              organizationId: params.context.organizationId,
              scopeId: params.context.scopeId,
            }),
            eq(assets.kind, parsed.assetRef.kind),
            eq(assets.value, normalizedValue),
          ),
        )
        .limit(1);
      if (!asset) {
        return { notes: [], totalCount: 0 };
      }
      assetId = asset.id;
    }

    const normalizedNtype = parsed.ntype ? this.helpers.normalizeNtype(parsed.ntype) : undefined;
    const whereClauses = [
      eq(inventoryNotes.userId, params.userId),
      eq(inventoryNotes.organizationId, params.context.organizationId),
      eq(inventoryNotes.scopeId, params.context.scopeId),
      assetId ? eq(inventoryNotes.assetId, assetId) : undefined,
      parsed.since ? sql`${inventoryNotes.lastSeenAt} >= ${new Date(parsed.since)}` : undefined,
      normalizedNtype
        ? normalizedNtype.endsWith('.')
          ? like(inventoryNotes.ntype, `${normalizedNtype}%`)
          : eq(inventoryNotes.ntype, normalizedNtype)
        : undefined,
    ].filter(isSqlClause);

    const rows = await this.db
      .select({
        id: inventoryNotes.id,
        assetId: inventoryNotes.assetId,
        ntype: inventoryNotes.ntype,
        title: inventoryNotes.title,
        data: inventoryNotes.data,
        confidence: inventoryNotes.confidence,
        firstSeenAt: inventoryNotes.firstSeenAt,
        lastSeenAt: inventoryNotes.lastSeenAt,
      })
      .from(inventoryNotes)
      .where(and(...whereClauses))
      .orderBy(desc(inventoryNotes.lastSeenAt))
      .limit(parsed.limit);

    const filteredRows = params.context.workflowDiscipline === 'compliance'
      ? rows.filter((row) => noteMatchesActiveComplianceFramework(row, params.context.activeComplianceFrameworkKey))
      : rows;

    const mapped = filteredRows.map((row) => ({
      id: row.id,
      assetId: row.assetId,
      ntype: row.ntype,
      title: row.title ?? null,
      data: row.data,
      confidence: row.confidence ?? null,
      firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : String(row.firstSeenAt),
      lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : String(row.lastSeenAt),
    }));

    return { notes: mapped, totalCount: mapped.length };
  }
}
