import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

export type NaabuIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'naabu', artifactPath: string) => IngestSummary;
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
  normalizePort: (value: unknown) => number | undefined;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  parseHostPortLine: (line: string) => { host: string; port: number } | undefined;
  detectAssetKind: (value: string) => ScannerAssetRef['kind'];
  ensureIngestedAsset: (params: {
    summary: IngestSummary;
    seenAssets: Set<string>;
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    assetRef: ScannerAssetRef;
    evidence: ScannerEvidenceRef[];
  }) => Promise<void>;
  reportService: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    input: unknown;
  }) => Promise<{ created: boolean }>;
};

export const ingestNaabuArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: NaabuIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('naabu', artifact.relativePath);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'naabu artifact' }];
  const seenAssets = new Set<string>();
  const seenServices = new Set<string>();

  await ctx.forEachArtifactLine(artifact, async (line) => {
    let host: string | undefined;
    let port: number | undefined;
    let protocol: 'tcp' | 'udp' = 'tcp';

    if (line.startsWith('{')) {
      try {
        const parsedLine = JSON.parse(line) as unknown;
        if (!ctx.isRecord(parsedLine)) {
          summary.skipped += 1;
          return;
        }

        host =
          ctx.normalizeArtifactHost(ctx.getString(parsedLine['host'])) ??
          ctx.normalizeArtifactHost(ctx.getString(parsedLine['ip'])) ??
          ctx.normalizeArtifactHost(params.parsed.rootAssetRef?.value);
        port = ctx.normalizePort(parsedLine['port']);
        const protocolRaw = ctx.normalizeOptionalToolText(ctx.getString(parsedLine['protocol']))?.toLowerCase();
        protocol = protocolRaw === 'udp' ? 'udp' : 'tcp';
      } catch {
        summary.skipped += 1;
        return;
      }
    } else {
      const parsedLine = ctx.parseHostPortLine(line);
      host = parsedLine?.host;
      port = parsedLine?.port;
    }

    if (!host || !port) {
      summary.skipped += 1;
      return;
    }

    const assetRef = { kind: ctx.detectAssetKind(host), value: host } as const;
    await ctx.ensureIngestedAsset({
      summary,
      seenAssets,
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      assetRef,
      evidence,
    });

    const serviceKey = `${assetRef.kind}:${assetRef.value}:${protocol}:${port}`;
    if (seenServices.has(serviceKey)) {
      return;
    }
    seenServices.add(serviceKey);

    const result = await ctx.reportService({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        assetRef,
        protocol,
        port,
        evidence,
      },
    });

    if (result.created) {
      summary.servicesCreated += 1;
    } else {
      summary.servicesTouched += 1;
    }
  });

  return summary;
};
