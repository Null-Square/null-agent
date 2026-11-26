import * as fs from 'fs/promises';
import { z } from 'zod';

import { AssetRefSchema } from '@/domains/security-ops/assets/AssetReportingService';
import { ScannerIngestorRegistry } from '@/domains/security-ops/tools/ingestion/ScannerIngestorRegistry';
import { ingestDalfoxArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/dalfox';
import { ingestFfufArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/ffuf';
import { ingestGitleaksArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/gitleaks';
import { ingestHttpxArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/httpx';
import { ingestKatanaArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/katana';
import { ingestNaabuArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/naabu';
import { ingestNmapArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/nmap';
import { ingestNucleiArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/nuclei';
import { ingestOpenApiArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/openapi';
import { ingestSemgrepArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/semgrep';
import { ingestSqlmapArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/sqlmap';
import { ingestSubfinderArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/subfinder';
import { ingestTrivyArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/trivy';
import { ingestTrufflehogArtifact } from '@/domains/security-ops/tools/ingestion/ingestors/trufflehog';
import type {
  IngestSummary,
  ScannerAssetRef,
  ScannerCodeLocation,
  ScannerEvidenceRef,
  ScannerParsedInput,
  ScannerResolvedArtifact,
  ScannerSeverity,
} from '@/domains/security-ops/tools/ingestion/types';

export const INGEST_SCAN_ARTIFACT_PARSERS = [
  'subfinder',
  'naabu',
  'httpx',
  'nuclei',
  'sqlmap',
  'dalfox',
  'katana',
  'ffuf',
  'openapi',
  'nmap',
  'gitleaks',
  'trufflehog',
  'trivy',
  'semgrep',
] as const;

export type IngestScanArtifactParser = (typeof INGEST_SCAN_ARTIFACT_PARSERS)[number];

const IngestScanArtifactParserSchema = z.enum(INGEST_SCAN_ARTIFACT_PARSERS);
export const IngestScanArtifactSchema = z.object({
  parser: IngestScanArtifactParserSchema,
  artifactPath: z.string().min(1).optional(),
  rootAssetRef: AssetRefSchema.optional(),
  partial: z.boolean().optional().default(false),
});
export type IngestScanArtifactInput = z.infer<typeof IngestScanArtifactSchema>;
export type SecurityOpsIngestSummary = IngestSummary<IngestScanArtifactParser>;

const OPENAPI_VALIDATION_LEAD_CAP = 80;
const FFUF_NOISY_CLUSTER_MIN_SIZE = 8;
const FFUF_NOISY_CLUSTER_RATIO = 0.6;

const createIngestSummary = (
  parser: IngestScanArtifactParser,
  artifactPath: string,
): SecurityOpsIngestSummary => ({
  parser,
  artifactPath,
  assetsCreated: 0,
  assetsTouched: 0,
  servicesCreated: 0,
  servicesTouched: 0,
  subdomainNotesCreated: 0,
  subdomainNotesTouched: 0,
  endpointNotesCreated: 0,
  endpointNotesTouched: 0,
  techNotesCreated: 0,
  techNotesTouched: 0,
  observationsCreated: 0,
  observationsTouched: 0,
  findingsCreated: 0,
  findingsTouched: 0,
  skipped: 0,
  suppressed: 0,
  duplicates: 0,
  noise: {},
});

const incrementIngestNoise = (summary: SecurityOpsIngestSummary, reason: string): void => {
  summary.suppressed += 1;
  summary.noise[reason] = (summary.noise[reason] ?? 0) + 1;
};

type ScannerIngestionContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  activePhaseKey?: string;
  complianceReport?: {
    framework?: string;
    source?: string;
    sourceRunId?: string;
  };
};

type ScannerObservationParams<TContext> = {
  userId: string;
  workspaceDir: string;
  sessionId?: string;
  context?: TContext;
  parser: IngestScanArtifactParser;
  artifactPath: string;
  assetRef?: ScannerAssetRef;
  observationType: string;
  title: string;
  severity?: ScannerSeverity;
  confidence?: number;
  dedupeParts: unknown[];
  data: Record<string, unknown>;
  evidence: ScannerEvidenceRef[];
};

type ScannerFindingParams<TContext> = {
  userId: string;
  workspaceDir: string;
  sessionId?: string;
  context?: TContext;
  parser: IngestScanArtifactParser;
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
};

type OpenApiParameter = {
  name: string;
  in?: string;
};

type ScannerArtifactIngestionOptions<TContext> = {
  resolveScannerArtifactPath: (
    workspaceDir: string,
    parsed: Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
  ) => Promise<ScannerResolvedArtifact>;
  forEachArtifactLine: (
    artifact: ScannerResolvedArtifact,
    onLine: (line: string, lineNumber: number) => Promise<void>,
  ) => Promise<void>;
  readArtifactJson: (artifact: ScannerResolvedArtifact) => Promise<unknown>;
  readArtifactJsonLines: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>[]>;
  readOpenApiDocument: (artifact: ScannerResolvedArtifact) => Promise<Record<string, unknown>>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getString: (value: unknown) => string | undefined;
  normalizeOptionalToolText: (value: string | undefined) => string | undefined;
  toNonNegativeInt: (value: unknown) => number | undefined;
  stableStringify: (value: unknown) => string;
  normalizeArtifactHost: (rawValue: string | undefined) => string | undefined;
  normalizePort: (value: unknown) => number | undefined;
  parseHostPortLine: (line: string) => { host: string; port: number } | undefined;
  detectAssetKind: (value: string) => ScannerAssetRef['kind'];
  splitProductVersion: (rawValue: string) => { product: string; version?: string };
  extractHttpxTechFingerprints: (value: Record<string, unknown>) => Array<{
    product: string;
    version?: string;
    category?: string;
    confidence?: number;
  }>;
  normalizeFfufEndpointUrl: (rawUrl: string | undefined) => {
    url: string;
    dedupeKey: string;
    pathname: string;
  } | undefined;
  ffufResponseSignature: (entry: Record<string, unknown>) => string;
  isHighSignalFfufPath: (pathname: string) => boolean;
  assetRefFromScannerValue: (
    value: unknown,
    fallback?: ScannerAssetRef,
  ) => ScannerAssetRef | undefined;
  normalizeScannerSeverity: (value: unknown) => ScannerSeverity;
  extractScannerCveIds: (value: unknown) => string[];
  extractScannerCweIds: (value: unknown) => string[];
  resolveCandidateParentAsset: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    hostname: string;
    rootAssetRef?: ScannerAssetRef;
  }) => Promise<{ assetRef: ScannerAssetRef; created: boolean } | null>;
  ensureIngestedAsset: (params: {
    summary: SecurityOpsIngestSummary;
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
  recordScannerObservation: (params: ScannerObservationParams<TContext>) => Promise<{ created: boolean }>;
  reportScannerFinding: (params: ScannerFindingParams<TContext>) => Promise<{ created: boolean }>;
  resolveOpenApiBaseUrl: (
    document: Record<string, unknown>,
    rootAssetRef?: ScannerAssetRef,
  ) => string | undefined;
  extractOpenApiParameters: (value: unknown) => OpenApiParameter[];
  extractOpenApiBodyParams: (operation: Record<string, unknown>) => string[];
  buildOpenApiEndpointUrl: (baseUrl: string | undefined, routePath: string) => string;
  extractOpenApiStringArray: (value: unknown) => string[];
  describeOpenApiAuthHint: (
    document: Record<string, unknown>,
    operation: Record<string, unknown>,
  ) => string;
  deriveOpenApiValidationLeads: (params: {
    document: Record<string, unknown>;
    operation: Record<string, unknown>;
    method: string;
    routePath: string;
    endpointUrl: string;
    parameters: OpenApiParameter[];
    bodyParams: string[];
    artifactPath: string;
  }) => Array<Record<string, unknown>>;
  warn: (payload: Record<string, unknown>, message: string) => void;
};

export class ScannerArtifactIngestionService<TContext extends ScannerIngestionContext = ScannerIngestionContext> {
  constructor(private readonly options: ScannerArtifactIngestionOptions<TContext>) {}

  async ingestScanArtifact(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: TContext;
    input: unknown;
  }): Promise<SecurityOpsIngestSummary> {
    const parsed = IngestScanArtifactSchema.parse(params.input);
    const withPartialFlag = (summary: SecurityOpsIngestSummary): SecurityOpsIngestSummary =>
      parsed.partial ? { ...summary, partial: true } : summary;
    const genericScannerContext = {
      createIngestSummary,
      resolveScannerArtifactPath: (workspaceDir: string, parsedInput: ScannerParsedInput) =>
        this.options.resolveScannerArtifactPath(
          workspaceDir,
          parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
        ),
      readArtifactJson: (artifact: ScannerResolvedArtifact) => this.options.readArtifactJson(artifact),
      readArtifactJsonLines: (artifact: ScannerResolvedArtifact) => this.options.readArtifactJsonLines(artifact),
      readArtifactText: (artifact: ScannerResolvedArtifact) => fs.readFile(artifact.absolutePath, 'utf8'),
      isRecord: this.options.isRecord,
      getString: this.options.getString,
      normalizeOptionalToolText: this.options.normalizeOptionalToolText,
      toNonNegativeInt: this.options.toNonNegativeInt,
      stableStringify: this.options.stableStringify,
      assetRefFromScannerValue: this.options.assetRefFromScannerValue,
      normalizeScannerSeverity: this.options.normalizeScannerSeverity,
      extractScannerCveIds: this.options.extractScannerCveIds,
      extractScannerCweIds: this.options.extractScannerCweIds,
      recordScannerObservation: this.options.recordScannerObservation,
      reportScannerFinding: this.options.reportScannerFinding,
      warn: this.options.warn,
    };

    const registry = new ScannerIngestorRegistry<
      IngestScanArtifactParser,
      IngestScanArtifactInput,
      SecurityOpsIngestSummary,
      TContext
    >({
      subfinder: (ingestParams) => ingestSubfinderArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        forEachArtifactLine: this.options.forEachArtifactLine,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        normalizeArtifactHost: this.options.normalizeArtifactHost,
        resolveCandidateParentAsset: this.options.resolveCandidateParentAsset,
        reportNote: this.options.reportNote,
      }),
      naabu: (ingestParams) => ingestNaabuArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        forEachArtifactLine: this.options.forEachArtifactLine,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        normalizeArtifactHost: this.options.normalizeArtifactHost,
        normalizePort: this.options.normalizePort,
        normalizeOptionalToolText: this.options.normalizeOptionalToolText,
        parseHostPortLine: this.options.parseHostPortLine,
        detectAssetKind: this.options.detectAssetKind,
        ensureIngestedAsset: this.options.ensureIngestedAsset,
        reportService: this.options.reportService,
      }),
      httpx: (ingestParams) => ingestHttpxArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        forEachArtifactLine: this.options.forEachArtifactLine,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        normalizeOptionalToolText: this.options.normalizeOptionalToolText,
        normalizeArtifactHost: this.options.normalizeArtifactHost,
        normalizePort: this.options.normalizePort,
        toNonNegativeInt: this.options.toNonNegativeInt,
        detectAssetKind: this.options.detectAssetKind,
        splitProductVersion: this.options.splitProductVersion,
        extractHttpxTechFingerprints: this.options.extractHttpxTechFingerprints,
        ensureIngestedAsset: this.options.ensureIngestedAsset,
        reportService: this.options.reportService,
        reportNote: this.options.reportNote,
      }),
      nuclei: (ingestParams) => ingestNucleiArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        readArtifactJsonLines: this.options.readArtifactJsonLines,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        normalizeOptionalToolText: this.options.normalizeOptionalToolText,
        assetRefFromScannerValue: this.options.assetRefFromScannerValue,
        normalizeScannerSeverity: this.options.normalizeScannerSeverity,
        extractScannerCveIds: this.options.extractScannerCveIds,
        extractScannerCweIds: this.options.extractScannerCweIds,
        recordScannerObservation: this.options.recordScannerObservation,
        reportScannerFinding: this.options.reportScannerFinding,
        warn: this.options.warn,
      }),
      katana: (ingestParams) => ingestKatanaArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        readArtifactJsonLines: this.options.readArtifactJsonLines,
        getString: this.options.getString,
        normalizeOptionalToolText: this.options.normalizeOptionalToolText,
        assetRefFromScannerValue: this.options.assetRefFromScannerValue,
        reportNote: this.options.reportNote,
      }),
      ffuf: (ingestParams) => ingestFfufArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        readArtifactJson: this.options.readArtifactJson,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        toNonNegativeInt: this.options.toNonNegativeInt,
        normalizeFfufEndpointUrl: this.options.normalizeFfufEndpointUrl,
        ffufResponseSignature: this.options.ffufResponseSignature,
        isHighSignalFfufPath: this.options.isHighSignalFfufPath,
        incrementIngestNoise,
        noisyClusterMinSize: FFUF_NOISY_CLUSTER_MIN_SIZE,
        noisyClusterRatio: FFUF_NOISY_CLUSTER_RATIO,
        assetRefFromScannerValue: this.options.assetRefFromScannerValue,
        reportNote: this.options.reportNote,
      }),
      openapi: (ingestParams) => ingestOpenApiArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        readOpenApiDocument: this.options.readOpenApiDocument,
        isRecord: this.options.isRecord,
        getString: this.options.getString,
        resolveOpenApiBaseUrl: this.options.resolveOpenApiBaseUrl,
        extractOpenApiParameters: this.options.extractOpenApiParameters,
        extractOpenApiBodyParams: this.options.extractOpenApiBodyParams,
        buildOpenApiEndpointUrl: this.options.buildOpenApiEndpointUrl,
        assetRefFromScannerValue: this.options.assetRefFromScannerValue,
        extractOpenApiStringArray: this.options.extractOpenApiStringArray,
        describeOpenApiAuthHint: this.options.describeOpenApiAuthHint,
        deriveOpenApiValidationLeads: this.options.deriveOpenApiValidationLeads,
        validationLeadCap: OPENAPI_VALIDATION_LEAD_CAP,
        reportNote: this.options.reportNote,
      }),
      nmap: (ingestParams) => ingestNmapArtifact(ingestParams, {
        createIngestSummary,
        resolveScannerArtifactPath: (workspaceDir, parsedInput) =>
          this.options.resolveScannerArtifactPath(
            workspaceDir,
            parsedInput as Pick<IngestScanArtifactInput, 'parser' | 'artifactPath'>,
          ),
        readArtifactText: (artifact) => fs.readFile(artifact.absolutePath, 'utf8'),
        normalizeArtifactHost: this.options.normalizeArtifactHost,
        normalizePort: this.options.normalizePort,
        detectAssetKind: this.options.detectAssetKind,
        ensureIngestedAsset: this.options.ensureIngestedAsset,
        reportService: this.options.reportService,
      }),
      dalfox: (ingestParams) => ingestDalfoxArtifact(ingestParams, genericScannerContext),
      gitleaks: (ingestParams) => ingestGitleaksArtifact(ingestParams, genericScannerContext),
      trufflehog: (ingestParams) => ingestTrufflehogArtifact(ingestParams, genericScannerContext),
      trivy: (ingestParams) => ingestTrivyArtifact(ingestParams, genericScannerContext),
      semgrep: (ingestParams) => ingestSemgrepArtifact(ingestParams, genericScannerContext),
      sqlmap: (ingestParams) => ingestSqlmapArtifact(ingestParams, genericScannerContext),
    });

    const ingestor = registry.get(parsed.parser);
    if (!ingestor) {
      throw new Error(`Unsupported scanner parser: ${parsed.parser}`);
    }

    return withPartialFlag(await ingestor({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      parsed,
    }));
  }
}
