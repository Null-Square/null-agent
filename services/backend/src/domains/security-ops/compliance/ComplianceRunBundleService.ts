import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  agentArtifacts,
  agentSessions,
  complianceEvidenceItems,
  findingEvidence,
  runs,
} from '@/db/schema';
import {
  isTextLikeComplianceEvidence,
  parseComplianceEvidenceReference,
  readComplianceEvidenceArtifact,
} from '@/domains/security-ops/compliance/ComplianceEvidenceFileResolver';
import {
  resolveProofEvidenceReference,
  type ProofEvidenceResolution,
} from '@/domains/security-ops/findings/ProofEvidenceReferenceResolver';
import type {
  RunTraceBundleEntry,
  RunTraceComplianceBundleSource,
  RunTraceResponse,
  RunTraceRunRef,
} from '@/domains/security-ops/runs/RunTraceService';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import { parseS3Uri } from '@/shared/storage/s3Utils';

import { ComplianceControlCheckReviewService } from './ComplianceControlCheckReviewService';
import type {
  ComplianceControlCheckView,
  ComplianceReadinessResponse,
} from './ComplianceReadinessModel';

const MAX_EVIDENCE_FILES = 250;
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const MAX_SINGLE_EVIDENCE_BYTES = 8 * 1024 * 1024;
const PREVIEW_BYTES = 100 * 1024;

type CheckContext = ComplianceControlCheckView & {
  frameworkKey: string;
  frameworkLabel: string;
  controlId: string;
  controlTitle: string;
  controlVerdict: string;
  controlOutcome: string;
  proofObligation: { id: string; statement: string } | null;
};

type EvidenceCandidate = {
  reference: string;
  checkIds: string[];
  sessionIds: string[];
};

type EvidenceManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
};

type EvidenceManifestItem = {
  reference: string;
  normalizedReference: string;
  checkIds: string[];
  sessionIds: string[];
  sourceType: string;
  sourceRef: string;
  resolutionStatus: 'resolved' | 'unresolved' | 'oversized';
  redacted: boolean;
  warning: string | null;
  bundledPath: string | null;
  sha256: string | null;
  files: EvidenceManifestFile[];
};

export type ComplianceEvidencePreview = {
  reference: string;
  resolutionStatus: 'resolved' | 'unresolved' | 'oversized';
  sourceType: string;
  sourceRef: string;
  mimeType: string | null;
  bytes: number | null;
  sha256: string | null;
  redacted: boolean;
  warning: string | null;
  text: string | null;
  binary: boolean;
  truncated: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (content: Buffer | string): string =>
  createHash('sha256').update(content).digest('hex');

const safePathPart = (value: string): string => {
  const normalized = value.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return normalized.slice(0, 100) || 'evidence';
};

export const normalizePortableEvidenceReference = (value: string): string => {
  let normalized = value.trim().replace(/\\/g, '/').replace(/[),.;]+$/u, '');
  normalized = normalized.replace(/^(raw-http|exchange|http-history):/iu, '');
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
  } else if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, '');
};

const evidenceReferenceMatches = (
  reference: string,
  value: string | null | undefined,
): boolean => {
  if (!value) return false;
  const normalizedReference = normalizePortableEvidenceReference(reference);
  const normalizedValue = normalizePortableEvidenceReference(value);
  if (normalizedReference === normalizedValue) {
    return true;
  }
  return normalizedReference.startsWith('.artifacts/') &&
    normalizedValue.endsWith(`/${normalizedReference}`);
};

const jsonEntry = (entryPath: string, value: unknown): RunTraceBundleEntry => ({
  path: entryPath,
  content: JSON.stringify(value, null, 2),
});

/** Durable record of an HTTP exchange recovered from the trace (the workspace is
 *  deleted post-run, so trace events are the durable source for evidence verification). */
