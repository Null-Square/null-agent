import { createHash } from 'crypto';
import { isIP } from 'net';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  findingEvents,
  findingEvidence,
  findings,
  runValidationQueue,
  type RunWorkflowDiscipline,
} from '@/db/schema';
import type { AttackResultV1 } from '@/domains/agent-brain/domain/workers/attackContracts';
import { ComponentInventoryService } from '@/domains/security-ops/components/ComponentInventoryService';
import { ExposureVerificationCompletion } from '@/domains/security-ops/exposure/ExposureVerificationCompletion';
import { AssetIngestionWriter } from '@/domains/security-ops/assets/AssetIngestionWriter';
import {
  type AssetKindSchema,
  type AssetRefSchema,
  AssetReportingService,
  type EvidenceRef,
  type ReportAssetInput,
  type ReportAssetResult,
  type ReportServiceResult,
} from '@/domains/security-ops/assets/AssetReportingService';
import {
  InventoryNoteQueryService,
  type QueryNotesResult,
} from '@/domains/security-ops/assets/InventoryNoteQueryService';
import { InventoryNoteWriter } from '@/domains/security-ops/assets/InventoryNoteWriter';
import { InventoryProjection } from '@/domains/security-ops/assets/InventoryProjection';
import { InventoryQueryService } from '@/domains/security-ops/assets/InventoryQueryService';
import type { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { CodeSourceService } from '@/domains/security-ops/code-sources/CodeSourceService';
import {
  ConnectedRepositoryToolService,
  type ConnectedRepositoryGateway,
  type ListCodeReviewRepositoryFilesResult,
  type ListConnectedRepositoriesResult,
  type ReadConnectedRepositoryFileResult,
  type SearchConnectedRepositoryResult,
} from '@/domains/security-ops/code-sources/ConnectedRepositoryToolService';
import type { ComplianceReadinessResponse } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { ComplianceControlCheckService } from '@/domains/security-ops/compliance/ComplianceControlCheckService';
import { ComplianceControlRequestService } from '@/domains/security-ops/compliance/ComplianceControlRequestService';
import { ComplianceEvidenceService } from '@/domains/security-ops/compliance/ComplianceEvidenceService';
import { COMPLIANCE_FRAMEWORK_KEYS, type ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import { isComplianceFrameworkKey } from '@/domains/security-ops/compliance/profile';
import {
  ComplianceToolQueryService,
  type QueryComplianceEvidenceResult,
  type QueryComplianceMissingEvidenceResult,
  type QueryComplianceProofPackageResult,
  type QueryComplianceReadinessResult,
} from '@/domains/security-ops/compliance/ComplianceToolQueryService';
import type { FindingCodeLocation } from '@/domains/security-ops/findings/findingContracts';
import {
  FindingQueryService,
  type QueryFindingsResult,
} from '@/domains/security-ops/findings/FindingQueryService';
import {
  FindingReportService,
  hasDurableFindingEvidence as findingReportHasDurableFindingEvidence,
  type FindingCodeLocationInput,
  type FindingSeverity,
  type ReportFindingEvidenceInput,
  type ReportFindingResult,
} from '@/domains/security-ops/findings/FindingReportService';
import {
  FindingDispositionOutcomeSchema,
  FindingDispositionVerificationService,
  type FindingDispositionOutcomeInput,
} from '@/domains/security-ops/findings/FindingDispositionVerificationService';
import {
  FindingValidationService,
  type PromoteFindingResult,
  type SubmitValidationOutcomeResult,
} from '@/domains/security-ops/findings/FindingValidationService';
import type { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import {
  normalizeCveIds,
  normalizeCweIds,
} from '@/domains/security-ops/tools/cweOwasp';
import { SecurityOpsEventEmitter } from '@/domains/security-ops/tools/events/SecurityOpsEventEmitter';
import {
  SecurityOpsEvidenceResolver,
  type ResolvedEvidenceWithExcerpt,
  type ResolvedFindingEvidence,
} from '@/domains/security-ops/tools/evidence/EvidenceResolver';
import {
  resolveCurrentSessionHttpHistoryEvidence,
} from '@/domains/security-ops/tools/evidence/HttpHistoryFindingEvidence';
import {
  resolveBrowserExchangeEvidence,
} from '@/domains/security-ops/tools/evidence/BrowserExchangeFindingEvidence';
import type { FindingDuplicateJudge } from '@/domains/security-ops/tools/FindingDuplicateJudge';
import type { TurnExecutorPort } from '@/domains/agent-brain/ports';
import { OpenApiValidationLeadBuilder } from '@/domains/security-ops/tools/ingestion/OpenApiValidationLeadBuilder';
import {
  ScannerArtifactIngestionService,
  type IngestScanArtifactParser,
  type SecurityOpsIngestSummary,
} from '@/domains/security-ops/tools/ingestion/ScannerArtifactIngestionService';
import { ScannerArtifactIO } from '@/domains/security-ops/tools/ingestion/ScannerArtifactIO';
import { ScannerObservationWriter } from '@/domains/security-ops/tools/ingestion/ScannerObservationWriter';
import {
  detectAssetKind,
  extractHttpxTechFingerprints,
  ffufResponseSignature,
  isHighSignalFfufPath,
  normalizeArtifactHost,
  normalizeFfufEndpointUrl,
  normalizePort,
  parseHostPortLine,
  splitProductVersion,
} from '@/domains/security-ops/tools/ingestion/ScannerRuntimeHelpers';
import { reportNoteTemplates } from '@/domains/security-ops/tools/ntypeSchemas';
import type { FinalizerPlanStep } from '@/domains/security-ops/tools/reporting/RunReportStateLoader';
import {
  RunReportWorkflowService,
  type AutomatedRunCloseoutReconciliation,
  type FinalizeRunArtifactsMode,
  type FinalizeRunArtifactsResult,
  type PrepareReportContextResult,
  type ReportFinalizerPreflightResult,
} from '@/domains/security-ops/tools/reporting/RunReportWorkflowService';
import {
  ValidationLeadService,
  type SubmitValidationLeadOutcomeResult,
} from '@/domains/security-ops/tools/validation/ValidationLeadService';
import { logger } from '@/shared/logger';
export type {
  AutomatedRunCloseoutReconciliation,
  RunCompletion
} from '@/domains/security-ops/tools/reporting/RunReportWorkflowService';

const SessionIdSchema = z.string().uuid();

type EvidenceWithExcerpt = EvidenceRef & { excerpt?: string };
type IngestSummary = SecurityOpsIngestSummary;

type ResolvedEvidenceRef = EvidenceRef & { path: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const getPgErrorCode = (error: unknown, depth = 0): string | undefined => {
  if (depth > 5) return undefined;
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'];
  if (isRecord(error) && 'cause' in error) return getPgErrorCode(error['cause'], depth + 1);
  return undefined;
};

const getPgConstraintName = (error: unknown, depth = 0): string | undefined => {
  if (depth > 5) return undefined;
  if (isRecord(error) && typeof error['constraint'] === 'string') return error['constraint'];
  if (isRecord(error) && 'cause' in error) return getPgConstraintName(error['cause'], depth + 1);
  return undefined;
};

const isUniqueViolation = (error: unknown): boolean => getPgErrorCode(error) === '23505';
const isMissingSessionObservationForeignKey = (error: unknown): boolean =>
  getPgErrorCode(error) === '23503' &&
  getPgConstraintName(error) === 'asset_observations_session_id_agent_sessions_id_fk';

const normalizeToolText = (value: string): string => value.trim();
const normalizeOptionalToolText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeToolText(value);
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeSessionId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  return SessionIdSchema.parse(raw.trim());
};

// Collects proof evidence references from a raw submit_validation_outcome
// payload without depending on the zod parse, so browser-network:<id>
// references can be resolved from durable capture_exchange artifacts.
const collectProofEvidenceReferences = (input: unknown): string[] => {
  if (!isRecord(input) || !isRecord(input.proof)) {
    return [];
  }
  const references: string[] = [];
  for (const key of ['evidenceIds', 'evidence_ids'] as const) {
    const value = input.proof[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        references.push(entry.trim());
      }
    }
  }
  return references;
};

const normalizeOptionalUuid = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = SessionIdSchema.safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
};

const normalizeAssetValue = (kind: z.infer<typeof AssetKindSchema>, rawValue: string): string => {
  const trimmed = normalizeToolText(rawValue);
  if (!trimmed) {
    return trimmed;
  }

  // Allow passing a URL as the asset value by extracting the hostname.
  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.trim();
      if (host) {
        return kind === 'domain' ? host.toLowerCase() : host;
      }
    } catch {
      // fall through
    }
  }

  if (kind === 'domain') {
    const withoutPath = trimmed.split('/')[0]?.trim() ?? trimmed;
    const withoutPort = withoutPath.split(':')[0]?.trim() ?? withoutPath;
    return withoutPort.toLowerCase().replace(/\.$/, '');
  }

  // IP: keep as-is (may be IPv6) but strip any trailing path.
  return trimmed.split('/')[0]?.trim() ?? trimmed;
};

