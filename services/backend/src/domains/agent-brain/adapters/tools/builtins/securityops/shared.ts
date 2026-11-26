import { deriveCloseoutStates } from '@/domains/security-ops/runs/closeoutStates';
import { ZodError } from 'zod';

import { createTimelineEntry } from '@/domains/agent-brain/application/orchestration/utils/timelineEntries';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import {
  formatMermaidErrors,
  validateMermaidInMarkdown,
  type MermaidValidationResult,
} from '@/shared/markdown/validateMermaid';
import type { TimelineEntry } from '@null-ai/contracts';
import { promises as fs } from 'fs';
import path from 'path';
import { resolveSecurityOpsToolContext } from '../securityopsContext';

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const COMPLIANCE_READINESS_STATUS_VALUES = [
  'missing',
  'partial',
  'passing',
  'failing',
  'stale',
  'accepted_risk',
  'not_applicable',
  'not_supported',
] as const;

export const COMPLIANCE_EVIDENCE_STATUS_VALUES = [
  'unreviewed',
  'approved',
  'rejected',
  'expired',
  'accepted_risk',
] as const;

export const COMPLIANCE_EVIDENCE_SOURCE_VALUES = [
  'user_upload',
  'user_attestation',
  'agent_finding',
  'integration',
] as const;

export const COMPLIANCE_SUPPORT_LEVEL_VALUES = [
  'automated_testable',
  'manual_evidence_required',
  'integration_required',
  'out_of_selected_scope',
] as const;

export const REPORT_FINDING_MERMAID_FIELDS = [
  'summary',
  'businessImpact',
  'technicalAnalysis',
  'pocDescription',
  'pocScriptCode',
  'assumptions',
  'remediation',
] as const;

export const projectionScopesForNote = (ntype: string | undefined) => {
  switch (ntype) {
    case 'http.endpoint':
    case 'tech.fingerprint':
      return ['recon', 'model'] as const;
    case 'scan.coverage':
      return ['coverage', 'model'] as const;
    case 'validation.lead':
      return ['leads', 'model'] as const;
    case 'approach.tried':
    case 'approach.blocker':
    case 'run.digest':
      return ['context', 'model'] as const;
    default:
      return ['model'] as const;
  }
};

export interface MermaidFieldFailure {
  field: string;
  result: MermaidValidationResult;
}

export const collectMermaidFieldFailures = async (
  source: Record<string, unknown> | undefined,
  fields: readonly string[],
): Promise<MermaidFieldFailure[]> => {
  if (!source) return [];
  const failures: MermaidFieldFailure[] = [];
  for (const field of fields) {
    const value = source[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const result = await validateMermaidInMarkdown(value);
    if (!result.ok) failures.push({ field, result });
  }
  return failures;
};

export const formatMermaidFieldFailures = (failures: MermaidFieldFailure[]): string =>
  failures
    .map(({ field, result }) => `Field "${field}":\n${formatMermaidErrors(result)}`)
    .join('\n\n');

export const buildMermaidRejectionError = (failures: MermaidFieldFailure[]): string =>
  'Mermaid diagram validation failed. Fix the diagram syntax and resubmit.\n\n' +
  formatMermaidFieldFailures(failures);

export const formatToolError = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const requireUserId = (ctx: ToolContext): string | null => {
  const userId = getSessionFromContext(ctx)?.userId;
  return userId ?? null;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const getSecurityOpsFlags = (session: SessionState | undefined): Record<string, unknown> | undefined =>
  isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;

/**
 * Pure decision: did the run's reporting phase record a handoff?
 *
 * The authoritative signal is `run_phases.handoff_out_ref`, which is written ONLY
 * by submit_phase_handoff (synchronously, awaited). It is immune to the in-memory
 * session-flag race that can drop `phaseHandoffSubmitted` across the
 * handoff -> finalize model-call boundary inside the reporting session.
 *
 * Matching rules (a run has exactly one reporting phase today):
 * - Only `phaseKey === 'reporting'` phases can authorize finalize. A non-reporting
 *   handoff (e.g. enumeration) must never authorize, even if a stale `activePhaseId`
 *   happens to point at it.
 * - With the single reporting phase, a recorded handoff authorizes regardless of the
 *   supplied id, so a stale/lost `activePhaseId` cannot wrongly reject the lone
 *   reporting phase (this is the exact flag-loss case we are recovering from).
 * - `reportingPhaseId` only disambiguates the defensive multi-reporting case (not
 *   produced today): if more than one reporting phase has handed off, require the
 *   active id to match one of them so an older reporting handoff cannot authorize the
 *   current finalize.
 */
export const isReportingHandoffRecorded = (
  phases: ReadonlyArray<{ id: string; phaseKey: string; handoffOutRef?: string | null }>,
  reportingPhaseId?: string,
): boolean => {
  const handedOffReporting = phases.filter(
    (phase) =>
      phase.phaseKey === 'reporting' &&
      typeof phase.handoffOutRef === 'string' &&
      phase.handoffOutRef.trim().length > 0,
  );
  if (handedOffReporting.length === 0) {
    return false;
  }
  if (handedOffReporting.length === 1) {
    return true;
  }
  // Defensive only: multiple handed-off reporting phases require an explicit id match.
  return reportingPhaseId ? handedOffReporting.some((phase) => phase.id === reportingPhaseId) : false;
};

/**
 * Authoritative DB fallback for the reporting-handoff gate. Fail-closed: any lookup
 * failure returns false, preserving the strict reject. An infrastructure error can
 * therefore never falsely authorize finalize — only a confirmed handoff record can.
 */
export const reportingHandoffRecordedInDb = async (
  runId: string | undefined,
  reportingPhaseId: string | undefined,
): Promise<boolean> => {
  if (!runId) {
    return false;
  }
  try {
    const [{ db }, { RunPhaseRepository }] = await Promise.all([
      import('@/db/client'),
      import('@/domains/security-ops/runs/RunPhaseRepository'),
    ]);
    const phases = await new RunPhaseRepository(db).listByRunId(runId);
    return isReportingHandoffRecorded(phases, reportingPhaseId);
  } catch {
    return false;
  }
};

export const phaseToolGuardError = async (
  securityopsFlags: Record<string, unknown> | undefined,
  options: { requireReportingHandoff?: boolean; runId?: string } = {},
): Promise<string | null> => {
  const activePhaseKey = getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase();
  if (!activePhaseKey) {
    return null;
  }
  if (activePhaseKey !== 'reporting') {
    return 'Reporting closeout tools are restricted to the dedicated reporting phase session. Submit the current phase handoff and wait for reporting to start.';
  }
  if (options.requireReportingHandoff && securityopsFlags?.phaseHandoffSubmitted !== true) {
    // Fast path missed: the in-memory phaseHandoffSubmitted flag can be lost across
    // the handoff -> finalize model-call boundary. Confirm against the authoritative
    // DB handoff record before rejecting.
    const reportingPhaseId = getString(securityopsFlags?.activePhaseId);
    const handed = await reportingHandoffRecordedInDb(options.runId, reportingPhaseId);
    if (!handed) {
      return 'finalize_run_artifacts requires submit_phase_handoff from the reporting phase first.';
    }
  }
  return null;
};

export const markPhaseFinalizedFromFlags = async (
  securityopsFlags: Record<string, unknown> | undefined,
  mode: string | undefined,
): Promise<void> => {
  const phaseId = getString(securityopsFlags?.activePhaseId);
  const activePhaseKey = getString(securityopsFlags?.activePhaseKey)?.trim().toLowerCase();
  if (!phaseId || activePhaseKey !== 'reporting' || securityopsFlags?.phaseHandoffSubmitted !== true) {
    return;
  }

  if (mode !== 'final') {
    return;
  }

  try {
    const [{ db }, { RunPhaseRepository }] = await Promise.all([
      import('@/db/client'),
      import('@/domains/security-ops/runs/RunPhaseRepository'),
    ]);
    await new RunPhaseRepository(db).updateStatus({ phaseId, status: 'completed' });
  } catch {
    // Phase status reconciliation is best-effort; final artifact validation still owns run completion.
  }
};

export const uniqueStrings = (values: unknown[]): string[] =>
  Array.from(
    new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)),
  );

