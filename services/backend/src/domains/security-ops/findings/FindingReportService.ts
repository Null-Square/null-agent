import { findReportingSeverityEscalation } from './severityCalibration';
import { createHash } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import { findingEvents, findingEvidence, findings, inventoryNotes, inventoryServices, type RiskState } from '@/db/schema';
import { type AssetKindSchema, AssetRefSchema, type AssetRef } from '@/domains/security-ops/assets/AssetReportingService';
import type {
  EndpointLocation,
  InventoryProjection
} from '@/domains/security-ops/assets/InventoryProjection';
import type { FindingCodeLocation } from '@/domains/security-ops/findings/findingContracts';
import {
  buildFindingReportCompleteness,
  type FindingReportCompleteness,
} from '@/domains/security-ops/findings/findingReportCompleteness';
import { calculateCvss } from '@/domains/security-ops/tools/cvss';
import { deriveOwaspCategory, normalizeCveIds, normalizeCweId, normalizeCweIds } from '@/domains/security-ops/tools/cweOwasp';
import { buildCodeLocationKey, type ResolvedFindingEvidence } from '@/domains/security-ops/tools/evidence/EvidenceResolver';
import type {
  FindingDuplicateDecision,
  FindingDuplicateJudge,
  FindingDuplicateReport,
} from '@/domains/security-ops/tools/FindingDuplicateJudge';
import { isReportableRiskState } from '@/domains/security-ops/risks/riskLifecycle';
import type { TurnExecutorPort } from '@/domains/agent-brain/ports';

const EvidenceRefSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).optional(),
});

const EvidenceWithExcerptSchema = EvidenceRefSchema.extend({
  excerpt: z.string().min(1).optional(),
});

const HttpHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  redacted: z.boolean().optional(),
});

const HttpRequestEvidenceSchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  contentType: z.string().min(1).optional(),
  headers: z.array(HttpHeaderSchema).optional(),
  body: z.string().optional(),
});

const HttpResponseEvidenceSchema = z.object({
  statusCode: z.number().int(),
  contentType: z.string().min(1).optional(),
  headers: z.array(HttpHeaderSchema).optional(),
  body: z.string().optional(),
});

export const HttpExchangeEvidenceSchema = z.object({
  kind: z.literal('http_exchange'),
  label: z.string().min(1).optional(),
  source: z.enum(['browser', 'request_tool', 'manual', 'unknown']).optional(),
  durationMs: z.number().finite().min(0).optional(),
  request: HttpRequestEvidenceSchema,
  response: HttpResponseEvidenceSchema,
});

export const FindingCodeLocationSchema = z.object({
  pathKind: z.enum(['repository', 'workspace']),
  repository: z.string().min(1).nullable().optional(),
  ref: z.string().min(1).nullable().optional(),
  filePath: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  label: z.string().min(1).nullable().optional(),
  fixBefore: z.string().min(1),
  fixAfter: z.string().min(1),
});