const isValidIpOrCidr = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isIP(trimmed) !== 0) return true;

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return false;

  const baseIp = trimmed.slice(0, slashIndex);
  const prefixRaw = trimmed.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefixRaw)) return false;

  const family = isIP(baseIp);
  if (family === 0) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  return family === 4 ? prefix <= 32 : prefix <= 128;
};

const validateIpAssetRefOrThrow = (value: string, toolName: 'query_notes' | 'query_findings'): void => {
  if (isValidIpOrCidr(value)) return;
  const maybeUuidHint = /^[0-9a-fA-F-]{36}$/.test(value)
    ? ' It looks like a UUID. Use assetId for UUID lookups, or set assetRef.value to the actual IP/CIDR from query_inventory output.'
    : '';
  throw new Error(
    `${toolName} validation failed: assetRef.kind=ip requires a valid IP or CIDR value; received "${value}".${maybeUuidHint}`,
  );
};

const isSubdomainOf = (candidateHost: string, rootHost: string): boolean =>
  candidateHost.length > rootHost.length && candidateHost.endsWith(`.${rootHost}`);

const extractHostnameFromUrl = (rawUrl: string): string | undefined => {
  try {
    const url = new URL(rawUrl);
    return normalizeAssetValue('domain', url.hostname);
  } catch {
    return undefined;
  }
};

type SecurityOpsContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  activePhaseKey?: string;
  workflowDiscipline?: RunWorkflowDiscipline;
  complianceAssessment?: {
    framework?: string;
  };
  complianceReport?: {
    framework?: string;
    source?: string;
    sourceRunId?: string;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = DatabaseClient | any;

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

const mergeEvidenceByPath = (
  existing: Array<{ path: string; label?: string }> | null | undefined,
  incoming: Array<{ path: string; label?: string }> | null | undefined,
): Array<{ path: string; label?: string }> => {
  const map = new Map<string, { path: string; label?: string }>();
  for (const item of existing ?? []) {
    if (!item?.path) continue;
    map.set(item.path, { path: item.path, ...(item.label ? { label: item.label } : {}) });
  }
  for (const item of incoming ?? []) {
    if (!item?.path) continue;
    const prev = map.get(item.path);
    map.set(item.path, {
      path: item.path,
      label: item.label ?? prev?.label,
    });
  }
  return Array.from(map.values());
};

type NoteEvidence = { path: string; label?: string; excerpt?: string; fileMissing?: boolean };

const mergeEvidenceWithExcerptsByPath = (
  existing: NoteEvidence[] | null | undefined,
  incoming: NoteEvidence[] | null | undefined,
): NoteEvidence[] => {
  const map = new Map<string, NoteEvidence>();
  for (const item of existing ?? []) {
    if (!item?.path) continue;
    map.set(item.path, {
      path: item.path,
      ...(item.label ? { label: item.label } : {}),
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      ...(item.fileMissing ? { fileMissing: item.fileMissing } : {}),
    });
  }
  for (const item of incoming ?? []) {
    if (!item?.path) continue;
    const prev = map.get(item.path);
    map.set(item.path, {
      path: item.path,
      label: item.label ?? prev?.label,
      excerpt: item.excerpt ?? prev?.excerpt,
      fileMissing: item.fileMissing ?? prev?.fileMissing,
    });
  }
  return Array.from(map.values());
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
};

const normalizeNtype = (raw: string): string => normalizeToolText(raw).toLowerCase();

const formatReportNoteTemplateExample = (ntype: string | undefined): string | undefined => {
  if (!ntype) {
    return undefined;
  }
  const template = reportNoteTemplates[normalizeNtype(ntype)];
  return template ? JSON.stringify(template) : undefined;
};

const buildReportNoteValidationError = (detail: string, ntype?: string): Error => {
  const normalizedNtype = typeof ntype === 'string' && ntype.trim().length > 0 ? normalizeNtype(ntype) : undefined;
  const topLevelDataHint = detail.includes('data: Required')
    ? ' The `data` object is always required for report_note.'
    : '';
  const approachTriedHint = normalizedNtype === 'approach.tried'
    ? ' `approach.tried` requires a URL-shaped `data.endpoint`; when the endpoint is local, use `assetRef` plus a `file:///workspace/...` URL.'
    : '';
  const template = formatReportNoteTemplateExample(normalizedNtype);
  return new Error(
    `report_note validation failed${normalizedNtype ? ` for ${normalizedNtype}` : ''}: ${detail}.${topLevelDataHint}${approachTriedHint}${template ? ` Example: ${template}` : ''}`.trim(),
  );
};

const readPathValue = (value: unknown, path: string[]): string | undefined => {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (typeof current === 'string') {
    const normalized = normalizeOptionalToolText(current);
    return normalized;
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }
  return undefined;
};

const dedupeKeySelectors: Array<{
  pattern: RegExp;
  paths: string[][];
}> = [
  { pattern: /^dns\.subdomain$/, paths: [['hostname']] },
  { pattern: /^dns\.(a|aaaa|cname|mx|txt|ns)$/, paths: [['name'], ['value']] },
  { pattern: /^http\.endpoint$/, paths: [['method'], ['url']] },
  { pattern: /^http\.(headers|robots)$/, paths: [['url']] },
  { pattern: /^tech\.fingerprint$/, paths: [['product']] },
  { pattern: /^tls\.certificate$/, paths: [['subject'], ['serialNumber']] },
  { pattern: /^whois$/, paths: [] },
  { pattern: /^os\.fingerprint$/, paths: [['method']] },
  { pattern: /^network\.traceroute$/, paths: [] },
  { pattern: /^approach\.tried$/, paths: [['endpoint'], ['technique']] },
  { pattern: /^credential\.found$/, paths: [['type'], ['username'], ['context']] },
  {
    pattern: /^scan\.coverage$/,
    paths: [['family'], ['profileVersion'], ['phase'], ['target'], ['targetHost'], ['targetUrl']],
  },
  { pattern: /^validation\.lead$/, paths: [['source'], ['target'], ['method'], ['path'], ['parameter'], ['riskFamily']] },
  { pattern: /^enumeration\.disposition$/, paths: [['taskId'], ['resultHash']] },
  { pattern: /^report\.section$/, paths: [['section'], ['heading']] },
];

const dedupeKeyForNtype = (ntype: string, data: Record<string, unknown>): string => {
  const normalizedNtype = normalizeNtype(ntype);
  const selector = dedupeKeySelectors.find((entry) => entry.pattern.test(normalizedNtype));
  const selectorValues =
    selector && selector.paths.length > 0
      ? selector.paths.map((pathSegments) => readPathValue(data, pathSegments) ?? '').join(':')
      : '';
  const canonical = selectorValues && selectorValues.replace(/:+/g, '').length > 0
    ? selectorValues
    : stableStringify(data);
  return createHash('sha256').update(`${normalizedNtype}:${canonical}`).digest('hex');
};

const deepMergeData = (
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> => {
  const base: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isRecord(value) && isRecord(base[key])) {
      base[key] = deepMergeData(base[key] as Record<string, unknown>, value);
      continue;
    }
    base[key] = value;
  }
  return base;
};

