import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

export type SubfinderIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'subfinder', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  forEachArtifactLine: (
    artifact: ScannerResolvedArtifact,
    onLine: (line: string, lineNumber: number) => Promise<void>,
  ) => Promise<void>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  normalizeArtifactHost: (rawValue: string | undefined) => string | undefined;
  resolveCandidateParentAsset: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    hostname: string;
    rootAssetRef?: ScannerAssetRef;
  }) => Promise<{ assetRef: ScannerAssetRef; created: boolean } | null>;
  reportNote: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    input: unknown;
  }) => Promise<{ created: boolean }>;
};

export const ingestSubfinderArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: SubfinderIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('subfinder', artifact.relativePath);
  const noteEvidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'subfinder artifact' }];
  const seenHosts = new Set<string>();

  await ctx.forEachArtifactLine(artifact, async (line) => {
    let hostname: string | undefined;
    if (line.startsWith('{')) {
      try {
        const parsedLine = JSON.parse(line) as unknown;
        if (!ctx.isRecord(parsedLine)) {
          summary.skipped += 1;
          return;
        }
        hostname =
          ctx.getString(parsedLine['host']) ??
          ctx.getString(parsedLine['hostname']) ??
          ctx.getString(parsedLine['subdomain']) ??
          ctx.getString(parsedLine['name']);
      } catch {
        summary.skipped += 1;
        return;
      }
    } else {
      hostname = line;
    }

    const normalizedHost = ctx.normalizeArtifactHost(hostname);
    if (!normalizedHost) {
      summary.skipped += 1;
      return;
    }

    if (seenHosts.has(normalizedHost)) {
      return;
    }
    seenHosts.add(normalizedHost);

    const parentAsset = await ctx.resolveCandidateParentAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      hostname: normalizedHost,
      rootAssetRef: params.parsed.rootAssetRef,
    });

    if (!parentAsset) {
      summary.skipped += 1;
      return;
    }

    if (parentAsset.created) {
      summary.assetsCreated += 1;
    } else {
      summary.assetsTouched += 1;
    }

    if (parentAsset.assetRef.value === normalizedHost) {
      return;
    }

    const noteResult = await ctx.reportNote({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        assetRef: parentAsset.assetRef,
        ntype: 'dns.subdomain',
        data: {
          hostname: normalizedHost,
        },
        evidence: noteEvidence,
      },
    });

    if (noteResult.created) {
      summary.subdomainNotesCreated += 1;
    } else {
      summary.subdomainNotesTouched += 1;
    }
  });

  return summary;
};
