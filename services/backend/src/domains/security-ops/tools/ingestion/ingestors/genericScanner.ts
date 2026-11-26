import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerCodeLocation,
  ScannerEvidenceRef,
  ScannerIngestorParams,
  ScannerParsedInput,
  ScannerResolvedArtifact,
  ScannerSeverity,
} from '../types';

export type GenericScannerParser =
  | 'dalfox'
  | 'gitleaks'
  | 'trufflehog'
  | 'trivy'
  | 'semgrep'
  | 'sqlmap';

export type GenericScannerIngestorContext<TContext = unknown> = {
  createIngestSummary: (parser: GenericScannerParser, artifactPath: string) => IngestSummary;
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: ScannerParsedInput,
  ) => Promise<ScannerResolvedArtifact>;
  readArtifactJson: (artifact: ScannerResolvedArtifact) => Promise<unknown>;
  readArtifactJsonLines: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>[]>;
  readArtifactText: (artifact: ScannerResolvedArtifact) => Promise<string>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  toNonNegativeInt: (value: unknown) => number | undefined;
  stableStringify: (value: unknown) => string;
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
    parser: GenericScannerParser;
    artifactPath: string;
    assetRef?: ScannerAssetRef;
    observationType: string;
    title: string;
    severity?: ScannerSeverity;
    confidence?: number;
    dedupeParts: unknown[];
    data: Record<string, unknown>;
    evidence: ScannerEvidenceRef[];
  }) => Promise<{ created: boolean }>;
  reportScannerFinding: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    parser: GenericScannerParser;
    artifactPath: string;
    assetRef: ScannerAssetRef;
    title: string;
    severity: ScannerSeverity;
    summary: string;
    technicalAnalysis: string;
    cveIds?: string[];
    cweIds?: string[];
    confidence?: number;
    codeLocations?: ScannerCodeLocation[];
  }) => Promise<{ created: boolean }>;
  warn: (payload: Record<string, unknown>, message: string) => void;
};

export const expandGenericScannerRows = async (
  parser: GenericScannerParser,
  artifact: ScannerResolvedArtifact,
  ctx: Pick<
    GenericScannerIngestorContext,
    'readArtifactJson' | 'readArtifactJsonLines' | 'readArtifactText' | 'isRecord' | 'getString' | 'toNonNegativeInt'
  >,
): Promise<Record<string, unknown>[]> => {
  if (parser === 'trufflehog') {
    return ctx.readArtifactJsonLines(artifact);
  }
  if (parser === 'sqlmap') {
    const raw = await ctx.readArtifactText(artifact);
    if (!/vulnerable|parameter.+injectable|sql injection/iu.test(raw)) {
      return [];
    }
    return [{ title: 'SQL injection signal from sqlmap', severity: 'high', target: artifact.relativePath, outputPreview: raw.slice(0, 4000), cwe: ['CWE-89'] }];
  }
  const parsed = await ctx.readArtifactJson(artifact);
  if (parser === 'trivy' && ctx.isRecord(parsed)) {
    const rows: Record<string, unknown>[] = [];
    for (const result of Array.isArray(parsed['Results']) ? parsed['Results'] : []) {
      if (!ctx.isRecord(result)) continue;
      for (const vuln of Array.isArray(result['Vulnerabilities']) ? result['Vulnerabilities'] : []) {
        if (!ctx.isRecord(vuln)) continue;
        rows.push({
          ...vuln,
          title: ctx.getString(vuln['Title']) ?? ctx.getString(vuln['VulnerabilityID']) ?? 'Trivy vulnerability',
          severity: ctx.getString(vuln['Severity']),
          vulnerabilityID: ctx.getString(vuln['VulnerabilityID']),
          target: ctx.getString(result['Target']),
          cve: ctx.getString(vuln['VulnerabilityID']),
        });
      }
    }
    return rows;
  }
  if (parser === 'semgrep' && ctx.isRecord(parsed)) {
    const runs = Array.isArray(parsed['runs']) ? parsed['runs'] : [];
    const rows: Record<string, unknown>[] = [];
    for (const run of runs) {
      if (!ctx.isRecord(run)) continue;
      for (const result of Array.isArray(run['results']) ? run['results'] : []) {
        if (!ctx.isRecord(result)) continue;
        const location = Array.isArray(result['locations']) && ctx.isRecord(result['locations'][0]) ? result['locations'][0] : {};
        const physical = ctx.isRecord(location['physicalLocation']) ? location['physicalLocation'] : {};
        const artifactLocation = ctx.isRecord(physical['artifactLocation']) ? physical['artifactLocation'] : {};
        const region = ctx.isRecord(physical['region']) ? physical['region'] : {};
        rows.push({
          ...result,
          title: ctx.getString(result['message']) ?? ctx.getString(result['ruleId']) ?? 'Semgrep finding',
          severity: 'medium',
          ruleId: ctx.getString(result['ruleId']),
          file: ctx.getString(artifactLocation['uri']),
          startLine: ctx.toNonNegativeInt(region['startLine']),
          endLine: ctx.toNonNegativeInt(region['endLine']) ?? ctx.toNonNegativeInt(region['startLine']),
        });
      }
    }
    return rows;
  }
  if (Array.isArray(parsed)) {
    return parsed.filter(ctx.isRecord);
  }
  if (ctx.isRecord(parsed) && Array.isArray(parsed['results'])) {
    return parsed['results'].filter(ctx.isRecord);
  }
  if (ctx.isRecord(parsed) && Array.isArray(parsed['findings'])) {
    return parsed['findings'].filter(ctx.isRecord);
  }
  return ctx.isRecord(parsed) ? [parsed] : [];
};