const pruneNullishDeep = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneNullishDeep(entry))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) {
    return value;
  }

  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = pruneNullishDeep(entry);
    if (next !== undefined) {
      pruned[key] = next;
    }
  }
  return pruned;
};

const mergeReportNoteData = (
  ntype: string,
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = deepMergeData(existing, incoming);
  if (normalizeNtype(ntype) !== 'scan.coverage') {
    return merged;
  }

  for (const key of ['status', 'reason', 'toolset', 'stats', 'inventoryFingerprint']) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      merged[key] = incoming[key];
    } else {
      delete merged[key];
    }
  }

  return merged;
};

export type SecurityOpsToolServiceDeps = {
  db: DatabaseClient;
  now?: () => Date;
  scopeService?: Pick<ScopeService, 'isAssetInScope'>;
  automationService?: Pick<AutomationService, 'evaluateEvent'>;
  /** The scope's code source; defaults to the local folder or clone the scope points at. */
  codeSourceService?: ConnectedRepositoryGateway;
  duplicateJudge?: FindingDuplicateJudge;
};

export class SecurityOpsToolService {
  private readonly eventEmitter: SecurityOpsEventEmitter;
  private readonly evidenceResolver: SecurityOpsEvidenceResolver;
  private readonly inventoryProjection: InventoryProjection;
  private readonly inventoryQueryService: InventoryQueryService;
  private readonly inventoryNoteQueryService: InventoryNoteQueryService;
  private readonly inventoryNoteWriter: InventoryNoteWriter;
  private readonly findingQueryService: FindingQueryService;
  private readonly findingReportService: FindingReportService;
  private readonly findingValidationService: FindingValidationService;
  private readonly findingDispositionVerificationService: FindingDispositionVerificationService;
  private readonly complianceToolQueries: ComplianceToolQueryService;
  private readonly complianceControlChecks: ComplianceControlCheckService;
  private readonly complianceControlRequests: ComplianceControlRequestService;
  private readonly complianceEvidenceService: ComplianceEvidenceService;
  private readonly assetWriter: AssetIngestionWriter;
  private readonly componentInventory: ComponentInventoryService;
  private readonly exposureVerificationCompletion: ExposureVerificationCompletion;
  private readonly assetReportingService: AssetReportingService;
  private readonly validationLeadService: ValidationLeadService;
  private readonly scannerArtifactIO: ScannerArtifactIO<IngestScanArtifactParser>;
  private readonly scannerIngestionService: ScannerArtifactIngestionService<SecurityOpsContext>;
  private readonly scannerObservationWriter: ScannerObservationWriter;
  private readonly openApiValidationLeadBuilder: OpenApiValidationLeadBuilder;
  private readonly runReportWorkflowService: RunReportWorkflowService;
  private readonly connectedRepositoryTools: ConnectedRepositoryToolService;

