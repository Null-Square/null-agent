import * as fs from 'fs/promises';
import * as path from 'path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { flattenEvidenceText, projectFindingForReport } from '@/domains/security-ops/findings/severityCalibration';

import type { DatabaseClient } from '@/db/client';
import { runEvents, runPhases, runs, type RiskState, type RunWorkflowDiscipline } from '@/db/schema';
import { persistDurableAgentArtifactFile } from '@/domains/security-ops/artifacts/DurableAgentArtifact';
import type { ComplianceReadinessResponse } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { buildFindingReportCompleteness } from '@/domains/security-ops/findings/findingReportCompleteness';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';
import {
  RunReportFinalizer,
  type AuthoredArtifactValidation,
} from '@/domains/security-ops/tools/reporting/RunReportFinalizer';
import { RunReportRenderer } from '@/domains/security-ops/tools/reporting/RunReportRenderer';
import {
  RunReportStateLoader,
  type FinalizerCoverageSummary,
  type FinalizerFindingRow,
  type FinalizerPlanStep,
  type FinalizerReportState,
  type RunCompletion as ReportingRunCompletion,
} from '@/domains/security-ops/tools/reporting/RunReportStateLoader';
import type { ReportRendererBrowserEvidenceSummary } from '@/domains/security-ops/tools/reporting/RunReportRenderer';
import { logger } from '@/shared/logger';
import { isReportableRiskState } from '@/domains/security-ops/risks/riskLifecycle';
import {
  normalizeReportingCloseoutOutcome,
  reportingCloseoutRequiresInterim,
  type ReportingCloseoutOutcome,
} from '@/domains/security-ops/tools/reporting/RunReportAuthority';

const FinalizeRunArtifactsSchema = z.object({
  mode: z.enum(['final', 'interim']).optional().default('final'),
  reason: z.string().min(1).optional(),
});

const PrepareReportContextSchema = z.object({
  detail: z.enum(['brief', 'full']).optional().default('brief'),
});

const ReportFinalizerPreflightSchema = z.object({
  intendedMode: z.enum(['final', 'interim']).optional(),
  checkAuthoredFiles: z.boolean().optional().default(false),
});

export type RunCompletion = ReportingRunCompletion;
export type FinalizeRunArtifactsMode = z.infer<typeof FinalizeRunArtifactsSchema>['mode'];
export type PrepareReportContextDetail = z.infer<typeof PrepareReportContextSchema>['detail'];
type ReportFinalizerPreflightInput = z.infer<typeof ReportFinalizerPreflightSchema>;

export type AutomatedRunCloseoutReconciliation = {
  outcome: 'finalized' | 'paused';
  mode: FinalizeRunArtifactsMode;
  runCompletion: RunCompletion;
  reason?: string;
};

export type ReportFinalizerPreflightResult = {
  generatedAt: string;
  preflightPath: string;
  finalized: boolean;
  canFinalizeFinal: boolean;
  canFinalizeInterim: boolean;
  requiredMode: FinalizeRunArtifactsMode;
  intendedMode: FinalizeRunArtifactsMode;
  reportingCloseoutOutcome?: ReportingCloseoutOutcome;
  findingCount: number;
  candidateCount: number;
  reportableCount: number;
  validatingCount: number;
  unpromotedCandidateBlockers: RunCompletion['unresolvedPromotableFindings'];
  missingDurableEvidenceBlockers: Array<{
    id: string;
    title: string;
    severity: string;
    state: RiskState;
    reason: string;
  }>;
  missingReportFieldBlockers: Array<{
    id: string;
    title: string;
    severity: string;
    state: RiskState;
    missingReportFields: string[];
    repairInstruction: string;
  }>;
  findingWarnings: string[];
  finalizerBlockers: string[];
  complianceBoundarySentence: string;
  exportExpectations: {
    summaryPath: string;
    reportPath: string;
    validationPath: string;
    contextPath: string;
    preflightPath: string;
  };
  runCompletion: RunCompletion;
  authoredArtifactCheck: {
    checked: boolean;
    canPass?: boolean;
    summaryPath?: string;
    reportPath?: string;
    summaryBytes?: number;
    reportBytes?: number;
    warnings?: string[];
    error?: string;
  };
};

export type FinalizeRunArtifactsResult = {
  mode: FinalizeRunArtifactsMode;
  summaryPath: string;
  reportPath: string;
  runCompletion: RunCompletion;
  findingCount: number;
  reportableFindingCount: number;
  warnings: string[];
};

export type PrepareReportContextResult = {
  detail: PrepareReportContextDetail;
  contextPath: string;
  briefPath: string;
  runCompletion: RunCompletion;
  findingCount: number;
  reportableFindingCount: number;
  candidateFindingCount: number;
  validatingFindingCount: number;
  complianceContextPath?: string;
  complianceTemplatePath?: string;
  complianceFrameworks: string[];
  recommendedSections: string[];
};

export type RunReportWorkflowContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  workflowDiscipline?: RunWorkflowDiscipline;
  complianceReport?: {
    framework?: string;
    source?: string;
    sourceRunId?: string;
  };
};

export const assertRunReportWorkflowSupported = (
  context?: RunReportWorkflowContext,
): void => {
  if (context?.workflowDiscipline === 'code_review') {
    throw new Error(
      'Code Review reporting requires its dedicated report workflow and cannot fall back to Pentest reporting',
    );
  }
};

type RunReportWorkflowParams = {
  userId: string;
  workspaceDir?: string;
  sessionId?: string;
  context?: RunReportWorkflowContext;
  plan?: FinalizerPlanStep[];
  reportedFindingIds?: string[];
  shellJobs?: Record<string, unknown>;
  alreadyFinalized?: boolean;
  finalizedMode?: FinalizeRunArtifactsMode;
};

type BrowserArtifactType = 'screenshot' | 'network' | 'bundle' | 'trace' | 'sensitive_state';