export const extractCodeLocationsFromScannerRow = (
  parser: string,
  row: Record<string, unknown>,
  ctx: Pick<GenericScannerIngestorContext, 'getString' | 'toNonNegativeInt'>,
): ScannerCodeLocation[] | undefined => {
  if (parser !== 'semgrep') {
    return undefined;
  }
  const filePath = ctx.getString(row['file']);
  const startLine = ctx.toNonNegativeInt(row['startLine']);
  const endLine = ctx.toNonNegativeInt(row['endLine']) ?? startLine;
  if (!filePath || !startLine || !endLine) {
    return undefined;
  }
  return [{
    pathKind: 'workspace',
    filePath,
    startLine,
    endLine,
    label: ctx.getString(row['ruleId']) ?? 'semgrep',
    fixBefore: 'See scanner artifact for vulnerable code context.',
    fixAfter: 'Apply the remediation recommended for this rule and rerun Semgrep.',
  }];
};

export const ingestGenericScannerFindings = async <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext> & { parser: GenericScannerParser },
  ctx: GenericScannerIngestorContext<TContext>,
): Promise<IngestSummary> => {
  const artifact = await ctx.resolveScannerArtifactPath(params.workspaceDir, params.parsed);
  const summary = ctx.createIngestSummary(params.parser, artifact.relativePath);
  const evidence: ScannerEvidenceRef[] = [{ path: artifact.relativePath, label: `${params.parser} artifact` }];
  const rows = await expandGenericScannerRows(params.parser, artifact, ctx);

  for (const row of rows) {
    try {
      const networkTarget =
        ctx.getString(row['url']) ??
        ctx.getString(row['host']) ??
        (params.parser === 'dalfox' ? ctx.getString(row['target']) : undefined);
      const target =
        networkTarget ??
        ctx.getString(row['target']) ??
        ctx.getString(row['file']) ??
        ctx.getString(row['path']) ??
        params.parsed.rootAssetRef?.value;
      const assetRef = networkTarget
        ? ctx.assetRefFromScannerValue(networkTarget, params.parsed.rootAssetRef)
        : params.parsed.rootAssetRef;
      if (!assetRef) {
        summary.skipped += 1;
        continue;
      }
      const title =
        ctx.normalizeOptionalToolText(
          ctx.getString(row['title']) ??
          ctx.getString(row['name']) ??
          ctx.getString(row['ruleId']) ??
          ctx.getString(row['rule_id']) ??
          ctx.getString(row['id']),
        ) ?? `${params.parser} scanner signal`;
      const severity = ctx.normalizeScannerSeverity(row['severity']);
      const cveIds = ctx.extractScannerCveIds(row['cveIds'] ?? row['cve'] ?? row['vulnerabilityID']);
      const cweIds = ctx.extractScannerCweIds(row['cweIds'] ?? row['cwe']);
      const confidence = typeof row['confidence'] === 'number' ? row['confidence'] as number : severity === 'info' ? 0.45 : 0.6;
      const observation = await ctx.recordScannerObservation({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId: params.sessionId,
        context: params.context,
        parser: params.parser,
        artifactPath: artifact.relativePath,
        assetRef,
        observationType: 'vulnerability',
        title,
        severity,
        confidence,
        dedupeParts: [params.parser, title, target, row['ruleId'], row['vulnerabilityID']],
        data: row,
        evidence,
      });
      if (observation.created) summary.observationsCreated += 1; else summary.observationsTouched += 1;
      if (severity !== 'info' || params.parser === 'gitleaks' || params.parser === 'trufflehog') {
        const finding = await ctx.reportScannerFinding({
          userId: params.userId,
          workspaceDir: params.workspaceDir,
          sessionId: params.sessionId,
          context: params.context,
          parser: params.parser,
          artifactPath: artifact.relativePath,
          assetRef,
          title,
          severity: severity === 'info' ? 'low' : severity,
          summary: `${title} was produced by ${params.parser}.`,
          technicalAnalysis: ctx.stableStringify(row).slice(0, 4000),
          cveIds,
          cweIds,
          confidence: Math.max(0.5, confidence),
          codeLocations: extractCodeLocationsFromScannerRow(params.parser, row, ctx),
        });
        if (finding.created) summary.findingsCreated += 1; else summary.findingsTouched += 1;
      }
    } catch (error) {
      ctx.warn({ err: error, parser: params.parser }, '[security-ops] Skipped scanner ingest row');
      summary.skipped += 1;
    }
  }
  return summary;
};