export const toWorkspaceVisiblePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const artifactIndex = normalized.indexOf('/.artifacts/');
  if (artifactIndex >= 0) {
    return `/workspace${normalized.slice(artifactIndex)}`;
  }

  const fileName = path.basename(normalized);
  if (fileName === 'summary.md' || fileName === 'report.md') {
    return `/workspace/${fileName}`;
  }

  return normalized;
};

export const pickToolArgsPreview = (args: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isRecord(args)) {
    return {};
  }

  const preview: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) {
      preview[key] = value;
    }
  }
  return preview;
};

export const summarizePrepareReportContextResult = (result: {
  detail: string;
  contextPath: string;
  briefPath: string;
  runCompletion: { state?: string };
  findingCount: number;
  reportableFindingCount: number;
  candidateFindingCount: number;
  validatingFindingCount: number;
  complianceContextPath?: string;
  complianceTemplatePath?: string;
  complianceFrameworks?: string[];
  recommendedSections: string[];
}) => ({
  success: true,
  detail: result.detail,
  contextPath: toWorkspaceVisiblePath(result.contextPath),
  briefPath: toWorkspaceVisiblePath(result.briefPath),
  ...(result.complianceContextPath
    ? { complianceContextPath: toWorkspaceVisiblePath(result.complianceContextPath) }
    : {}),
  ...(result.complianceTemplatePath
    ? { complianceTemplatePath: toWorkspaceVisiblePath(result.complianceTemplatePath) }
    : {}),
  runCompletionState: result.runCompletion?.state ?? 'unknown',
  // D23 - `completed` alone cannot say whether the assessment concluded, whether the
  // artifacts exist, or whether the findings were settled. These four can.
  ...deriveCloseoutStates({
    runCompletionState: result.runCompletion?.state ?? null,
    finalized: (result.runCompletion as { finalized?: boolean } | undefined)?.finalized === true,
    mode: (result as { mode?: unknown }).mode as string | null | undefined ?? null,
    operatorInputRequired: result.runCompletion?.state === 'not_ready',
    reportableFindingCount: (result as { reportableFindingCount?: number }).reportableFindingCount,
  }),
  findingCount: result.findingCount,
  reportableFindingCount: result.reportableFindingCount,
  candidateFindingCount: result.candidateFindingCount,
  validatingFindingCount: result.validatingFindingCount,
  complianceFrameworks: result.complianceFrameworks ?? [],
  recommendedSections: result.recommendedSections,
});

export const summarizeReportFinalizerPreflightResult = (result: {
  preflightPath: string;
  canFinalizeFinal: boolean;
  canFinalizeInterim: boolean;
  requiredMode: string;
  intendedMode: string;
  runCompletion: { state?: string };
  findingCount: number;
  candidateCount: number;
  reportableCount: number;
  validatingCount: number;
  unpromotedCandidateBlockers?: unknown[];
  missingDurableEvidenceBlockers?: unknown[];
  missingReportFieldBlockers?: unknown[];
  findingWarnings?: string[];
  finalizerBlockers?: string[];
  complianceBoundarySentence: string;
  exportExpectations: Record<string, unknown>;
  authoredArtifactCheck?: Record<string, unknown>;
}) => ({
  success: true,
  preflightPath: toWorkspaceVisiblePath(result.preflightPath),
  canFinalizeFinal: result.canFinalizeFinal,
  canFinalizeInterim: result.canFinalizeInterim,
  requiredMode: result.requiredMode,
  intendedMode: result.intendedMode,
  runCompletionState: result.runCompletion?.state ?? 'unknown',
  // D23 - `completed` alone cannot say whether the assessment concluded, whether the
  // artifacts exist, or whether the findings were settled. These four can.
  ...deriveCloseoutStates({
    runCompletionState: result.runCompletion?.state ?? null,
    finalized: (result.runCompletion as { finalized?: boolean } | undefined)?.finalized === true,
    mode: (result as { mode?: unknown }).mode as string | null | undefined ?? null,
    operatorInputRequired: result.runCompletion?.state === 'not_ready',
    reportableFindingCount: (result as { reportableFindingCount?: number }).reportableFindingCount,
  }),
  findingCount: result.findingCount,
  candidateCount: result.candidateCount,
  reportableCount: result.reportableCount,
  validatingCount: result.validatingCount,
  unpromotedCandidateBlockerCount: Array.isArray(result.unpromotedCandidateBlockers)
    ? result.unpromotedCandidateBlockers.length
    : 0,
  missingDurableEvidenceBlockerCount: Array.isArray(result.missingDurableEvidenceBlockers)
    ? result.missingDurableEvidenceBlockers.length
    : 0,
  missingReportFieldBlockerCount: Array.isArray(result.missingReportFieldBlockers)
    ? result.missingReportFieldBlockers.length
    : 0,
  missingReportFieldBlockers: Array.isArray(result.missingReportFieldBlockers)
    ? result.missingReportFieldBlockers.slice(0, 6)
    : [],
  findingWarnings: Array.isArray(result.findingWarnings)
    ? result.findingWarnings.slice(0, 6)
    : [],
  finalizerBlockers: Array.isArray(result.finalizerBlockers)
    ? result.finalizerBlockers.slice(0, 6)
    : [],
  complianceBoundarySentence: result.complianceBoundarySentence,
  exportExpectations: result.exportExpectations,
  authoredArtifactCheck: result.authoredArtifactCheck ?? { checked: false },
});