type HttpExchangeRecord = {
  historyEntryId: string;
  toolName: string | null;
  url: string | null;
  method: string | null;
  statusCode: number | null;
  responseTimeMs: number | null;
  bodySize: number | null;
  bodyPreview: string | null;
  responseHeaders: Record<string, unknown> | null;
  capturedAt: string | null;
};

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Index HTTP exchanges from trace tool.finish events by their history_entry_id. */
export const buildHttpExchangeMap = (trace: RunTraceResponse | undefined): Map<string, HttpExchangeRecord> => {
  const map = new Map<string, HttpExchangeRecord>();
  for (const event of trace?.events ?? []) {
    if (event.event !== 'tool.finish') continue;
    const payload = isRecord(event.payload) ? event.payload : null;
    const result = payload && isRecord(payload.result) ? payload.result : null;
    if (!result) continue;
    const id = asString(result.history_entry_id);
    if (!id) continue;
    map.set(id, {
      historyEntryId: id,
      toolName: asString(payload?.toolName),
      url: asString(result.url),
      method: asString(result.method),
      statusCode: asNumber(result.status_code),
      responseTimeMs: asNumber(result.response_time_ms),
      bodySize: asNumber(result.body_size),
      bodyPreview: asString(result.body_preview),
      responseHeaders: isRecord(result.interesting_headers) ? result.interesting_headers : null,
      capturedAt: asString(event.ts),
    });
  }
  return map;
};

const flattenChecks = (readiness: ComplianceReadinessResponse): CheckContext[] =>
  readiness.frameworks.flatMap((framework) =>
    framework.controls.flatMap((control) =>
      control.controlChecks.map((check) => ({
        ...check,
        frameworkKey: framework.key,
        frameworkLabel: framework.label,
        controlId: control.id,
        controlTitle: control.title,
        controlVerdict: control.verdict,
        controlOutcome: control.outcome,
        proofObligation: control.proofObligation,
      })),
    ),
  );

const collectCandidates = (checks: CheckContext[]): EvidenceCandidate[] => {
  const candidates = new Map<string, { checkIds: Set<string>; sessionIds: Set<string> }>();
  for (const check of checks) {
    const references = [
      ...check.evidenceRefs,
      ...check.proof.evidenceIds,
      ...(check.proof.replayArtifact ? [check.proof.replayArtifact] : []),
    ];
    for (const reference of references) {
      const normalized = reference.trim();
      if (!normalized) continue;
      const candidate = candidates.get(normalized) ?? {
        checkIds: new Set<string>(),
        sessionIds: new Set<string>(),
      };
      candidate.checkIds.add(check.id);
      candidate.sessionIds.add(check.sessionId);
      candidates.set(normalized, candidate);
    }
  }
  return Array.from(candidates.entries())
    .map(([reference, value]) => ({
      reference,
      checkIds: Array.from(value.checkIds).sort(),
      sessionIds: Array.from(value.sessionIds).sort(),
    }))
    .sort((left, right) => left.reference.localeCompare(right.reference));
};