type BrowserArtifactFile = {
  type: BrowserArtifactType;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  createdAt: string;
};

type ReportingCloseoutAuthority = {
  outcome?: ReportingCloseoutOutcome;
  error?: string;
};

const browserWorkspacePath = (relativePath: string): string => `/workspace/${relativePath.replace(/\\/g, '/')}`;

const collectBrowserArtifactFiles = async (
  workspaceDir: string,
): Promise<BrowserArtifactFile[]> => {
  const browserRoot = path.join(workspaceDir, '.artifacts', 'browser');
  const files: BrowserArtifactFile[] = [];
  const categoryByDir: Record<string, BrowserArtifactType> = {
    screenshots: 'screenshot',
    network: 'network',
    bundles: 'bundle',
    traces: 'trace',
    state: 'sensitive_state',
  };

  for (const [dirName, type] of Object.entries(categoryByDir)) {
    const dir = path.join(browserRoot, dirName);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({
        type,
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replace(/\\/g, '/'),
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
  }

  return files.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 500);
};

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const parseBrowserChallengeBundle = async (
  file: BrowserArtifactFile,
): Promise<ReportRendererBrowserEvidenceSummary['challenges'][number] | null> => {
  if (file.type !== 'bundle' || !file.relativePath.endsWith('.json') || file.bytes > 1_500_000) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(file.absolutePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const challenge = record.challenge;
    if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) return null;
    const challengeRecord = challenge as Record<string, unknown>;
    const kind = toOptionalString(challengeRecord.kind);
    const confidence = toOptionalString(challengeRecord.confidence);
    if (!kind || !confidence) return null;
    return {
      artifactPath: browserWorkspacePath(file.relativePath),
      url: toOptionalString(record.url),
      title: toOptionalString(record.title),
      kind,
      confidence,
      blockingStage: toOptionalString(challengeRecord.blocking_stage),
      evidenceSummary: toOptionalString(challengeRecord.evidence_summary),
      recommendedAuthorizedPath: toOptionalString(challengeRecord.recommended_authorized_path),
    };
  } catch {
    return null;
  }
};

const collectBrowserEvidenceSummary = async (
  workspaceDir: string,
): Promise<ReportRendererBrowserEvidenceSummary> => {
  const files = await collectBrowserArtifactFiles(workspaceDir);
  const challenges = (
    await Promise.all(files.map((file) => parseBrowserChallengeBundle(file)))
  )
    .filter((entry): entry is ReportRendererBrowserEvidenceSummary['challenges'][number] => entry !== null)
    .slice(0, 20);

  return {
    screenshotCount: files.filter((file) => file.type === 'screenshot').length,
    networkArtifactCount: files.filter((file) => file.type === 'network').length,
    bundleArtifactCount: files.filter((file) => file.type === 'bundle').length,
    traceArtifactCount: files.filter((file) => file.type === 'trace').length,
    sensitiveStateArtifactCount: files.filter((file) => file.type === 'sensitive_state').length,
    challengeCount: challenges.length,
    latestArtifacts: files
      .filter((file) => file.type !== 'sensitive_state')
      .slice(0, 25)
      .map((file) => ({
        path: browserWorkspacePath(file.relativePath),
        type: file.type,
        bytes: file.bytes,
        createdAt: file.createdAt,
      })),
    challenges,
  };
};

const hasComplianceReportContextFlag = (context: RunReportWorkflowContext): boolean =>
  Boolean(context.complianceReport) || context.workflowDiscipline === 'compliance';

export class RunReportWorkflowService {
  private readonly runReportFinalizer: RunReportFinalizer;
  private readonly runReportRenderer: RunReportRenderer;
  private readonly runReportStateLoader: RunReportStateLoader;

  constructor(
    private readonly db: DatabaseClient,
    private readonly options: {
      now: () => Date;
      emitRunSystemEvent: (runId: string | undefined, note: string) => Promise<void>;
      artifactStorageRoot?: string;
    },
  ) {
    this.runReportRenderer = new RunReportRenderer();
    this.runReportFinalizer = new RunReportFinalizer(db, { now: options.now });
    this.runReportStateLoader = new RunReportStateLoader(db, this.runReportRenderer);
  }

