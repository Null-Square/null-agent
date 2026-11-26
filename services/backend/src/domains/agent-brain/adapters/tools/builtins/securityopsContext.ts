import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { CodeReviewContext, RunWorkflowDiscipline } from '@/db/schema';
import { validateCodeReviewContext } from '@/domains/security-ops/runs/codeReviewRunContext';

// Marker for ToolManifestRegistry: this is a helper module, not a tool module definition.
export const __skipToolManifest = true as const;

type SecurityOpsToolContext = {
  organizationId?: string;
  scopeId?: string;
  runId?: string;
  runHost?: 'research_lab';
  activePhaseKey?: string;
  workflowDiscipline?: RunWorkflowDiscipline;
  codeReview?: CodeReviewContext;
  complianceAssessment?: {
    framework?: string;
  };
  complianceReport?: {
    framework?: string;
    source?: string;
    sourceRunId?: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolve SecurityOps context for tool handlers.
 *
 * Precedence:
 * - organizationId/runId: from flags.securityops
 * - scopeId: session.scopeId first, then flags.securityops.scopeId fallback
 */
export const resolveSecurityOpsToolContext = (ctx: ToolContext): SecurityOpsToolContext => {
  const session = getSessionFromContext(ctx);
  const contextSecurityops = isRecord(ctx.flags?.securityops) ? ctx.flags.securityops : undefined;
  const sessionSecurityops = isRecord(session?.flags?.securityops) ? session.flags.securityops : undefined;
  const organizationId = typeof contextSecurityops?.organizationId === 'string'
    ? contextSecurityops.organizationId
    : typeof sessionSecurityops?.organizationId === 'string'
      ? sessionSecurityops.organizationId
      : undefined;
  const runId = typeof contextSecurityops?.runId === 'string'
    ? contextSecurityops.runId
    : typeof sessionSecurityops?.runId === 'string'
      ? sessionSecurityops.runId
      : undefined;
  const runHostRaw = typeof contextSecurityops?.runHost === 'string'
    ? contextSecurityops.runHost
    : typeof sessionSecurityops?.runHost === 'string'
      ? sessionSecurityops.runHost
      : undefined;
  const runHost = runHostRaw === 'research_lab' ? runHostRaw : undefined;
  const activePhaseKeyRaw = typeof contextSecurityops?.activePhaseKey === 'string'
    ? contextSecurityops.activePhaseKey
    : typeof sessionSecurityops?.activePhaseKey === 'string'
      ? sessionSecurityops.activePhaseKey
      : undefined;
  const activePhaseKey = activePhaseKeyRaw?.trim().toLowerCase() || undefined;
  const complianceReportSource = isRecord(contextSecurityops?.complianceReport)
    ? contextSecurityops.complianceReport
    : isRecord(sessionSecurityops?.complianceReport)
      ? sessionSecurityops.complianceReport
      : undefined;
  const workflowDisciplineRaw = typeof contextSecurityops?.workflowDiscipline === 'string'
    ? contextSecurityops.workflowDiscipline
    : typeof sessionSecurityops?.workflowDiscipline === 'string'
      ? sessionSecurityops.workflowDiscipline
      : undefined;
  const normalizedWorkflowDiscipline = workflowDisciplineRaw?.trim().toLowerCase();
  const workflowDiscipline =
    normalizedWorkflowDiscipline === 'pentest'
      || normalizedWorkflowDiscipline === 'compliance'
      || normalizedWorkflowDiscipline === 'code_review'
      ? normalizedWorkflowDiscipline
      : undefined;
  const codeReviewSource = isRecord(contextSecurityops?.codeReview)
    ? contextSecurityops.codeReview
    : isRecord(sessionSecurityops?.codeReview)
      ? sessionSecurityops.codeReview
      : undefined;
  const codeReview =
    workflowDiscipline === 'code_review'
    && validateCodeReviewContext(codeReviewSource).ok
      ? codeReviewSource as CodeReviewContext
      : undefined;
  const complianceAssessmentSource = isRecord(contextSecurityops?.complianceAssessment)
    ? contextSecurityops.complianceAssessment
    : isRecord(sessionSecurityops?.complianceAssessment)
      ? sessionSecurityops.complianceAssessment
      : undefined;
  const complianceReport = isRecord(complianceReportSource)
    ? {
        framework: typeof complianceReportSource.framework === 'string'
          ? complianceReportSource.framework
          : undefined,
        source: typeof complianceReportSource.source === 'string'
          ? complianceReportSource.source
          : undefined,
        sourceRunId: typeof complianceReportSource.sourceRunId === 'string'
          ? complianceReportSource.sourceRunId
          : undefined,
      }
    : workflowDiscipline === 'compliance' && isRecord(complianceAssessmentSource)
      ? {
          framework: typeof complianceAssessmentSource.framework === 'string'
            ? complianceAssessmentSource.framework
            : undefined,
          source: 'assessment-run',
          sourceRunId: undefined,
        }
    : undefined;
  const scopeId = typeof session?.scopeId === 'string'
    ? session.scopeId
    : typeof contextSecurityops?.scopeId === 'string'
      ? contextSecurityops.scopeId
      : typeof sessionSecurityops?.scopeId === 'string'
        ? sessionSecurityops.scopeId
      : undefined;

  return {
    organizationId,
    scopeId,
    runId,
    ...(runHost ? { runHost } : {}),
    ...(activePhaseKey ? { activePhaseKey } : {}),
    ...(workflowDiscipline ? { workflowDiscipline } : {}),
    ...(codeReview ? { codeReview } : {}),
    ...(isRecord(complianceAssessmentSource)
      ? {
          complianceAssessment: {
            framework: typeof complianceAssessmentSource.framework === 'string'
              ? complianceAssessmentSource.framework
              : undefined,
          },
        }
      : {}),
    ...(complianceReport ? { complianceReport } : {}),
  };
};
