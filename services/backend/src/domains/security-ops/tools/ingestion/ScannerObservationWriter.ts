import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { scannerObservations } from '@/db/schema';

type AssetRef = {
  kind: 'domain' | 'ip';
  value: string;
};

type EvidenceWithExcerpt = {
  path: string;
  label?: string;
  excerpt?: string;
  fileMissing?: boolean;
};

type ScannerObservationContext = {
  organizationId: string;
  scopeId: string;
  runId?: string;
};

type ScannerObservationWriterOptions = {
  now?: () => Date;
  normalizeSessionId: (raw: string | undefined) => string | undefined;
  normalizeToolText: (value: string) => string;
  pruneNullishDeep: (value: unknown) => unknown;
  mergeEvidenceWithExcerptsByPath: (
    existing: EvidenceWithExcerpt[] | null | undefined,
    incoming: EvidenceWithExcerpt[],
  ) => EvidenceWithExcerpt[];
  resolveEvidenceWithExcerpts: (workspaceDir: string, evidence: EvidenceWithExcerpt[]) => Promise<EvidenceWithExcerpt[]>;
  upsertAsset: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: ScannerObservationContext;
    input: AssetRef & {
      evidence: Array<{ path: string; label: string }>;
    };
  }) => Promise<{ assetId: string }>;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
};

const scannerDedupeKey = (parser: string, parts: unknown[]): string =>
  createHash('sha256')
    .update(
      parts
        .map((part) => {
          if (typeof part === 'string') {
            return part.trim().toLowerCase();
          }
          return stableStringify(part);
        })
        .join('|'),
    )
    .digest('hex');

export class ScannerObservationWriter {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: ScannerObservationWriterOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async recordObservation(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: ScannerObservationContext;
    parser: string;
    artifactPath: string;
    assetRef?: AssetRef;
    findingId?: string;
    observationType: string;
    title: string;
    severity?: string;
    confidence?: number;
    dedupeParts: unknown[];
    data: Record<string, unknown>;
    evidence: EvidenceWithExcerpt[];
  }): Promise<{ observationId: string; created: boolean }> {
    const sessionId = this.options.normalizeSessionId(params.sessionId);
    const now = this.now();
    const dedupeKey = scannerDedupeKey(params.parser, params.dedupeParts);
    const evidence = await this.options.resolveEvidenceWithExcerpts(params.workspaceDir, params.evidence);
    let assetId: string | null = null;

    if (params.assetRef) {
      const asset = await this.options.upsertAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId,
        context: params.context,
        input: {
          kind: params.assetRef.kind,
          value: params.assetRef.value,
          evidence: [{ path: params.artifactPath, label: `${params.parser} artifact` }],
        },
      });
      assetId = asset.assetId;
    }

    const [existing] = await this.db
      .select({ id: scannerObservations.id, evidence: scannerObservations.evidence })
      .from(scannerObservations)
      .where(
        and(
          eq(scannerObservations.userId, params.userId),
          eq(scannerObservations.organizationId, params.context.organizationId),
          eq(scannerObservations.parser, params.parser),
          eq(scannerObservations.dedupeKey, dedupeKey),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(scannerObservations)
        .set({
          scopeId: params.context.scopeId,
          sessionId: sessionId ?? null,
          assetId,
          findingId: params.findingId ?? null,
          sourceTool: params.parser,
          artifactPath: params.artifactPath,
          observationType: params.observationType,
          title: this.options.normalizeToolText(params.title),
          severity: params.severity ?? 'info',
          confidence: params.confidence ?? undefined,
          data: this.options.pruneNullishDeep(params.data) as Record<string, unknown>,
          evidence: this.options.mergeEvidenceWithExcerptsByPath(existing.evidence, evidence),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(scannerObservations.id, existing.id));
      return { observationId: existing.id, created: false };
    }

    const [row] = await this.db
      .insert(scannerObservations)
      .values({
        organizationId: params.context.organizationId,
        scopeId: params.context.scopeId,
        userId: params.userId,
        runId: params.context.runId ?? null,
        sessionId: sessionId ?? null,
        assetId,
        findingId: params.findingId ?? null,
        parser: params.parser,
        sourceTool: params.parser,
        artifactPath: params.artifactPath,
        observationType: params.observationType,
        title: this.options.normalizeToolText(params.title),
        severity: params.severity ?? 'info',
        confidence: params.confidence ?? undefined,
        dedupeKey,
        data: this.options.pruneNullishDeep(params.data) as Record<string, unknown>,
        evidence,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: scannerObservations.id });

    return { observationId: row.id, created: true };
  }
}