  async reportFinalizerPreflight(params: RunReportWorkflowParams & {
    workspaceDir: string;
    input: unknown;
  }): Promise<ReportFinalizerPreflightResult> {
    assertRunReportWorkflowSupported(params.context);
    const parsed: ReportFinalizerPreflightInput = ReportFinalizerPreflightSchema.parse(params.input);
    const reportState = await this.buildFinalizerReportState(params);
    const reportingCloseoutAuthority = await this.loadReportingCloseoutAuthority(params);
    const reportingCloseoutOutcome = reportingCloseoutAuthority.outcome;
    const reportingCloseoutBlocksFinal =
      reportingCloseoutRequiresInterim(reportingCloseoutOutcome) ||
      Boolean(reportingCloseoutAuthority.error);
    const reportDir = path.join(params.workspaceDir, '.artifacts', 'report');
    const preflightPath = path.join(reportDir, 'finalizer-preflight.json');
    const reportable = reportState.findings.filter((finding) => isReportableRiskState(finding.state));
    const candidates = reportState.findings.filter(
      (finding) => finding.state === 'potential' || finding.state === 'not_reproduced',
    );
    const validating = reportState.findings.filter((finding) => finding.state === 'verifying');
    const reportCompletenessByFindingId = new Map(
      reportState.findings.map((finding) => [finding.id, buildFindingReportCompleteness(finding)]),
    );
    const missingDurableEvidenceBlockers = reportable
      .filter((finding) => !this.runReportStateLoader.finalizerFindingHasDurableEvidence(finding))
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        state: finding.state,
        reason: 'reportable Risk has no durable evidence artifact or HTTP exchange available for report citation',
      }));
    const stateBlockers =
      reportState.runCompletion.state === 'ready_for_finalization'
        ? []
        : reportState.runCompletion.reasons;
    const durableBlockers = missingDurableEvidenceBlockers.map(
      (finding) => `validated finding ${finding.id} has no durable evidence citation`,
    );
    const missingReportFieldBlockers = reportable
      .map((finding) => ({
        finding,
        reportCompleteness: reportCompletenessByFindingId.get(finding.id) ?? buildFindingReportCompleteness(finding),
      }))
      .filter(({ reportCompleteness }) => !reportCompleteness.canFinalizeReportable)
      .map(({ finding, reportCompleteness }) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        state: finding.state,
        missingReportFields: reportCompleteness.missingReportFields,
        repairInstruction:
          reportCompleteness.repairInstruction ??
          `Call report_finding with validatesFindingId="${finding.id}" and backfill missing report fields.`,
      }));
    const reportFieldBlockers = missingReportFieldBlockers.map(
      (finding) => `validated finding ${finding.id} missing report fields: ${finding.missingReportFields.join(', ')}`,
    );
    const coveragePhaseBlockers = await this.loadUnresolvedCoveragePhaseBlockers(params.context?.runId);
    const findingWarnings = reportState.findings
      .map((finding) => ({
        finding,
        reportCompleteness: reportCompletenessByFindingId.get(finding.id) ?? buildFindingReportCompleteness(finding),
      }))
      .filter(({ reportCompleteness }) => reportCompleteness.missingReportFields.length > 0)
      .map(
        ({ finding, reportCompleteness }) =>
          `finding ${finding.id} (${finding.title}) missing report fields: ${reportCompleteness.missingReportFields.join(', ')}`,
      );
    // D19/D25 — said here, before the prose is written, while the reporting phase can still
    // repair it. Warnings rather than blockers: both readings are judgements about text, and
    // a wrong one must cost a sentence, not a finished run.
    for (const finding of reportState.findings) {
      const projection = this.projectFindingSeverity(finding);
      if (projection.severityCalibration?.ceilingApplied === true) {
        findingWarnings.push(
          `finding ${finding.id} (${finding.title}) claims ${projection.severityCalibration.declaredSeverity} `
          + `with no validation outcome; report it as ${projection.severity} until validation raises it`,
        );
      }
      for (const claim of projection.unsupportedImpactClaims) {
        findingWarnings.push(`finding ${finding.id} (${finding.title}) — ${claim.refusal}`);
      }
    }
    let canFinalizeFinal =
      reportState.runCompletion.state === 'ready_for_finalization' &&
      missingDurableEvidenceBlockers.length === 0 &&
      missingReportFieldBlockers.length === 0 &&
      coveragePhaseBlockers.length === 0 &&
      !reportingCloseoutBlocksFinal;
    const intendedMode: FinalizeRunArtifactsMode = parsed.intendedMode ?? (canFinalizeFinal ? 'final' : 'interim');
    const authoredArtifactCheck: ReportFinalizerPreflightResult['authoredArtifactCheck'] = {
      checked: parsed.checkAuthoredFiles,
    };

    if (parsed.checkAuthoredFiles) {
      try {
        const validation = await this.validateAuthoredRunArtifacts({
          workspaceDir: params.workspaceDir,
          mode: intendedMode,
          findings: reportState.findings,
          coverage: reportState.coverage,
        });
        authoredArtifactCheck.canPass = true;
        authoredArtifactCheck.summaryPath = validation.summaryPath;
        authoredArtifactCheck.reportPath = validation.reportPath;
        authoredArtifactCheck.summaryBytes = validation.summaryBytes;
        authoredArtifactCheck.reportBytes = validation.reportBytes;
        authoredArtifactCheck.warnings = validation.warnings;
      } catch (error) {
        authoredArtifactCheck.canPass = false;
        authoredArtifactCheck.error = error instanceof Error ? error.message : String(error);
        if (intendedMode === 'final') {
          canFinalizeFinal = false;
        }
      }
    }

    const finalizerBlockers = [
      ...stateBlockers,
      ...durableBlockers,
      ...reportFieldBlockers,
      ...coveragePhaseBlockers,
      ...(reportingCloseoutRequiresInterim(reportingCloseoutOutcome)
        ? [`reporting handoff requires interim closeout: ${reportingCloseoutOutcome}`]
        : []),
      ...(reportingCloseoutAuthority.error ? [reportingCloseoutAuthority.error] : []),
      ...(authoredArtifactCheck.error ? [`authored artifact validation failed: ${authoredArtifactCheck.error}`] : []),
    ];
    const requiredMode: FinalizeRunArtifactsMode = canFinalizeFinal ? 'final' : 'interim';
    const generatedAt = this.now().toISOString();
    const result: ReportFinalizerPreflightResult = {
      generatedAt,
      preflightPath,
      finalized: false,
      canFinalizeFinal,
      canFinalizeInterim: reportState.runCompletion.finalized !== true,
      requiredMode,
      intendedMode,
      ...(reportingCloseoutOutcome ? { reportingCloseoutOutcome } : {}),
      findingCount: reportState.findings.length,
      candidateCount: candidates.length,
      reportableCount: reportable.length,
      validatingCount: validating.length,
      unpromotedCandidateBlockers: reportState.runCompletion.unresolvedPromotableFindings,
      missingDurableEvidenceBlockers,
      missingReportFieldBlockers,
      findingWarnings,
      finalizerBlockers,
      complianceBoundarySentence: COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
      exportExpectations: {
        summaryPath: 'summary.md',
        reportPath: 'report.md',
        validationPath: '.artifacts/report/validation.json',
        contextPath: '.artifacts/report/context.json',
        preflightPath: '.artifacts/report/finalizer-preflight.json',
      },
      runCompletion: reportState.runCompletion,
      authoredArtifactCheck,
    };

    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      preflightPath,
      `${JSON.stringify(
        {
          ...result,
          preflightPath: result.exportExpectations.preflightPath,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    await this.options.emitRunSystemEvent(
      params.context?.runId,
      `report_finalizer_preflight selected ${requiredMode} closeout mode`,
    );
    return result;
  }

  async finalizeRunArtifacts(params: RunReportWorkflowParams & {
    workspaceDir: string;
    input: unknown;
  }): Promise<FinalizeRunArtifactsResult> {
    assertRunReportWorkflowSupported(params.context);
    const parsed = FinalizeRunArtifactsSchema.parse(params.input);
    const mode = parsed.mode;
    const reportState = await this.buildFinalizerReportState(params);
    const reportingCloseoutAuthority = await this.loadReportingCloseoutAuthority(params);
    const reportingCloseoutOutcome = reportingCloseoutAuthority.outcome;
    await this.persistComplianceCloseoutContextIfApplicable({
      ...params,
      reportState,
    });
    const missingReportFieldBlockers = reportState.findings
      .filter((finding) => isReportableRiskState(finding.state))
      .map((finding) => ({
        finding,
        reportCompleteness: buildFindingReportCompleteness(finding),
      }))
      .filter(({ reportCompleteness }) => !reportCompleteness.canFinalizeReportable)
      .map(
        ({ finding, reportCompleteness }) =>
          `validated finding ${finding.id} missing report fields: ${reportCompleteness.missingReportFields.join(', ')}`,
      );
    const coveragePhaseBlockers = await this.loadUnresolvedCoveragePhaseBlockers(params.context?.runId);

    if (mode === 'final' && reportState.runCompletion.state !== 'ready_for_finalization') {
      throw new Error(
        `Cannot finalize run as final: ${reportState.runCompletion.reasons.join('; ') || 'run is not ready'}`,
      );
    }
    if (mode === 'final' && reportingCloseoutRequiresInterim(reportingCloseoutOutcome)) {
      throw new Error(
        `Cannot finalize run as final: reporting handoff requires interim closeout (${reportingCloseoutOutcome})`,
      );
    }
    if (mode === 'final' && reportingCloseoutAuthority.error) {
      throw new Error(`Cannot finalize run as final: ${reportingCloseoutAuthority.error}`);
    }
    if (mode === 'final' && missingReportFieldBlockers.length > 0) {
      throw new Error(
        `Cannot finalize run as final: ${missingReportFieldBlockers.join('; ')}`,
      );
    }
    if (mode === 'final' && coveragePhaseBlockers.length > 0) {
      throw new Error(`Cannot finalize run as final: ${coveragePhaseBlockers.join('; ')}`);
    }

    const validation = await this.validateAuthoredRunArtifacts({
      workspaceDir: params.workspaceDir,
      mode,
      findings: reportState.findings,
      coverage: reportState.coverage,
    });

    const completedRunCompletion: RunCompletion = {
      ...reportState.runCompletion,
      state: 'completed',
      ready: true,
      finalized: true,
      reasons:
        mode === 'final'
          ? ['finalize_run_artifacts completed successfully']
          : [
              'finalize_run_artifacts completed interim closeout',
              ...reportState.runCompletion.reasons,
            ],
    };

    await this.writeReportValidationArtifact({
      workspaceDir: params.workspaceDir,
      mode,
      runCompletion: completedRunCompletion,
      findingCount: reportState.findings.length,
      reportableFindingCount: reportState.findings.filter((row) => isReportableRiskState(row.state)).length,
      validation,
    });

    await this.options.emitRunSystemEvent(
      params.context?.runId,
      `finalize_run_artifacts finalized authored ${mode} closeout artifacts`,
    );
    await this.markRunCompleted(
      params.context?.runId,
      mode === 'final'
        ? 'finalize_run_artifacts completed final report closeout'
        : 'finalize_run_artifacts completed interim report closeout',
    );

    return {
      mode,
      summaryPath: validation.summaryPath,
      reportPath: validation.reportPath,
      runCompletion: completedRunCompletion,
      findingCount: reportState.findings.length,
      reportableFindingCount: reportState.findings.filter((row) => isReportableRiskState(row.state)).length,
      warnings: validation.warnings,
    };
  }

  async reconcileAutomatedRunCloseout(params: RunReportWorkflowParams & {
    workspaceDir: string;
  }): Promise<AutomatedRunCloseoutReconciliation> {
    assertRunReportWorkflowSupported(params.context);
    const reportState = await this.buildFinalizerReportState(params);
    const reportingCloseoutAuthority = await this.loadReportingCloseoutAuthority(params);
    const reportingCloseoutOutcome = reportingCloseoutAuthority.outcome;
    const reportingCloseoutBlocksFinal =
      reportingCloseoutRequiresInterim(reportingCloseoutOutcome) ||
      Boolean(reportingCloseoutAuthority.error);

    if (reportState.runCompletion.state === 'completed') {
      await this.persistComplianceCloseoutContextIfApplicable({
        ...params,
        reportState,
      });
      return {
        outcome: 'finalized',
        mode: params.finalizedMode ?? 'final',
        runCompletion: reportState.runCompletion,
      };
    }

    if (
      reportState.runCompletion.state === 'ready_for_finalization' &&
      !reportingCloseoutBlocksFinal
    ) {
      try {
        const finalized = await this.finalizeRunArtifacts({
          ...params,
          input: {
            mode: 'final',
            reason: 'server-side closeout reconciliation after automated session completion',
          },
        });
        return {
          outcome: 'finalized',
          mode: finalized.mode,
          runCompletion: finalized.runCompletion,
        };
      } catch (error) {
        const reason =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'final closeout validation failed';
        const warningValidation = await this.readAuthoredRunArtifactsWithWarning({
          workspaceDir: params.workspaceDir,
          warning: reason,
        });
        if (warningValidation) {
          const reportableFindingCount = reportState.findings.filter(
            (row) => isReportableRiskState(row.state),
          ).length;
          const completedRunCompletion: RunCompletion = {
            ...reportState.runCompletion,
            state: 'completed',
            ready: true,
            finalized: true,
            reasons: [
              'automated closeout completed interim report artifacts with validation warnings',
              reason,
            ],
          };
          await this.writeReportValidationArtifact({
            workspaceDir: params.workspaceDir,
            mode: 'interim',
            runCompletion: completedRunCompletion,
            findingCount: reportState.findings.length,
            reportableFindingCount,
            validation: warningValidation,
          });
          await this.markRunCompleted(
            params.context?.runId,
            'closeout reconciliation completed interim report closeout with validation warnings',
          );
          await this.options.emitRunSystemEvent(
            params.context?.runId,
            `closeout reconciliation completed interim report closeout with validation warning: ${reason}`,
          );
          return {
            outcome: 'finalized',
            mode: 'interim',
            runCompletion: completedRunCompletion,
            reason,
          };
        }
        return {
          outcome: 'paused',
          mode: 'interim',
          runCompletion: reportState.runCompletion,
          reason,
        };
      }
    }

    const reportableFindingCount = reportState.findings.filter(
      (row) => isReportableRiskState(row.state),
    ).length;
    let reason = reportingCloseoutAuthority.error
      ?? (reportingCloseoutRequiresInterim(reportingCloseoutOutcome)
        ? `reporting handoff requires interim closeout (${reportingCloseoutOutcome})`
        : reportState.runCompletion.reasons.join('; ') || 'run closeout is not ready');

    try {
      await this.persistComplianceCloseoutContextIfApplicable({
        ...params,
        reportState,
      });
      const validation = await this.validateAuthoredRunArtifacts({
        workspaceDir: params.workspaceDir,
        mode: 'interim',
        findings: reportState.findings,
        coverage: reportState.coverage,
      });
      const completedRunCompletion: RunCompletion = {
        ...reportState.runCompletion,
        state: 'completed',
        ready: true,
        finalized: true,
        reasons: [
          'automated closeout completed interim report artifacts',
          ...reportState.runCompletion.reasons,
        ],
      };
      await this.writeReportValidationArtifact({
        workspaceDir: params.workspaceDir,
        mode: 'interim',
        runCompletion: completedRunCompletion,
        findingCount: reportState.findings.length,
        reportableFindingCount,
        validation,
      });
      await this.markRunCompleted(
        params.context?.runId,
        'closeout reconciliation completed interim report closeout',
      );
      await this.options.emitRunSystemEvent(
        params.context?.runId,
        'closeout reconciliation completed interim report closeout',
      );
      return {
        outcome: 'finalized',
        mode: 'interim',
        runCompletion: completedRunCompletion,
      };
    } catch (error) {
      const validationReason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'interim closeout validation failed';
      const warningValidation = await this.readAuthoredRunArtifactsWithWarning({
        workspaceDir: params.workspaceDir,
        warning: validationReason,
      });
      if (warningValidation) {
        const completedRunCompletion: RunCompletion = {
          ...reportState.runCompletion,
          state: 'completed',
          ready: true,
          finalized: true,
          reasons: [
            'automated closeout completed interim report artifacts with validation warnings',
            ...reportState.runCompletion.reasons,
          ],
        };
        await this.writeReportValidationArtifact({
          workspaceDir: params.workspaceDir,
          mode: 'interim',
          runCompletion: completedRunCompletion,
          findingCount: reportState.findings.length,
          reportableFindingCount,
          validation: warningValidation,
        });
        await this.markRunCompleted(
          params.context?.runId,
          'closeout reconciliation completed interim report closeout with validation warnings',
        );
        await this.options.emitRunSystemEvent(
          params.context?.runId,
          `closeout reconciliation completed interim report closeout with validation warning: ${validationReason}`,
        );
        return {
          outcome: 'finalized',
          mode: 'interim',
          runCompletion: completedRunCompletion,
          reason: validationReason,
        };
      }
      reason = `${reason}; ${validationReason}`;
    }

    await this.options.emitRunSystemEvent(
      params.context?.runId,
      `closeout reconciliation paused the run: ${reason}`,
    );

    return {
      outcome: 'paused',
      mode: 'interim',
      runCompletion: reportState.runCompletion,
      reason,
    };
  }

  /**
   * Reads one finding's severity and impact claims the same way everywhere the report layer
   * asks. Kept on the service so the preflight and the context file cannot disagree.
   */
  private projectFindingSeverity(finding: FinalizerFindingRow): {
    severity: string;
    declaredSeverity: string;
    severityLabel: string;
    severityCalibration: ReturnType<typeof projectFindingForReport>['calibration'];
    unsupportedImpactClaims: ReturnType<typeof projectFindingForReport>['unsupportedImpactClaims'];
  } {
    const projection = projectFindingForReport({
      severity: finding.severity,
      state: finding.state,
      hasDurableEvidence: this.runReportStateLoader.finalizerFindingHasDurableEvidence(finding),
      prose: [
        finding.summary,
        finding.businessImpact,
        finding.technicalAnalysis,
        finding.pocDescription,
        finding.assumptions,
      ],
      evidence: [
        finding.pocScriptCode,
        ...(finding.evidence ?? []).flatMap((row) => [
          row.label,
          row.excerpt,
          row.data ? flattenEvidenceText(row.data) : null,
        ]),
      ],
    });

    return {
      // One authoritative severity for whoever writes the report, and the original claim
      // beside it under its own name. Handing an author both `severity` and
      // `severityForReport` is an invitation to cite the inflated one.
      severity: projection.severityForReport,
      declaredSeverity: finding.severity,
      severityLabel: projection.severityLabel,
      severityCalibration: projection.calibration,
      unsupportedImpactClaims: projection.unsupportedImpactClaims,
    };
  }

  async prepareReportContext(params: RunReportWorkflowParams & {
    workspaceDir: string;
    input: unknown;
  }): Promise<PrepareReportContextResult> {
    assertRunReportWorkflowSupported(params.context);
    const parsed = PrepareReportContextSchema.parse(params.input);
    const normalizedContext = params.context ?? {};
    const reportState = await this.buildFinalizerReportState({
      ...params,
      context: normalizedContext,
    });
    const reportDir = path.join(params.workspaceDir, '.artifacts', 'report');
    const contextPath = path.join(reportDir, 'context.json');
    const complianceContextPath = path.join(reportDir, 'compliance-context.json');
    const complianceTemplatePath = path.join(reportDir, 'compliance-template.md');
    const complianceCanonicalSectionPath = path.join(reportDir, 'compliance-canonical-section.md');
    const briefPath = path.join(reportDir, 'brief.md');
    const reportable = reportState.findings.filter((finding) => isReportableRiskState(finding.state));
    const candidates = reportState.findings.filter(
      (finding) => finding.state === 'potential' || finding.state === 'not_reproduced',
    );
    const validating = reportState.findings.filter(
      (finding) => finding.state === 'verifying',
    );
    // D19/D25 — the report is where a severity becomes a claim to a customer, so it is where
    // an unvalidated severity is capped and an impact sentence is checked against the evidence
    // the finding actually carries. The declared severity travels with it; nothing is lost.
    const findingsWithReportCompleteness = reportState.findings.map((finding) => ({
      ...this.runReportRenderer.withReportCompleteness(finding),
      ...this.projectFindingSeverity(finding),
    }));
    const complianceReportEnabled = await this.isComplianceReportContextEnabled(normalizedContext);
    const reportFramework = complianceReportEnabled
      ? await this.runReportFinalizer.resolveReportFramework({
          runId: normalizedContext.runId,
          contextFramework: normalizedContext.complianceReport?.framework,
        })
      : null;
    const complianceReadiness = complianceReportEnabled
      ? this.runReportFinalizer.focusComplianceReadinessForReportContext(
          await this.runReportFinalizer.buildComplianceReadinessForReportContext({
            organizationId: reportState.organizationId,
            scopeId: reportState.scopeId,
            runId: normalizedContext.runId,
            source: normalizedContext.complianceReport?.source,
            sourceRunId: normalizedContext.complianceReport?.sourceRunId,
          }),
          reportFramework,
        )
      : undefined;
    const complianceFrameworks = complianceReadiness?.frameworks.map((framework) => framework.label) ?? [];
    const recommendedSections = this.runReportRenderer.recommendReportSections(reportState, complianceReadiness);
    const browserEvidence = await collectBrowserEvidenceSummary(params.workspaceDir);

    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      contextPath,
      `${JSON.stringify(
        {
          generatedAt: this.now().toISOString(),
          detail: parsed.detail,
          organizationId: reportState.organizationId,
          scopeId: reportState.scopeId,
          runCompletion: reportState.runCompletion,
          findings: findingsWithReportCompleteness,
          notes: parsed.detail === 'full'
            ? reportState.notes
            : this.runReportRenderer.compactReportContextNotes(reportState.notes),
          coverage: reportState.coverage,
          browserEvidence,
          ...(complianceReadiness ? { complianceReadiness } : {}),
          recommendedSections,
          authoringContract: {
            summaryPath: 'summary.md',
            reportPath: 'report.md',
            finalizerRole: 'validate authored files and mark RunCompletion; it does not write report prose',
            ...(complianceReadiness ? { complianceReportBoundary: COMPLIANCE_READINESS_BOUNDARY_SENTENCE } : {}),
            ...(complianceReadiness?.frameworks.some((framework) => framework.selected && framework.supported && framework.key === 'gdpr')
              ? { complianceFrameworkBoundaries: { gdpr: GDPR_READINESS_BOUNDARY_SENTENCE } }
              : {}),
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    const templateWritten = complianceReadiness
      ? await (async () => {
          await fs.writeFile(
            complianceContextPath,
            `${JSON.stringify(complianceReadiness, null, 2)}\n`,
            'utf-8',
          );
          await fs.writeFile(
            complianceCanonicalSectionPath,
            this.runReportRenderer.renderCanonicalComplianceReportSection(complianceReadiness),
            'utf-8',
          );
          return this.runReportFinalizer.writeComplianceTemplateIfApplicable({
            complianceReadiness,
            templatePath: complianceTemplatePath,
          });
        })()
      : false;
    await fs.writeFile(
      briefPath,
      this.runReportRenderer.renderReportContextBrief({
        reportState,
        reportable,
        candidates,
        ...(complianceReadiness ? { complianceReadiness } : {}),
        recommendedSections,
        browserEvidence,
      }),
      'utf-8',
    );
    await this.persistReportHandoffArtifacts({
      sessionId: params.sessionId,
      files: [
        { originalName: '.artifacts/report/context.json', absolutePath: contextPath },
        { originalName: '.artifacts/report/brief.md', absolutePath: briefPath },
        ...(complianceReadiness
          ? [
              { originalName: '.artifacts/report/compliance-context.json', absolutePath: complianceContextPath },
              { originalName: '.artifacts/report/compliance-canonical-section.md', absolutePath: complianceCanonicalSectionPath },
            ]
          : []),
        ...(templateWritten
          ? [{ originalName: '.artifacts/report/compliance-template.md', absolutePath: complianceTemplatePath }]
          : []),
      ],
    });

    await this.options.emitRunSystemEvent(
      params.context?.runId,
      'prepare_report_context wrote reporter handoff artifacts',
    );

    return {
      detail: parsed.detail,
      contextPath,
      briefPath,
      runCompletion: reportState.runCompletion,
      findingCount: reportState.findings.length,
      reportableFindingCount: reportable.length,
      candidateFindingCount: candidates.length,
      validatingFindingCount: validating.length,
      ...(complianceReadiness ? { complianceContextPath } : {}),
      ...(templateWritten ? { complianceTemplatePath } : {}),
      complianceFrameworks,
      recommendedSections,
    };
  }

  private async persistComplianceCloseoutContextIfApplicable(params: RunReportWorkflowParams & {
    workspaceDir: string;
    reportState: FinalizerReportState;
  }): Promise<ComplianceReadinessResponse | null> {
    const normalizedContext = params.context ?? {};
    if (!(await this.isComplianceReportContextEnabled(normalizedContext))) {
      return null;
    }
    const reportFramework = await this.runReportFinalizer.resolveReportFramework({
      runId: normalizedContext.runId,
      contextFramework: normalizedContext.complianceReport?.framework,
    });
    const complianceReadiness = this.runReportFinalizer.focusComplianceReadinessForReportContext(
      await this.runReportFinalizer.buildComplianceReadinessForReportContext({
        organizationId: params.reportState.organizationId,
        scopeId: params.reportState.scopeId,
        runId: normalizedContext.runId,
        source: normalizedContext.complianceReport?.source,
        sourceRunId: normalizedContext.complianceReport?.sourceRunId,
      }),
      reportFramework,
    );
    const reportDir = path.join(params.workspaceDir, '.artifacts', 'report');
    const complianceContextPath = path.join(reportDir, 'compliance-context.json');
    const complianceCanonicalSectionPath = path.join(reportDir, 'compliance-canonical-section.md');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      complianceContextPath,
      `${JSON.stringify(complianceReadiness, null, 2)}\n`,
      'utf-8',
    );
    await fs.writeFile(
      complianceCanonicalSectionPath,
      this.runReportRenderer.renderCanonicalComplianceReportSection(complianceReadiness),
      'utf-8',
    );
    await this.persistReportHandoffArtifacts({
      sessionId: params.sessionId,
      files: [
        { originalName: '.artifacts/report/compliance-context.json', absolutePath: complianceContextPath },
        { originalName: '.artifacts/report/compliance-canonical-section.md', absolutePath: complianceCanonicalSectionPath },
      ],
    });
    return complianceReadiness;
  }

  private async isComplianceReportContextEnabled(context: RunReportWorkflowContext): Promise<boolean> {
    if (hasComplianceReportContextFlag(context)) {
      return true;
    }
    if (!context.runId) {
      return false;
    }
    try {
      const [row] = await this.db
        .select({ workflowDiscipline: runs.workflowDiscipline })
        .from(runs)
        .where(eq(runs.id, context.runId))
        .limit(1);
      return row?.workflowDiscipline === 'compliance';
    } catch (error) {
      logger.warn(
        {
          scope: 'RunReportWorkflowService',
          runId: context.runId,
          err: error,
        },
        'Failed to resolve run workflow discipline for report context; skipping compliance closeout fallback',
      );
      return false;
    }
  }

  focusComplianceReadinessForReportContext(
    readiness: ComplianceReadinessResponse,
    requestedFramework?: string | null,
  ): ComplianceReadinessResponse {
    return this.runReportFinalizer.focusComplianceReadinessForReportContext(readiness, requestedFramework);
  }

  private async buildFinalizerReportState(params: RunReportWorkflowParams): Promise<FinalizerReportState> {
    const context = params.context ?? {};
    const organizationId = this.requireOrganizationId(context);
    const scopeId = this.requireScopeId(context);
    return this.runReportStateLoader.buildReportState({
      userId: params.userId,
      organizationId,
      scopeId,
      sessionId: params.sessionId,
      runId: context.runId,
      complianceSourceRunId: context.complianceReport?.sourceRunId,
      plan: params.plan,
      reportedFindingIds: params.reportedFindingIds,
      shellJobs: params.shellJobs,
      alreadyFinalized: params.alreadyFinalized,
    });
  }

  private async loadReportingCloseoutAuthority(params: {
    workspaceDir?: string;
    context?: RunReportWorkflowContext;
  }): Promise<ReportingCloseoutAuthority> {
    const runId = params.context?.runId;
    if (!runId || !params.workspaceDir) {
      return {};
    }
    const [reportingPhase] = await this.db
      .select({ handoffOutRef: runPhases.handoffOutRef })
      .from(runPhases)
      .where(
        and(
          eq(runPhases.runId, runId),
          eq(runPhases.phaseKey, 'reporting'),
          sql`${runPhases.handoffOutRef} is not null`,
        ),
      )
      .orderBy(desc(runPhases.ordinal))
      .limit(1);
    const handoffRef = reportingPhase?.handoffOutRef?.trim();
    if (!handoffRef) {
      return {};
    }
    const workspaceRoot = path.resolve(params.workspaceDir);
    if (path.isAbsolute(handoffRef)) {
      return { error: 'reporting handoff reference is outside the run workspace' };
    }
    const handoffPath = path.resolve(workspaceRoot, handoffRef);
    const relative = path.relative(workspaceRoot, handoffPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { error: 'reporting handoff reference is outside the run workspace' };
    }
    try {
      const payload = JSON.parse(await fs.readFile(handoffPath, 'utf-8')) as Record<string, unknown>;
      const outcome = normalizeReportingCloseoutOutcome(payload.closeoutOutcome);
      if ('closeoutOutcome' in payload && payload.closeoutOutcome !== undefined && !outcome) {
        return { error: 'reporting handoff has an invalid closeoutOutcome' };
      }
      return outcome ? { outcome } : {};
    } catch (error) {
      logger.warn(
        { scope: 'RunReportWorkflowService', runId, handoffRef, err: error },
        'Reporting handoff could not be read for closeout authority',
      );
      return { error: 'reporting handoff could not be read for closeout authority' };
    }
  }

  private async persistReportHandoffArtifacts(params: {
    sessionId?: string | null;
    files: Array<{ originalName: string; absolutePath: string }>;
  }): Promise<void> {
    if (!params.sessionId) {
      return;
    }
    for (const file of params.files) {
      await persistDurableAgentArtifactFile({
        db: this.db,
        sessionId: params.sessionId,
        absolutePath: file.absolutePath,
        originalName: file.originalName,
        artifactStorageRoot: this.options.artifactStorageRoot,
      });
    }
  }

  private async readAuthoredRunArtifactsWithWarning(params: {
    workspaceDir: string;
    warning: string;
  }): Promise<AuthoredArtifactValidation | null> {
    return this.runReportFinalizer.readAuthoredRunArtifactsWithWarning(params);
  }

  private async validateAuthoredRunArtifacts(params: {
    workspaceDir: string;
    mode: FinalizeRunArtifactsMode;
    findings: FinalizerFindingRow[];
    coverage: FinalizerCoverageSummary;
  }): Promise<AuthoredArtifactValidation> {
    await this.applyPreparedCanonicalComplianceSection(params.workspaceDir);
    return this.runReportFinalizer.validateAuthoredRunArtifacts(params);
  }

  private async applyPreparedCanonicalComplianceSection(workspaceDir: string): Promise<void> {
    const complianceContextPath = path.join(workspaceDir, '.artifacts', 'report', 'compliance-context.json');
    const reportPath = path.join(workspaceDir, 'report.md');
    let readiness: ComplianceReadinessResponse;
    try {
      readiness = JSON.parse(await fs.readFile(complianceContextPath, 'utf-8')) as ComplianceReadinessResponse;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code === 'ENOENT') return;
      throw error;
    }
    if (!Array.isArray(readiness.frameworks) || readiness.frameworks.length === 0) {
      return;
    }

    let report: string;
    try {
      report = await fs.readFile(reportPath, 'utf-8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code === 'ENOENT') return;
      throw error;
    }
    const updated = this.runReportRenderer.applyCanonicalComplianceReportSection(report, readiness);
    if (updated !== report) {
      await fs.writeFile(reportPath, updated, 'utf-8');
    }
  }

  private async writeReportValidationArtifact(params: {
    workspaceDir: string;
    mode: FinalizeRunArtifactsMode;
    runCompletion: RunCompletion;
    findingCount: number;
    reportableFindingCount: number;
    validation: AuthoredArtifactValidation;
  }): Promise<void> {
    await this.runReportFinalizer.writeReportValidationArtifact(params);
    if (params.runCompletion.state === 'completed' && params.runCompletion.finalized) {
      await this.writeFinalizedPreflightArtifact(params);
    }
  }

  private async writeFinalizedPreflightArtifact(params: {
    workspaceDir: string;
    mode: FinalizeRunArtifactsMode;
    runCompletion: RunCompletion;
    findingCount: number;
    reportableFindingCount: number;
    validation: AuthoredArtifactValidation;
  }): Promise<void> {
    const reportDir = path.join(params.workspaceDir, '.artifacts', 'report');
    const preflightPath = path.join(reportDir, 'finalizer-preflight.json');
    let previous: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(preflightPath, 'utf-8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        previous = parsed as Record<string, unknown>;
      }
    } catch {
      // Recovery closeout can legitimately finalize without an earlier local
      // preflight file. The terminal snapshot below is authoritative by itself.
    }

    const terminalPreflight = {
      ...previous,
      generatedAt: this.now().toISOString(),
      preflightPath: '.artifacts/report/finalizer-preflight.json',
      finalized: true,
      canFinalizeFinal: false,
      canFinalizeInterim: false,
      requiredMode: params.mode,
      intendedMode: params.mode,
      findingCount: params.findingCount,
      reportableCount: params.reportableFindingCount,
      runCompletion: params.runCompletion,
      authoredArtifactCheck: {
        checked: true,
        canPass: true,
        summaryPath: params.validation.summaryPath,
        reportPath: params.validation.reportPath,
        summaryBytes: params.validation.summaryBytes,
        reportBytes: params.validation.reportBytes,
        warnings: params.validation.warnings,
      },
    };
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(preflightPath, `${JSON.stringify(terminalPreflight, null, 2)}\n`, 'utf-8');
  }

  private async loadUnresolvedCoveragePhaseBlockers(runId: string | undefined): Promise<string[]> {
    if (!runId) return [];
    const phases = await this.db
      .select({
        phaseKey: runPhases.phaseKey,
        status: runPhases.status,
        stepIds: runPhases.stepIds,
        lastError: runPhases.lastError,
      })
      .from(runPhases)
      .where(and(
        eq(runPhases.runId, runId),
        sql`${runPhases.phaseKey} NOT IN ('reporting', 'review_reporting')`,
        sql`${runPhases.status} <> 'completed'`,
      ));
    return (Array.isArray(phases) ? phases : [])
      .filter((phase) => typeof phase?.phaseKey === 'string' && typeof phase?.status === 'string')
      .map((phase) => {
        const stepIds = Array.isArray(phase.stepIds) ? phase.stepIds : [];
        return `coverage phase ${phase.phaseKey} is ${phase.status}` +
          `${stepIds.length > 0 ? ` for mission(s) ${stepIds.join(', ')}` : ''}` +
          `${phase.lastError ? `: ${phase.lastError}` : ''}`;
      });
  }

  private async markRunCompleted(runId: string | undefined, note: string): Promise<void> {
    if (!runId) {
      return;
    }
    const completedAt = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          status: 'completed',
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(runs.id, runId));
      await tx
        .update(runPhases)
        .set({
          status: 'completed',
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(runPhases.runId, runId),
            sql`${runPhases.status} not in ('completed', 'blocked', 'failed', 'timed_out', 'aborted')`,
          ),
        );
      await tx.insert(runEvents).values({
        runId,
        type: 'completed',
        note,
      });
    });
  }

  private now(): Date {
    return this.options.now();
  }

  private requireOrganizationId(context: RunReportWorkflowContext): string {
    if (!context.organizationId) {
      throw new Error('organizationId is required in SecurityOps context');
    }
    return context.organizationId;
  }

  private requireScopeId(context: RunReportWorkflowContext): string {
    if (!context.scopeId) {
      throw new Error('scopeId is required in SecurityOps context');
    }
    return context.scopeId;
  }
}
