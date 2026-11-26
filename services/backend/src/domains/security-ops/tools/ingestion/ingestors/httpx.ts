import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
} from '../types';

type ParsedTechFingerprint = {
  product: string;
  version?: string;
  category?: string;
  confidence?: number;
};

export type HttpxIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'httpx', artifactPath: string) => IngestSummary;
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
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  normalizeArtifactHost: (rawValue: string | undefined) => string | undefined;
  normalizePort: (value: unknown) => number | undefined;
  toNonNegativeInt: (value: unknown) => number | undefined;
  detectAssetKind: (value: string) => ScannerAssetRef['kind'];
  splitProductVersion: (rawValue: string) => { product: string; version?: string };
  extractHttpxTechFingerprints: (value: Record<string, unknown>) => ParsedTechFingerprint[];
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
  reportNote: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    componentObservationSource?: 'httpx';
    context?: TContext;
    input: unknown;
  }) => Promise<{ created: boolean }>;
};

export const ingestHttpxArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: HttpxIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('httpx', artifact.relativePath);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'httpx artifact' }];
  const noteEvidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'httpx artifact' }];
  const seenAssets = new Set<string>();
  const seenServices = new Set<string>();
  const seenEndpoints = new Set<string>();
  const seenTechs = new Set<string>();
  let parsedRows = 0;

  await ctx.forEachArtifactLine(artifact, async (line, lineNumber) => {
    if (!line.startsWith('{')) {
      if (parsedRows === 0) {
        throw new Error(
          `ingest_scan_artifact(parser=httpx) requires JSONL output. Rerun httpx with -j or -json and ingest that artifact. First invalid line: ${lineNumber}`,
        );
      }
      summary.skipped += 1;
      return;
    }

    let parsedLine: Record<string, unknown>;
    try {
      const candidate = JSON.parse(line) as unknown;
      if (!ctx.isRecord(candidate)) {
        summary.skipped += 1;
        return;
      }
      parsedLine = candidate;
    } catch {
      summary.skipped += 1;
      return;
    }

    const rawUrl = ctx.getString(parsedLine['url']) ?? ctx.getString(parsedLine['input']);
    const normalizedUrl = ctx.normalizeOptionalToolText(rawUrl);
    if (!normalizedUrl) {
      summary.skipped += 1;
      return;
    }
    parsedRows += 1;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      summary.skipped += 1;
      return;
    }

    const host = ctx.normalizeArtifactHost(parsedUrl.hostname);
    const protocol = parsedUrl.protocol === 'https:' ? 'https' : parsedUrl.protocol === 'http:' ? 'http' : undefined;
    const port = ctx.normalizePort(parsedLine['port']) ?? ctx.normalizePort(parsedUrl.port) ?? (protocol === 'https' ? 443 : protocol === 'http' ? 80 : undefined);
    if (!host || !protocol || !port) {
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
    if (!seenServices.has(serviceKey)) {
      seenServices.add(serviceKey);
      const parsedWebserver = ctx.splitProductVersion(
        ctx.normalizeOptionalToolText(ctx.getString(parsedLine['webserver']) ?? ctx.getString(parsedLine['webServer'])) ?? '',
      );
      const serviceResult = await ctx.reportService({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        input: {
          assetRef,
          protocol,
          port,
          serviceName: protocol,
          ...(parsedWebserver.product ? { product: parsedWebserver.product } : {}),
          ...(parsedWebserver.version ? { version: parsedWebserver.version } : {}),
          versionReadMethod: 'http_banner',
          evidence,
        },
      });

      if (serviceResult.created) {
        summary.servicesCreated += 1;
      } else {
        summary.servicesTouched += 1;
      }
    }

    const method =
      ctx.normalizeOptionalToolText(ctx.getString(parsedLine['method']))?.toUpperCase() ??
      'GET';
    const endpointKey = `${method}:${normalizedUrl}`;
    if (!seenEndpoints.has(endpointKey)) {
      seenEndpoints.add(endpointKey);
      const endpointResult = await ctx.reportNote({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        input: {
          assetRef,
          ntype: 'http.endpoint',
          title: ctx.getString(parsedLine['title']),
          data: {
            url: normalizedUrl,
            method,
            ...(ctx.toNonNegativeInt(parsedLine['status_code']) !== undefined
              ? { statusCode: ctx.toNonNegativeInt(parsedLine['status_code']) }
              : {}),
            ...(ctx.getString(parsedLine['title']) ? { title: ctx.getString(parsedLine['title']) } : {}),
          },
          evidence: noteEvidence,
        },
      });

      if (endpointResult.created) {
        summary.endpointNotesCreated += 1;
      } else {
        summary.endpointNotesTouched += 1;
      }
    }

    for (const fingerprint of ctx.extractHttpxTechFingerprints(parsedLine)) {
      const techKey = `${assetRef.kind}:${assetRef.value}:${fingerprint.product.trim().toLowerCase()}`;
      if (seenTechs.has(techKey)) {
        continue;
      }
      seenTechs.add(techKey);

      const techResult = await ctx.reportNote({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        componentObservationSource: 'httpx',
        context: params.context,
        input: {
          assetRef,
          ntype: 'tech.fingerprint',
          data: {
            product: fingerprint.product,
            ...(fingerprint.version ? { version: fingerprint.version } : {}),
            ...(fingerprint.category ? { category: fingerprint.category } : {}),
            ...(fingerprint.confidence !== undefined ? { confidence: fingerprint.confidence } : {}),
          },
          ...(fingerprint.confidence !== undefined ? { confidence: fingerprint.confidence } : {}),
          evidence: noteEvidence,
        },
      });

      if (techResult.created) {
        summary.techNotesCreated += 1;
      } else {
        summary.techNotesTouched += 1;
      }
    }
  });

  if (parsedRows === 0 && summary.skipped > 0) {
    throw new Error(
      'ingest_scan_artifact(parser=httpx) did not find any valid JSONL records. Rerun httpx with -j or -json and ingest that artifact.',
    );
  }

  return summary;
};