  constructor(private readonly deps: SecurityOpsToolServiceDeps) {
    const codeSourceService = deps.codeSourceService ?? new CodeSourceService(deps.db);
    this.connectedRepositoryTools = new ConnectedRepositoryToolService(codeSourceService);
    this.eventEmitter = new SecurityOpsEventEmitter({
      db: deps.db,
      automationService: deps.automationService,
    });
    this.evidenceResolver = new SecurityOpsEvidenceResolver({ codeSourceService });
    this.inventoryProjection = new InventoryProjection(deps.db);
    this.inventoryQueryService = new InventoryQueryService(deps.db, {
      inventoryProjection: this.inventoryProjection,
      now: () => this.now(),
    });
    this.inventoryNoteQueryService = new InventoryNoteQueryService(deps.db, {
      normalizeAssetValue,
      validateIpAssetRefOrThrow,
      normalizeNtype,
    });
    this.inventoryNoteWriter = new InventoryNoteWriter(deps.db, {
      inventoryProjection: this.inventoryProjection,
      now: () => this.now(),
      normalizeSessionId,
      normalizeNtype,
      normalizeAssetValue,
      normalizeToolText,
      normalizeOptionalToolText,
      normalizeAssetRefForHost: (params) => this.normalizeAssetRefForHost(params),
      extractHostnameFromUrl,
      pruneNullishDeep,
      buildReportNoteValidationError,
      dedupeKeyForNtype,
      mergeReportNoteData,
      mergeEvidenceWithExcerptsByPath,
      isUniqueViolation,
      resolveEvidenceWithExcerpts: (workspaceDir, evidence) => this.resolveEvidenceWithExcerpts(workspaceDir, evidence),
      upsertAsset: (assetParams) => this.upsertAsset(assetParams),
      updateAssetLastScannedAt: (assetId, now) => this.assetWriter.updateAssetLastScannedAt(assetId, now),
      incrementRunCounter: (runId, column) => this.incrementRunCounter(runId, column),
      recordComponentObservation: (componentParams) =>
        this.componentInventory.recordObservation(componentParams),
    });
    this.findingQueryService = new FindingQueryService(deps.db, {
      normalizeAssetValue,
      validateIpAssetRefOrThrow,
      mergeStringSet,
    });
    this.findingReportService = new FindingReportService(deps.db, {
      now: () => this.now(),
      normalizeSessionId,
      normalizeAssetValue,
      resolveFindingEvidenceEntries: (workspaceDir, evidence) =>
        this.resolveFindingEvidenceEntries(workspaceDir, evidence),
      normalizeFindingCodeLocations: (locationParams) => this.normalizeFindingCodeLocations(locationParams),
      upsertAsset: (assetParams) => this.upsertAsset(assetParams),
      incrementRunCounter: (runId, counter, executor) => this.incrementRunCounter(runId, counter, executor),
      emitSecurityOpsEvent: (organizationId, event) => this.emitSecurityOpsEvent(organizationId, event),
      inventoryProjection: this.inventoryProjection,
      duplicateJudge: deps.duplicateJudge,
    });
    this.findingValidationService = new FindingValidationService(deps.db, {
      now: () => this.now(),
      normalizeSessionId,
      normalizeToolText,
      resolveFindingEvidenceEntries: (workspaceDir, evidence) =>
        this.resolveFindingEvidenceEntries(workspaceDir, evidence as ReportFindingEvidenceInput[]),
      hasDurableFindingEvidence: findingReportHasDurableFindingEvidence,
      emitRunSystemEvent: (runId, note) => this.emitRunSystemEvent(runId, note),
    });
    this.findingDispositionVerificationService = new FindingDispositionVerificationService(
      deps.db,
      () => this.now(),
    );
    this.complianceToolQueries = new ComplianceToolQueryService(deps.db);
    this.complianceControlChecks = new ComplianceControlCheckService(deps.db, () => this.now());
    this.complianceControlRequests = new ComplianceControlRequestService(deps.db, () => this.now());
    this.complianceEvidenceService = new ComplianceEvidenceService(deps.db);
    this.validationLeadService = new ValidationLeadService(deps.db, {
      now: () => this.now(),
      normalizeToolText,
      buildReportNoteValidationError,
      mergeEvidenceWithExcerptsByPath,
    });
    this.scannerArtifactIO = new ScannerArtifactIO<IngestScanArtifactParser>();
    this.scannerObservationWriter = new ScannerObservationWriter(deps.db, {
      now: () => this.now(),
      normalizeSessionId,
      normalizeToolText,
      pruneNullishDeep,
      mergeEvidenceWithExcerptsByPath,
      resolveEvidenceWithExcerpts: (workspaceDir, evidence) => this.resolveEvidenceWithExcerpts(workspaceDir, evidence),
      upsertAsset: (assetParams) => this.upsertAsset(assetParams),
    });
    this.openApiValidationLeadBuilder = new OpenApiValidationLeadBuilder();
    this.runReportWorkflowService = new RunReportWorkflowService(deps.db, {
      now: () => this.now(),
      emitRunSystemEvent: (runId, note) => this.emitRunSystemEvent(runId, note),
    });
    this.componentInventory = new ComponentInventoryService(deps.db, () => this.now());
    this.exposureVerificationCompletion = new ExposureVerificationCompletion(deps.db, () => this.now());
    this.assetWriter = new AssetIngestionWriter({
      db: deps.db,
      now: () => this.now(),
      scopeService: deps.scopeService,
      resolveEvidenceRefs: (workspaceDir, evidence) => this.resolveEvidenceRefs(workspaceDir, evidence),
      normalizeAssetValue,
      mergeStringSet,
      mergeEvidenceByPath,
      isSubdomainOf,
      isUniqueViolation,
      isMissingSessionObservationForeignKey,
    });
    this.assetReportingService = new AssetReportingService(deps.db, {
      now: () => this.now(),
      assetWriter: this.assetWriter,
      normalizeSessionId,
      normalizeAssetValue,
      normalizeAssetRefForHost: (params) => this.normalizeAssetRefForHost(params),
      resolveEvidenceRefs: (workspaceDir, evidence) => this.resolveEvidenceRefs(workspaceDir, evidence),
      mergeEvidenceByPath,
      isUniqueViolation,
      emitSecurityOpsEvent: (organizationId, event) => this.emitSecurityOpsEvent(organizationId, event),
      recordComponentObservation: (componentParams) =>
        this.componentInventory.recordObservation({ ...componentParams, source: 'agent' }),
    });
    this.scannerIngestionService = new ScannerArtifactIngestionService<SecurityOpsContext>({
      resolveScannerArtifactPath: (workspaceDir, parsed) =>
        this.scannerArtifactIO.resolveScannerArtifactPath(workspaceDir, parsed),
      forEachArtifactLine: (artifact, onLine) => this.scannerArtifactIO.forEachArtifactLine(artifact, onLine),
      readArtifactJson: (artifact) => this.scannerArtifactIO.readArtifactJson(artifact),
      readArtifactJsonLines: (artifact) => this.scannerArtifactIO.readArtifactJsonLines(artifact),
      readOpenApiDocument: (artifact) => this.scannerArtifactIO.readOpenApiDocument(artifact),
      isRecord,
      getString,
      normalizeOptionalToolText,
      toNonNegativeInt,
      stableStringify,
      normalizeArtifactHost,
      normalizePort,
      parseHostPortLine,
      detectAssetKind,
      splitProductVersion,
      extractHttpxTechFingerprints,
      normalizeFfufEndpointUrl,
      ffufResponseSignature,
      isHighSignalFfufPath,
      assetRefFromScannerValue: (value, fallback) => this.assetRefFromScannerValue(value, fallback),
      normalizeScannerSeverity: (value) => this.normalizeScannerSeverity(value),
      extractScannerCveIds: (value) => this.extractScannerCveIds(value),
      extractScannerCweIds: (value) => this.extractScannerCweIds(value),
      resolveCandidateParentAsset: (parentParams) => this.resolveCandidateParentAsset(parentParams),
      ensureIngestedAsset: (assetParams) => this.ensureIngestedAsset(assetParams),
      reportService: (serviceParams) => this.reportService(serviceParams),
      reportNote: (noteParams) => this.reportNote(noteParams),
      recordScannerObservation: (observationParams) => this.recordScannerObservation(observationParams),
      reportScannerFinding: (findingParams) => this.reportScannerFinding(findingParams),
      resolveOpenApiBaseUrl: (document, rootAssetRef) =>
        this.openApiValidationLeadBuilder.resolveBaseUrl(document, rootAssetRef),
      extractOpenApiParameters: (value) => this.openApiValidationLeadBuilder.extractParameters(value),
      extractOpenApiBodyParams: (operation) => this.openApiValidationLeadBuilder.extractBodyParams(operation),
      buildOpenApiEndpointUrl: (baseUrl, routePath) =>
        this.openApiValidationLeadBuilder.buildEndpointUrl(baseUrl, routePath),
      extractOpenApiStringArray: (value) => this.openApiValidationLeadBuilder.extractStringArray(value),
      describeOpenApiAuthHint: (document, operation) =>
        this.openApiValidationLeadBuilder.describeAuthHint(document, operation),
      deriveOpenApiValidationLeads: (leadParams) =>
        this.openApiValidationLeadBuilder.deriveValidationLeads(leadParams),
      warn: (payload, message) => logger.warn(payload, message),
    });
  }