export const summarizeFinalizeRunArtifactsResult = (result: {
  mode: string;
  summaryPath: string;
  reportPath: string;
  runCompletion: { state?: string; finalized?: boolean };
  findingCount: number;
  reportableFindingCount: number;
  warnings?: string[];
}) => ({
  success: true,
  mode: result.mode,
  summaryPath: toWorkspaceVisiblePath(result.summaryPath),
  reportPath: toWorkspaceVisiblePath(result.reportPath),
  runCompletionState: result.runCompletion?.state ?? 'unknown',
  // D23 - `completed` alone cannot say whether the assessment concluded, whether the
  // artifacts exist, or whether the findings were settled. These four can.
  ...deriveCloseoutStates({
    runCompletionState: result.runCompletion?.state ?? null,
    finalized: (result.runCompletion as { finalized?: boolean } | undefined)?.finalized === true,
    mode: (result as { mode?: unknown }).mode as string | null | undefined ?? null,
    operatorInputRequired: result.runCompletion?.state === 'not_ready',
    reportableFindingCount: (result as { reportableFindingCount?: number }).reportableFindingCount,
  }),
  finalized: result.runCompletion?.finalized === true,
  findingCount: result.findingCount,
  reportableFindingCount: result.reportableFindingCount,
  warningCount: Array.isArray(result.warnings) ? result.warnings.length : 0,
  ...(Array.isArray(result.warnings) && result.warnings.length > 0
    ? { warnings: result.warnings.slice(0, 3) }
    : {}),
});

export const normalizeWorkspaceRelativePath = (rawPath: string): string => {
  let candidate = rawPath.trim().replace(/\\/g, '/');
  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  } else if (candidate.startsWith('workspace/')) {
    candidate = candidate.slice('workspace/'.length);
  }
  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  while (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }
  return candidate;
};

export const buildWorkspacePathCandidates = (rawPath: string): { relativePath: string; remotePaths: string[] } => {
  const trimmed = rawPath.trim().replace(/\\/g, '/');
  const relativePath = normalizeWorkspaceRelativePath(trimmed);
  const remotePaths = uniqueStrings([
    trimmed,
    relativePath,
    relativePath ? `/workspace/${relativePath}` : '',
  ]);
  return { relativePath, remotePaths };
};

export const resolveToolWorkspaceDir = (ctx: ToolContext, session = getSessionFromContext(ctx)): string =>
  typeof session?.workspaceDir === 'string' && session.workspaceDir.trim().length > 0
    ? session.workspaceDir
    : ctx.workspaceDir;

export const writeWorkspaceMirrorFile = async (
  roots: string[],
  relativePath: string,
  content: Buffer,
): Promise<void> => {
  const uniqueRoots = uniqueStrings(roots);
  await Promise.all(
    uniqueRoots.map(async (root) => {
      const destination = path.resolve(root, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }),
  );
};

export type RemoteWorkspaceHydrationResult = {
  hydrated: boolean;
  relativePath?: string;
  localPath?: string;
  remotePath?: string;
  attemptedRemotePaths: string[];
  error?: string;
};

export const collectEvidencePaths = (value: unknown, output: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEvidencePaths(entry, output);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.path === 'string' && value.path.trim().length > 0) {
    output.add(value.path.trim());
  }

  for (const child of Object.values(value)) {
    collectEvidencePaths(child, output);
  }
};