export const FindingEvidenceInputSchema = z.union([EvidenceWithExcerptSchema, HttpExchangeEvidenceSchema]);

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const FixEffortSchema = z.enum(['trivial', 'low', 'medium', 'high']);
const CvssMetricsSchema = z.object({
  attackVector: z.enum(['N', 'A', 'L', 'P']),
  attackComplexity: z.enum(['L', 'H']),
  privilegesRequired: z.enum(['N', 'L', 'H']),
  userInteraction: z.enum(['N', 'R']),
  scope: z.enum(['U', 'C']),
  confidentiality: z.enum(['N', 'L', 'H']),
  integrity: z.enum(['N', 'L', 'H']),
  availability: z.enum(['N', 'L', 'H']),
});
const SignalClassSchema = z.enum([
  'sensitive-content-disclosure',
  'id-variance-with-pii',
  'id-variance-without-pii',
  'open-redirect-accepted',
  'user-enum-confirmed',
  'user-enum-undifferentiated',
  'auth-tamper-accepted',
  'framework-leak',
  'header-tamper-accepted',
  'method-tamper-accepted',
  'mass-assignment-accepted',
  'unauthenticated-state-change',
  'response-variance',
  'waf-detected',
  'other',
]);
const DifferentialObservationSchema = z.object({
  parameter: z.string().min(1),
  baselineValue: z.union([z.string(), z.number(), z.null()]).optional(),
  observedValue: z.union([z.string(), z.number(), z.null()]),
  signal: z.enum(['status', 'body_length', 'body_diff', 'response_time', 'headers', 'set']),
  delta: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

export const ReportFindingSchema = z.object({
  assetRef: AssetRefSchema,
  title: z.string().min(1),
  severity: SeveritySchema,
  summary: z.string().min(1),
  businessImpact: z.string().min(1).optional(),
  technicalAnalysis: z.string().min(1).optional(),
  pocDescription: z.string().min(1).optional(),
  pocScriptCode: z.string().min(1).optional(),
  assumptions: z.string().min(1).optional(),
  fixEffort: FixEffortSchema.optional(),
  remediation: z.string().min(1).optional(),
  cvss: CvssMetricsSchema.optional(),
  cweId: z.string().min(1).optional(),
  cveId: z.string().min(1).optional(),
  cweIds: z.array(z.string().min(1)).optional(),
  cveIds: z.array(z.string().min(1)).optional(),
  owaspCategory: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(FindingEvidenceInputSchema).min(1),
  codeLocations: z.array(FindingCodeLocationSchema).optional(),
  endpointRef: z.string().uuid().optional(),
  serviceRef: z.string().uuid().optional(),
  validatesFindingId: z.string().uuid().optional(),
  signalClass: SignalClassSchema.optional(),
  hypothesis: z.string().min(1).optional(),
  differentialEvidence: z.array(DifferentialObservationSchema).optional(),
  observationLeadId: z.string().uuid().optional(),
});

export type FindingSeverity = z.infer<typeof SeveritySchema>;
export type StructuredHttpEvidenceInput = z.infer<typeof HttpExchangeEvidenceSchema>;
export type FindingCodeLocationInput = z.infer<typeof FindingCodeLocationSchema>;
export type ReportFindingEvidenceInput = z.infer<typeof FindingEvidenceInputSchema>;

export type FindingDedupeKeyParts = {
  target: string;
  surface: string;
  vulnerabilityClass: string;
};

export type FindingDedupeMatchSource =
  | 'created'
  | 'explicit_validates_finding'
  | 'exact_key'
  | 'legacy_key'
  | 'structural_match'
  | 'llm_judge';

export type ReportFindingResult = {
  findingId: string;
  created: boolean;
  dedupeKey: string;
  dedupe: {
    key: string;
    legacyKey?: string;
    parts: FindingDedupeKeyParts;
    matchedBy: FindingDedupeMatchSource;
    mergedFindingId?: string;
  };
  warnings?: string[];
  state: RiskState;
  lifecycleStage: 'candidate' | 'reportable';
  evidenceGate: { requirements: string[]; passed: boolean; missing: string[] };
  reportCompleteness: FindingReportCompleteness;
};

export type FindingReportContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  activePhaseKey?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = DatabaseClient | any;

type FindingKeyInput = {
  assetId: string;
  scopeId: string;
  assetKind: z.infer<typeof AssetKindSchema>;
  assetValue: string;
  title: string;
  endpoint?: EndpointLocation;
  endpointId?: string;
  serviceId?: string;
  cweIds?: string[];
  cveIds?: string[];
  owaspCategory?: string;
};

type FindingReportServiceOptions = {
  now: () => Date;
  normalizeSessionId: (raw: string | undefined) => string | undefined;
  normalizeAssetValue: (kind: z.infer<typeof AssetKindSchema>, rawValue: string) => string;
  resolveFindingEvidenceEntries: (
    workspaceDir: string,
    evidence: ReportFindingEvidenceInput[],
  ) => Promise<ResolvedFindingEvidence[]>;
  normalizeFindingCodeLocations: (params: {
    workspaceDir: string;
    context?: FindingReportContext;
    codeLocations?: FindingCodeLocationInput[];
  }) => Promise<FindingCodeLocation[]>;
  upsertAsset: (params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: FindingReportContext;
    input: {
      kind: AssetRef['kind'];
      value: string;
    };
    executor?: DbExecutor;
  }) => Promise<{ assetId: string; created: boolean }>;
  incrementRunCounter: (
    runId: string | undefined,
    counter: 'inventoryAdded' | 'findingsCount',
    executor?: DbExecutor,
  ) => Promise<void>;
  emitSecurityOpsEvent: (
    organizationId: string | undefined,
    event: {
      type: 'finding_created' | 'asset_discovered';
      payload: Record<string, unknown>;
      summary: string;
    },
  ) => Promise<void>;
  inventoryProjection: Pick<InventoryProjection, 'queryDuplicateCandidateRows' | 'loadEndpointLocationsByIds'>;
  duplicateJudge?: FindingDuplicateJudge;
};

const normalizeToolText = (value: string): string => value.trim();
const normalizeOptionalToolText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeToolText(value);
  return normalized.length > 0 ? normalized : undefined;
};

export const hasDurableFindingEvidence = (evidence: ResolvedFindingEvidence[]): boolean =>
  evidence.some((entry) => entry.kind === 'http_exchange' || (entry.kind === 'artifact' && entry.fileMissing !== true));

const mergeStringSet = (existing: string[] | null | undefined, incoming: string[] | null | undefined): string[] => {
  const set = new Set<string>();
  for (const value of existing ?? []) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v) set.add(v);
  }
  for (const value of incoming ?? []) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v) set.add(v);
  }
  return Array.from(set);
};

const severityRank: Record<FindingSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const pickHigherSeverity = (existing: string, incoming: FindingSeverity): FindingSeverity =>
  severityRank[incoming] > (severityRank[existing as FindingSeverity] ?? 0)
    ? incoming
    : (existing as FindingSeverity);

/**
 * Reporting may complete prose and classification metadata, but it may not
 * reclassify a Risk that validation already settled. A real severity change
 * belongs in validation with fresh evidence, not in report drafting.
 */
export const assertReportingClassificationStable = (params: {
  existingSeverity: string;
  incomingSeverity: FindingSeverity;
  calculatedCvssSeverity?: FindingSeverity;
}): void => {
  const existingSeverity = params.existingSeverity as FindingSeverity;
  if (params.incomingSeverity !== existingSeverity) {
    throw new Error(
      `report_finding in the reporting phase cannot change validated severity from ${existingSeverity} to ${params.incomingSeverity}. ` +
        'Return the Risk to validation with fresh evidence if its severity must change.',
    );
  }
  if (params.calculatedCvssSeverity && params.calculatedCvssSeverity !== existingSeverity) {
    throw new Error(
      `report_finding in the reporting phase cannot attach CVSS severity ${params.calculatedCvssSeverity} to a validated ${existingSeverity} Risk. ` +
        'Use a CVSS vector that agrees with validated severity, omit CVSS, or return the Risk to validation.',
    );
  }
};

