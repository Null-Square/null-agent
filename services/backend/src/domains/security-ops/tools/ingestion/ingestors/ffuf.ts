import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

type NormalizedFfufEndpoint = {
  url: string;
  dedupeKey: string;
  pathname: string;
};

type FfufIngestCandidate<TAssetRef extends ScannerAssetRef = ScannerAssetRef> = {
  entry: Record<string, unknown>;
  endpoint: NormalizedFfufEndpoint;
  assetRef: TAssetRef;
  statusCode: number | undefined;
  signature: string;
  highSignal: boolean;
};

export type FfufIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'ffuf', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readArtifactJson: (artifact: ScannerResolvedArtifact) => Promise<unknown>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  toNonNegativeInt: (value: unknown) => number | undefined;
  normalizeFfufEndpointUrl: (rawUrl: string | undefined) => NormalizedFfufEndpoint | undefined;
  ffufResponseSignature: (entry: Record<string, unknown>) => string;
  isHighSignalFfufPath: (pathname: string) => boolean;
  incrementIngestNoise: (summary: IngestSummary, reason: string) => void;
  noisyClusterMinSize: number;
  noisyClusterRatio: number;
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

export const ingestFfufArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: FfufIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('ffuf', artifact.relativePath);
  const parsed = await ctx.readArtifactJson(artifact);
  const results = ctx.isRecord(parsed) && Array.isArray(parsed['results']) ? parsed['results'] : Array.isArray(parsed) ? parsed : [];
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'ffuf artifact' }];
  const candidates = results
    .map((entry) => {
      if (!ctx.isRecord(entry)) {
        summary.skipped += 1;
        return undefined;
      }
      const endpoint = ctx.normalizeFfufEndpointUrl(ctx.getString(entry['url']));
      if (!endpoint) {
        summary.skipped += 1;
        return undefined;
      }
      const assetRef = ctx.assetRefFromScannerValue(endpoint.url, params.parsed.rootAssetRef);
      if (!assetRef) {
        summary.skipped += 1;
        return undefined;
      }
      return {
        entry,
        endpoint,
        assetRef,
        statusCode: ctx.toNonNegativeInt(entry['status']),
        signature: ctx.ffufResponseSignature(entry),
        highSignal: ctx.isHighSignalFfufPath(endpoint.pathname),
      };
    })
    .filter((candidate): candidate is FfufIngestCandidate => candidate !== undefined);

  const signatureCounts = new Map<string, number>();
  for (const candidate of candidates) {
    signatureCounts.set(candidate.signature, (signatureCounts.get(candidate.signature) ?? 0) + 1);
  }
  const noisySignatures = new Set(
    Array.from(signatureCounts.entries())
      .filter(([, count]) => count >= ctx.noisyClusterMinSize && count >= candidates.length * ctx.noisyClusterRatio)
      .map(([signature]) => signature),
  );
  const seenEndpoints = new Set<string>();

  for (const candidate of candidates) {
    if (seenEndpoints.has(candidate.endpoint.dedupeKey)) {
      summary.duplicates += 1;
      ctx.incrementIngestNoise(summary, 'duplicate_normalized_endpoint');
      continue;
    }
    seenEndpoints.add(candidate.endpoint.dedupeKey);

    const statusCode = candidate.statusCode;
    const protectedEndpoint = statusCode === 401 || statusCode === 403;
    if (noisySignatures.has(candidate.signature) && !protectedEndpoint) {
      ctx.incrementIngestNoise(summary, 'repeated_response_cluster');
      continue;
    }
    if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && !candidate.highSignal) {
      ctx.incrementIngestNoise(summary, 'low_signal_redirect');
      continue;
    }

    const result = await ctx.reportNote({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        assetRef: candidate.assetRef,
        ntype: 'http.endpoint',
        data: {
          url: candidate.endpoint.url,
          method: 'GET',
          ...(statusCode !== undefined ? { statusCode } : {}),
          source: 'ffuf',
          sourceArtifact: artifact.relativePath,
          signal: candidate.highSignal ? 'high' : 'observed',
        },
        confidence: candidate.highSignal || protectedEndpoint ? 0.7 : 0.45,
        evidence,
      },
    });
    if (result.created) summary.endpointNotesCreated += 1; else summary.endpointNotesTouched += 1;
  }
  return summary;
};