export const hydrateRemoteWorkspaceFile = async (
  ctx: ToolContext,
  rawPath: string | undefined,
  options?: { required?: boolean },
): Promise<RemoteWorkspaceHydrationResult> => {
  const trimmedPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  const { relativePath, remotePaths } = trimmedPath
    ? buildWorkspacePathCandidates(trimmedPath)
    : { relativePath: '', remotePaths: [] };
  const session = getSessionFromContext(ctx);
  const workspaceRoots = uniqueStrings([resolveToolWorkspaceDir(ctx, session), ctx.workspaceDir]);
  const localPath = relativePath
    ? path.resolve(workspaceRoots[0] ?? ctx.workspaceDir, relativePath)
    : undefined;

  const fail = (reason: string, lastError?: unknown): RemoteWorkspaceHydrationResult => {
    const errorMessage = [
      `Unable to hydrate workspace file "${trimmedPath || rawPath || '(missing path)'}".`,
      reason,
      remotePaths.length > 0 ? `Tried: ${remotePaths.join(', ')}` : '',
      lastError instanceof Error ? `Last error: ${lastError.message}` : '',
      options?.required && relativePath
        ? `Ensure the artifact exists at /workspace/${relativePath} before retrying ingest_scan_artifact.`
        : '',
    ]
      .filter((part) => part.length > 0)
      .join(' ');

    if (options?.required) {
      throw new Error(errorMessage);
    }

    return {
      hydrated: false,
      relativePath: relativePath || undefined,
      localPath,
      attemptedRemotePaths: remotePaths,
      error: errorMessage,
    };
  };

  if (!trimmedPath) {
    return fail('No workspace path was provided.');
  }

  if (!relativePath) {
    return fail(`Could not normalize a workspace-relative path from "${trimmedPath}".`);
  }

  for (const root of workspaceRoots) {
    const candidateLocalPath = path.resolve(root, relativePath);
    const localExists = await fs
      .stat(candidateLocalPath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!localExists) {
      continue;
    }

    const content = await fs.readFile(candidateLocalPath);
    await writeWorkspaceMirrorFile(workspaceRoots, relativePath, content);
    return {
      hydrated: true,
      relativePath,
      localPath: candidateLocalPath,
      attemptedRemotePaths: remotePaths,
    };
  }

  if (!session) {
    return fail('Session lookup failed.');
  }

  if (typeof ctx.sandbox.readFile !== 'function') {
    return fail('Sandbox file reads are unavailable for this session.');
  }

  let lastError: unknown;
  for (const remotePath of remotePaths) {
    if (!remotePath) {
      continue;
    }
    try {
      if (typeof ctx.sandbox.statFile === 'function') {
        const stat = await ctx.sandbox.statFile(session, remotePath);
        if (!stat.exists || !stat.isFile) {
          continue;
        }
      }
      const content = await ctx.sandbox.readFile(session, remotePath);
      await writeWorkspaceMirrorFile(workspaceRoots, relativePath, content);
      return {
        hydrated: true,
        relativePath,
        localPath,
        remotePath,
        attemptedRemotePaths: remotePaths,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return fail('The file was not available in the local workspace or sandbox workspace.', lastError);
};

export const hydrateRemoteEvidenceFiles = async (ctx: ToolContext, args: unknown): Promise<void> => {
  const rawPaths = new Set<string>();
  collectEvidencePaths(args, rawPaths);

  for (const rawPath of rawPaths) {
    await hydrateRemoteWorkspaceFile(ctx, rawPath, { required: false });
  }
};


export const getAssetRefLabel = (assetRef: unknown): string | undefined => {
  if (!isRecord(assetRef)) {
    return undefined;
  }
  const kind = getString(assetRef.kind);
  const value = getString(assetRef.value);
  if (!value) {
    return undefined;
  }
  return kind ? `${kind}:${value}` : value;
};

export const emitSecurityOpsTimeline = (
  ctx: ToolContext,
  input: Omit<TimelineEntry, 'id' | 'sessionId' | 'source' | 'ts'> &
    Partial<Pick<TimelineEntry, 'id' | 'ts'>>,
): void => {
  ctx.streamBroker.emit(ctx.sessionId, {
    type: 'timeline_event',
    data: createTimelineEntry({
      ...input,
      sessionId: ctx.sessionId,
      source: 'securityops',
    }),
  });
};

export const buildSecurityOpsRelatedIds = (
  context: ReturnType<typeof resolveSecurityOpsToolContext>,
  result: Record<string, unknown>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({
      runId: context.runId,
      assetId: getString(result.assetId),
      serviceId: getString(result.serviceId),
      endpointId: getString(result.endpointId),
      subdomainId: getString(result.subdomainId),
      techId: getString(result.techId),
      noteId: getString(result.noteId),
      findingId: getString(result.findingId),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  );

export const buildNoteRelatedIds = (
  context: ReturnType<typeof resolveSecurityOpsToolContext>,
  result: Record<string, unknown>,
  ntype: string | undefined,
): Record<string, string> => {
  const noteId = getString(result.noteId);
  if (!noteId) {
    return buildSecurityOpsRelatedIds(context, result);
  }

  switch (ntype?.toLowerCase()) {
    case 'http.endpoint':
      return buildSecurityOpsRelatedIds(context, { ...result, endpointId: noteId });
    case 'dns.subdomain':
      return buildSecurityOpsRelatedIds(context, { ...result, subdomainId: noteId });
    case 'tech.fingerprint':
      return buildSecurityOpsRelatedIds(context, { ...result, techId: noteId });
    default:
      return buildSecurityOpsRelatedIds(context, result);
  }
};

export const recordReportedFinding = async (
  ctx: ToolContext,
  finding: { findingId: string; state?: string; lifecycleStage?: string },
): Promise<void> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return;
  }

  const existingSecurityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const existingReportedFindingIds = Array.isArray(existingSecurityOps?.reportedFindingIds)
    ? uniqueStrings(existingSecurityOps.reportedFindingIds)
    : [];
  const existingCandidateFindingIds = Array.isArray(existingSecurityOps?.candidateFindingIds)
    ? uniqueStrings(existingSecurityOps.candidateFindingIds)
    : [];
  const existingReportableFindingIds = Array.isArray(existingSecurityOps?.reportableFindingIds)
    ? uniqueStrings(existingSecurityOps.reportableFindingIds)
    : [];
  const isReportable = finding.lifecycleStage === 'reportable';
  const reportedFindingIds = uniqueStrings([...existingReportedFindingIds, finding.findingId]);
  const candidateFindingIds = isReportable
    ? existingCandidateFindingIds.filter((id) => id !== finding.findingId)
    : uniqueStrings([...existingCandidateFindingIds, finding.findingId]);
  const reportableFindingIds = isReportable
    ? uniqueStrings([...existingReportableFindingIds, finding.findingId])
    : existingReportableFindingIds;

  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      reportedFindingIds,
      reportFindingCount: reportedFindingIds.length,
      candidateFindingIds,
      candidateFindingCount: candidateFindingIds.length,
      reportableFindingIds,
      reportableFindingCount: reportableFindingIds.length,
      lastReportedFindingId: finding.findingId,
    },
  };
  await ctx.sessionStore.setAsync(session.id, session, 'securityops.report_finding_recorded');
};

export const recordPromotedFinding = async (ctx: ToolContext, findingId: string): Promise<void> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return;
  }
  const existingSecurityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const candidateFindingIds = Array.isArray(existingSecurityOps?.candidateFindingIds)
    ? uniqueStrings(existingSecurityOps.candidateFindingIds).filter((id) => id !== findingId)
    : [];
  const reportableFindingIds = uniqueStrings([
    ...(Array.isArray(existingSecurityOps?.reportableFindingIds)
      ? uniqueStrings(existingSecurityOps.reportableFindingIds)
      : []),
    findingId,
  ]);
  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      candidateFindingIds,
      candidateFindingCount: candidateFindingIds.length,
      reportableFindingIds,
      reportableFindingCount: reportableFindingIds.length,
      lastPromotedFindingId: findingId,
    },
  };
  await ctx.sessionStore.setAsync(session.id, session, 'securityops.promote_finding_recorded');
};