export class ComplianceRunBundleService implements RunTraceComplianceBundleSource {
  private readonly reviewService: ComplianceControlCheckReviewService;
  private readonly artifactStorageRoot: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly deps: {
      artifactStorageRoot?: string;
      s3ArtifactsClient?: S3StorageService;
      now?: () => Date;
    } = {},
  ) {
    this.reviewService = new ComplianceControlCheckReviewService(db);
    this.artifactStorageRoot = path.resolve(
      process.cwd(),
      deps.artifactStorageRoot ?? 'storage/artifacts',
    );
  }

  async getRunBundleEntries(
    run: RunTraceRunRef,
    sessionIds: readonly string[],
    closeoutEntries: readonly RunTraceBundleEntry[],
    trace?: RunTraceResponse,
  ): Promise<RunTraceBundleEntry[]> {
    if (!run.id) return [];
    const material = await this.loadRunMaterial(run.id, sessionIds);
    if (!material) return [];

    const httpExchanges = buildHttpExchangeMap(trace);
    const checks = flattenChecks(material.review.readiness);
    const evidence = await this.buildEvidenceEntries(
      collectCandidates(checks),
      material,
      httpExchanges,
    );
    const persistedCloseoutReadiness = this.readCloseoutReadiness(closeoutEntries);
    const closeoutReadiness = persistedCloseoutReadiness ?? material.review.readiness;
    const closeoutSnapshotSource = persistedCloseoutReadiness
      ? 'closeout_artifact'
      : 'current_readiness_fallback';
    const drift = this.buildDrift({
      closeoutReadiness,
      closeoutSnapshotSource,
      currentReadiness: material.review.readiness,
      checks,
      manifestItems: evidence.manifestItems,
    });
    const auditPackage = this.buildAuditPackage(checks, evidence.manifestItems);
    const reviews = checks
      .flatMap((check) =>
        check.reviewHistory.map((review) => ({
          ...review,
          checkId: check.id,
          frameworkKey: check.frameworkKey,
          controlId: check.controlId,
        })),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return [
      {
        path: 'compliance/README.md',
        content: [
          '# Compliance Proof Bundle',
          '',
          'This directory contains the immutable control checks recorded by the run, append-only reviewer decisions, portable evidence, and a closeout-to-current drift comparison.',
          '',
          '- A rejected check is ineligible; it does not establish the opposite verdict.',
          '- Unresolved evidence is listed explicitly in evidence-manifest.json.',
          '- HTTP history copies redact sensitive request headers. Raw HTTP byte artifacts remain exact.',
          '- readiness-at-closeout.json records whether it came from a persisted closeout artifact or a current-readiness fallback.',
          '',
        ].join('\n'),
      },
      jsonEntry('compliance/readiness-at-closeout.json', {
        ...closeoutReadiness,
        bundleSnapshot: {
          source: closeoutSnapshotSource,
          generatedAt: this.now().toISOString(),
          fallback: !persistedCloseoutReadiness,
        },
      }),
      jsonEntry('compliance/readiness-current.json', material.review.readiness),
      jsonEntry('compliance/control-checks.json', {
        schemaVersion: 1,
        generatedAt: this.now().toISOString(),
        runId: run.id,
        checks,
        sessionContributions: material.review.sessionContributions,
      }),
      jsonEntry('compliance/reviews.json', {
        schemaVersion: 1,
        generatedAt: this.now().toISOString(),
        runId: run.id,
        reviews,
      }),
      jsonEntry('compliance/evidence-manifest.json', {
        schemaVersion: 1,
        generatedAt: this.now().toISOString(),
        runId: run.id,
        total: evidence.manifestItems.length,
        resolved: evidence.manifestItems.filter((item) => item.resolutionStatus === 'resolved').length,
        unresolved: evidence.manifestItems.filter((item) => item.resolutionStatus === 'unresolved').length,
        oversized: evidence.manifestItems.filter((item) => item.resolutionStatus === 'oversized').length,
        items: evidence.manifestItems,
      }),
      jsonEntry('compliance/audit-package/control-evidence-index.json', {
        schemaVersion: 1,
        generatedAt: this.now().toISOString(),
        runId: run.id,
        controls: auditPackage.controls,
      }),
      {
        path: 'compliance/audit-package/README.md',
        content: auditPackage.markdown,
      },
      jsonEntry('compliance/drift.json', drift),
      ...evidence.entries,
    ];
  }

  async getEvidencePreview(
    runId: string,
    reference: string,
    trace?: RunTraceResponse,
  ): Promise<ComplianceEvidencePreview | null> {
    const material = await this.loadRunMaterial(runId, []);
    if (!material) return null;
    const checks = flattenChecks(material.review.readiness);
    const normalizedReference = normalizePortableEvidenceReference(reference);
    const candidate = collectCandidates(checks).find((item) =>
      item.reference === reference ||
      normalizePortableEvidenceReference(item.reference) === normalizedReference,
    );
    if (!candidate) return null;
    const resolution = await this.resolveCandidate(candidate, material, buildHttpExchangeMap(trace));
    const file = resolution.files[0];
    if (!file) {
      return {
        reference,
        resolutionStatus: resolution.resolutionStatus,
        sourceType: resolution.sourceType,
        sourceRef: resolution.sourceRef,
        mimeType: null,
        bytes: null,
        sha256: null,
        redacted: resolution.redacted,
        warning: resolution.warning,
        text: null,
        binary: false,
        truncated: false,
      };
    }
    const isText = isTextLikeComplianceEvidence(file.mimeType, file.relativePath);
    return {
      reference,
      resolutionStatus: resolution.resolutionStatus,
      sourceType: resolution.sourceType,
      sourceRef: resolution.sourceRef,
      mimeType: file.mimeType,
      bytes: file.content.length,
      sha256: sha256(file.content),
      redacted: resolution.redacted,
      warning: resolution.warning,
      text: isText ? file.content.subarray(0, PREVIEW_BYTES).toString('utf8') : null,
      binary: !isText,
      truncated: file.content.length > PREVIEW_BYTES || resolution.files.length > 1,
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async loadRunMaterial(runId: string, knownSessionIds: readonly string[]) {
    const [run] = await this.db
      .select({
        id: runs.id,
        organizationId: runs.organizationId,
        scopeId: runs.scopeId,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) return null;
    const review = await this.reviewService.getRunReview({
      organizationId: run.organizationId,
      runId,
    });
    if (!review) return null;

    const reviewSessionIds = review.sessionContributions.map((item) => item.sessionId);
    const sessionIds = Array.from(new Set([...knownSessionIds, ...reviewSessionIds]));
    const sessions = sessionIds.length > 0
      ? await this.db
          .select({ id: agentSessions.id, workspaceDir: agentSessions.workspaceDir })
          .from(agentSessions)
          .where(inArray(agentSessions.id, sessionIds))
      : [];
    const findingRows = sessionIds.length > 0
      ? await this.db
          .select({
            id: findingEvidence.id,
            sessionId: findingEvidence.sessionId,
            findingId: findingEvidence.findingId,
            kind: findingEvidence.kind,
            path: findingEvidence.path,
            displayPath: findingEvidence.displayPath,
            label: findingEvidence.label,
            excerpt: findingEvidence.excerpt,
            data: findingEvidence.data,
            fileMissing: findingEvidence.fileMissing,
          })
          .from(findingEvidence)
          .where(and(
            eq(findingEvidence.organizationId, run.organizationId),
            inArray(findingEvidence.sessionId, sessionIds),
          ))
      : [];
    const artifacts = sessionIds.length > 0
      ? await this.db
          .select()
          .from(agentArtifacts)
          .where(inArray(agentArtifacts.sessionId, sessionIds))
      : [];
    const evidenceRows = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(
        eq(complianceEvidenceItems.organizationId, run.organizationId),
        or(eq(complianceEvidenceItems.scopeId, run.scopeId), isNull(complianceEvidenceItems.scopeId))!,
      ));

    return { run, review, sessions, findingRows, artifacts, evidenceRows };
  }

  private async readPersistedArtifact(filePath: string): Promise<Buffer | null> {
    const parsedS3 = parseS3Uri(filePath);
    if (parsedS3) {
      if (!this.deps.s3ArtifactsClient || parsedS3.bucket !== this.deps.s3ArtifactsClient.getBucket()) {
        return null;
      }
      return this.deps.s3ArtifactsClient.getObjectBuffer(parsedS3.key).catch(() => null);
    }
    const absolutePath = path.resolve(this.artifactStorageRoot, filePath);
    const relative = path.relative(this.artifactStorageRoot, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return fs.readFile(absolutePath).catch(() => null);
  }

  private async resolveCandidate(
    candidate: EvidenceCandidate,
    material: NonNullable<Awaited<ReturnType<ComplianceRunBundleService['loadRunMaterial']>>>,
    httpExchanges?: Map<string, HttpExchangeRecord>,
  ): Promise<ProofEvidenceResolution> {
    // Durable HTTP-exchange evidence: the workspace HTTP history is deleted on run
    // teardown, so recover the exchange from the trace (request URL/method, response
    // status/headers/body preview) — enough to verify a control-check verdict.
    const normalizedReference = normalizePortableEvidenceReference(candidate.reference);
    const complianceEvidenceId = parseComplianceEvidenceReference(candidate.reference);
    if (complianceEvidenceId) {
      const evidence = material.evidenceRows.find((row) => row.id === complianceEvidenceId);
      if (evidence) {
        const stored = await readComplianceEvidenceArtifact(evidence.artifact, {
          maxBytes: MAX_SINGLE_EVIDENCE_BYTES,
        });
        if (stored.status === 'resolved') {
          return {
            originalReference: candidate.reference,
            normalizedReference,
            resolutionStatus: 'resolved',
            sourceType: 'compliance_evidence',
            sourceRef: `compliance-evidence:${evidence.id}`,
            files: [{
              relativePath: safePathPart(stored.artifact.fileName ?? `${evidence.id}.bin`),
              mimeType: stored.artifact.mimeType ?? 'application/octet-stream',
              content: stored.content,
            }],
            redacted: false,
            warning: null,
          };
        }
        return {
          originalReference: candidate.reference,
          normalizedReference,
          resolutionStatus: stored.status === 'oversized' ? 'oversized' : 'unresolved',
          sourceType: 'compliance_evidence',
          sourceRef: `compliance-evidence:${evidence.id}`,
          files: [],
          redacted: false,
          warning: stored.warning,
        };
      }
    }

    const exchange =
      httpExchanges?.get(candidate.reference) ??
      httpExchanges?.get(normalizedReference);
    if (exchange) {
      return {
        originalReference: candidate.reference,
        normalizedReference,
        resolutionStatus: 'resolved',
        sourceType: 'http_history',
        sourceRef: `http-history:${normalizedReference}`,
        files: [{
          relativePath: `http-exchange-${safePathPart(normalizedReference)}.json`,
          mimeType: 'application/json',
          content: Buffer.from(JSON.stringify(exchange, null, 2), 'utf8'),
        }],
        redacted: true,
        warning: null,
      };
    }

    const orderedSessions = [
      ...candidate.sessionIds,
      ...material.sessions.map((session) => session.id),
    ];
    for (const sessionId of Array.from(new Set(orderedSessions))) {
      const session = material.sessions.find((item) => item.id === sessionId);
      if (!session) continue;
      const resolution = await resolveProofEvidenceReference({
        workspaceDir: session.workspaceDir,
        evidenceId: candidate.reference,
      });
      if (resolution.resolutionStatus !== 'unresolved') return resolution;
      if (normalizedReference !== candidate.reference) {
        const normalizedResolution = await resolveProofEvidenceReference({
          workspaceDir: session.workspaceDir,
          evidenceId: normalizedReference,
        });
        if (normalizedResolution.resolutionStatus !== 'unresolved') {
          return {
            ...normalizedResolution,
            originalReference: candidate.reference,
          };
        }
      }
    }

    const finding = material.findingRows.find((item) =>
      evidenceReferenceMatches(candidate.reference, item.id) ||
      evidenceReferenceMatches(candidate.reference, item.path) ||
      evidenceReferenceMatches(candidate.reference, item.displayPath),
    );
    if (finding) {
      return {
        originalReference: candidate.reference,
        normalizedReference,
        resolutionStatus: 'resolved',
        sourceType: 'known_evidence',
        sourceRef: `finding-evidence:${finding.id}`,
        files: [{
          relativePath: `finding-evidence-${finding.id}.json`,
          mimeType: 'application/json',
          content: Buffer.from(JSON.stringify(finding, null, 2), 'utf8'),
        }],
        redacted: true,
        warning: finding.fileMissing ? 'The source evidence file was marked missing; canonical database evidence is included.' : null,
      };
    }

    const artifact = material.artifacts.find((item) =>
      evidenceReferenceMatches(candidate.reference, item.id) ||
      evidenceReferenceMatches(candidate.reference, item.filePath) ||
      evidenceReferenceMatches(candidate.reference, item.originalName) ||
      normalizePortableEvidenceReference(item.originalName).startsWith(`compliance-proof/${safePathPart(normalizedReference)}/`),
    );
    if (artifact) {
      if (artifact.sizeBytes > MAX_SINGLE_EVIDENCE_BYTES) {
        return {
          originalReference: candidate.reference,
          normalizedReference,
          resolutionStatus: 'oversized',
          sourceType: 'known_evidence',
          sourceRef: `agent-artifact:${artifact.id}`,
          files: [],
          redacted: false,
          warning: 'Persisted artifact exceeded the per-file compliance bundle limit.',
        };
      }
      const content = await this.readPersistedArtifact(artifact.filePath);
      if (content) {
        return {
          originalReference: candidate.reference,
          normalizedReference,
          resolutionStatus: 'resolved',
          sourceType: 'known_evidence',
          sourceRef: `agent-artifact:${artifact.id}`,
          files: [{
            relativePath: safePathPart(artifact.originalName),
            mimeType: artifact.fileType ?? 'application/octet-stream',
            content,
          }],
          redacted: false,
          warning: null,
        };
      }
    }

    return {
      originalReference: candidate.reference,
      normalizedReference,
      resolutionStatus: 'unresolved',
      sourceType: 'unresolved',
      sourceRef: candidate.reference,
      files: [],
      redacted: false,
      warning: 'Evidence could not be resolved from any contributing session, finding evidence, or persisted artifact.',
    };
  }

  private async buildEvidenceEntries(
    candidates: EvidenceCandidate[],
    material: NonNullable<Awaited<ReturnType<ComplianceRunBundleService['loadRunMaterial']>>>,
    httpExchanges?: Map<string, HttpExchangeRecord>,
  ): Promise<{ entries: RunTraceBundleEntry[]; manifestItems: EvidenceManifestItem[] }> {
    const entries: RunTraceBundleEntry[] = [];
    const manifestItems: EvidenceManifestItem[] = [];
    let totalBytes = 0;
    let fileCount = 0;

    for (const [index, candidate] of candidates.entries()) {
      const resolution = await this.resolveCandidate(candidate, material, httpExchanges);
      const files: EvidenceManifestFile[] = [];
      let status = resolution.resolutionStatus;
      let warning = resolution.warning;
      const directory = `${String(index + 1).padStart(3, '0')}-${sha256(candidate.reference).slice(0, 12)}`;

      for (const file of resolution.files) {
        if (
          fileCount >= MAX_EVIDENCE_FILES ||
          totalBytes + file.content.length > MAX_EVIDENCE_BYTES
        ) {
          status = 'oversized';
          warning = 'The compliance evidence bundle reached its file-count or total-byte limit.';
          break;
        }
        const entryPath = `compliance/evidence/${directory}/${safePathPart(path.basename(file.relativePath))}`;
        entries.push({ path: entryPath, content: file.content });
        files.push({
          path: entryPath,
          bytes: file.content.length,
          sha256: sha256(file.content),
          mimeType: file.mimeType,
        });
        fileCount += 1;
        totalBytes += file.content.length;
      }

      manifestItems.push({
        reference: candidate.reference,
        normalizedReference: resolution.normalizedReference,
        checkIds: candidate.checkIds,
        sessionIds: candidate.sessionIds,
        sourceType: resolution.sourceType,
        sourceRef: resolution.sourceRef,
        resolutionStatus: status,
        redacted: resolution.redacted,
        warning,
        bundledPath: files[0]?.path ?? null,
        sha256: files[0]?.sha256 ?? null,
        files,
      });
    }
    return { entries, manifestItems };
  }

  private readCloseoutReadiness(
    closeoutEntries: readonly RunTraceBundleEntry[],
  ): ComplianceReadinessResponse | null {
    for (const entry of closeoutEntries) {
      const isReportContext = entry.path.endsWith('/.artifacts/report/context.json');
      const isComplianceContext = entry.path.endsWith('/.artifacts/report/compliance-context.json');
      if (!isReportContext && !isComplianceContext) continue;
      try {
        const parsed = JSON.parse(
          Buffer.isBuffer(entry.content) ? entry.content.toString('utf8') : entry.content,
        ) as unknown;
        if (!isRecord(parsed)) continue;
        if (isComplianceContext && Array.isArray(parsed.frameworks)) {
          return parsed as unknown as ComplianceReadinessResponse;
        }
        if (isRecord(parsed.complianceReadiness)) {
          return parsed.complianceReadiness as unknown as ComplianceReadinessResponse;
        }
      } catch {
        // Continue to another reporting session if this context is corrupt.
      }
    }
    return null;
  }

  private buildDrift(params: {
    closeoutReadiness: ComplianceReadinessResponse | null;
    closeoutSnapshotSource: string;
    currentReadiness: ComplianceReadinessResponse;
    checks: CheckContext[];
    manifestItems: EvidenceManifestItem[];
  }) {
    const items: Array<{
      type: string;
      severity: 'warning' | 'error';
      frameworkKey?: string;
      controlId?: string;
      checkId?: string;
      reference?: string;
      message: string;
      closeoutValue?: string;
      currentValue?: string;
    }> = [];

    if (!params.closeoutReadiness) {
      items.push({
        type: 'closeout_snapshot_missing',
        severity: 'warning',
        message: 'No closeout readiness snapshot was available, so verdict drift cannot be fully compared.',
      });
    } else {
      const closeoutControls = new Map<string, string>(
        params.closeoutReadiness.frameworks.flatMap((framework) =>
          framework.controls.map((control) => [
            `${framework.key}:${control.id}`,
            control.verdict,
          ] as const),
        ),
      );
      for (const framework of params.currentReadiness.frameworks) {
        for (const control of framework.controls) {
          const key = `${framework.key}:${control.id}`;
          const closeoutVerdict = closeoutControls.get(key);
          if (closeoutVerdict && closeoutVerdict !== control.verdict) {
            items.push({
              type: 'verdict_changed',
              severity: 'warning',
              frameworkKey: framework.key,
              controlId: control.id,
              message: `${framework.label} ${control.id} changed from ${closeoutVerdict} to ${control.verdict}.`,
              closeoutValue: closeoutVerdict,
              currentValue: control.verdict,
            });
          }
        }
      }
    }

    for (const check of params.checks) {
      if (!check.fresh) {
        items.push({
          type: 'check_stale',
          severity: 'warning',
          frameworkKey: check.frameworkKey,
          controlId: check.controlId,
          checkId: check.id,
          message: `Control check ${check.id} is no longer fresh.`,
        });
      }
    }
    for (const item of params.manifestItems) {
      if (item.resolutionStatus !== 'resolved') {
        items.push({
          type: item.resolutionStatus === 'oversized' ? 'evidence_oversized' : 'evidence_unresolved',
          severity: 'error',
          reference: item.reference,
          message: item.warning ?? `Evidence ${item.reference} is not available in the bundle.`,
        });
      }
    }

    const checksByControl = new Map<string, CheckContext[]>();
    for (const check of params.checks.filter((item) => item.eligible && item.fresh)) {
      const key = `${check.frameworkKey}:${check.controlId}`;
      checksByControl.set(key, [...(checksByControl.get(key) ?? []), check]);
    }
    for (const [key, checks] of checksByControl) {
      if (
        checks.some((check) => check.verdict === 'pass') &&
        checks.some((check) => check.verdict === 'fail')
      ) {
        const [frameworkKey, controlId] = key.split(':');
        items.push({
          type: 'contradictory_checks',
          severity: 'error',
          frameworkKey,
          controlId,
          message: 'Fresh eligible pass and fail checks exist for the same control; failure precedence applies.',
        });
      }
    }

    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      runId: params.currentReadiness.runId,
      status: items.some((item) => item.severity === 'error')
        ? 'attention_required'
        : items.length > 0
          ? 'warnings'
          : 'clean',
      closeoutSnapshotAvailable: Boolean(params.closeoutReadiness),
      closeoutSnapshotSource: params.closeoutSnapshotSource,
      summary: {
        total: items.length,
        errors: items.filter((item) => item.severity === 'error').length,
        warnings: items.filter((item) => item.severity === 'warning').length,
      },
      items,
    };
  }

  private buildAuditPackage(
    checks: readonly CheckContext[],
    manifestItems: readonly EvidenceManifestItem[],
  ): {
    controls: Array<{
      frameworkKey: string;
      frameworkLabel: string;
      controlId: string;
      controlTitle: string;
      verdict: string;
      outcome: string;
      checks: Array<{
        id: string;
        basis: string;
        verdict: string;
        reason: string;
        proofObligationId: string;
        method: string;
        targetRef: string;
        limitations: string[];
        freshUntil: string;
        createdAt: string;
        evidence: Array<{
          reference: string;
          status: string;
          bundledPath: string | null;
          sha256: string | null;
          warning: string | null;
        }>;
      }>;
    }>;
    markdown: string;
  } {
    const evidenceByCheckId = new Map<string, EvidenceManifestItem[]>();
    for (const item of manifestItems) {
      for (const checkId of item.checkIds) {
        evidenceByCheckId.set(checkId, [...(evidenceByCheckId.get(checkId) ?? []), item]);
      }
    }

    const grouped = new Map<string, {
      frameworkKey: string;
      frameworkLabel: string;
      controlId: string;
      controlTitle: string;
      verdict: string;
      outcome: string;
      checks: CheckContext[];
    }>();
    for (const check of checks) {
      const key = `${check.frameworkKey}:${check.controlId}`;
      const entry = grouped.get(key) ?? {
        frameworkKey: check.frameworkKey,
        frameworkLabel: check.frameworkLabel,
        controlId: check.controlId,
        controlTitle: check.controlTitle,
        verdict: check.controlVerdict,
        outcome: check.controlOutcome,
        checks: [],
      };
      entry.checks.push(check);
      grouped.set(key, entry);
    }

    const controls = Array.from(grouped.values())
      .sort((left, right) => `${left.frameworkKey}:${left.controlId}`.localeCompare(`${right.frameworkKey}:${right.controlId}`))
      .map((control) => ({
        frameworkKey: control.frameworkKey,
        frameworkLabel: control.frameworkLabel,
        controlId: control.controlId,
        controlTitle: control.controlTitle,
        verdict: control.verdict,
        outcome: control.outcome,
        checks: control.checks
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((check) => ({
            id: check.id,
            basis: check.basis,
            verdict: check.verdict,
            reason: check.reason,
            proofObligationId: check.proofObligationId,
            method: check.method,
            targetRef: check.targetRef,
            limitations: check.limitations,
            freshUntil: check.freshUntil,
            createdAt: check.createdAt,
            evidence: (evidenceByCheckId.get(check.id) ?? []).map((item) => ({
              reference: item.reference,
              status: item.resolutionStatus,
              bundledPath: item.bundledPath,
              sha256: item.files[0]?.sha256 ?? null,
              warning: item.warning,
            })),
          })),
      }));

    const lines = [
      '# Compliance Audit Evidence Package',
      '',
      'This package is organized by framework control. Each section lists the agent control checks, verdict basis, proof obligation, limitations, and bundled evidence paths with integrity hashes.',
      '',
      `Controls with checks: ${controls.length}`,
      '',
    ];
    for (const control of controls) {
      lines.push(`## ${control.frameworkLabel} ${control.controlId}: ${control.controlTitle}`);
      lines.push('');
      lines.push(`- Current verdict: ${control.verdict}`);
      lines.push(`- Current outcome: ${control.outcome}`);
      lines.push(`- Checks in this package: ${control.checks.length}`);
      lines.push('');
      for (const check of control.checks) {
        lines.push(`### Check ${check.id}`);
        lines.push('');
        lines.push(`- Verdict: ${check.verdict}`);
        lines.push(`- Basis: ${check.basis}`);
        lines.push(`- Proof obligation: ${check.proofObligationId}`);
        lines.push(`- Method: ${check.method}`);
        lines.push(`- Target: ${check.targetRef}`);
        lines.push(`- Fresh until: ${check.freshUntil}`);
        lines.push(`- Reason: ${check.reason}`);
        if (check.limitations.length > 0) {
          lines.push(`- Limitations: ${check.limitations.join('; ')}`);
        }
        if (check.evidence.length > 0) {
          lines.push('- Evidence:');
          for (const item of check.evidence) {
            const sha = item.sha256 ? ` sha256=${item.sha256}` : '';
            const pathPart = item.bundledPath ? ` path=${item.bundledPath}` : '';
            const warning = item.warning ? ` warning=${item.warning}` : '';
            lines.push(`  - ${item.reference} status=${item.status}${pathPart}${sha}${warning}`);
          }
        } else {
          lines.push('- Evidence: none bundled for this check');
        }
        lines.push('');
      }
    }

    return { controls, markdown: lines.join('\n') };
  }
}