const preferExistingText = (existing: string | null | undefined, incoming: string | undefined): string | undefined =>
  normalizeOptionalToolText(existing ?? undefined) ?? normalizeOptionalToolText(incoming);

const preferExistingNumber = (existing: number | null | undefined, incoming: number | undefined): number | undefined =>
  existing ?? incoming;

const preferHigherConfidence = (existing: number | null | undefined, incoming: number | undefined): number | undefined => {
  if (existing == null) return incoming;
  if (incoming == null) return existing;
  return Math.max(existing, incoming);
};

const mergeCodeLocations = (
  existing: FindingCodeLocation[] | null | undefined,
  incoming: FindingCodeLocation[] | null | undefined,
): FindingCodeLocation[] => {
  const merged = new Map<string, FindingCodeLocation>();
  for (const location of existing ?? []) {
    merged.set(buildCodeLocationKey(location), location);
  }
  for (const location of incoming ?? []) {
    const key = buildCodeLocationKey(location);
    if (!merged.has(key)) {
      merged.set(key, location);
    }
  }
  return Array.from(merged.values());
};

const normalizeDedupePart = (value: string | null | undefined): string => {
  const normalized = normalizeOptionalToolText(value ?? undefined)?.toLowerCase();
  return normalized ?? '';
};

const canonicalFindingTarget = (input: {
  scopeId: string;
  assetKind: z.infer<typeof AssetKindSchema> | string;
  assetValue: string;
}): string => [
  input.scopeId,
  input.assetKind,
  normalizeDedupePart(input.assetValue),
].join(':');

const normalizeFindingClass = (input: {
  title: string;
  cweIds?: string[] | null;
  cweId?: string | null;
  cveIds?: string[] | null;
  cveId?: string | null;
  owaspCategory?: string | null;
}): string =>
  normalizeDedupePart(input.cweIds?.[0]) ||
  normalizeDedupePart(input.cweId) ||
  normalizeDedupePart(input.cveIds?.[0]) ||
  normalizeDedupePart(input.cveId) ||
  normalizeDedupePart(input.owaspCategory) ||
  normalizeDedupePart(input.title);

const normalizeFindingTitleFamily = (title: string): string => {
  const normalized = normalizeDedupePart(title);
  const families: Array<[RegExp, string]> = [
    [/\b(?:xss|cross\s*site\s*scripting|script)\b/u, 'xss'],
    [/\b(?:ssrf|server\s*side\s*request\s*forgery)\b/u, 'ssrf'],
    [/\b(?:sqli|sql\s*injection)\b/u, 'sql-injection'],
    [/\b(?:idor|object\s*reference|tenant|authorization|access\s*control)\b/u, 'access-control'],
    [/\b(?:csrf|cross\s*site\s*request\s*forgery)\b/u, 'csrf'],
    [/\b(?:open\s*redirect|redirect)\b/u, 'open-redirect'],
    [/\b(?:security\s*headers?|csp|hsts|x-frame-options)\b/u, 'security-headers'],
    [/\b(?:wordpress|wp-)\b/u, 'wordpress'],
    [/\b(?:grafana)\b/u, 'grafana'],
    [/\b(?:framework|version|fingerprint|technology)\b/u, 'framework-leak'],
  ];
  for (const [pattern, family] of families) {
    if (pattern.test(normalized)) {
      return family;
    }
  }
  return normalized;
};

const isRiskyDedupeClassShift = (
  existing: {
    title: string;
    cweIds?: string[] | null;
    cweId?: string | null;
    cveIds?: string[] | null;
    cveId?: string | null;
    owaspCategory?: string | null;
  },
  incoming: {
    title: string;
    cweIds?: string[] | null;
    cveIds?: string[] | null;
    owaspCategory?: string | null;
  },
): boolean => {
  const existingClass = normalizeFindingClass(existing);
  const incomingClass = normalizeFindingClass(incoming);
  if (existingClass === incomingClass) {
    return false;
  }
  return normalizeFindingTitleFamily(existing.title) !== normalizeFindingTitleFamily(incoming.title);
};

const hashFindingDedupeParts = (parts: FindingDedupeKeyParts): string =>
  createHash('sha256')
    .update(
      [
        `target:${parts.target}`,
        `surface:${parts.surface}`,
        `class:${parts.vulnerabilityClass}`,
      ].join('|'),
    )
    .digest('hex');

const buildFindingKeyParts = (input: FindingKeyInput): FindingDedupeKeyParts => {
  const endpointSurface =
    input.endpoint?.url
      ? `endpoint:${normalizeDedupePart(input.endpoint.method ?? 'GET')}:${normalizeDedupePart(input.endpoint.url)}`
      : input.endpointId
        ? `endpoint:${input.endpointId}`
        : undefined;
  const canonicalTarget = canonicalFindingTarget(input);
  return {
    target: canonicalTarget,
    surface: endpointSurface ?? (input.serviceId ? `service:${input.serviceId}` : `asset:${canonicalTarget}`),
    vulnerabilityClass: normalizeFindingClass(input),
  };
};