export const spawnValidationWorkerForFinding = async (
  ctx: ToolContext,
  findingId: string,
  rationale?: string,
): Promise<{ spawned: boolean; taskId?: string; workerSessionId?: string; status?: string; error?: string }> => {
  const session = getSessionFromContext(ctx);
  if (!ctx.workers || !session || session.coordination?.role === 'worker') {
    return { spawned: false };
  }

  try {
    const result = await ctx.workers.spawnWorker({
      parentSessionId: ctx.sessionId,
      workerType: 'validator_worker',
      task: [
        `Independently reproduce finding ${findingId} from a fresh context.`,
        'Do not treat the parent evidence as proof. Query the finding, rerun the relevant request or command yourself, attach durable evidence, then call submit_validation_outcome.',
        'Use outcome="validated" only when command-backed evidence reproduces the issue. Use outcome="false_positive" only when the claim is disproven with the required prerequisites available. Use outcome="inconclusive" when scoped attempts cannot decide because of auth, credentials, WAF/rate limits, target/tooling limits, or insufficient evidence.',
        rationale ? `Parent rationale: ${rationale}` : '',
      ].filter(Boolean).join(' '),
      reason: `promote_finding requested independent validation for ${findingId}`,
      expectedArtifactType: 'validation_result',
      executionMode: 'background',
      dependencyMode: 'dependency',
      continuationMode: 'spawn',
      planStepId: session.currentPlanStepId,
      mission: {
        question: `Can finding ${findingId} be independently reproduced?`,
        whyReadyNow: 'The discovery context supplied a candidate finding with durable evidence and requested promotion.',
        requiredEvidence: [
          'query_findings output for the target finding',
          'fresh command or HTTP request output from this validator session',
          'submit_validation_outcome with validated, false_positive, or inconclusive',
        ],
        expectedArtifact: 'validation_result',
        stopCondition: 'A validation outcome has been submitted for the finding.',
        assignedSkills: ['validation'],
        revalidatesFindingId: findingId,
      },
      budget: { maxToolCalls: 30 },
    });

    return {
      spawned: true,
      taskId: result.task.taskId,
      workerSessionId: result.sessionId,
      status: result.task.status,
    };
  } catch (error) {
    return { spawned: false, error: formatToolError(error) };
  }
};

export const queueValidationPhaseFinding = async (
  ctx: ToolContext,
  findingId: string,
  rationale?: string,
): Promise<{
  queued: boolean;
  queueId?: string;
  validationPhaseId?: string;
  fallbackReason?: string;
  error?: string;
}> => {
  const context = resolveSecurityOpsToolContext(ctx);
  if (!context.runId) {
    return { queued: false, fallbackReason: 'runId is unavailable' };
  }

  try {
    const [{ db }, { RunPhaseRepository }, { ValidationQueueRepository }] = await Promise.all([
      import('@/db/client'),
      import('@/domains/security-ops/runs/RunPhaseRepository'),
      import('@/domains/security-ops/runs/ValidationQueueRepository'),
    ]);
    const phaseRepo = new RunPhaseRepository(db);
    const phases = await phaseRepo.listByRunId(context.runId);
    const validationPhase = phases.find((phase) =>
      phase.phaseKey === 'validation' &&
      (phase.status === 'pending' || phase.status === 'active')
    );
    if (!validationPhase) {
      return { queued: false, fallbackReason: 'no open validation phase exists for this run' };
    }

    const queueRepo = new ValidationQueueRepository(db);
    const row = await queueRepo.enqueue({
      runId: context.runId,
      phaseId: validationPhase.id,
      findingId,
      rationale: rationale ?? null,
      requestedBySessionId: ctx.sessionId,
    });

    return {
      queued: true,
      queueId: row.id,
      validationPhaseId: validationPhase.id,
    };
  } catch (error) {
    return { queued: false, error: formatToolError(error) };
  }
};

export const completeValidationQueueFinding = async (
  ctx: ToolContext,
  findingId: string,
  outcome: 'validated' | 'false_positive' | 'inconclusive',
): Promise<void> => {
  const context = resolveSecurityOpsToolContext(ctx);
  if (!context.runId) {
    return;
  }

  try {
    const [{ db }, { ValidationQueueRepository }] = await Promise.all([
      import('@/db/client'),
      import('@/domains/security-ops/runs/ValidationQueueRepository'),
    ]);
    await new ValidationQueueRepository(db).completeFinding({
      runId: context.runId,
      findingId,
      outcome,
      sessionId: ctx.sessionId,
    });
  } catch {
    // Queue status follows canonical finding state best-effort; validation outcome remains authoritative.
  }
};

export const incrementProgressCounter = (value: unknown, delta: number): number =>
  (typeof value === 'number' ? value : 0) + delta;