  private async emitSecurityOpsEvent(
    organizationId: string | undefined,
    event: {
      type: 'finding_created' | 'asset_discovered';
      payload: Record<string, unknown>;
      summary: string;
    },
  ): Promise<void> {
    await this.eventEmitter.emitSecurityOpsEvent(organizationId, event);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private normalizeContext(context?: SecurityOpsContext): SecurityOpsContext {
    if (!context) return {};
    const complianceAssessmentFramework = normalizeOptionalToolText(context.complianceAssessment?.framework);
    const complianceAssessment = complianceAssessmentFramework
      ? { framework: complianceAssessmentFramework }
      : undefined;
    const complianceReport = context.complianceReport
      ? {
          framework: normalizeOptionalToolText(context.complianceReport.framework),
          source: normalizeOptionalToolText(context.complianceReport.source),
          sourceRunId: normalizeOptionalUuid(context.complianceReport.sourceRunId),
        }
      : undefined;
    const activePhaseKey = normalizeOptionalToolText(context.activePhaseKey)?.toLowerCase();
    const workflowDisciplineRaw = normalizeOptionalToolText(context.workflowDiscipline)?.toLowerCase();
    const workflowDiscipline =
      workflowDisciplineRaw === 'pentest'
      || workflowDisciplineRaw === 'compliance'
      || workflowDisciplineRaw === 'code_review'
      ? workflowDisciplineRaw
      : undefined;
    return {
      organizationId: normalizeOptionalUuid(context.organizationId),
      scopeId: normalizeOptionalUuid(context.scopeId),
      runId: normalizeOptionalUuid(context.runId),
      ...(activePhaseKey ? { activePhaseKey } : {}),
      ...(workflowDiscipline ? { workflowDiscipline } : {}),
      ...(complianceAssessment ? { complianceAssessment } : {}),
      ...(complianceReport ? { complianceReport } : {}),
    };
  }

  private activeComplianceFramework(context: SecurityOpsContext): ComplianceFrameworkKey | undefined {
    const candidate =
      context.workflowDiscipline === 'compliance'
        ? context.complianceAssessment?.framework ?? context.complianceReport?.framework
        : context.complianceReport?.framework;
    return isComplianceFrameworkKey(candidate) ? candidate : undefined;
  }

  private requireOrganizationId(context: SecurityOpsContext): string {
    if (!context.organizationId) {
      throw new Error('organizationId is required in SecurityOps context');
    }
    return context.organizationId;
  }

  private requireScopeId(context: SecurityOpsContext): string {
    if (!context.scopeId) {
      throw new Error('scopeId is required in SecurityOps context');
    }
    return context.scopeId;
  }

  private async resolveCandidateParentAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    hostname: string;
    rootAssetRef?: z.infer<typeof AssetRefSchema>;
    executor?: DbExecutor;
  }): Promise<{ assetRef: z.infer<typeof AssetRefSchema>; created: boolean } | null> {
    const context = this.normalizeContext(params.context);
    return this.assetWriter.resolveCandidateParentAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context,
      hostname: params.hostname,
      rootAssetRef: params.rootAssetRef,
      executor: params.executor,
    });
  }

  private async emitRunSystemEvent(
    runId: string | undefined,
    note: string,
  ): Promise<void> {
    await this.eventEmitter.emitRunSystemEvent(runId, note);
  }

  private normalizeAssetRefForHost(params: {
    assetRef: z.infer<typeof AssetRefSchema>;
    hostname?: string;
    endpointUrl?: string;
  }): z.infer<typeof AssetRefSchema> {
    const normalizedAssetValue = normalizeAssetValue(params.assetRef.kind, params.assetRef.value);
    if (params.assetRef.kind !== 'domain') {
      return {
        kind: params.assetRef.kind,
        value: normalizedAssetValue,
      };
    }

    const normalizedHostnameFromInput = normalizeOptionalToolText(params.hostname);
    const normalizedHost = normalizedHostnameFromInput
      ? normalizeAssetValue('domain', normalizedHostnameFromInput)
      : params.endpointUrl
        ? extractHostnameFromUrl(params.endpointUrl)
        : undefined;

    if (!normalizedHost || normalizedHost === normalizedAssetValue) {
      return { kind: 'domain', value: normalizedAssetValue };
    }

    if (isSubdomainOf(normalizedHost, normalizedAssetValue)) {
      return { kind: 'domain', value: normalizedHost };
    }

    return { kind: 'domain', value: normalizedAssetValue };
  }

  private async incrementRunCounter(
    runId: string | undefined,
    counter: 'inventoryAdded' | 'findingsCount',
    executor: DbExecutor = this.deps.db,
  ): Promise<void> {
    await this.assetWriter.incrementRunCounter(runId, counter, executor);
  }

  private async resolveEvidenceRefs(
    workspaceDir: string,
    evidence: EvidenceRef[] | undefined,
  ): Promise<ResolvedEvidenceRef[]> {
    return this.evidenceResolver.resolveEvidenceRefs(workspaceDir, evidence);
  }

  private async resolveEvidenceWithExcerpts(
    workspaceDir: string,
    evidence: EvidenceWithExcerpt[],
  ): Promise<ResolvedEvidenceWithExcerpt[]> {
    return this.evidenceResolver.resolveEvidenceWithExcerpts(workspaceDir, evidence);
  }

  private async ensureIngestedAsset(params: {
    summary: IngestSummary;
    seenAssets: Set<string>;
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    assetRef: z.infer<typeof AssetRefSchema>;
    evidence: EvidenceRef[];
  }): Promise<void> {
    await this.assetReportingService.ensureIngestedAsset({
      summary: params.summary,
      seenAssets: params.seenAssets,
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: this.normalizeContext(params.context),
      assetRef: params.assetRef,
      evidence: params.evidence,
    });
  }

  private extractScannerCveIds(value: unknown): string[] {
    if (Array.isArray(value)) {
      return normalizeCveIds(value.filter((entry): entry is string => typeof entry === 'string'));
    }
    if (typeof value === 'string') {
      return normalizeCveIds(value.split(/[,;\s]+/u).filter(Boolean));
    }
    return [];
  }

  private extractScannerCweIds(value: unknown): string[] {
    if (Array.isArray(value)) {
      return normalizeCweIds(value.filter((entry): entry is string => typeof entry === 'string'));
    }
    if (typeof value === 'string') {
      return normalizeCweIds(value.split(/[,;\s]+/u).filter(Boolean));
    }
    return [];
  }

  private async resolveFindingEvidenceEntries(
    workspaceDir: string,
    evidence: ReportFindingEvidenceInput[],
  ): Promise<ResolvedFindingEvidence[]> {
    return this.evidenceResolver.resolveFindingEvidenceEntries(workspaceDir, evidence);
  }

  private async normalizeFindingCodeLocations(params: {
    workspaceDir: string;
    context?: SecurityOpsContext;
    codeLocations?: FindingCodeLocationInput[];
  }): Promise<FindingCodeLocation[]> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.evidenceResolver.normalizeFindingCodeLocations({
      workspaceDir: params.workspaceDir,
      organizationId,
      scopeId,
      codeLocations: params.codeLocations,
    });
  }

  private async upsertAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: ReportAssetInput & {
      parentAssetId?: string | null;
    };
    executor?: DbExecutor;
  }): Promise<{ assetId: string; created: boolean }> {
    const context = this.normalizeContext(params.context);
    return this.assetReportingService.upsertAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context,
      input: params.input,
      executor: params.executor,
    });
  }

  async reportAsset(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<ReportAssetResult> {
    const context = this.normalizeContext(params.context);
    return this.assetReportingService.reportAsset({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context,
      input: params.input,
    });
  }

  async reportService(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<ReportServiceResult> {
    const context = this.normalizeContext(params.context);
    return this.assetReportingService.reportService({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context,
      input: params.input,
    });
  }

  async ingestScanArtifact(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<IngestSummary> {
    return this.scannerIngestionService.ingestScanArtifact({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: this.normalizeContext(params.context),
      input: params.input,
    });
  }

  async reportNote(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    componentObservationSource?: 'httpx' | 'agent' | 'scan_preview' | 'connected_site' | 'lockfile';
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<{ noteId: string; created: boolean; dedupeKey: string }> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.inventoryNoteWriter.reportNote({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      componentObservationSource: params.componentObservationSource,
      context: {
        organizationId,
        scopeId,
        ...(context.runId ? { runId: context.runId } : {}),
      },
      input: params.input,
    });
  }

  async queryNotes(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryNotesResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.inventoryNoteQueryService.queryNotes({
      userId: params.userId,
      context: {
        organizationId,
        scopeId,
        workflowDiscipline: context.workflowDiscipline,
        activeComplianceFrameworkKey: this.activeComplianceFramework(context),
      },
      input: params.input,
    });
  }

  async updateValidationLeadPromptMetadata(params: {
    userId: string;
    context?: SecurityOpsContext;
    leadId: string;
    promptSha256: string;
    promptPath: string;
    normalizedLead: Record<string, unknown>;
  }): Promise<{
    leadId: string;
    promptSha256: string;
    promptPath: string;
    status: string;
  }> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.validationLeadService.updatePromptMetadata({
      userId: params.userId,
      organizationId,
      scopeId,
      leadId: params.leadId,
      promptSha256: params.promptSha256,
      promptPath: params.promptPath,
      normalizedLead: params.normalizedLead,
    });
  }

  async submitValidationLeadOutcome(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<SubmitValidationLeadOutcomeResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    const result = await this.validationLeadService.submitOutcome({
      userId: params.userId,
      organizationId,
      scopeId,
      input: params.input,
    });

    await this.emitRunSystemEvent(
      context.runId,
      `Validation lead ${result.leadId} closed as ${result.outcome}${result.autoDeferred ? ' by repeated blocker auto-deferral' : ''}.`,
    );
    return result;
  }

  async queryComplianceReadiness(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryComplianceReadinessResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceToolQueries.queryComplianceReadiness({
      organizationId,
      scopeId: context.scopeId ?? null,
      activeFrameworkKey: this.activeComplianceFramework(context),
      input: params.input,
    });
  }

  async queryComplianceEvidence(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryComplianceEvidenceResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceToolQueries.queryComplianceEvidence({
      organizationId,
      scopeId: context.scopeId ?? null,
      activeFrameworkKey: this.activeComplianceFramework(context),
      input: params.input,
    });
  }

  async queryComplianceProofPackage(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryComplianceProofPackageResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceToolQueries.queryComplianceProofPackage({
      organizationId,
      scopeId: context.scopeId ?? null,
      activeFrameworkKey: this.activeComplianceFramework(context),
      input: params.input,
    });
  }

  async queryComplianceMissingEvidence(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryComplianceMissingEvidenceResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceToolQueries.queryComplianceMissingEvidence({
      organizationId,
      scopeId: context.scopeId ?? null,
      activeFrameworkKey: this.activeComplianceFramework(context),
      input: params.input,
    });
  }

  async recordComplianceControlCheck(params: {
    userId: string;
    workspaceDir: string;
    sessionId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    if (!context.runId) {
      throw new Error('runId is required to record a compliance control check');
    }
    return this.complianceControlChecks.record({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      organizationId,
      scopeId,
      runId: context.runId,
      input: params.input,
    });
  }

  async recordComplianceControlRequest(params: {
    userId: string;
    sessionId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    if (!context.runId) {
      throw new Error('runId is required to record a compliance control request');
    }
    return this.complianceControlRequests.record({
      userId: params.userId,
      sessionId: params.sessionId,
      organizationId,
      scopeId,
      runId: context.runId,
      input: params.input,
    });
  }

  async reviewComplianceControlRequest(params: {
    userId: string;
    sessionId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    if (!context.runId) {
      throw new Error('runId is required to review a compliance control request');
    }
    return this.complianceControlRequests.review({
      actorId: params.sessionId,
      actorType: 'agent',
      organizationId,
      runId: context.runId,
      requestId: z.object({ requestId: z.string().uuid() }).parse(params.input).requestId,
      input: params.input,
    });
  }

  async mapComplianceEvidence(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const MappingSchema = z.object({
      evidenceItemId: z.string().uuid(),
      mappings: z.array(z.object({
        frameworkKey: z.enum(COMPLIANCE_FRAMEWORK_KEYS),
        controlId: z.string().min(1).max(80),
        mappingSource: z.enum(['system_suggested']).optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        rationale: z.string().max(2000).optional(),
        citationAnchors: z.array(z.object({
          page: z.number().int().positive().nullable().optional(),
          section: z.string().max(240).nullable().optional(),
          line: z.number().int().positive().nullable().optional(),
          chunkId: z.string().max(160).nullable().optional(),
          excerpt: z.string().max(1000).nullable().optional(),
          excerptSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
        })).max(10).optional(),
      })).min(1).max(20),
    });
    const parsed = MappingSchema.parse(params.input);
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceEvidenceService.upsertEvidenceMappings({
      organizationId,
      evidenceItemId: parsed.evidenceItemId,
      actorUserId: params.userId,
      mappings: parsed.mappings.map((mapping) => ({
        frameworkKey: mapping.frameworkKey,
        controlId: mapping.controlId,
        mappingSource: mapping.mappingSource ?? 'system_suggested',
        confidence: mapping.confidence ?? 'medium',
        rationale: mapping.rationale ?? null,
        citationAnchors: mapping.citationAnchors,
      })),
    });
  }

  async annotateComplianceEvidence(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const AnnotateSchema = z.object({
      evidenceItemId: z.string().uuid(),
      title: z.string().min(3).max(240).optional(),
      description: z.string().max(4000).nullable().optional(),
      evidenceType: z.enum([
        'policy',
        'access_review',
        'risk_register',
        'incident_record',
        'continuity_exercise',
        'vendor_review',
        'change_approval',
        'training_record',
        'system_export',
        'other',
      ]).optional(),
      validUntil: z.string().datetime().optional(),
    });
    const parsed = AnnotateSchema.parse(params.input);
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.complianceEvidenceService.annotateEvidenceItem({
      organizationId,
      evidenceItemId: parsed.evidenceItemId,
      actorUserId: params.userId,
      title: parsed.title,
      description: parsed.description,
      evidenceType: parsed.evidenceType,
      validUntil: parsed.validUntil ? new Date(parsed.validUntil) : undefined,
    });
  }

  async persistControlledExploitationResult(params: {
    userId: string;
    sessionId: string;
    context?: SecurityOpsContext;
    result: AttackResultV1;
  }): Promise<{
    findingIds: string[];
    evidenceIds: string[];
    status: AttackResultV1['status'];
  }> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    if (!context.runId || context.activePhaseKey !== 'exploitation') {
      throw new Error('Controlled exploitation persistence requires the active exploitation run context.');
    }

    const eligible = await this.deps.db
      .select({ findingId: findings.id })
      .from(runValidationQueue)
      .innerJoin(findings, eq(findings.id, runValidationQueue.findingId))
      .where(and(
        eq(runValidationQueue.runId, context.runId),
        eq(runValidationQueue.status, 'validated'),
        eq(runValidationQueue.outcome, 'validated'),
        inArray(findings.state, ['confirmed', 'resolved', 'accepted']),
        eq(findings.sourceKind, 'assessment'),
        eq(findings.organizationId, organizationId),
        eq(findings.scopeId, scopeId),
        inArray(findings.id, params.result.validatedFindingIds),
      ));
    const eligibleIds = new Set(eligible.map((row) => row.findingId));
    if (
      eligibleIds.size !== params.result.validatedFindingIds.length ||
      params.result.validatedFindingIds.some((id) => !eligibleIds.has(id))
    ) {
      throw new Error('Controlled exploitation result references a finding that is not same-run validated.');
    }

    const attackResultPath =
      `/workspace/.artifacts/workers/attack/${params.result.missionId}/attack-result.json`;
    const restricted =
      params.result.objectiveFamily === 'demonstrate_sensitive_data_access';
    const evidenceIds: string[] = [];
    await this.deps.db.transaction(async (tx) => {
      for (const findingId of params.result.validatedFindingIds) {
        const [evidence] = await tx
          .insert(findingEvidence)
          .values({
            organizationId,
            findingId,
            userId: params.userId,
            sessionId: params.sessionId,
            kind: 'artifact',
            path: attackResultPath,
            displayPath: attackResultPath,
            label: restricted
              ? 'Controlled exploitation result (restricted evidence)'
              : 'Controlled exploitation result',
            excerpt: params.result.proofClaim.slice(0, 1_000),
            fileMissing: false,
            data: params.result,
          })
          .onConflictDoUpdate({
            target: [findingEvidence.findingId, findingEvidence.path],
            set: {
              sessionId: params.sessionId,
              label: restricted
                ? 'Controlled exploitation result (restricted evidence)'
                : 'Controlled exploitation result',
              excerpt: params.result.proofClaim.slice(0, 1_000),
              fileMissing: false,
              data: params.result,
            },
          })
          .returning({ id: findingEvidence.id });
        if (evidence?.id) evidenceIds.push(evidence.id);

        await tx.insert(findingEvents).values({
          organizationId,
          findingId,
          userId: params.userId,
          type: 'impact_disposition',
          note: JSON.stringify({
            schemaVersion: 1,
            missionId: params.result.missionId,
            status: params.result.status,
            objectiveFamily: params.result.objectiveFamily,
            proofClaim: params.result.proofClaim,
            changedStateSummary: params.result.changedStateSummary,
            cleanup: params.result.cleanup,
            evidenceIds: params.result.evidenceIds,
            limitations: params.result.limitations,
          }),
        });
      }
    });

    return {
      findingIds: [...params.result.validatedFindingIds],
      evidenceIds,
      status: params.result.status,
    };
  }

  async reportFinding(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
    workerTasks?: Array<{ workerType: string; status: string }>;
    turnNumber?: number;
    abortSignal?: AbortSignal;
    executeModelCall?: TurnExecutorPort['executeModelCall'];
  }): Promise<ReportFindingResult> {
    return this.findingReportService.reportFinding({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: this.normalizeContext(params.context),
      input: params.input,
      workerTasks: params.workerTasks,
      turnNumber: params.turnNumber,
      abortSignal: params.abortSignal,
      executeModelCall: params.executeModelCall,
    });
  }

  async promoteFinding(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<PromoteFindingResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    return this.findingValidationService.promoteFinding({
      userId: params.userId,
      organizationId,
      input: params.input,
    });
  }

  /**
   * Close a Threat Watch verification.
   *
   * A confirmed verdict creates a real finding carrying the advisory id. Without
   * that the customer is told "yes you are exposed" and has nothing in their
   * findings list to act on, triage, or hand to whoever fixes it — which is most
   * of the value of having tested it at all.
   */
  async submitExposureVerification(params: {
    organizationId: string;
    /** The verification run; the match is found through it. */
    runId: string;
    userId: string;
    sessionId?: string;
    workspaceDir: string;
    outcome: 'confirmed' | 'not_reproduced' | 'inconclusive';
    method: string;
    reason?: string | null;
    confidence?: number | null;
    evidence?: Array<{ path: string; label?: string }>;
  }): Promise<{ exposureMatchId: string; state: string; riskId: string | null }> {
    // Exposure evidence is stricter than note evidence: every reference must be
    // a real file in this run's workspace. Excerpt-only fallback is useful for
    // imported scanner notes, but it would let model-authored text authorize a
    // validated CVE finding without a durable artifact.
    //
    // This is what makes "a confirmed verdict requires evidence" mean something.
    // Checking that the array is non-empty only proves the model typed a string:
    // an invented path would sail through and authorise a `validated` finding.
    // The resolver constrains the path to the workspace and rejects missing or
    // non-file references before the confirmation reaches the database.
    const resolvedEvidence = await this.resolveEvidenceRefs(
      params.workspaceDir,
      params.evidence ?? [],
    );

    return this.exposureVerificationCompletion.complete({
      ...params,
      evidence: resolvedEvidence,
    });
  }

  async submitValidationOutcome(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<SubmitValidationOutcomeResult> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const browserExchangeEvidence = await resolveBrowserExchangeEvidence({
      workspaceDir: params.workspaceDir,
      evidenceReferences: collectProofEvidenceReferences(params.input),
    });
    return this.findingValidationService.submitValidationOutcome({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      organizationId,
      runId: context.runId,
      input: params.input,
      structuredEvidence: browserExchangeEvidence.map((entry) => entry.input),
    });
  }

  async reportFinalizerPreflight(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
    plan?: FinalizerPlanStep[];
    reportedFindingIds?: string[];
    shellJobs?: Record<string, unknown>;
    alreadyFinalized?: boolean;
  }): Promise<ReportFinalizerPreflightResult> {
    return this.runReportWorkflowService.reportFinalizerPreflight({
      ...params,
      context: this.normalizeContext(params.context),
    });
  }

  async finalizeRunArtifacts(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
    plan?: FinalizerPlanStep[];
    reportedFindingIds?: string[];
    shellJobs?: Record<string, unknown>;
    alreadyFinalized?: boolean;
    finalizedMode?: FinalizeRunArtifactsMode;
  }): Promise<FinalizeRunArtifactsResult> {
    return this.runReportWorkflowService.finalizeRunArtifacts({
      ...params,
      context: this.normalizeContext(params.context),
    });
  }

  async reconcileAutomatedRunCloseout(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    plan?: FinalizerPlanStep[];
    reportedFindingIds?: string[];
    shellJobs?: Record<string, unknown>;
    alreadyFinalized?: boolean;
    finalizedMode?: FinalizeRunArtifactsMode;
  }): Promise<AutomatedRunCloseoutReconciliation> {
    return this.runReportWorkflowService.reconcileAutomatedRunCloseout({
      ...params,
      context: this.normalizeContext(params.context),
    });
  }

  async prepareReportContext(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    input: unknown;
    plan?: FinalizerPlanStep[];
    reportedFindingIds?: string[];
    shellJobs?: Record<string, unknown>;
    alreadyFinalized?: boolean;
  }): Promise<PrepareReportContextResult> {
    return this.runReportWorkflowService.prepareReportContext({
      ...params,
      context: this.normalizeContext(params.context),
    });
  }

  private focusComplianceReadinessForReportContext(
    readiness: ComplianceReadinessResponse,
    requestedFramework?: string | null,
  ): ComplianceReadinessResponse {
    return this.runReportWorkflowService.focusComplianceReadinessForReportContext(readiness, requestedFramework);
  }

  private normalizeScannerSeverity(value: unknown): FindingSeverity {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
      return normalized;
    }
    if (normalized === 'info' || normalized === 'informational' || normalized === 'unknown') {
      return 'info';
    }
    return 'info';
  }

  private assetRefFromScannerValue(value: unknown, fallback?: z.infer<typeof AssetRefSchema>): z.infer<typeof AssetRefSchema> | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return fallback;
    }
    const host = normalizeArtifactHost(value);
    if (!host) {
      return fallback;
    }
    return { kind: detectAssetKind(host), value: host };
  }

  private async recordScannerObservation(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    parser: IngestScanArtifactParser;
    artifactPath: string;
    assetRef?: z.infer<typeof AssetRefSchema>;
    findingId?: string;
    observationType: string;
    title: string;
    severity?: FindingSeverity;
    confidence?: number;
    dedupeParts: unknown[];
    data: Record<string, unknown>;
    evidence: EvidenceWithExcerpt[];
  }): Promise<{ observationId: string; created: boolean }> {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.scannerObservationWriter.recordObservation({
      ...params,
      context: {
        organizationId,
        scopeId,
        ...(context.runId ? { runId: context.runId } : {}),
      },
    });
  }

  private async reportScannerFinding(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    context?: SecurityOpsContext;
    parser: IngestScanArtifactParser;
    artifactPath: string;
    assetRef: z.infer<typeof AssetRefSchema>;
    title: string;
    severity: FindingSeverity;
    summary: string;
    technicalAnalysis: string;
    cweIds?: string[];
    cveIds?: string[];
    confidence?: number;
    codeLocations?: FindingCodeLocationInput[];
  }): Promise<{ findingId: string; created: boolean }> {
    const result = await this.reportFinding({
      userId: params.userId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      context: params.context,
      input: {
        assetRef: params.assetRef,
        title: params.title,
        severity: params.severity,
        summary: params.summary,
        businessImpact: 'Scanner produced a candidate vulnerability signal that may affect confidentiality, integrity, or availability. Independent validation is required before reportable promotion.',
        technicalAnalysis: params.technicalAnalysis,
        pocDescription: `Review and reproduce the scanner signal from ${params.parser}.`,
        pocScriptCode: 'N/A - scanner artifact evidence only; reproduce before promotion.',
        assumptions: 'Auto-ingested scanner signal. Treat as candidate until independently validated.',
        fixEffort: 'medium',
        remediation: 'Reproduce the issue, confirm affected component and version, then apply vendor or code-level remediation.',
        confidence: params.confidence ?? 0.6,
        evidence: [{ path: params.artifactPath, label: `${params.parser} artifact` }],
        ...(params.cweIds && params.cweIds.length > 0 ? { cweIds: params.cweIds } : {}),
        ...(params.cveIds && params.cveIds.length > 0 ? { cveIds: params.cveIds } : {}),
        ...(params.codeLocations && params.codeLocations.length > 0 ? { codeLocations: params.codeLocations } : {}),
      },
    });
    return { findingId: result.findingId, created: result.created };
  }

  async queryInventory(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<{
    assets: Array<Record<string, unknown>>;
    totalCount: number;
    leadCount: number;
    mode?: 'digest';
    digest?: {
      returnedAssets: number;
      confirmedAssets: number;
      leadAssets: number;
      needsBroadScan: number;
      limitReached: boolean;
    };
  }> {
    return this.inventoryQueryService.queryInventory({
      userId: params.userId,
      context: this.normalizeContext(params.context),
      input: params.input,
    });
  }

  async queryFindings(params: {
    userId: string;
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<QueryFindingsResult> {
    return this.findingQueryService.queryFindings({
      userId: params.userId,
      context: this.normalizeContext(params.context),
      input: params.input,
    });
  }

  async listConnectedRepositories(params: {
    context?: SecurityOpsContext;
    input?: unknown;
  }): Promise<ListConnectedRepositoriesResult> {
    const context = this.normalizeContext(params.context);
    return this.connectedRepositoryTools.listConnectedRepositories({
      orgId: this.requireOrganizationId(context),
      scopeId: this.requireScopeId(context),
      input: params.input,
    });
  }

  async searchConnectedRepository(params: {
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<SearchConnectedRepositoryResult> {
    const context = this.normalizeContext(params.context);
    return this.connectedRepositoryTools.searchConnectedRepository({
      orgId: this.requireOrganizationId(context),
      scopeId: this.requireScopeId(context),
      input: params.input,
    });
  }

  async readConnectedRepositoryFile(params: {
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<ReadConnectedRepositoryFileResult> {
    const context = this.normalizeContext(params.context);
    return this.connectedRepositoryTools.readConnectedRepositoryFile({
      orgId: this.requireOrganizationId(context),
      scopeId: this.requireScopeId(context),
      input: params.input,
    });
  }

  async submitFindingDispositionOutcome(params: {
    userId: string;
    workspaceDir: string;
    sessionId?: string;
    sessionStartedAt?: number;
    context?: SecurityOpsContext;
    input: unknown;
  }) {
    const context = this.normalizeContext(params.context);
    const organizationId = this.requireOrganizationId(context);
    const runId = context.runId?.trim();
    const sessionId = normalizeSessionId(params.sessionId);
    if (!runId || !sessionId) {
      throw new Error('submit_finding_disposition_outcome requires a product Run and session identity');
    }
    const input: FindingDispositionOutcomeInput = FindingDispositionOutcomeSchema.parse(params.input);
    const resolvedEvidence = await this.resolveFindingEvidenceEntries(
      params.workspaceDir,
      input.evidence as ReportFindingEvidenceInput[],
    );
    const historyEvidence = params.sessionStartedAt === undefined
      ? []
      : await resolveCurrentSessionHttpHistoryEvidence({
          workspaceDir: params.workspaceDir,
          evidenceReferences: [
            ...input.proof.evidenceIds,
            ...input.proof.controlEvidenceIds,
          ],
          sessionStartedAt: params.sessionStartedAt,
        });
    const resolvedHistoryEvidence = historyEvidence.map(({ aliases, input: historyInput }) => ({
      aliases,
      evidence: this.evidenceResolver.normalizeStructuredHttpEvidence(historyInput),
    }));
    const browserExchangeEvidence = await resolveBrowserExchangeEvidence({
      workspaceDir: params.workspaceDir,
      evidenceReferences: [
        ...input.proof.evidenceIds,
        ...input.proof.controlEvidenceIds,
      ],
      ...(params.sessionStartedAt !== undefined ? { sessionStartedAt: params.sessionStartedAt } : {}),
    });
    const resolvedBrowserExchangeEvidence = browserExchangeEvidence.map(({ aliases, input: exchangeInput }) => ({
      aliases,
      evidence: this.evidenceResolver.normalizeStructuredHttpEvidence(exchangeInput),
    }));
    return this.findingDispositionVerificationService.submitOutcome({
      organizationId,
      userId: params.userId,
      runId,
      sessionId,
      workspaceEvidence: resolvedEvidence.map((evidence) => ({
        kind: evidence.kind,
        path: evidence.path,
        displayPath: evidence.displayPath,
        ...(evidence.label ? { label: evidence.label } : {}),
        ...(evidence.kind === 'artifact'
          ? {
              excerpt: evidence.excerpt,
              fileMissing: evidence.fileMissing,
            }
          : { data: evidence.data }),
      })).concat(resolvedHistoryEvidence.map(({ aliases, evidence }) => ({
        kind: evidence.kind,
        path: evidence.path,
        displayPath: evidence.displayPath,
        ...(evidence.label ? { label: evidence.label } : {}),
        data: evidence.data,
        aliases,
      }))).concat(resolvedBrowserExchangeEvidence.map(({ aliases, evidence }) => ({
        kind: evidence.kind,
        path: evidence.path,
        displayPath: evidence.displayPath,
        ...(evidence.label ? { label: evidence.label } : {}),
        data: evidence.data,
        aliases,
      }))),
      input,
    });
  }

  async listCodeReviewRepositoryFiles(params: {
    context?: SecurityOpsContext;
    input: unknown;
  }): Promise<ListCodeReviewRepositoryFilesResult> {
    const context = this.normalizeContext(params.context);
    return this.connectedRepositoryTools.listCodeReviewRepositoryFiles({
      orgId: this.requireOrganizationId(context),
      scopeId: this.requireScopeId(context),
      input: params.input,
    });
  }

}
