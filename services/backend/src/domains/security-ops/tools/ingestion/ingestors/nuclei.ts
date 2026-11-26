import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
  ScannerSeverity,
} from '../types';

export type NucleiIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: 'nuclei', artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readArtifactJsonLines: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>[]>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  assetRefFromScannerValue: (
    value: unknown,
    fallback?: ScannerAssetRef,
  ) => ScannerAssetRef | undefined;
  normalizeScannerSeverity: (value: unknown) => ScannerSeverity;
  extractScannerCveIds: (value: unknown) => string[];
  extractScannerCweIds: (value: unknown) => string[];
  recordScannerObservation: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    parser: 'nuclei';
    artifactPath: string;
    assetRef: ScannerAssetRef;
    observationType: string;
    title: string;
    severity: ScannerSeverity;
    confidence: number;
    dedupeParts: unknown[];
    data: Record<string, unknown>;
    evidence: ScannerEvidenceRef[];
  }) => Promise<{ created: boolean }>;
  reportScannerFinding: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    parser: 'nuclei';
    artifactPath: string;
    assetRef: ScannerAssetRef;
    title: string;
    severity: ScannerSeverity;
    summary: string;
    technicalAnalysis: string;
    cveIds: string[];
    cweIds: string[];
    confidence: number;
  }) => Promise<{ created: boolean }>;
  warn: (payload: Record<string, unknown>, message: string) => void;
};

export const ingestNucleiArtifact = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: NucleiIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary('nuclei', artifact.relativePath);
  const rows = await ctx.readArtifactJsonLines(artifact);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: 'nuclei artifact' }];

  for (const row of rows) {
    try {
      const info = ctx.isRecord(row['info']) ? row['info'] : {};
      const target =
        ctx.getString(row['matched-at']) ??
        ctx.getString(row['host']) ??
        ctx.getString(row['url']) ??
        ctx.getString(row['ip']);
      const assetRef = ctx.assetRefFromScannerValue(target, params.parsed.rootAssetRef);
      if (!assetRef) {
        summary.skipped += 1;
        continue;
      }
      const templateId = ctx.getString(row['template-id']) ?? ctx.getString(row['templateID']) ?? 'nuclei-template';
      const title = ctx.normalizeOptionalToolText(ctx.getString(info['name']) ?? ctx.getString(row['name'])) ?? templateId;
      const severity = ctx.normalizeScannerSeverity(info['severity']);
      const classification = ctx.isRecord(info['classification']) ? info['classification'] : {};
      const cveIds = ctx.extractScannerCveIds(classification['cve-id'] ?? classification['cve']);
      const cweIds = ctx.extractScannerCweIds(classification['cwe-id'] ?? classification['cwe']);
      const observation = await ctx.recordScannerObservation({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        parser: 'nuclei',
        artifactPath: artifact.relativePath,
        assetRef,
        observationType: 'vulnerability',
        title,
        severity,
        confidence: severity === 'info' ? 0.4 : 0.7,
        dedupeParts: ['nuclei', templateId, target],
        data: row,
        evidence,
      });
      if (observation.created) summary.observationsCreated += 1; else summary.observationsTouched += 1;
      if (severity !== 'info') {
        const finding = await ctx.reportScannerFinding({
          userId: params.userId,
          workspaceDir: params.workspaceDir,
          sessionId: params.sessionId,
          context: params.context,
          parser: 'nuclei',
          artifactPath: artifact.relativePath,
          assetRef,
          title,
          severity,
          summary: `${title} was reported by nuclei template ${templateId}.`,
          technicalAnalysis: `Nuclei matched template ${templateId} against ${target ?? assetRef.value}. Reproduce before promotion.`,
          cveIds,
          cweIds,
          confidence: 0.6,
        });
        if (finding.created) summary.findingsCreated += 1; else summary.findingsTouched += 1;
      }
    } catch (error) {
      ctx.warn({ err: error }, '[security-ops] Skipped nuclei ingest row');
      summary.skipped += 1;
    }
  }
  return summary;
};