export const recordInventoryProgress = async (
  ctx: ToolContext,
  delta: {
    assetsCreated?: number;
    assetsTouched?: number;
    servicesCreated?: number;
    servicesTouched?: number;
    subdomainNotesCreated?: number;
    subdomainNotesTouched?: number;
    endpointNotesCreated?: number;
    endpointNotesTouched?: number;
    techNotesCreated?: number;
    techNotesTouched?: number;
    noteType?: string;
    coverageStatus?: string;
    ingestParser?: string;
    ingestSucceeded?: boolean;
    ingestFailed?: boolean;
    lastIngestError?: string;
  },
): Promise<void> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return;
  }

  const existingSecurityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const existingProgress = isRecord(existingSecurityOps?.inventoryProgress)
    ? existingSecurityOps.inventoryProgress
    : undefined;
  const noteTypes = isRecord(existingProgress?.noteTypes)
    ? { ...(existingProgress.noteTypes as Record<string, unknown>) }
    : {};
  const normalizedNoteType = delta.noteType?.trim().toLowerCase();
  const normalizedIngestParser = delta.ingestParser?.trim().toLowerCase();
  if (normalizedNoteType) {
    noteTypes[normalizedNoteType] = incrementProgressCounter(noteTypes[normalizedNoteType], 1);
  }

  const ingestedParsers = uniqueStrings([
    ...(Array.isArray(existingProgress?.ingestedParsers) ? existingProgress.ingestedParsers : []),
    delta.ingestSucceeded && normalizedIngestParser ? normalizedIngestParser : '',
  ]);
  const existingFailedIngestParsers = Array.isArray(existingProgress?.failedIngestParsers)
    ? uniqueStrings(existingProgress.failedIngestParsers)
    : [];
  const failedIngestParsers = delta.ingestFailed && normalizedIngestParser
    ? uniqueStrings([...existingFailedIngestParsers, normalizedIngestParser])
    : delta.ingestSucceeded && normalizedIngestParser
      ? existingFailedIngestParsers.filter((parser) => parser !== normalizedIngestParser)
      : existingFailedIngestParsers;

  const nextInventoryProgress: Record<string, unknown> = {
    assetsCreated: incrementProgressCounter(existingProgress?.assetsCreated, delta.assetsCreated ?? 0),
    assetsTouched: incrementProgressCounter(existingProgress?.assetsTouched, delta.assetsTouched ?? 0),
    servicesCreated: incrementProgressCounter(existingProgress?.servicesCreated, delta.servicesCreated ?? 0),
    servicesTouched: incrementProgressCounter(existingProgress?.servicesTouched, delta.servicesTouched ?? 0),
    subdomainNotesCreated: incrementProgressCounter(
      existingProgress?.subdomainNotesCreated,
      delta.subdomainNotesCreated ?? 0,
    ),
    subdomainNotesTouched: incrementProgressCounter(
      existingProgress?.subdomainNotesTouched,
      delta.subdomainNotesTouched ?? 0,
    ),
    endpointNotesCreated: incrementProgressCounter(
      existingProgress?.endpointNotesCreated,
      delta.endpointNotesCreated ?? 0,
    ),
    endpointNotesTouched: incrementProgressCounter(
      existingProgress?.endpointNotesTouched,
      delta.endpointNotesTouched ?? 0,
    ),
    techNotesCreated: incrementProgressCounter(existingProgress?.techNotesCreated, delta.techNotesCreated ?? 0),
    techNotesTouched: incrementProgressCounter(existingProgress?.techNotesTouched, delta.techNotesTouched ?? 0),
    coverageNotes: incrementProgressCounter(
      existingProgress?.coverageNotes,
      normalizedNoteType === 'scan.coverage' ? 1 : 0,
    ),
    ingestSuccessCount: incrementProgressCounter(
      existingProgress?.ingestSuccessCount,
      delta.ingestSucceeded ? 1 : 0,
    ),
    ingestFailureCount: incrementProgressCounter(
      existingProgress?.ingestFailureCount,
      delta.ingestFailed ? 1 : 0,
    ),
    ingestedParsers,
    failedIngestParsers,
    unresolvedIngestFailureCount: failedIngestParsers.length,
    ...(Object.keys(noteTypes).length > 0 ? { noteTypes } : {}),
    ...(delta.coverageStatus ? { lastCoverageStatus: delta.coverageStatus } : {}),
    lastUpdatedAt: new Date().toISOString(),
  };

  const unresolvedFailureSummary =
    failedIngestParsers.length > 0
      ? `Unresolved ingest failure${failedIngestParsers.length === 1 ? '' : 's'} for parser(s): ${failedIngestParsers.join(', ')}`
      : undefined;

  if (delta.lastIngestError) {
    nextInventoryProgress.lastIngestError = delta.lastIngestError;
    if (normalizedIngestParser) {
      nextInventoryProgress.lastIngestFailureParser = normalizedIngestParser;
    }
  } else if (delta.ingestSucceeded && normalizedIngestParser) {
    const existingFailureParser =
      typeof existingProgress?.lastIngestFailureParser === 'string'
        ? existingProgress.lastIngestFailureParser.trim().toLowerCase()
        : '';
    if (failedIngestParsers.length === 0) {
      delete nextInventoryProgress.lastIngestError;
      delete nextInventoryProgress.lastIngestFailureParser;
    } else if (existingFailureParser === normalizedIngestParser) {
      nextInventoryProgress.lastIngestError = unresolvedFailureSummary;
      nextInventoryProgress.lastIngestFailureParser = failedIngestParsers[failedIngestParsers.length - 1];
    } else {
      if (
        typeof existingProgress?.lastIngestError === 'string' &&
        existingProgress.lastIngestError.trim().length > 0
      ) {
        nextInventoryProgress.lastIngestError = existingProgress.lastIngestError;
      } else if (unresolvedFailureSummary) {
        nextInventoryProgress.lastIngestError = unresolvedFailureSummary;
      }
      if (existingFailureParser) {
        nextInventoryProgress.lastIngestFailureParser = existingFailureParser;
      } else if (failedIngestParsers.length > 0) {
        nextInventoryProgress.lastIngestFailureParser = failedIngestParsers[failedIngestParsers.length - 1];
      }
    }
  } else {
    if (
      typeof existingProgress?.lastIngestError === 'string' &&
      existingProgress.lastIngestError.trim().length > 0 &&
      failedIngestParsers.length > 0
    ) {
      nextInventoryProgress.lastIngestError = existingProgress.lastIngestError;
    } else if (unresolvedFailureSummary) {
      nextInventoryProgress.lastIngestError = unresolvedFailureSummary;
    }
    if (
      typeof existingProgress?.lastIngestFailureParser === 'string' &&
      existingProgress.lastIngestFailureParser.trim().length > 0 &&
      failedIngestParsers.length > 0
    ) {
      nextInventoryProgress.lastIngestFailureParser = existingProgress.lastIngestFailureParser;
    } else if (failedIngestParsers.length > 0) {
      nextInventoryProgress.lastIngestFailureParser = failedIngestParsers[failedIngestParsers.length - 1];
    }
  }

  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      inventoryProgress: nextInventoryProgress,
    },
  };

  await ctx.sessionStore.setAsync(session.id, session, 'securityops.inventory_progress_recorded');
};

export const normalizeWorkspaceArtifactPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  let normalized = value.trim().replace(/\\/g, '/').replace(/[),.;]+$/u, '');
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
  } else if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

export const recordScannerIngestResolution = async (
  ctx: ToolContext,
  parser: string | undefined,
  artifactPath: string | undefined,
  partial = false,
): Promise<void> => {
  const normalizedParser = parser?.trim().toLowerCase();
  const normalizedPath = normalizeWorkspaceArtifactPath(artifactPath);
  if (!normalizedParser || !normalizedPath) {
    return;
  }
  const session = getSessionFromContext(ctx);
  if (!session) {
    return;
  }
  const existingSecurityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const existingArtifacts = Array.isArray(existingSecurityOps?.ingestedScannerArtifacts)
    ? existingSecurityOps.ingestedScannerArtifacts
    : [];
  const next = uniqueStrings([
    ...existingArtifacts
      .filter(isRecord)
      .map((item) => {
        const itemParser = getString(item.parser)?.trim().toLowerCase();
        const itemPath = normalizeWorkspaceArtifactPath(item.artifactPath);
        return itemParser && itemPath ? `${itemParser}\u0000${itemPath}` : '';
      }),
    `${normalizedParser}\u0000${normalizedPath}`,
  ])
    .map((key) => {
      const [keyParser, keyPath] = key.split('\u0000');
      if (!keyParser || !keyPath) {
        return null;
      }
      const existing = existingArtifacts
        .filter(isRecord)
        .find((item) =>
          getString(item.parser)?.trim().toLowerCase() === keyParser &&
          normalizeWorkspaceArtifactPath(item.artifactPath) === keyPath);
      const existingPartial = existing?.partial === true;
      return {
        parser: keyParser,
        artifactPath: keyPath,
        partial: keyParser === normalizedParser && keyPath === normalizedPath
          ? partial
          : existingPartial,
      };
    })
    .filter((item): item is { parser: string; artifactPath: string; partial: boolean } => item !== null);

  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      ingestedScannerArtifacts: next,
    },
  };
  await ctx.sessionStore.setAsync(session.id, session, 'securityops.scanner_artifact_ingested');
};

export const recordRunCompletion = async (
  ctx: ToolContext,
  result: { mode?: string; runCompletion?: unknown },
): Promise<void> => {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return;
  }
  const existingSecurityOps = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const runCompletion = isRecord(result.runCompletion) ? result.runCompletion : undefined;
  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...(existingSecurityOps ?? {}),
      runCompletion,
      finalizedMode: result.mode,
      artifactsFinalizedAt: new Date().toISOString(),
      finalizedAt:
        runCompletion?.state === 'completed'
          ? new Date().toISOString()
          : existingSecurityOps?.finalizedAt,
    },
  };
  await ctx.sessionStore.setAsync(session.id, session, 'securityops.run_completion_recorded');
};

export const REPORT_NOTE_DATA_GUIDANCE =
  'Required fields by ntype: ' +
  'approach.tried => { technique, endpoint (full URL required, e.g. https://api.example.com/path — asset is auto-derived from the host), result: "success" | "failed" | "blocked", http_status?, reason? }; do not send endpoints[] or file-path placeholders here; endpoint must be one concrete URL. ' +
  'approach.blocker => { blocker_type, target, blocker_reason or reason, prerequisites?: string[] }; ' +
  'scan.coverage => { family: "broad-surface" or one scanner family such as "httpx"|"katana"|"ffuf"|"nmap"|"nuclei", status: "completed" | "blocked", profileVersion, phase?, target?, targetHost?, targetUrl?, inventoryFingerprint?, reason?, toolset?: string[], stats?: { endpointsDiscovered?, findingsCreated?, techsDetected?, rowsParsed?, rowsKept?, suppressed?, duplicates? } }; assetRef is required; use family="broad-surface" for aggregate broad coverage and per-tool families when closing one scanner artifact; include target/phase when coverage is for one host, endpoint family, or phase artifact so distinct coverage notes do not collapse; inventoryFingerprint is auto-filled if omitted; status="completed" means every material scan job for that coverage finished and was reviewed; use status="blocked" with reason when a scan is cancelled, times out, or remains running past a bounded wait; write it when this run completed or blocked a broad discovery pass or materially updated coverage, not just to restate unchanged fresh coverage; ' +
  'validation.lead => { source, priority?: "critical"|"high"|"medium"|"low", riskFamily, target?, method?, path?, parameter?, hypothesis, requiredControls?: string[], requiredPrerequisites?: string[], evidenceRefs?: string[], attempts?, promptSha256?, promptPath?, status?: "open"|"validated"|"false_positive"|"blocked"|"deferred"|"superseded" }; use this to persist concrete validation targets discovered by enumeration, OpenAPI ingestion, or prior-phase artifacts; close rendered leads with submit_validation_lead_outcome, not generic report_note updates; ' +
  'run.digest => { workflowDiscipline?: "pentest"|"compliance"|"code_review", frameworkKey?: string, repositoryId?: string, immutableCommitSha?: string, goal, outcome, blocker_summary?, completed_tasks?: string[], blocked_tasks?: string[], blocked_prerequisite_work?: string[], next_prerequisites?: string[], closesCompliance?: [{ frameworkKey, controlId }] }; write it once after final coverage/memory notes are complete. outcome must match final task state: completed when all plan tasks completed with no material blocker, partially_completed when any task is blocked or incomplete, blocked when no meaningful progress was possible. For compliance runs, set frameworkKey to the selected compliance framework. For code-review runs, repositoryId and immutableCommitSha are required. Keep operator-side blockers in next_prerequisites. If completed work closes an agent-provable compliance gap, add closesCompliance with the framework/control IDs. The product derives customer actions from current state; do not store a prose next-run recommendation in the digest; ' +
  'report.section => { section, heading?, content, evidence_refs?: string[], status?: "draft" | "final" }; optional for long runs only; use it to persist management or technical narrative sections as work progresses. It does not promote findings and must reference canonical findings, notes, or artifact paths when making security claims; ' +
  'dns.subdomain => { hostname, resolvedIps? }; ' +
  'dns.a/dns.aaaa/dns.cname/dns.mx/dns.txt/dns.ns => include { name, value } (dns.mx may include priority, ttl); ' +
  'http.endpoint => { url, method?, statusCode?, title? }; do not use paths[] or methods[] shorthand here; url is required. ' +
  'http.headers => { url, headers?: Record<string,string>, missing?: string[] }; ' +
  'http.parameters => { url, params?: [{ name, type?, example? }] }; ' +
  'tech.fingerprint => { product, version?, category?, confidence?, versionReadMethod?: "http_banner"|"service_probe"|"application_fingerprint"|"error_behavior"|"tls_fingerprint" }; product is required; for a query_inventory versionAcquisition objective, copy recommendedMethod exactly even when version remains absent; generic header lists belong in http.headers instead. ' +
  'tls.certificate => { subject, issuer?, sans?, validFrom?, validTo?, keyType?, keyBits?, protocols?, selfSigned?, serialNumber? }; ' +
  'whois => { registrar?, createdDate?, expiresDate?, registrant? }; ' +
  'os.fingerprint => { method, os?, version?, confidence? }; ' +
  'network.traceroute => { hops?: [{ ttl?, ip?, rtt? }] }; ' +
  'pentest.plan => { recommended_next_task, rationale, priority_targets?, confidence?, chain? }; ' +
  'credential.found => { type, username?, context?, exposure? }. ' +
  'For any ntype not listed above, always provide data with at least { summary } containing the observation text. Never omit data entirely.';

