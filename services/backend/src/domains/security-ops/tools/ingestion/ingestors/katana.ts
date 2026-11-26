import {
  discountSharedVersions,
  extractWordPressAssetFromUrl,
  type WordPressAssetFromUrl,
} from '@/domains/security-ops/components/fingerprint/wordpressAssets';
import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

export type KatanaIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'katana', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readArtifactJsonLines: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>[]>;
  getString: (value: unknown) => string | undefined;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  assetRefFromScannerValue: (
    value: unknown,
    fallback?: ScannerAssetRef,
  ) => ScannerAssetRef | undefined;
  reportNote: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    input: unknown;
  }) => Promise<{ created: boolean }>;
};

export const ingestKatanaArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: KatanaIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('katana', artifact.relativePath);
  const rows = await ctx.readArtifactJsonLines(artifact);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'katana artifact' }];
  const seenEndpoints = new Set<string>();
  /**
   * WordPress components seen while crawling, collected before writing.
   *
   * They are held back deliberately: `discountSharedVersions` needs the whole
   * set to tell a plugin's own version from the core version WordPress
   * substitutes, and that judgement cannot be made one URL at a time.
   */
  const wordpressAssets: Array<{ asset: WordPressAssetFromUrl; assetRef: ScannerAssetRef }> = [];

  for (const row of rows) {
    // katana's real `-jsonl` output nests the crawled URL under `request.endpoint`
    // (and the verb under `request.method`); the flat `url`/`endpoint` shapes only
    // ever appear in trimmed samples. Reading the top level alone skipped 100% of a
    // real crawl. Cover both, nested last so the flat forms still win when present.
    const request =
      typeof row['request'] === 'object' && row['request'] !== null
        ? (row['request'] as Record<string, unknown>)
        : undefined;
    const rawUrl =
      ctx.getString(row['url'])
      ?? ctx.getString(row['endpoint'])
      ?? ctx.getString(request?.['endpoint'])
      ?? ctx.getString(row['request']);
    const url = ctx.normalizeOptionalToolText(rawUrl);
    const assetRef = ctx.assetRefFromScannerValue(url, params.parsed.rootAssetRef);
    if (!url || !assetRef) {
      summary.skipped += 1;
      continue;
    }
    const method = ctx.normalizeOptionalToolText(
      ctx.getString(row['method']) ?? ctx.getString(request?.['method']),
    )?.toUpperCase() ?? 'GET';
    const key = `${method}:${url}`;
    if (seenEndpoints.has(key)) {
      continue;
    }
    seenEndpoints.add(key);
    const result = await ctx.reportNote({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        assetRef,
        ntype: 'http.endpoint',
        data: { url, method, source: 'katana' },
        evidence,
      },
    });
    if (result.created) summary.endpointNotesCreated += 1; else summary.endpointNotesTouched += 1;

    const wordpressAsset = extractWordPressAssetFromUrl(url);
    if (wordpressAsset) {
      wordpressAssets.push({ asset: wordpressAsset, assetRef });
    }
  }

  await writeWordPressComponents({ params, ctx, summary, evidence, wordpressAssets });

  return summary;
};

/**
 * Record crawled WordPress plugins and themes as their own fingerprints.
 *
 * Plugins, not core, are what actually compromises WordPress sites — so folding
 * them into a single "WordPress" note leaves a plugin advisory feed with
 * nothing to match against.
 */
const writeWordPressComponents = async <TContext>(input: {
  params: ScannerIngestorParams<ScannerParsedInput, TContext>;
  ctx: KatanaIngestorContext<TContext>;
  summary: IngestSummary;
  evidence: ScannerEvidenceRef[];
  wordpressAssets: Array<{ asset: WordPressAssetFromUrl; assetRef: ScannerAssetRef }>;
}): Promise<void> => {
  if (input.wordpressAssets.length === 0) return;

  const discounted = discountSharedVersions(input.wordpressAssets.map((entry) => entry.asset));

  // One note per slug, keeping the best-evidenced sighting: a crawl surfaces the
  // same plugin on nearly every page, and only some of those URLs carry a version.
  const bySlug = new Map<string, { asset: WordPressAssetFromUrl; assetRef: ScannerAssetRef }>();
  discounted.forEach((asset, index) => {
    const assetRef = input.wordpressAssets[index]!.assetRef;
    const key = `${asset.kind}:${asset.slug}`;
    const existing = bySlug.get(key);
    if (existing && existing.asset.confidence >= asset.confidence) return;
    bySlug.set(key, { asset, assetRef });
  });

  for (const { asset, assetRef } of bySlug.values()) {
    const result = await input.ctx.reportNote({
      userId: input.params.userId,
      workspaceDir: input.params.workspaceDir,
      sessionId: input.params.sessionId,
      context: input.params.context,
      input: {
        assetRef,
        ntype: 'tech.fingerprint',
        data: {
          product: asset.slug,
          ...(asset.version ? { version: asset.version } : {}),
          category: asset.kind === 'plugins' ? 'wordpress-plugin' : 'wordpress-theme',
          source: 'katana',
        },
        ...(asset.confidence > 0 ? { confidence: asset.confidence } : {}),
        evidence: input.evidence,
      },
    });

    if (result.created) input.summary.techNotesCreated += 1;
    else input.summary.techNotesTouched += 1;
  }
};
