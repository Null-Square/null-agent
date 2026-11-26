import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

export type NmapIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'nmap', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readArtifactText: (artifact: ScannerResolvedArtifact) => Promise<string>;
  normalizeArtifactHost: (rawValue: string | undefined) => string | undefined;
  normalizePort: (value: unknown) => number | undefined;
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

export const ingestNmapArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: NmapIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('nmap', artifact.relativePath);
  const xml = await ctx.readArtifactText(artifact);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'nmap artifact' }];
  const hostBlocks = xml.match(/<host[\s\S]*?<\/host>/gu) ?? [];
  const seenAssets = new Set<string>();

  for (const block of hostBlocks) {
    const hostname = block.match(/<hostname[^>]*\sname="([^"]+)"/u)?.[1];
    const address = block.match(/<address[^>]*\saddr="([^"]+)"/u)?.[1];
    const host = ctx.normalizeArtifactHost(hostname ?? address);
    if (!host) {
      summary.skipped += 1;
      continue;
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
    const portBlocks = block.match(/<port[\s\S]*?<\/port>/gu) ?? [];
    for (const portBlock of portBlocks) {
      if (!/state="open"/u.test(portBlock)) {
        continue;
      }
      const protocol = portBlock.match(/protocol="([^"]+)"/u)?.[1] === 'udp' ? 'udp' : 'tcp';
      const port = ctx.normalizePort(portBlock.match(/portid="([^"]+)"/u)?.[1]);
      if (!port) {
        continue;
      }
      const serviceName = portBlock.match(/<service[^>]*\sname="([^"]+)"/u)?.[1];
      const product = portBlock.match(/<service[^>]*\sproduct="([^"]+)"/u)?.[1];
      const version = portBlock.match(/<service[^>]*\sversion="([^"]+)"/u)?.[1];
      const service = await ctx.reportService({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        input: {
          assetRef,
          protocol,
          port,
          serviceName,
          product,
          version,
          versionReadMethod: 'service_probe',
          evidence,
        },
      });
      if (service.created) summary.servicesCreated += 1; else summary.servicesTouched += 1;
    }
  }
  return summary;
};