export const ACTIVE_SCAN_COMMAND_PATTERN =
  /\b(?:nuclei|nmap|subfinder|httpx|ffuf|gobuster|dirsearch|katana|gospider|naabu|amass|assetfinder|dnsx|puredns|nikto|dalfox|wafw00f)\b/iu;

export const normalizeScannerTarget = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.replace(/\.$/, '');
  } catch {
    const withoutPath = trimmed.split(/[/?#]/u)[0] ?? '';
    const withoutPort = withoutPath.replace(/:\d+$/u, '');
    return withoutPort.replace(/\.$/, '') || undefined;
  }
};

export const extractScannerTargets = (command: string): Set<string> =>
  new Set(
    (command.match(/https?:\/\/[^\s"'<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}|\b\d{1,3}(?:\.\d{1,3}){3}\b/giu) ?? [])
      .map((value) => normalizeScannerTarget(value))
      .filter((value): value is string => Boolean(value)),
  );

export const getCoverageTargets = (args: Record<string, unknown>): Set<string> => {
  const targets = new Set<string>();
  const assetRef = isRecord(args.assetRef) ? args.assetRef : undefined;
  const assetValue = getString(assetRef?.value);
  const data = isRecord(args.data) ? args.data : undefined;
  const dataTarget = getString(data?.target);
  const endpoint = getString(data?.endpoint);
  for (const value of [assetValue, dataTarget, endpoint]) {
    if (!value) {
      continue;
    }
    const normalized = normalizeScannerTarget(value);
    if (normalized) {
      targets.add(normalized);
    }
  }
  return targets;
};

export const getActiveScanShellJobs = (
  ctx: ToolContext,
  targets = new Set<string>(),
): Array<{ jobId: string; command: string }> => {
  const session = getSessionFromContext(ctx);
  const shellJobs = isRecord(session?.flags?.shellJobs) ? session.flags.shellJobs : undefined;
  if (!shellJobs) {
    return [];
  }

  return Object.values(shellJobs)
    .filter(isRecord)
    .map((job) => ({
      jobId: getString(job.jobId) ?? '',
      command: getString(job.command) ?? '',
      status: getString(job.status)?.toLowerCase(),
      commandFinished: job.commandFinished,
    }))
    .filter((job) => {
      if (
        job.jobId.length === 0 ||
        !ACTIVE_SCAN_COMMAND_PATTERN.test(job.command) ||
        !(job.status === 'running' || job.status === 'unknown' || job.commandFinished === false)
      ) {
        return false;
      }
      if (targets.size === 0) {
        return true;
      }
      const commandTargets = extractScannerTargets(job.command);
      return Array.from(targets).some((target) => commandTargets.has(target));
    })
    .map(({ jobId, command }) => ({ jobId, command }));
};

export const downgradeCompletedScanCoverageForActiveJobs = (
  args: unknown,
  ctx: ToolContext,
): { args: unknown; warning?: string } => {
  if (!isRecord(args)) {
    return { args };
  }
  const ntype = getString(args.ntype)?.toLowerCase();
  const data = isRecord(args.data) ? args.data : undefined;
  if (ntype !== 'scan.coverage' || !data || getString(data.status)?.toLowerCase() !== 'completed') {
    return { args };
  }

  const activeJobs = getActiveScanShellJobs(ctx, getCoverageTargets(args));
  if (activeJobs.length === 0) {
    return { args };
  }

  const jobSummary = activeJobs
    .slice(0, 3)
    .map((job) => `${job.jobId}: ${job.command.slice(0, 120)}`)
    .join('; ');
  const warning =
    `scan.coverage was downgraded to blocked because active scanner job(s) were still running: ${jobSummary}`;
  return {
    args: {
      ...args,
      data: {
        ...data,
        status: 'blocked',
        reason: [getString(data.reason), warning].filter(Boolean).join(' '),
      },
    },
    warning,
  };
};