const buildLegacyFindingKeyParts = (
  input: Omit<FindingKeyInput, 'scopeId' | 'assetKind' | 'assetValue'>,
): FindingDedupeKeyParts => {
  const endpointSurface =
    input.endpoint?.url
      ? `endpoint:${normalizeDedupePart(input.endpoint.method ?? 'GET')}:${normalizeDedupePart(input.endpoint.url)}`
      : input.endpointId
        ? `endpoint:${input.endpointId}`
        : undefined;
  return {
    target: input.assetId,
    surface: endpointSurface ?? (input.serviceId ? `service:${input.serviceId}` : `asset:${input.assetId}`),
    vulnerabilityClass: normalizeFindingClass(input),
  };
};

const hashFindingKeyLegacy = (input: Omit<FindingKeyInput, 'scopeId' | 'assetKind' | 'assetValue'>): string => {
  return hashFindingDedupeParts(buildLegacyFindingKeyParts(input));
};

export class FindingReportService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: FindingReportServiceOptions,
  ) {}

  async reportFinding(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context: FindingReportContext;
    input: unknown;
    workerTasks?: Array<{ workerType: string; status: string }>;
    turnNumber?: number;
    abortSignal?: AbortSignal;
    executeModelCall?: TurnExecutorPort['executeModelCall'];
  }): Promise<ReportFindingResult> {
    const parsed = ReportFindingSchema.parse(params.input);

    if (parsed.confidence !== undefined && parsed.confidence !== null && parsed.confidence < 0.3) {
      throw new Error(
        `Finding rejected: confidence score (${parsed.confidence}) is below the theoretical floor (0.3). ` +
        `Scores below 0.3 indicate the signal is essentially noise. ` +
        `Either record this as an approach.tried note or describe the differential observation ` +
        `that warrants a candidate and resubmit.`,
      );
    }

    const normalizedCweIds = mergeStringSet(
      normalizeCweIds(parsed.cweIds),
      parsed.cweId ? [normalizeCweId(parsed.cweId)].filter((value): value is string => Boolean(value)) : [],
    );
    const normalizedCveIds = mergeStringSet(
      normalizeCveIds(parsed.cveIds),
      parsed.cveId ? normalizeCveIds([parsed.cveId]) : [],
    );
    const explicitOwaspCategory = normalizeOptionalToolText(parsed.owaspCategory);
    const calculatedCvss = parsed.cvss ? calculateCvss(parsed.cvss) : undefined;
    const effectiveSeverity: FindingSeverity = calculatedCvss
      ? (calculatedCvss.severity === 'none' ? 'info' : calculatedCvss.severity)
      : parsed.severity;

    const now = this.options.now();
    const sessionId = this.options.normalizeSessionId(params.sessionId);
    const organizationId = this.requireOrganizationId(params.context);
    const scopeId = this.requireScopeId(params.context);
    const isReportingPhase = params.context.activePhaseKey === 'reporting';
    const hasReportingRepairField = [
      parsed.businessImpact,
      parsed.technicalAnalysis,
      parsed.pocDescription,
      parsed.assumptions,
      parsed.remediation,
    ].some((value) => typeof value === 'string' && value.trim().length > 0);
    if (isReportingPhase && !parsed.validatesFindingId) {
      throw new Error(
        'report_finding is repair-only in the reporting phase; provide validatesFindingId to backfill an existing canonical finding row instead of creating a new finding.',
      );
    }
    if (isReportingPhase && parsed.validatesFindingId && !hasReportingRepairField) {
      throw new Error(
        'report_finding in the reporting phase must backfill at least one final-report field: businessImpact, technicalAnalysis, pocDescription, assumptions, or remediation.',
      );
    }
    const resolvedEvidence = await this.options.resolveFindingEvidenceEntries(params.workspaceDir, parsed.evidence);
    const normalizedCodeLocations = await this.options.normalizeFindingCodeLocations({
      workspaceDir: params.workspaceDir,
      context: params.context,
      codeLocations: parsed.codeLocations,
    });
    const durableEvidencePresent = hasDurableFindingEvidence(resolvedEvidence);
    const evidenceGate = {
      requirements: ['durable_evidence'],
      passed: durableEvidencePresent,
      missing: durableEvidencePresent ? [] : ['durable_evidence'],
    };
    const normalizedTitle = normalizeToolText(parsed.title);
    const normalizedSummary = normalizeToolText(parsed.summary);
    const normalizeOptional = (value: string | undefined): string =>
      typeof value === 'string' ? value.trim() : '';
    const normalizedBusinessImpact = normalizeOptional(parsed.businessImpact);
    const normalizedTechnicalAnalysis = normalizeOptional(parsed.technicalAnalysis);
    const normalizedPocDescription = normalizeOptional(parsed.pocDescription);
    const normalizedPocScriptCode = normalizeOptional(parsed.pocScriptCode);
    const normalizedAssumptions = normalizeOptional(parsed.assumptions);
    const normalizedRemediation = normalizeOptional(parsed.remediation);
    const remediationWarning =
      normalizedRemediation.length === 0
        ? 'remediation is missing; candidates are accepted, but add concrete fix guidance before reporting or promotion'
        : undefined;
    const normalizedAssetValue = this.options.normalizeAssetValue(parsed.assetRef.kind, parsed.assetRef.value);
    let createdFindingPayload: {
      findingId: string;
      severity: string;
      assetId: string;
      confidenceScore: number | null;
    } | null = null;

    const result = await this.db.transaction(async (tx) => {
      const { assetId } = await this.options.upsertAsset({
        userId: params.userId,
        workspaceDir: params.workspaceDir,
        sessionId,
        context: params.context,
        input: {
          kind: parsed.assetRef.kind,
          value: parsed.assetRef.value,
        },
        executor: tx,
      });

      let endpointId: string | undefined;
      let candidateEndpointLocation: EndpointLocation | undefined;
      if (parsed.endpointRef) {
        const [endpoint] = await tx
          .select({ id: inventoryNotes.id, data: inventoryNotes.data })
          .from(inventoryNotes)
          .where(
            and(
              eq(inventoryNotes.userId, params.userId),
              eq(inventoryNotes.organizationId, organizationId),
              eq(inventoryNotes.id, parsed.endpointRef),
              eq(inventoryNotes.ntype, 'http.endpoint'),
            ),
          )
          .limit(1);
        if (!endpoint) {
          throw new Error(`endpointRef not found: ${parsed.endpointRef}`);
        }
        endpointId = endpoint.id;
        const endpointData = this.isRecord(endpoint.data) ? endpoint.data : {};
        candidateEndpointLocation = {
          url: typeof endpointData['url'] === 'string' ? normalizeOptionalToolText(endpointData['url']) : undefined,
          method:
            typeof endpointData['method'] === 'string'
              ? normalizeOptionalToolText(endpointData['method'])?.toUpperCase()
              : undefined,
        };
      }

      let serviceId: string | undefined;
      if (parsed.serviceRef) {
        const [service] = await tx
          .select({ id: inventoryServices.id })
          .from(inventoryServices)
          .where(
            and(
              eq(inventoryServices.userId, params.userId),
              eq(inventoryServices.organizationId, organizationId),
              eq(inventoryServices.id, parsed.serviceRef),
            ),
          )
          .limit(1);
        if (!service) {
          throw new Error(`serviceRef not found: ${parsed.serviceRef}`);
        }
        serviceId = service.id;
      }

      const dedupeInput = {
        assetId,
        scopeId,
        assetKind: parsed.assetRef.kind,
        assetValue: normalizedAssetValue,
        title: normalizedTitle,
        endpoint: candidateEndpointLocation,
        endpointId,
        serviceId,
        cweIds: normalizedCweIds,
        cveIds: normalizedCveIds,
        owaspCategory: explicitOwaspCategory,
      };
      const dedupeParts = buildFindingKeyParts(dedupeInput);
      const dedupeKey = hashFindingDedupeParts(dedupeParts);
      const legacyDedupeInput = {
        assetId,
        title: normalizedTitle,
        endpoint: candidateEndpointLocation,
        endpointId,
        serviceId,
        cweIds: normalizedCweIds,
        cveIds: normalizedCveIds,
        owaspCategory: explicitOwaspCategory,
      };
      const legacyDedupeKey = hashFindingKeyLegacy(legacyDedupeInput);

      const validatesFindingId = parsed.validatesFindingId;
      const existingSelectFields = {
        id: findings.id,
        dedupeKey: findings.dedupeKey,
        title: findings.title,
        severity: findings.severity,
        state: findings.state,
        summary: findings.summary,
        businessImpact: findings.businessImpact,
        technicalAnalysis: findings.technicalAnalysis,
        pocDescription: findings.pocDescription,
        pocScriptCode: findings.pocScriptCode,
        assumptions: findings.assumptions,
        fixEffort: findings.fixEffort,
        remediation: findings.remediation,
        confidenceScore: findings.confidenceScore,
        cweId: findings.cweId,
        cveId: findings.cveId,
        cweIds: findings.cweIds,
        cveIds: findings.cveIds,
        owaspCategory: findings.owaspCategory,
        cvssVector: findings.cvssVector,
        cvssScore: findings.cvssScore,
        endpointId: findings.endpointId,
        serviceId: findings.serviceId,
        codeLocations: findings.codeLocations,
      };
      const findExistingByDedupeKey = async (key: string) =>
        tx
          .select(existingSelectFields)
          .from(findings)
          .where(
            and(
              eq(findings.organizationId, organizationId),
              eq(findings.sourceKind, 'assessment'),
              eq(findings.dedupeKey, key),
              sql`${findings.state} <> 'dismissed'`,
            ),
          )
          .limit(1);

      let existingMatchedLegacyDedupe = false;
      let dedupeMatchSource: FindingDedupeMatchSource = 'created';
      let existing: Awaited<ReturnType<typeof findExistingByDedupeKey>>[number] | undefined;
      if (validatesFindingId) {
        [existing] = await tx
          .select(existingSelectFields)
          .from(findings)
          .where(and(
            eq(findings.id, validatesFindingId),
            eq(findings.organizationId, organizationId),
            eq(findings.sourceKind, 'assessment'),
          ))
          .limit(1);
        if (existing) {
          dedupeMatchSource = 'explicit_validates_finding';
        }
      } else {
        [existing] = await findExistingByDedupeKey(dedupeKey);
        if (existing) {
          dedupeMatchSource = 'exact_key';
        }
      }

      if (!existing && !validatesFindingId && legacyDedupeKey !== dedupeKey) {
        [existing] = await findExistingByDedupeKey(legacyDedupeKey);
        existingMatchedLegacyDedupe = Boolean(existing);
        if (existing) {
          dedupeMatchSource = 'legacy_key';
        }
      }

      if (validatesFindingId && !existing) {
        throw new Error(`validatesFindingId not found or access denied: ${validatesFindingId}`);
      }

      // D20 - reporting is read-mostly with respect to security truth. In run r1 the reporter
      // enriched the Grafana finding with business impact, CVSS and technical analysis on a
      // row that had never been through an exploit validation, helping turn a recon
      // observation into a polished Medium. Presentation fields may be filled here; the
      // judgement of how bad something is may not be raised by the phase that writes it up.
      if (isReportingPhase && existing) {
        const raised = findReportingSeverityEscalation({
          existingSeverity: existing.severity,
          requestedSeverity: parsed.severity,
        });
        if (raised) {
          throw new Error(raised);
        }
      }

      if (!existing && !validatesFindingId) {
        const candidateRows = await this.options.inventoryProjection.queryDuplicateCandidateRows({
          executor: tx,
          organizationId,
          assetId,
          scopeId,
          endpointId,
          serviceId,
        });

        if (candidateRows.length > 0) {
          const currentTarget = canonicalFindingTarget({
            scopeId,
            assetKind: parsed.assetRef.kind,
            assetValue: normalizedAssetValue,
          });
          const currentClass = normalizeFindingClass({
            title: normalizedTitle,
            cweIds: normalizedCweIds,
            cveIds: normalizedCveIds,
            owaspCategory: explicitOwaspCategory,
          });
          const structuralMatch = candidateRows.find((row) => {
            const rowTarget = canonicalFindingTarget({
              scopeId,
              assetKind: row.assetKind,
              assetValue: row.assetValue,
            });
            const rowClass = normalizeFindingClass(row);
            const sameSurface = endpointId
              ? row.endpointId === endpointId
              : serviceId
                ? row.serviceId === serviceId
                : !row.endpointId && !row.serviceId;
            return rowTarget === currentTarget && rowClass === currentClass && sameSurface;
          });
          if (structuralMatch) {
            existing = structuralMatch;
            dedupeMatchSource = 'structural_match';
          }

          if (!existing && this.options.duplicateJudge) {
            const endpointLocationMap = await this.options.inventoryProjection.loadEndpointLocationsByIds({
              executor: tx,
              endpointIds: candidateRows
                .map((row) => row.endpointId)
                .filter((value): value is string => typeof value === 'string' && value.length > 0),
            });

            const candidateReport = this.buildDuplicateJudgeReport({
              row: {
                title: normalizedTitle,
                summary: normalizedSummary,
                businessImpact: normalizedBusinessImpact,
                technicalAnalysis: normalizedTechnicalAnalysis,
                pocDescription: normalizedPocDescription,
              },
              target: parsed.assetRef.value,
              endpoint: candidateEndpointLocation,
            });
            const existingReports = candidateRows.map((row) =>
              this.buildDuplicateJudgeReport({
                row,
                target: parsed.assetRef.value,
                endpoint: row.endpointId ? endpointLocationMap.get(row.endpointId) : undefined,
              }),
            );
            const duplicateDecision: FindingDuplicateDecision = await this.options.duplicateJudge.checkDuplicate(
              candidateReport,
              existingReports,
              params.executeModelCall && params.sessionId
                ? {
                    sessionId: params.sessionId,
                    turnNumber: params.turnNumber ?? 0,
                    abortSignal: params.abortSignal ?? new AbortController().signal,
                    executeModelCall: params.executeModelCall,
                  }
                : undefined,
            );

            if (duplicateDecision.isDuplicate && duplicateDecision.duplicateId) {
              const matchedCandidate = candidateRows.find((row) => row.id === duplicateDecision.duplicateId);
              if (matchedCandidate) {
                existing = matchedCandidate;
                dedupeMatchSource = 'llm_judge';
              }
            }
          }
        }
      }

      if (existing) {
        const dedupeWarnings: string[] = [];
        const titleChanged = normalizeDedupePart(existing.title) !== normalizeDedupePart(normalizedTitle);
        const riskyClassShift = isRiskyDedupeClassShift(existing, {
          title: normalizedTitle,
          cweIds: normalizedCweIds,
          cveIds: normalizedCveIds,
          owaspCategory: explicitOwaspCategory,
        });
        if (!validatesFindingId && titleChanged) {
          dedupeWarnings.push(
            `dedupe merge matched existing finding ${existing.id} by ${dedupeMatchSource} with a different title; use validatesFindingId when intentionally re-verifying this row`,
          );
        }
        if (!validatesFindingId && dedupeMatchSource === 'llm_judge' && riskyClassShift) {
          throw new Error(
            `report_finding requires explicit confirmation before merging a different vulnerability class into existing finding ${existing.id} ("${existing.title}"). ` +
            `The duplicate judge matched by semantics, but the incoming title/class "${normalizedTitle}" differs. ` +
            `If this is fresh evidence for the existing row, call report_finding with validatesFindingId="${existing.id}". Otherwise adjust the title/class and submit as a new finding.`,
          );
        }

        if (existingMatchedLegacyDedupe && existing.dedupeKey !== dedupeKey) {
          const [v2Peer] = await findExistingByDedupeKey(dedupeKey);
          if (!v2Peer || v2Peer.id === existing.id) {
            await tx
              .update(findings)
              .set({ dedupeKey, updatedAt: now })
              .where(eq(findings.id, existing.id));
            existing.dedupeKey = dedupeKey;
          }
        }

        if (isReportingPhase) {
          assertReportingClassificationStable({
            existingSeverity: existing.severity,
            incomingSeverity: parsed.severity,
            ...(calculatedCvss
              ? {
                  calculatedCvssSeverity:
                    calculatedCvss.severity === 'none' ? 'info' : calculatedCvss.severity,
                }
              : {}),
          });
        }

        const previousState = existing.state;
        const nextState = existing.state === 'resolved' ? 'confirmed' : existing.state;
        const nextSeverity = isReportingPhase
          ? existing.severity as FindingSeverity
          : calculatedCvss
            ? effectiveSeverity
            : pickHigherSeverity(existing.severity, parsed.severity);
        const existingCweIds = mergeStringSet(
          existing.cweIds,
          existing.cweId
            ? [normalizeCweId(existing.cweId)].filter((value): value is string => Boolean(value))
            : [],
        );
        const existingCveIds = mergeStringSet(
          existing.cveIds,
          existing.cveId ? normalizeCveIds([existing.cveId]) : [],
        );
        const nextCweIds = mergeStringSet(existingCweIds, normalizedCweIds);
        const nextCveIds = mergeStringSet(existingCveIds, normalizedCveIds);
        const nextOwaspCategory =
          explicitOwaspCategory ??
          deriveOwaspCategory(nextCweIds) ??
          existing.owaspCategory ??
          undefined;
        const nextEndpointId = existing.endpointId ?? endpointId;
        const nextServiceId = existing.serviceId ?? serviceId;
        const nextCodeLocations = mergeCodeLocations(existing.codeLocations, normalizedCodeLocations);
        const nextBusinessImpact = preferExistingText(existing.businessImpact, normalizedBusinessImpact);
        const nextTechnicalAnalysis = preferExistingText(existing.technicalAnalysis, normalizedTechnicalAnalysis);
        const nextPocDescription = preferExistingText(existing.pocDescription, normalizedPocDescription);
        const nextPocScriptCode = preferExistingText(existing.pocScriptCode, normalizedPocScriptCode);
        const nextAssumptions = preferExistingText(existing.assumptions, normalizedAssumptions);
        const nextFixEffort = preferExistingText(existing.fixEffort, parsed.fixEffort);
        const nextRemediation = preferExistingText(existing.remediation, normalizedRemediation);
        const nextCvssVector = preferExistingText(existing.cvssVector, calculatedCvss?.vector);
        const nextCvssScore = preferExistingNumber(existing.cvssScore, calculatedCvss?.score);
        const reportCompleteness = buildFindingReportCompleteness({
          id: existing.id,
          title: existing.title,
          businessImpact: nextBusinessImpact,
          technicalAnalysis: nextTechnicalAnalysis,
          pocDescription: nextPocDescription,
          assumptions: nextAssumptions,
          remediation: nextRemediation,
          fixEffort: nextFixEffort,
          cweId: nextCweIds[0] ?? null,
          cweIds: nextCweIds.length > 0 ? nextCweIds : null,
          owaspCategory: nextOwaspCategory ?? null,
          cvssVector: nextCvssVector,
          cvssScore: nextCvssScore,
        });

        await tx
          .update(findings)
          .set({
            organizationId,
            scopeId,
            assetId,
            title: existing.title,
            severity: nextSeverity,
            state: nextState,
            summary: existing.summary,
            businessImpact: nextBusinessImpact,
            technicalAnalysis: nextTechnicalAnalysis,
            pocDescription: nextPocDescription,
            pocScriptCode: nextPocScriptCode,
            assumptions: nextAssumptions,
            fixEffort: nextFixEffort,
            remediation: nextRemediation,
            cvssVector: nextCvssVector,
            cvssScore: nextCvssScore,
            confidenceScore: preferHigherConfidence(existing.confidenceScore, parsed.confidence),
            cweId: nextCweIds[0],
            cveId: nextCveIds[0],
            cweIds: nextCweIds.length > 0 ? nextCweIds : null,
            cveIds: nextCveIds.length > 0 ? nextCveIds : null,
            owaspCategory: nextOwaspCategory,
            endpointId: nextEndpointId,
            serviceId: nextServiceId,
            codeLocations: nextCodeLocations,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(findings.id, existing.id));

        if (nextState !== previousState) {
          await tx.insert(findingEvents).values({
            organizationId,
            userId: params.userId,
            findingId: existing.id,
            type: 'state_changed',
            fromState: previousState,
            toState: nextState,
            note: 'Auto-reopened on re-detection',
            createdAt: now,
          });
        }

        if (!validatesFindingId) {
          await tx.insert(findingEvents).values({
            organizationId,
            userId: params.userId,
            findingId: existing.id,
            type: 'dedup_merged',
            note: params.context.runId
              ? `Re-reported by run ${params.context.runId}; evidence merged via ${dedupeMatchSource}.`
              : `Re-reported by a later run; evidence merged via ${dedupeMatchSource}.`,
            createdAt: now,
          });
        }

        for (const ev of resolvedEvidence) {
          await tx
            .insert(findingEvidence)
            .values({
              organizationId,
              userId: params.userId,
              findingId: existing.id,
              sessionId,
              kind: ev.kind,
              path: ev.path,
              displayPath: ev.displayPath,
              label: ev.label,
              excerpt: ev.kind === 'artifact' ? ev.excerpt : undefined,
              fileMissing: ev.kind === 'artifact' ? ev.fileMissing ?? false : false,
              data: ev.kind === 'http_exchange' ? ev.data : null,
              createdAt: now,
            })
            .onConflictDoNothing({
              target: [findingEvidence.findingId, findingEvidence.path],
            });
        }

        const warnings = [
          ...dedupeWarnings,
          ...(remediationWarning && !existing.remediation ? [remediationWarning] : []),
        ];

        return {
          findingId: existing.id,
          created: false as const,
          dedupeKey: existing.dedupeKey,
          dedupe: {
            key: existing.dedupeKey,
            ...(legacyDedupeKey !== dedupeKey ? { legacyKey: legacyDedupeKey } : {}),
            parts: dedupeParts,
            matchedBy: dedupeMatchSource,
            mergedFindingId: existing.id,
          },
          ...(warnings.length > 0 ? { warnings } : {}),
          state: nextState,
          lifecycleStage: isReportableRiskState(nextState) ? 'reportable' as const : 'candidate' as const,
          evidenceGate,
          reportCompleteness,
        };
      }

      const [row] = await tx
        .insert(findings)
        .values({
          organizationId,
          scopeId,
          userId: params.userId,
          assetId,
          sourceKind: 'assessment',
          title: normalizedTitle,
          severity: effectiveSeverity,
          state: 'potential',
          summary: normalizedSummary,
          businessImpact: normalizedBusinessImpact,
          technicalAnalysis: normalizedTechnicalAnalysis,
          pocDescription: normalizedPocDescription,
          pocScriptCode: normalizedPocScriptCode,
          assumptions: normalizedAssumptions,
          fixEffort: parsed.fixEffort,
          remediation: normalizedRemediation,
          cvssVector: calculatedCvss?.vector,
          cvssScore: calculatedCvss?.score,
          confidenceScore: parsed.confidence ?? undefined,
          cweId: normalizedCweIds[0],
          cveId: normalizedCveIds[0],
          cweIds: normalizedCweIds.length > 0 ? normalizedCweIds : undefined,
          cveIds: normalizedCveIds.length > 0 ? normalizedCveIds : undefined,
          owaspCategory: explicitOwaspCategory ?? deriveOwaspCategory(normalizedCweIds),
          dedupeKey,
          endpointId,
          serviceId,
          codeLocations: normalizedCodeLocations,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: findings.id });

      await tx.insert(findingEvents).values({
        organizationId,
        userId: params.userId,
        findingId: row.id,
        type: 'created',
        createdAt: now,
      });

      for (const ev of resolvedEvidence) {
        await tx
          .insert(findingEvidence)
          .values({
            organizationId,
            userId: params.userId,
            findingId: row.id,
            sessionId,
            kind: ev.kind,
            path: ev.path,
            displayPath: ev.displayPath,
            label: ev.label,
            excerpt: ev.kind === 'artifact' ? ev.excerpt : undefined,
            fileMissing: ev.kind === 'artifact' ? ev.fileMissing ?? false : false,
            data: ev.kind === 'http_exchange' ? ev.data : null,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [findingEvidence.findingId, findingEvidence.path],
          });
      }

      await this.options.incrementRunCounter(params.context.runId, 'findingsCount', tx);
      createdFindingPayload = {
        findingId: row.id,
        severity: effectiveSeverity,
        assetId,
        confidenceScore: parsed.confidence ?? null,
      };
      const reportCompleteness = buildFindingReportCompleteness({
        id: row.id,
        title: normalizedTitle,
        businessImpact: normalizedBusinessImpact,
        technicalAnalysis: normalizedTechnicalAnalysis,
        pocDescription: normalizedPocDescription,
        assumptions: normalizedAssumptions,
        remediation: normalizedRemediation,
        fixEffort: parsed.fixEffort ?? null,
        cweId: normalizedCweIds[0] ?? null,
        cweIds: normalizedCweIds.length > 0 ? normalizedCweIds : null,
        owaspCategory: explicitOwaspCategory ?? deriveOwaspCategory(normalizedCweIds) ?? null,
        cvssVector: calculatedCvss?.vector ?? null,
        cvssScore: calculatedCvss?.score ?? null,
      });

      return {
        findingId: row.id,
        created: true as const,
        dedupeKey,
        dedupe: {
          key: dedupeKey,
          ...(legacyDedupeKey !== dedupeKey ? { legacyKey: legacyDedupeKey } : {}),
          parts: dedupeParts,
          matchedBy: 'created' as const,
        },
        state: 'potential' as const,
        lifecycleStage: 'candidate' as const,
        evidenceGate,
        reportCompleteness,
        ...(remediationWarning ? { warnings: [remediationWarning] } : {}),
      };
    });

    if (result.created && createdFindingPayload) {
      await this.options.emitSecurityOpsEvent(organizationId, {
        type: 'finding_created',
        payload: createdFindingPayload,
        summary: `New ${effectiveSeverity} finding: ${normalizedTitle}`,
      });
    }

    return result;
  }

  private buildDuplicateJudgeReport(params: {
    row: {
      id?: string;
      title: string;
      summary: string;
      businessImpact?: string | null;
      technicalAnalysis?: string | null;
      pocDescription?: string | null;
    };
    target: string;
    endpoint?: EndpointLocation;
  }): FindingDuplicateReport {
    return {
      ...(params.row.id ? { id: params.row.id } : {}),
      title: params.row.title,
      description: params.row.summary,
      impact: params.row.businessImpact ?? undefined,
      target: params.target,
      technicalAnalysis: params.row.technicalAnalysis ?? undefined,
      pocDescription: params.row.pocDescription ?? undefined,
      endpoint: params.endpoint?.url,
      method: params.endpoint?.method,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private requireOrganizationId(context: FindingReportContext): string {
    if (!context.organizationId) {
      throw new Error('organizationId is required in SecurityOps context');
    }
    return context.organizationId;
  }

  private requireScopeId(context: FindingReportContext): string {
    if (!context.scopeId) {
      throw new Error('scopeId is required in SecurityOps context');
    }
    return context.scopeId;
  }
}
