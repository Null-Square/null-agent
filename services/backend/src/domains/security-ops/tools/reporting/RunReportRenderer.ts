import type {
  ComplianceReadinessResponse,
  ComplianceReadinessControl,
  ComplianceReadinessStatus,
} from '@/domains/security-ops/compliance/ComplianceReadinessService';
import type {
  FindingCodeLocation,
  FindingEvidenceKind,
  FindingHttpExchange,
  FindingValidationProofBundle,
} from '@/domains/security-ops/findings/findingContracts';
import type { RiskState } from '@/db/schema';
import { isReportableRiskState } from '@/domains/security-ops/risks/riskLifecycle';
import type { AttackResultV1 } from '@/domains/agent-brain/domain/workers/attackContracts';
import {
  buildFindingReportCompleteness,
  type FinalReportAdvisoryField,
  type FinalReportRequiredField,
  type FindingReportCompleteness,
} from '@/domains/security-ops/findings/findingReportCompleteness';
import {
  COMPLIANCE_READINESS_BOUNDARY_SENTENCE,
  GDPR_READINESS_BOUNDARY_SENTENCE,
} from '@/domains/security-ops/tools/reporting/constants';

type RunCompletionState = 'not_ready' | 'ready_for_finalization' | 'completed';

export type ReportRendererRunCompletion = {
  state: RunCompletionState;
  ready: boolean;
  reasons: string[];
  incompletePlanSteps: Array<{ id: string; title: string; status: string; reason?: string }>;
  unresolvedPromotableFindings: Array<{ id: string; title: string; severity: string }>;
  finalized: boolean;
};

export type ReportRendererPlanStep = {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  mission?: unknown;
};

export type ReportRendererRunPhaseRow = {
  id: string;
  phaseKey: string;
  status: string;
  sessionId: string | null;
  lastError: string | null;
};

export type ReportRendererFindingRow = {
  id: string;
  assetId: string;
  title: string;
  severity: string;
  state: RiskState;
  summary: string;
  businessImpact: string | null;
  technicalAnalysis: string | null;
  pocDescription: string | null;
  pocScriptCode: string | null;
  assumptions: string | null;
  fixEffort: string | null;
  remediation: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  confidenceScore: number | null;
  cweId: string | null;
  cveId: string | null;
  cweIds: string[] | null;
  cveIds: string[] | null;
  owaspCategory: string | null;
  endpointId: string | null;
  serviceId: string | null;
  codeLocations: FindingCodeLocation[] | null;
  validationProof?: FindingValidationProofBundle | null;
  firstSeenAt: Date | string | null;
  lastSeenAt: Date | string | null;
  dedupeKey: string;
  evidence?: ReportRendererFindingEvidenceRow[];
};

export type ReportRendererFindingEvidenceRow = {
  findingId: string;
  kind: FindingEvidenceKind;
  path: string;
  displayPath: string | null;
  label: string | null;
  excerpt: string | null;
  fileMissing: boolean;
  data: FindingHttpExchange | AttackResultV1 | null;
  createdAt: Date | string | null;
};

export type ReportRendererNoteRow = {
  ntype: string;
  title: string | null;
  data: Record<string, unknown>;
  evidence: Array<{ path: string; label?: string; excerpt?: string; fileMissing?: boolean }>;
  lastSeenAt: Date;
};

export type ReportRendererCoverageSummary = {
  plan: {
    total: number;
    completed: number;
    blocked: number;
    pending: number;
    running: number;
    error: number;
  };
  missionQuestions: string[];
  missionSkills: string[];
  noteCounts: Array<{ ntype: string; count: number }>;
  testedClasses: string[];
  blockers: Array<{ title: string; detail: string }>;
  openDebts: string[];
  runDigest?: {
    goal?: string;
    outcome?: string;
    blockerSummary?: string;
    completedTasks: string[];
    blockedTasks: string[];
    nextPrerequisites: string[];
  };
  approaches: Array<{
    technique: string;
    endpoint: string;
    result: string;
    reason?: string;
  }>;
  scanCoverage: Array<{
    title: string;
    family?: string;
    status?: string;
    reason?: string;
    toolset: string[];
    stats: string[];
  }>;
  endpoints: Array<{ method?: string; url: string; statusCode?: number; title?: string }>;
  technologies: Array<{ product: string; version?: string; category?: string; confidence?: number }>;
  reportSections: Array<{ heading: string; section: string; content: string; evidenceRefs: string[] }>;
  scannerOutcomes: Array<{
    jobId: string;
    command: string;
    outcome: string;
    exitCode?: number;
    stdoutPath?: string;
    stderrPath?: string;
  }>;
};

export type ReportRendererBrowserEvidenceSummary = {
  screenshotCount: number;
  networkArtifactCount: number;
  bundleArtifactCount: number;
  traceArtifactCount: number;
  sensitiveStateArtifactCount: number;
  challengeCount: number;
  latestArtifacts: Array<{
    path: string;
    type: string;
    bytes: number;
    createdAt: string;
  }>;
  challenges: Array<{
    artifactPath: string;
    url?: string;
    title?: string;
    kind: string;
    confidence: string;
    blockingStage?: string;
    evidenceSummary?: string;
    recommendedAuthorizedPath?: string;
  }>;
};

export type ReportRendererState = {
  organizationId: string;
  scopeId: string;
  findings: ReportRendererFindingRow[];
  notes: ReportRendererNoteRow[];
  runCompletion: ReportRendererRunCompletion;
  coverage: ReportRendererCoverageSummary;
};

const FINALIZER_SETTLED_PHASE_STATUSES = new Set(['completed', 'blocked']);
const SCANNER_COMMAND_PATTERN =
  /\b(?:nuclei|nmap|subfinder|httpx|ffuf|gobuster|dirsearch|katana|gospider|naabu|amass|assetfinder|dnsx|puredns|nikto|dalfox|wafw00f|sqlmap|semgrep|trivy|gitleaks|trufflehog|bandit|ast-grep)\b/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAttackResultV1 = (value: unknown): value is AttackResultV1 =>
  isRecord(value) &&
  value.schemaVersion === 1 &&
  typeof value.missionId === 'string' &&
  typeof value.objectiveFamily === 'string' &&
  typeof value.status === 'string' &&
  isRecord(value.cleanup);

const isFindingHttpExchange = (value: unknown): value is FindingHttpExchange =>
  isRecord(value) &&
  isRecord(value.request) &&
  isRecord(value.response) &&
  typeof value.request.method === 'string' &&
  typeof value.request.url === 'string' &&
  typeof value.response.statusCode === 'number';

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const toNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
};

const normalizeReportScalar = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
};

const normalizeReportBlock = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return normalizeReportScalar(value);
  }
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeReportStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeReportScalar(entry))
    .filter((entry): entry is string => Boolean(entry));
};

const compactReportText = (value: unknown, maxLength = 900): string | undefined => {
  const normalized = normalizeReportScalar(value);
  if (!normalized) return undefined;
  if (/^(n\/a|none|not applicable|unknown)$/iu.test(normalized)) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
};

const compactReportBlockText = (value: unknown, maxLength = 1600): string | undefined => {
  const normalized = normalizeReportBlock(value);
  if (!normalized) return undefined;
  if (/^(n\/a|none|not applicable|unknown)$/iu.test(normalized.replace(/\s+/g, ' '))) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
};

const markdownTableCell = (value: unknown): string => {
  const normalized = normalizeReportScalar(value) ?? '-';
  return normalized.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};

const uniqueReportStrings = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const reportSeverityRank = (severity: string): number => {
  switch (severity.toLowerCase()) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    case 'info':
      return 4;
    default:
      return 5;
  }
};

const reportPlural = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

const toIsoString = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const finalizerStepMissionSkills = (step: ReportRendererPlanStep): string[] => {
  const mission = isRecord(step.mission) ? step.mission : undefined;
  const assignedSkills = Array.isArray(mission?.assignedSkills)
    ? mission.assignedSkills
    : Array.isArray(mission?.assigned_skills)
      ? mission.assigned_skills
      : [];
  return assignedSkills
    .filter((skill): skill is string => typeof skill === 'string')
    .map((skill) => skill.trim().toLowerCase())
    .filter((skill) => skill.length > 0);
};

const isRunningReportingCloseoutStep = (step: ReportRendererPlanStep): boolean =>
  step.status === 'running' && finalizerStepMissionSkills(step).includes('security-reporting');

const finalizerPresentationStepStatus = (step: ReportRendererPlanStep): string => {
  const status = typeof step.status === 'string' ? step.status : '';
  return isRunningReportingCloseoutStep(step) ? 'completed' : status;
};

export class RunReportRenderer {
  renderCanonicalComplianceReportSection(complianceReadiness: ComplianceReadinessResponse): string {
    const lines = [
      '<!-- nullsquare:canonical-compliance:start -->',
      '## Control Dispositions',
      '',
      `Boundary: ${COMPLIANCE_READINESS_BOUNDARY_SENTENCE}`,
      ...(complianceReadiness.frameworks.some((item) => item.selected && item.supported && item.key === 'gdpr')
        ? [`Boundary: ${GDPR_READINESS_BOUNDARY_SENTENCE}`]
        : []),
      '',
    ];

    for (const framework of complianceReadiness.frameworks.filter((item) => item.selected && item.supported)) {
      const runCheckedControls = framework.controls.filter((control) => (control.controlChecks ?? []).length > 0).length;
      const readinessNeedsAction = framework.outcomeCounts?.needs_action ?? 0;
      const readinessNotChecked = framework.outcomeCounts?.not_checked ?? 0;
      lines.push(
        `### ${framework.label}`,
        '',
        `- This run assessed: ${runCheckedControls}/${framework.controls.length} controls with direct agent check records.`,
        `- Overall framework readiness: denominator ${framework.controls.length}; ${readinessNeedsAction} need action; ${readinessNotChecked} not checked; status counts ${this.renderStatusCounts(framework.statusCounts)}.`,
        '',
      );

      if (framework.frameworkProfile?.kind === 'nist_csf_2_0') {
        lines.push(
          '#### NIST CSF Function Readiness',
          '',
          '| Function | Monitored | Direct checks | Passed | Failed | Needs action | Not checked | Excluded |',
          '|---|---:|---:|---:|---:|---:|---:|---:|',
          ...framework.frameworkProfile.functions.map((item) =>
            `| ${item.function} | ${item.monitored}/${item.total} | ${item.directCheckCount} | ${item.outcomeCounts.passed} | ${item.outcomeCounts.failed} | ${item.outcomeCounts.needs_action} | ${item.outcomeCounts.not_checked} | ${item.outcomeCounts.excluded} |`,
          ),
          '',
          `- Indicative Implementation Tier: not determined. ${framework.frameworkProfile.implementationTier.reason}`,
          '',
        );
      }

      const grouped = new Map<string, ComplianceReadinessControl[]>();
      for (const control of framework.controls) {
        const family = this.controlFamilyLabel(control);
        grouped.set(family, [...(grouped.get(family) ?? []), control]);
      }

      for (const [family, controls] of grouped.entries()) {
        lines.push(`#### ${family}`, '');
        for (const control of controls) {
          lines.push(...this.renderCanonicalControlDisposition(control), '');
        }
      }
    }

    lines.push('<!-- nullsquare:canonical-compliance:end -->', '');
    return lines.join('\n');
  }

  applyCanonicalComplianceReportSection(report: string, complianceReadiness: ComplianceReadinessResponse): string {
    const canonical = this.renderCanonicalComplianceReportSection(complianceReadiness).trimEnd();
    const markerPattern = /<!-- nullsquare:canonical-compliance:start -->[\s\S]*?<!-- nullsquare:canonical-compliance:end -->/u;
    if (markerPattern.test(report)) {
      return `${report.replace(markerPattern, canonical).trimEnd()}\n`;
    }

    const controlDispositionsPattern = /(?:\r?\n)?## Control Dispositions\b[\s\S]*?(?=\r?\n## (?!#)|$)/u;
    if (controlDispositionsPattern.test(report)) {
      return `${report.replace(controlDispositionsPattern, `\n${canonical}\n`).trimEnd()}\n`;
    }

    const complianceReadinessPattern = /(?:\r?\n)?## Compliance Readiness\b[\s\S]*?(?=\r?\n## (?!#)|$)/u;
    if (complianceReadinessPattern.test(report)) {
      return `${report.replace(complianceReadinessPattern, `\n${canonical}\n`).trimEnd()}\n`;
    }

    return `${report.trimEnd()}\n\n${canonical}\n`;
  }

  private renderCanonicalControlDisposition(control: ComplianceReadinessControl): string[] {
    const check = (control.controlChecks ?? []).find((item) => item.fresh && item.eligible) ?? control.controlChecks?.[0];
    const requests = (control.actionRequests ?? []).filter((request) =>
      ['open', 'fulfilled', 'insufficient', 'contradicted'].includes(request.status),
    );
    const evidenceRefs = check?.evidenceRefs?.length
      ? check.evidenceRefs
      : control.evidence.map((item) => item.sourceRef).filter(Boolean);
    const pciMetadata = control.pciDssRequirement
      ? [
          `requirement ${control.pciDssRequirement}`,
          control.pciDssApproach ? `approach ${control.pciDssApproach.replace(/_/gu, ' ')}` : null,
          control.pciDssCdeScope ? `CDE scope ${control.pciDssCdeScope.replace(/_/gu, ' ')}` : null,
          control.pciDssAccountData && control.pciDssAccountData !== 'none' ? `account data ${control.pciDssAccountData.toUpperCase()}` : null,
          control.pciDssSaqTypes?.length ? `SAQ ${control.pciDssSaqTypes.join('/')}` : null,
        ].filter(Boolean).join('; ')
      : '';
    const lines = [
      `- **${control.id} - ${control.title}**`,
      `  - Verdict: ${this.formatControlVerdict(control.verdict)} (${control.outcome.replace(/_/gu, ' ')})`,
      `  - Support: ${(control.supportLevel ?? 'unknown').replace(/_/gu, ' ')}${control.implementationSpec ? `; HIPAA implementation specification: ${control.implementationSpec.replace(/_/gu, ' ')}` : ''}`,
      ...(pciMetadata ? [`  - PCI DSS context: ${pciMetadata}`] : []),
      `  - Basis: ${check?.basis ?? control.basis ?? 'none recorded'}`,
      `  - Reason: ${check?.reason ?? control.verdictReason ?? control.rationale}`,
    ];
    if (check?.id) {
      lines.push(`  - Check: \`${check.id}\``);
    }
    if (evidenceRefs.length > 0) {
      lines.push(`  - Evidence: ${evidenceRefs.slice(0, 4).map((ref) => `\`${ref}\``).join(', ')}${evidenceRefs.length > 4 ? `, +${evidenceRefs.length - 4} more` : ''}`);
    }
    const limitations = uniqueStrings([...(check?.limitations ?? []), ...(control.coverageLimitations ?? [])]);
    if (limitations.length > 0) {
      lines.push(`  - Limitations: ${limitations.join('; ')}`);
    }
    if (requests.length > 0) {
      lines.push(`  - Requests: ${requests.map((request) => `${request.title} (${request.status})`).join('; ')}`);
    } else if (control.nextAction) {
      lines.push(`  - Next action: ${control.nextAction}`);
    }
    return lines;
  }

  private controlFamilyLabel(control: ComplianceReadinessControl): string {
    const family = control.id.match(/^[A-Z]+\d+/u)?.[0] ?? control.theme;
    return `${family} - ${control.theme}`;
  }

  private formatControlVerdict(value: string): string {
    return value.replace(/_/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
  }

  compactReportContextNotes(notes: ReportRendererNoteRow[]): ReportRendererNoteRow[] {
    const importantTypes = new Set([
      'run.digest',
      'report.section',
      'approach.tried',
      'approach.blocker',
      'scan.coverage',
      'http.endpoint',
      'tech.fingerprint',
    ]);
    return notes.filter((note) => importantTypes.has(note.ntype)).slice(0, 80);
  }

  recommendReportSections(
    reportState: ReportRendererState,
    complianceReadiness?: ComplianceReadinessResponse,
  ): string[] {
    const sections = new Set<string>(['executive-summary', 'methodology', 'limitations', 'next-steps']);
    if (reportState.coverage.endpoints.length > 0 || reportState.coverage.technologies.length > 0) {
      sections.add('attack-surface');
    }
    if (reportState.findings.some((finding) => isReportableRiskState(finding.state))) {
      sections.add('findings-narrative');
      sections.add('remediation-plan');
    }
    if ((complianceReadiness?.frameworks.length ?? 0) > 0) {
      sections.add('compliance-readiness');
    }
    if (reportState.coverage.openDebts.length === 0 && reportState.coverage.blockers.length === 0) {
      sections.delete('limitations');
    }
    return [...sections];
  }

  withReportCompleteness(finding: ReportRendererFindingRow): ReportRendererFindingRow & {
    reportCompleteness: FindingReportCompleteness;
    missingReportFields: FinalReportRequiredField[];
    advisoryMissingFields: FinalReportAdvisoryField[];
  } {
    const reportCompleteness = buildFindingReportCompleteness(finding);
    return {
      ...finding,
      reportCompleteness,
      missingReportFields: reportCompleteness.missingReportFields,
      advisoryMissingFields: reportCompleteness.advisoryMissingFields,
    };
  }

  buildRunCompletion(params: {
    plan: ReportRendererPlanStep[];
    findings: ReportRendererFindingRow[];
    durableEvidenceFindingIds: Set<string>;
    finalized: boolean;
    runPhaseRows?: ReportRendererRunPhaseRow[];
  }): ReportRendererRunCompletion {
    const canonicalPhaseRows = params.runPhaseRows ?? [];
    const incompletePlanSteps =
      canonicalPhaseRows.length > 0
        ? canonicalPhaseRows
            .filter((phase) => !FINALIZER_SETTLED_PHASE_STATUSES.has(phase.status))
            .map((phase) => ({
              id: phase.id,
              title: `${phase.phaseKey} phase`,
              status: phase.status || 'unknown',
              reason: phase.lastError ?? undefined,
            }))
        : params.plan
            .filter((step) => {
              const status = finalizerPresentationStepStatus(step);
              return status !== '' && status !== 'completed' && status !== 'blocked';
            })
            .map((step, index) => ({
              id: typeof step.id === 'string' ? step.id : `step-${index + 1}`,
              title: typeof step.title === 'string' ? step.title : `Plan step ${index + 1}`,
              status: typeof step.status === 'string' ? step.status : 'unknown',
              reason: typeof step.blockedReason === 'string' ? step.blockedReason : undefined,
            }));

    const unresolvedPromotableFindings = params.findings
      .filter(
        (finding) =>
          !isReportableRiskState(finding.state) &&
          params.durableEvidenceFindingIds.has(finding.id),
      )
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
      }));

    if (params.finalized) {
      return {
        state: 'completed',
        ready: true,
        reasons: ['final artifacts were already finalized'],
        incompletePlanSteps,
        unresolvedPromotableFindings,
        finalized: true,
      };
    }

    const reasons: string[] = [];
    if (incompletePlanSteps.length > 0) {
      reasons.push(`${incompletePlanSteps.length} plan step(s) are not completed`);
    }
    if (unresolvedPromotableFindings.length > 0) {
      reasons.push(`${unresolvedPromotableFindings.length} finding candidate(s) have durable evidence but are not promoted`);
    }

    const ready = reasons.length === 0;
    return {
      state: ready ? 'ready_for_finalization' : 'not_ready',
      ready,
      reasons: ready ? ['all plan steps completed and no promotable candidates remain'] : reasons,
      incompletePlanSteps,
      unresolvedPromotableFindings,
      finalized: false,
    };
  }

  buildFinalizerCoverageSummary(params: {
    plan: ReportRendererPlanStep[];
    findings: ReportRendererFindingRow[];
    notes: ReportRendererNoteRow[];
    runCompletion: ReportRendererRunCompletion;
    shellJobs?: Record<string, unknown>;
  }): ReportRendererCoverageSummary {
    const planCounts = {
      total: params.plan.length,
      completed: 0,
      blocked: 0,
      pending: 0,
      running: 0,
      error: 0,
    };
    const missionQuestions: string[] = [];
    const missionSkills = new Set<string>();
    for (const step of params.plan) {
      const status = finalizerPresentationStepStatus(step);
      if (status === 'completed') planCounts.completed += 1;
      else if (status === 'blocked') planCounts.blocked += 1;
      else if (status === 'running') planCounts.running += 1;
      else if (status === 'error') planCounts.error += 1;
      else planCounts.pending += 1;

      const mission = isRecord(step.mission) ? step.mission : undefined;
      const question = typeof mission?.question === 'string' ? mission.question.trim() : '';
      if (question) {
        missionQuestions.push(question);
      }
      for (const skill of finalizerStepMissionSkills(step)) {
        missionSkills.add(skill);
      }
    }

    const noteCountsMap = new Map<string, number>();
    const blockers: Array<{ title: string; detail: string }> = [];
    const approaches: ReportRendererCoverageSummary['approaches'] = [];
    const scanCoverage: ReportRendererCoverageSummary['scanCoverage'] = [];
    const endpoints: ReportRendererCoverageSummary['endpoints'] = [];
    const technologies: ReportRendererCoverageSummary['technologies'] = [];
    const reportSections: ReportRendererCoverageSummary['reportSections'] = [];
    let runDigest: ReportRendererCoverageSummary['runDigest'];
    for (const note of params.notes) {
      noteCountsMap.set(note.ntype, (noteCountsMap.get(note.ntype) ?? 0) + 1);
      if (note.ntype === 'approach.blocker') {
        const detail =
          compactReportText(note.data?.reason) ??
          compactReportText(note.data?.blocker_reason) ??
          compactReportText(note.data?.blocker) ??
          JSON.stringify(note.data);
        blockers.push({
          title: note.title ?? 'Approach blocker',
          detail,
        });
      } else if (note.ntype === 'approach.tried') {
        const technique = compactReportText(note.data?.technique);
        const endpoint = compactReportText(note.data?.endpoint);
        const result = compactReportText(note.data?.result);
        if (technique && endpoint && result) {
          approaches.push({
            technique,
            endpoint,
            result,
            reason: compactReportText(note.data?.reason),
          });
        }
      } else if (note.ntype === 'scan.coverage') {
        const statsRaw = isRecord(note.data?.stats) ? note.data.stats : undefined;
        const stats = statsRaw
          ? [
              toNonNegativeInt(statsRaw['endpointsDiscovered']) !== undefined
                ? `${toNonNegativeInt(statsRaw['endpointsDiscovered'])} endpoints`
                : '',
              toNonNegativeInt(statsRaw['techsDetected']) !== undefined
                ? `${toNonNegativeInt(statsRaw['techsDetected'])} technologies`
                : '',
              toNonNegativeInt(statsRaw['findingsCreated']) !== undefined
                ? `${toNonNegativeInt(statsRaw['findingsCreated'])} findings`
                : '',
            ].filter(Boolean)
          : [];
        scanCoverage.push({
          title: note.title ?? 'Scan coverage',
          family: compactReportText(note.data?.family),
          status: compactReportText(note.data?.status),
          reason: compactReportText(note.data?.reason),
          toolset: normalizeReportStringArray(note.data?.toolset),
          stats,
        });
      } else if (note.ntype === 'http.endpoint') {
        const url = compactReportText(note.data?.url);
        if (url) {
          endpoints.push({
            url,
            method: compactReportText(note.data?.method),
            statusCode: typeof note.data?.statusCode === 'number' ? note.data.statusCode : undefined,
            title: compactReportText(note.data?.title),
          });
        }
      } else if (note.ntype === 'tech.fingerprint') {
        const product = compactReportText(note.data?.product);
        if (product) {
          technologies.push({
            product,
            version: compactReportText(note.data?.version),
            category: compactReportText(note.data?.category),
            confidence: typeof note.data?.confidence === 'number' ? note.data.confidence : undefined,
          });
        }
      } else if (note.ntype === 'run.digest') {
        runDigest ??= {
          goal: compactReportText(note.data?.goal),
          outcome: compactReportText(note.data?.outcome),
          blockerSummary: compactReportText(note.data?.blocker_summary),
          completedTasks: normalizeReportStringArray(note.data?.completed_tasks),
          blockedTasks: normalizeReportStringArray(note.data?.blocked_tasks),
          nextPrerequisites: normalizeReportStringArray(note.data?.next_prerequisites),
        };
      } else if (note.ntype === 'report.section') {
        const content = compactReportBlockText(note.data?.content, 4000);
        const section = compactReportText(note.data?.section);
        if (content && section) {
          reportSections.push({
            section,
            heading: compactReportText(note.data?.heading) ?? note.title ?? section,
            content,
            evidenceRefs: normalizeReportStringArray(note.data?.evidence_refs),
          });
        }
      }
    }

    const noteCounts = [...noteCountsMap.entries()]
      .map(([ntype, count]) => ({ ntype, count }))
      .sort((left, right) => right.count - left.count || left.ntype.localeCompare(right.ntype));
    const testedClasses = Array.from(
      new Set([
        ...missionSkills,
        ...params.notes.map((note) => note.ntype).filter((ntype) => ntype !== 'run.digest'),
        ...params.findings.map((finding) => finding.title),
      ]),
    ).slice(0, 12);

    const openDebts = [
      ...params.runCompletion.incompletePlanSteps.map((step) =>
        `${step.id}: ${step.title} (${step.status}${step.reason ? ` - ${step.reason}` : ''})`,
      ),
      ...params.runCompletion.unresolvedPromotableFindings.map((finding) =>
        `${finding.severity.toUpperCase()}: ${finding.title} needs promote_finding or interim closeout`,
      ),
      ...blockers.map((blocker) => `${blocker.title}: ${blocker.detail}`),
    ];

    return {
      plan: planCounts,
      missionQuestions: missionQuestions.slice(0, 10),
      missionSkills: [...missionSkills].sort(),
      noteCounts,
      testedClasses,
      blockers: blockers.slice(0, 10),
      openDebts: Array.from(new Set(openDebts)).slice(0, 12),
      runDigest,
      approaches: approaches.slice(0, 20),
      scanCoverage: scanCoverage.slice(0, 12),
      endpoints: endpoints.slice(0, 20),
      technologies: technologies.slice(0, 20),
      reportSections: reportSections.slice(0, 12),
      scannerOutcomes: this.buildScannerOutcomeRows(params.shellJobs),
    };
  }

  private replayEscapeReasonLabel(reason: string): string {
    return reason.replace(/_/g, ' ');
  }

  private riskProofStateLabel(finding: ReportRendererFindingRow): string {
    if (!isReportableRiskState(finding.state)) {
      return finding.state;
    }
    const proof = finding.validationProof?.proof;
    if (!proof) {
      return finding.state;
    }
    if (proof.replayReproduced === true) {
      return `${finding.state} (reproduced)`;
    }
    if (proof.notReplayedReason) {
      return `${finding.state} (reproduction not applicable: ${this.replayEscapeReasonLabel(proof.notReplayedReason)})`;
    }
    if (proof.replayAttempted) {
      return `${finding.state} (replay reviewed)`;
    }
    return `${finding.state} (reproduction pending)`;
  }

  private renderValidationProofLines(finding: ReportRendererFindingRow): string[] {
    const bundle = finding.validationProof;
    if (!bundle) {
      return ['- No structured validation proof trail was recorded.'];
    }

    const proof = bundle.proof;
    const replayStatus = proof.replayReproduced === true
      ? `reproduced${proof.replayArtifact ? ` via ${proof.replayArtifact}` : ''}`
      : proof.notReplayedReason
        ? `not applicable or unsafe to replay (${this.replayEscapeReasonLabel(proof.notReplayedReason)})`
        : proof.replayAttempted
          ? `attempted${proof.replayArtifact ? `; artifact ${proof.replayArtifact}` : ''}${proof.replayReproduced === false ? '; did not reproduce' : ''}`
          : 'pending or not attempted';
    const lines = [
      `- Claim: ${proof.claim}`,
      `- Replay status: ${replayStatus}`,
      proof.evidenceIds.length > 0
        ? `- Bound evidence: ${proof.evidenceIds.join(', ')}`
        : '- Bound evidence: explicit replay escape reason recorded',
    ];

    if (bundle.obligations.length > 0) {
      lines.push('- Proof obligations:');
      lines.push(
        ...bundle.obligations.map((entry) =>
          `  - ${entry.status}: ${entry.observable}${entry.evidenceIds.length > 0 ? ` (evidence: ${entry.evidenceIds.join(', ')})` : ''}${entry.note ? ` - ${entry.note}` : ''}`,
        ),
      );
    }

    const triage = bundle.advisoryTriage;
    lines.push(
      `- Advisory triage: ${triage.verdict} by ${triage.triagedBy} - ${triage.reason}`,
    );
    if (triage.flags.length > 0 || triage.duplicateOf) {
      lines.push(
        `  - Flags: ${[
          ...triage.flags,
          triage.duplicateOf ? `duplicate_of:${triage.duplicateOf}` : '',
        ].filter(Boolean).join(', ')}`,
      );
    }
    return lines;
  }

  renderReportContextBrief(params: {
    reportState: ReportRendererState;
    reportable: ReportRendererFindingRow[];
    candidates: ReportRendererFindingRow[];
    complianceReadiness?: ComplianceReadinessResponse;
    recommendedSections: string[];
    browserEvidence?: ReportRendererBrowserEvidenceSummary;
  }): string {
    const digest = params.reportState.coverage.runDigest;
    const findingLines =
      params.reportable.length > 0
        ? params.reportable.map((finding) =>
            `- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.id}) - ${this.riskProofStateLabel(finding)}`,
          )
        : ['- No validated reportable findings.'];
    const proofTrailLines =
      params.reportable.length > 0
        ? [
            '',
            '## Validation Proof Trails',
            ...params.reportable.flatMap((finding) => [
              `### ${finding.title} (${finding.id})`,
              ...this.renderValidationProofLines(finding),
              '',
            ]),
          ]
        : [];
    const impactTrailLines =
      params.reportable.some((finding) => this.controlledExploitationResult(finding))
        ? [
            '',
            '## Controlled Exploitation Impact And Cleanup',
            ...params.reportable
              .filter((finding) => this.controlledExploitationResult(finding))
              .flatMap((finding) => [
                `### ${finding.title} (${finding.id})`,
                'Validated primitive:',
                ...this.renderValidationProofLines(finding),
                'Demonstrated impact:',
                ...this.renderDemonstratedImpactLines(finding),
                'Cleanup status:',
                ...this.renderCleanupStatusLines(finding),
                '',
              ]),
          ]
        : [];
    const candidateLines =
      params.candidates.length > 0
        ? [
            '',
            '## Candidate Findings',
            ...params.candidates.map(
              (finding) => `- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.state})`,
            ),
          ]
        : [];
    const missingReportFieldLines = params.reportState.findings
      .map((finding) => ({
        finding,
        reportCompleteness: buildFindingReportCompleteness(finding),
      }))
      .filter(({ reportCompleteness }) => reportCompleteness.missingReportFields.length > 0)
      .map(
        ({ finding, reportCompleteness }) =>
          `- ${finding.title} (${finding.id}): missing ${reportCompleteness.missingReportFields.join(', ')}. ${reportCompleteness.repairInstruction ?? ''}`.trim(),
      );
    const complianceLines =
      params.complianceReadiness && params.complianceReadiness.frameworks.length > 0
        ? [
            '',
            '## Compliance Readiness',
            `- Boundary: ${COMPLIANCE_READINESS_BOUNDARY_SENTENCE}`,
            ...(params.complianceReadiness.frameworks.some((framework) => framework.selected && framework.supported && framework.key === 'gdpr')
              ? [`- Boundary: ${GDPR_READINESS_BOUNDARY_SENTENCE}`]
              : []),
            `- Context artifact: /workspace/.artifacts/report/compliance-context.json`,
            ...params.complianceReadiness.frameworks.flatMap((framework) => {
              const runCheckedControls = framework.controls.filter((control) => (control.controlChecks ?? []).length > 0).length;
              const readinessNeedsAction = framework.outcomeCounts?.needs_action ?? 0;
              const readinessNotChecked = framework.outcomeCounts?.not_checked ?? 0;
              const implementationSpecCounts = framework.key === 'hipaa'
                ? framework.controls.reduce<Record<string, number>>((counts, control) => {
                    const key = control.implementationSpec ?? 'unlabeled';
                    counts[key] = (counts[key] ?? 0) + 1;
                    return counts;
                  }, {})
                : null;
              const pciContextCounts = framework.key === 'pci_dss'
                ? framework.controls.reduce<{
                    approaches: Record<string, number>;
                    cdeScopes: Record<string, number>;
                    accountData: Record<string, number>;
                  }>((counts, control) => {
                    const approach = control.pciDssApproach ?? 'unlabeled';
                    const cdeScope = control.pciDssCdeScope ?? 'unlabeled';
                    const accountData = control.pciDssAccountData ?? 'none';
                    counts.approaches[approach] = (counts.approaches[approach] ?? 0) + 1;
                    counts.cdeScopes[cdeScope] = (counts.cdeScopes[cdeScope] ?? 0) + 1;
                    counts.accountData[accountData] = (counts.accountData[accountData] ?? 0) + 1;
                    return counts;
                  }, { approaches: {}, cdeScopes: {}, accountData: {} })
                : null;
              return [
                `- ${framework.label}: ${framework.supported ? `${framework.outcomeCounts?.passed ?? framework.statusCounts.passing} passed, ${framework.outcomeCounts?.failed ?? framework.statusCounts.failing} failed` : 'selected but not mapped'}.`,
                `  - This run assessed: ${runCheckedControls}/${framework.controls.length} controls with direct agent check records.`,
                `  - Overall framework readiness: denominator ${framework.controls.length}; ${readinessNeedsAction} need action; ${readinessNotChecked} not checked; status counts ${this.renderStatusCounts(framework.statusCounts)}.`,
                ...(pciContextCounts
                  ? [
                      `  - PCI DSS context: approaches ${Object.entries(pciContextCounts.approaches).map(([key, count]) => `${key}=${count}`).join(', ')}; CDE scopes ${Object.entries(pciContextCounts.cdeScopes).map(([key, count]) => `${key}=${count}`).join(', ')}; account-data controls ${Object.entries(pciContextCounts.accountData).map(([key, count]) => `${key}=${count}`).join(', ')}. A declared CDE boundary and SAQ profile are customer context, not independently determined by this report.`,
                    ]
                  : []),
                ...(implementationSpecCounts
                  ? [
                      `  - HIPAA implementation specifications: required=${implementationSpecCounts.required ?? 0}; addressable=${implementationSpecCounts.addressable ?? 0}; mixed=${implementationSpecCounts.mixed ?? 0}. Addressable does not mean optional; accept implemented controls or documented risk-based alternatives only when evidence supports them.`,
                    ]
                  : []),
                ...(framework.frameworkProfile?.kind === 'nist_csf_2_0'
                  ? [
                      `  - Function readiness: ${framework.frameworkProfile.functions.map((item) => `${item.function} ${item.outcomeCounts.passed}/${item.total} passed (${item.directCheckCount} direct checks)`).join('; ')}.`,
                      `  - Indicative Implementation Tier: not determined. ${framework.frameworkProfile.implementationTier.reason}`,
                    ]
                  : []),
              ];
            }),
          ]
        : [];
    const browserScreenshotArtifacts =
      params.browserEvidence?.latestArtifacts.filter((artifact) => artifact.type === 'screenshot') ?? [];
    const browserEvidenceLines =
      params.browserEvidence &&
      (
        params.browserEvidence.screenshotCount > 0 ||
        params.browserEvidence.networkArtifactCount > 0 ||
        params.browserEvidence.bundleArtifactCount > 0 ||
        params.browserEvidence.traceArtifactCount > 0 ||
        params.browserEvidence.challengeCount > 0
      )
        ? [
            '',
            '## Browser Evidence',
            `- Screenshots: ${params.browserEvidence.screenshotCount}`,
            ...(browserScreenshotArtifacts.length > 0
              ? [
                  '- Report-safe screenshot embed syntax (alt text renders as visible caption):',
                  ...browserScreenshotArtifacts
                    .slice(0, 5)
                    .map((artifact) => this.renderBrowserScreenshotEmbedSnippet(artifact.path)),
                ]
              : []),
            `- Network/HAR artifacts: ${params.browserEvidence.networkArtifactCount}`,
            `- Evidence bundles: ${params.browserEvidence.bundleArtifactCount}`,
            `- Trace artifacts: ${params.browserEvidence.traceArtifactCount}`,
            `- Sensitive storage-state artifacts: ${params.browserEvidence.sensitiveStateArtifactCount} (do not cite or include in reports)`,
            ...(params.browserEvidence.challengeCount > 0
              ? [
                  '- Challenge/blocker summaries:',
                  ...params.browserEvidence.challenges.map((challenge) =>
                    `  - ${challenge.kind} (${challenge.confidence}) at ${challenge.url ?? challenge.artifactPath}: ${challenge.evidenceSummary ?? 'challenge indicators captured'}; authorized path: ${challenge.recommendedAuthorizedPath ?? 'not recorded'}`,
                  ),
                ]
              : ['- Challenge/blocker summaries: none captured']),
          ]
        : [];
    const lines = [
      '# Reporter Handoff',
      '',
      'Use this as source material. Author `summary.md` and `report.md` manually; do not paste this file as the report.',
      '',
      '## Closeout State',
      `- RunCompletion: ${params.reportState.runCompletion.state}`,
      `- Reasons: ${params.reportState.runCompletion.reasons.join('; ')}`,
      `- Plan: ${params.reportState.coverage.plan.completed}/${params.reportState.coverage.plan.total} completed`,
      digest?.goal ? `- Goal: ${digest.goal}` : '- Goal: not yet recorded in run.digest',
      digest?.outcome ? `- Outcome: ${digest.outcome}` : '- Outcome: not yet recorded in run.digest',
      '',
      '## Findings',
      ...findingLines,
      ...proofTrailLines,
      ...impactTrailLines,
      ...candidateLines,
      ...(missingReportFieldLines.length > 0
        ? [
            '',
            '## Missing Canonical Report Fields',
            ...missingReportFieldLines,
          ]
        : []),
      '',
      '## Coverage',
      `- Mission skills: ${params.reportState.coverage.missionSkills.join(', ') || 'none recorded'}`,
      `- Notes: ${params.reportState.coverage.noteCounts.map((entry) => `${entry.ntype}=${entry.count}`).join(', ') || 'none recorded'}`,
      params.reportState.coverage.openDebts.length > 0 ? '- Open debts:' : '- Open debts: none',
      ...params.reportState.coverage.openDebts.map((debt) => `  - ${debt}`),
      '',
      '## Discovery Snapshot',
      ...this.renderDiscoveryLines(params.reportState.coverage),
      '',
      '## Technique Attempts',
      ...this.renderApproachLines(params.reportState.coverage).slice(0, 12),
      '',
      '## Scanner Summary',
      ...this.renderScannerOutcomeLines(params.reportState.coverage).slice(0, 8),
      ...browserEvidenceLines,
      ...complianceLines,
      '',
      '## Recommended Report Sections',
      ...params.recommendedSections.map((section) => `- ${section}`),
      '',
      '## Finalization Checklist',
      '- Confirm `.artifacts/report/finalizer-preflight.json` before drafting; use final mode only when `canFinalizeFinal=true`.',
      '- Write or update `run.digest` after report sections are settled.',
      '- Write `summary.md` as a compact operator summary.',
      '- Write `report.md` as the polished assessment report.',
      '- Keep raw scanner logs in `.artifacts/report/context.json`; do not dump them into the report unless they are essential evidence.',
      '- Call `finalize_run_artifacts` only after both markdown files exist.',
    ];
    return `${lines.join('\n')}\n`;
  }

  renderSummaryArtifact(params: {
    mode: 'final' | 'interim';
    reason?: string;
    runCompletion: ReportRendererRunCompletion;
    findings: ReportRendererFindingRow[];
    coverage: ReportRendererCoverageSummary;
  }): string {
    const reportable = params.findings.filter((finding) => isReportableRiskState(finding.state));
    const candidates = params.findings.filter((finding) => !isReportableRiskState(finding.state));
    const severityCounts = reportable.reduce<Record<string, number>>((acc, finding) => {
      const key = finding.severity.toLowerCase();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const severityLine = ['critical', 'high', 'medium', 'low', 'info']
      .filter((severity) => severityCounts[severity])
      .map((severity) => `${severityCounts[severity]} ${severity}`)
      .join(', ') || 'none';
    return [
      `# Run Summary (${params.mode})`,
      '',
      `Closeout state: ${params.runCompletion.state}`,
      params.reason ? `Reason: ${params.reason}` : '',
      params.coverage.runDigest?.outcome ? `Outcome: ${params.coverage.runDigest.outcome}` : '',
      '',
      `Reportable findings: ${reportable.length} (${severityLine})`,
      `Candidate findings: ${candidates.length}`,
      `Evidence references: ${params.findings.reduce((sum, finding) => sum + (finding.evidence?.length ?? 0), 0)}`,
      '',
      '## Key Results',
      reportable.length > 0
        ? reportable.map((finding) => `- ${finding.severity.toUpperCase()}: ${finding.title}`).join('\n')
        : '- No reportable findings were promoted in this run.',
      candidates.length > 0
        ? `- ${candidates.length} candidate finding(s) remain unpromoted and are excluded from reportables.`
        : '- No unpromoted candidate findings remain.',
      '',
      '## Findings Snapshot',
      ...this.renderFindingSummaryTable(reportable),
      '',
      candidates.length > 0 ? '## Candidate Findings Excluded From Reportables' : '',
      ...(candidates.length > 0
        ? candidates.map((finding) => `- ${finding.severity.toUpperCase()}: ${finding.title}`)
        : []),
      '',
      '## Closeout Reasons',
      ...params.runCompletion.reasons.map((reason) => `- ${reason}`),
      '',
      ...this.renderCoverageLines(params.coverage),
      '',
      '## Scan Coverage Notes',
      ...this.renderScanCoverageLines(params.coverage),
      '',
      '## Scanner Outcomes',
      ...this.renderScannerOutcomeLines(params.coverage),
      '',
      '## Approach Notes',
      ...this.renderApproachLines(params.coverage),
      '',
      ...(params.mode === 'interim' ? [...this.renderInterimBlockerLines(params.coverage), ''] : []),
    ].filter((line) => line !== '').join('\n');
  }

  renderReportArtifact(params: {
    mode: 'final' | 'interim';
    reason?: string;
    runCompletion: ReportRendererRunCompletion;
    findings: ReportRendererFindingRow[];
    coverage: ReportRendererCoverageSummary;
  }): string {
    const reportable = params.findings.filter((finding) => isReportableRiskState(finding.state));
    const candidates = params.findings.filter((finding) => !isReportableRiskState(finding.state));
    const sortedReportable = [...reportable].sort(
      (left, right) => reportSeverityRank(left.severity) - reportSeverityRank(right.severity) || left.title.localeCompare(right.title),
    );
    const digest = params.coverage.runDigest;
    const buckets = this.bucketReportSections(params.coverage.reportSections);
    const hasOperatorNarrative = params.coverage.reportSections.length > 0;
    const evidenceTotal = params.findings.reduce((sum, finding) => sum + (finding.evidence?.length ?? 0), 0);

    const cover = [
      `# Security Assessment Report - ${digest?.goal ?? 'SecurityOps Engagement'}`,
      '',
      `**Report mode:** ${params.mode}  `,
      `**Closeout state:** ${params.runCompletion.state}  `,
      `**Outcome:** ${digest?.outcome ?? params.runCompletion.state}  `,
      `**Reportable findings:** ${reportable.length}  `,
      `**Unpromoted candidates:** ${candidates.length}`,
      params.reason ? '' : '',
      params.reason ? `> Closeout reason: ${params.reason}` : '',
      '',
      hasOperatorNarrative
        ? ''
        : '> **Legacy fallback notice.** This renderer is retained for compatibility only; normal SecurityOps closeout uses authored report files.',
      '',
      '---',
      '',
    ];

    const execSummary = [
      '## 1. Executive Summary',
      '',
      ...(buckets.executiveSummary.length > 0
        ? buckets.executiveSummary.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : [
            ...this.renderFallbackSummaryLines({
              runCompletion: params.runCompletion,
              findings: params.findings,
              candidates,
              coverage: params.coverage,
            }),
            '',
          ]),
      '### Risk Snapshot',
      ...this.renderSeverityCountList(reportable),
      `- Evidence references retained: ${evidenceTotal}`,
      `- Plan completion: ${params.coverage.plan.completed}/${params.coverage.plan.total} approved steps`,
      '',
    ];

    const findingsAtAGlance = [
      '## 2. Findings at a Glance',
      '',
      ...this.renderFindingSummaryTable(sortedReportable),
      '',
      candidates.length > 0
        ? `_${candidates.length} candidate finding(s) remain unpromoted and are excluded from reportables._`
        : '_No unpromoted candidate findings remain._',
      '',
    ];

    const methodologySection = [
      '## 3. Engagement Methodology',
      '',
      ...(buckets.methodology.length > 0
        ? buckets.methodology.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : [
            digest?.goal ? `**Run goal:** ${digest.goal}` : '_Run goal: not recorded in run.digest._',
            '',
            params.coverage.missionQuestions.length > 0
              ? `**Mission questions investigated:**\n${params.coverage.missionQuestions.map((question) => `- ${question}`).join('\n')}`
              : '_No mission questions were recorded._',
            '',
            params.coverage.missionSkills.length > 0
              ? `**Skills exercised:** ${params.coverage.missionSkills.join(', ')}`
              : '_No mission skills were recorded._',
            '',
          ]),
    ];

    const attackSurfaceSection = [
      '## 4. Attack Surface Overview',
      '',
      ...(buckets.attackSurface.length > 0
        ? buckets.attackSurface.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : []),
      '### Discovery Snapshot',
      ...this.renderDiscoveryLines(params.coverage),
      '',
      '### Scan Coverage',
      ...this.renderScanCoverageLines(params.coverage),
      '',
    ];

    const findingsNarrativeBlock = buckets.findingsNarrative.length > 0
      ? ['### Narrative', '', ...buckets.findingsNarrative.flatMap((section) => this.renderOperatorNarrativeSection(section, 3))]
      : [];
    const detailedFindingsSection = [
      '## 5. Findings - Detailed Analysis',
      '',
      ...findingsNarrativeBlock,
      ...(sortedReportable.length > 0
        ? sortedReportable.flatMap((finding, index) => this.renderDetailedFinding(finding, index))
        : ['_No reportable findings were promoted in this run._', '']),
      candidates.length > 0 ? '### Candidate Findings (Excluded From Reportables)' : '',
      ...(candidates.length > 0
        ? candidates.map((finding) => `- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.state})`)
        : []),
      '',
    ];

    const limitationsSection = [
      '## 6. Limitations and Coverage Debt',
      '',
      ...(buckets.limitations.length > 0
        ? buckets.limitations.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : []),
      ...this.renderCoverageLines(params.coverage),
      '',
      ...(params.mode === 'interim' ? [...this.renderInterimBlockerLines(params.coverage), ''] : []),
    ];

    const remediationSection = [
      '## 7. Remediation Plan',
      '',
      ...(buckets.remediation.length > 0
        ? buckets.remediation.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : sortedReportable.length > 0
          ? [
              '_Remediation guidance was not consolidated into a `remediation-plan` section. Per-finding remediation steps are listed in section 5._',
              '',
              ...sortedReportable.map((finding, index) => `${index + 1}. ${finding.severity.toUpperCase()} - ${finding.title}: see section 5.${index + 1}.`),
              '',
            ]
          : ['_No remediation plan is required; no reportable findings were promoted._', '']),
    ];

    const nextStepsSection = [
      '## 8. Next Steps',
      '',
      ...(buckets.nextSteps.length > 0
        ? buckets.nextSteps.flatMap((section) => this.renderOperatorNarrativeSection(section))
        : []),
      digest?.blockerSummary ? `**Blocking context:** ${digest.blockerSummary}` : '',
      digest?.nextPrerequisites.length ? '**Next prerequisites:**' : '',
      ...(digest?.nextPrerequisites ?? []).map((item) => `- ${item}`),
      '',
    ];

    const additionalOperatorSection = buckets.other.length > 0
      ? [
          '## 9. Additional Operator Notes',
          '',
          ...buckets.other.flatMap((section) => this.renderOperatorNarrativeSection(section)),
        ]
      : [];

    const appendices = [
      '---',
      '',
      '## Appendix A - Evidence Index',
      '',
      ...(params.findings.length > 0
        ? params.findings.flatMap((finding) => [
            `### ${finding.title}`,
            ...this.renderFindingEvidenceLines(finding),
            '',
          ])
        : ['_No finding evidence references were recorded._', '']),
      '## Appendix B - Techniques Attempted',
      '',
      ...this.renderApproachLines(params.coverage),
      '',
      '## Appendix C - Scanner Outcomes',
      '',
      ...this.renderScannerOutcomeLines(params.coverage),
      '',
      '## Appendix D - Run Completion Reasons',
      '',
      ...params.runCompletion.reasons.map((reason) => `- ${reason}`),
      '',
      digest?.completedTasks.length ? '### Completed Tasks (run.digest)' : '',
      ...(digest?.completedTasks ?? []).map((task) => `- ${task}`),
      digest?.blockedTasks.length ? '### Blocked Tasks (run.digest)' : '',
      ...(digest?.blockedTasks ?? []).map((task) => `- ${task}`),
      '',
    ];

    return [
      ...cover,
      ...execSummary,
      ...findingsAtAGlance,
      ...methodologySection,
      ...attackSurfaceSection,
      ...detailedFindingsSection,
      ...limitationsSection,
      ...remediationSection,
      ...nextStepsSection,
      ...additionalOperatorSection,
      ...appendices,
    ]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }

  private buildScannerOutcomeRows(shellJobs?: Record<string, unknown>): ReportRendererCoverageSummary['scannerOutcomes'] {
    if (!shellJobs) {
      return [];
    }
    const rows: ReportRendererCoverageSummary['scannerOutcomes'] = [];
    for (const job of Object.values(shellJobs).filter(isRecord)) {
      const command = compactReportText(job.command, 220) ?? '';
      if (!command || !SCANNER_COMMAND_PATTERN.test(command)) {
        continue;
      }
      const status = compactReportText(job.status)?.toLowerCase();
      const outcome =
        compactReportText(job.outcome)?.toLowerCase() ??
        (status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failed'
            : status === 'completed'
              ? 'completed_no_reportable_output'
              : status === 'running' || status === 'unknown'
                ? 'running'
                : 'not_run');
      rows.push({
        jobId: compactReportText(job.jobId) ?? 'unknown-job',
        command,
        outcome,
        ...(typeof job.exitCode === 'number' ? { exitCode: job.exitCode } : {}),
        ...(compactReportText(job.stdoutPath) ? { stdoutPath: compactReportText(job.stdoutPath) } : {}),
        ...(compactReportText(job.stderrPath) ? { stderrPath: compactReportText(job.stderrPath) } : {}),
      });
    }
    return rows.slice(0, 20);
  }

  private statusCountLabel(status: ComplianceReadinessStatus): string {
    switch (status) {
      case 'passing':
        return 'Passing';
      case 'partial':
        return 'Partial';
      case 'failing':
        return 'Failing';
      case 'stale':
        return 'Stale';
      case 'accepted_risk':
        return 'Accepted Risk';
      case 'not_applicable':
        return 'Not Applicable';
      case 'not_supported':
        return 'Not Supported';
      case 'missing':
      default:
        return 'Missing';
    }
  }

  private renderStatusCounts(statusCounts: Record<ComplianceReadinessStatus, number>): string {
    const order: ComplianceReadinessStatus[] = [
      'passing',
      'partial',
      'failing',
      'missing',
      'stale',
      'accepted_risk',
      'not_applicable',
      'not_supported',
    ];
    return order
      .map((status) => `${this.statusCountLabel(status)}=${statusCounts[status] ?? 0}`)
      .join(', ');
  }

  private renderBrowserScreenshotEmbedSnippet(artifactPath: string): string {
    const reportPath = artifactPath.replace(/^\/workspace\//, '');
    return `  - \`![${this.browserScreenshotCaption(artifactPath)}](${reportPath})\``;
  }

  private browserScreenshotCaption(artifactPath: string): string {
    const fileName = artifactPath.replace(/\\/g, '/').split('/').pop() ?? '';
    const stem = fileName.replace(/\.[^.]+$/, '');
    const caption = stem
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!caption) {
      return 'Browser Evidence Screenshot';
    }

    return caption
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private renderApproachLines(coverage: ReportRendererCoverageSummary): string[] {
    if (coverage.approaches.length === 0) {
      return ['- No approach.tried notes were recorded.'];
    }
    return coverage.approaches.map((approach) =>
      `- ${approach.technique} against ${approach.endpoint}: ${approach.result}${approach.reason ? ` - ${approach.reason}` : ''}`,
    );
  }

  private renderCoverageLines(coverage: ReportRendererCoverageSummary): string[] {
    return [
      '## Coverage',
      `- Plan steps: ${coverage.plan.total} total, ${coverage.plan.completed} completed, ${coverage.plan.blocked} blocked, ${coverage.plan.running} running, ${coverage.plan.pending} pending, ${coverage.plan.error} error`,
      coverage.missionQuestions.length > 0
        ? `- Mission questions: ${coverage.missionQuestions.join('; ')}`
        : '- Mission questions: none recorded',
      coverage.missionSkills.length > 0
        ? `- Mission skills: ${coverage.missionSkills.join(', ')}`
        : '- Mission skills: none recorded',
      coverage.noteCounts.length > 0
        ? `- Notes recorded: ${coverage.noteCounts.map((entry) => `${entry.ntype}=${entry.count}`).join(', ')}`
        : '- Notes recorded: none',
      coverage.testedClasses.length > 0
        ? `- Tested or reported classes: ${coverage.testedClasses.join('; ')}`
        : '- Tested or reported classes: none recorded',
      coverage.openDebts.length > 0 ? '- Open coverage debts:' : '- Open coverage debts: none',
      ...coverage.openDebts.map((debt) => `  - ${debt}`),
    ];
  }

  private renderScanCoverageLines(coverage: ReportRendererCoverageSummary): string[] {
    if (coverage.scanCoverage.length === 0) {
      return ['- No scan.coverage notes were recorded in this run.'];
    }
    return coverage.scanCoverage.map((entry) => {
      const details = [
        entry.family,
        entry.status,
        entry.toolset.length > 0 ? `tools: ${entry.toolset.join(', ')}` : undefined,
        entry.stats.length > 0 ? entry.stats.join(', ') : undefined,
        entry.reason,
      ].filter(Boolean);
      return `- ${entry.title}${details.length > 0 ? ` (${details.join('; ')})` : ''}`;
    });
  }

  private renderFallbackSummaryLines(params: {
    runCompletion: ReportRendererRunCompletion;
    findings: ReportRendererFindingRow[];
    candidates: ReportRendererFindingRow[];
    coverage: ReportRendererCoverageSummary;
  }): string[] {
    const reportable = params.findings.filter((finding) => isReportableRiskState(finding.state));
    const evidenceCount = params.findings.reduce((sum, finding) => sum + (finding.evidence?.length ?? 0), 0);
    const digest = params.coverage.runDigest;
    const completion =
      params.coverage.plan.total > 0
        ? `${params.coverage.plan.completed}/${params.coverage.plan.total} approved plan steps completed`
        : 'approved plan progress was not recorded';
    const skills =
      params.coverage.missionSkills.length > 0
        ? params.coverage.missionSkills.join(', ')
        : 'no mission skills recorded';
    const coverageStatement =
      params.coverage.scanCoverage.length > 0
        ? `${reportPlural(params.coverage.scanCoverage.length, 'scan coverage note')} and ${reportPlural(params.coverage.approaches.length, 'technique attempt')} were recorded.`
        : params.coverage.approaches.length > 0
          ? `${reportPlural(params.coverage.approaches.length, 'technique attempt')} were recorded; no scan.coverage note was filed.`
          : 'No scan.coverage or approach.tried notes were recorded.';
    const limitation = params.coverage.openDebts[0] ?? params.coverage.blockers[0]?.detail;

    return [
      `The run closed as ${digest?.outcome ?? params.runCompletion.state}; ${completion}. The work focused on ${skills}.`,
      reportable.length > 0
        ? `It produced ${reportPlural(reportable.length, 'validated reportable finding')} with ${reportPlural(evidenceCount, 'evidence reference')}.`
        : `It produced no validated reportable findings; ${reportPlural(evidenceCount, 'evidence reference')} were retained for auditability.`,
      params.candidates.length > 0
        ? `${reportPlural(params.candidates.length, 'candidate finding')} remain unpromoted and are excluded from final reportables.`
        : 'No unpromoted candidate findings remain.',
      coverageStatement,
      limitation ? `Main limitation: ${limitation}` : '',
      digest?.blockerSummary ? `Blocking context: ${digest.blockerSummary}` : '',
    ].filter((line) => line.length > 0);
  }

  private renderOperatorNarrativeSection(
    section: ReportRendererCoverageSummary['reportSections'][number],
    headingLevel: 2 | 3 = 3,
  ): string[] {
    const prefix = headingLevel === 2 ? '## ' : '### ';
    return [
      `${prefix}${section.heading}`,
      '',
      section.content,
      '',
      section.evidenceRefs.length > 0 ? `_Evidence references: ${section.evidenceRefs.join(', ')}_` : '',
      '',
    ];
  }

  private bucketReportSections(
    reportSections: ReportRendererCoverageSummary['reportSections'],
  ): {
    executiveSummary: ReportRendererCoverageSummary['reportSections'];
    methodology: ReportRendererCoverageSummary['reportSections'];
    attackSurface: ReportRendererCoverageSummary['reportSections'];
    findingsNarrative: ReportRendererCoverageSummary['reportSections'];
    limitations: ReportRendererCoverageSummary['reportSections'];
    remediation: ReportRendererCoverageSummary['reportSections'];
    nextSteps: ReportRendererCoverageSummary['reportSections'];
    other: ReportRendererCoverageSummary['reportSections'];
  } {
    const buckets = {
      executiveSummary: [] as ReportRendererCoverageSummary['reportSections'],
      methodology: [] as ReportRendererCoverageSummary['reportSections'],
      attackSurface: [] as ReportRendererCoverageSummary['reportSections'],
      findingsNarrative: [] as ReportRendererCoverageSummary['reportSections'],
      limitations: [] as ReportRendererCoverageSummary['reportSections'],
      remediation: [] as ReportRendererCoverageSummary['reportSections'],
      nextSteps: [] as ReportRendererCoverageSummary['reportSections'],
      other: [] as ReportRendererCoverageSummary['reportSections'],
    };
    for (const section of reportSections) {
      const key = section.section.trim().toLowerCase();
      if (key === 'executive-summary') buckets.executiveSummary.push(section);
      else if (key === 'methodology') buckets.methodology.push(section);
      else if (key === 'attack-surface') buckets.attackSurface.push(section);
      else if (key === 'findings-narrative') buckets.findingsNarrative.push(section);
      else if (key === 'limitations') buckets.limitations.push(section);
      else if (key === 'remediation-plan' || key === 'remediation') buckets.remediation.push(section);
      else if (key === 'next-steps') buckets.nextSteps.push(section);
      else buckets.other.push(section);
    }
    return buckets;
  }

  private renderSeverityCountList(reportable: ReportRendererFindingRow[]): string[] {
    if (reportable.length === 0) {
      return ['- No validated reportable findings.'];
    }
    const counts = reportable.reduce<Record<string, number>>((acc, finding) => {
      const key = finding.severity.toLowerCase();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return ['critical', 'high', 'medium', 'low', 'info']
      .filter((severity) => counts[severity])
      .map((severity) => `- ${severity.toUpperCase()}: ${counts[severity]}`);
  }

  private renderFindingSummaryTable(findingsToRender: ReportRendererFindingRow[]): string[] {
    if (findingsToRender.length === 0) {
      return ['No reportable findings.'];
    }
    const sorted = [...findingsToRender].sort(
      (left, right) => reportSeverityRank(left.severity) - reportSeverityRank(right.severity) || left.title.localeCompare(right.title),
    );
    return [
      '| Severity | Finding | CVSS | CWE / OWASP | Evidence | Status |',
      '| --- | --- | --- | --- | --- | --- |',
      ...sorted.map((finding) =>
        `| ${[
          markdownTableCell(finding.severity.toUpperCase()),
          markdownTableCell(finding.title),
          markdownTableCell(finding.cvssScore !== null && finding.cvssScore !== undefined ? `${finding.cvssScore} ${finding.cvssVector ?? ''}`.trim() : '-'),
          markdownTableCell(
            uniqueReportStrings([
              ...normalizeReportStringArray(finding.cweIds),
              ...(finding.cweId ? [finding.cweId] : []),
              ...(finding.owaspCategory ? [finding.owaspCategory] : []),
            ]).join(', ') || '-',
          ),
          markdownTableCell(`${finding.evidence?.length ?? 0} reference(s)`),
          markdownTableCell(this.riskProofStateLabel(finding)),
        ].join(' | ')} |`,
      ),
    ];
  }

  private renderFindingEvidenceLines(finding: ReportRendererFindingRow): string[] {
    const evidence = finding.evidence ?? [];
    if (evidence.length === 0) {
      return ['- No evidence references were stored for this finding.'];
    }
    return evidence.slice(0, 8).flatMap((entry) => {
      const displayPath = entry.displayPath ?? entry.path;
      const label = entry.label ? `${entry.label}: ` : '';
      const missing = entry.fileMissing ? ' (missing artifact)' : '';
      const lines = [`- ${label}${displayPath}${missing}`];
      if (entry.kind === 'http_exchange' && isFindingHttpExchange(entry.data)) {
        lines.push(
          `  - HTTP: ${entry.data.request.method} ${entry.data.request.url} -> ${entry.data.response.statusCode}`,
        );
      }
      const excerpt = compactReportText(entry.excerpt, 300);
      if (excerpt) {
        lines.push(`  - Excerpt: ${excerpt}`);
      }
      return lines;
    });
  }

  private controlledExploitationResult(
    finding: ReportRendererFindingRow,
  ): AttackResultV1 | undefined {
    return finding.evidence
      ?.map((entry) => entry.data)
      .find(isAttackResultV1);
  }

  private renderDemonstratedImpactLines(finding: ReportRendererFindingRow): string[] {
    const result = this.controlledExploitationResult(finding);
    if (!result) {
      return ['- Not attempted or no controlled exploitation result was recorded.'];
    }
    return [
      `- Status: ${result.status}`,
      `- Objective: ${result.objectiveFamily}`,
      `- Target: ${result.targetRef}`,
      `- Proof: ${result.proofClaim}`,
      `- Changed state: ${result.changedStateSummary ?? 'No state change recorded.'}`,
      result.evidenceIds.length > 0
        ? `- Impact evidence: ${result.evidenceIds.join(', ')}`
        : '- Impact evidence: none',
      ...(result.limitations.length > 0
        ? [`- Limitations: ${result.limitations.join('; ')}`]
        : []),
    ];
  }

  private renderCleanupStatusLines(finding: ReportRendererFindingRow): string[] {
    const result = this.controlledExploitationResult(finding);
    if (!result) {
      return ['- Status: not applicable (controlled exploitation was not attempted).'];
    }
    const cleanup = result.cleanup;
    const prominentWarning =
      cleanup.status === 'failed' || cleanup.status === 'unknown' || result.status === 'cleanup_failed'
        ? `- **ATTENTION - CLEANUP ${cleanup.status.toUpperCase()}: ${cleanup.remainingRisk ?? 'Remaining risk was not resolved.'}**`
        : undefined;
    return [
      ...(prominentWarning ? [prominentWarning] : []),
      `- Required: ${cleanup.required ? 'yes' : 'no'}`,
      `- Status: ${cleanup.status}`,
      ...(cleanup.actions.length > 0 ? [`- Actions: ${cleanup.actions.join('; ')}`] : []),
      cleanup.evidenceIds.length > 0
        ? `- Cleanup evidence: ${cleanup.evidenceIds.join(', ')}`
        : '- Cleanup evidence: none',
      ...(cleanup.remainingRisk ? [`- Remaining risk: ${cleanup.remainingRisk}`] : []),
    ];
  }

  private renderCodeLocationLines(finding: ReportRendererFindingRow): string[] {
    const codeLocations = Array.isArray(finding.codeLocations) ? finding.codeLocations : [];
    if (codeLocations.length === 0) {
      return [];
    }
    return [
      'Code locations:',
      ...codeLocations.slice(0, 6).map((location) =>
        `- ${location.repository ? `${location.repository}:` : ''}${location.filePath}:${location.startLine}-${location.endLine}${location.label ? ` (${location.label})` : ''}`,
      ),
    ];
  }

  private renderDetailedFinding(finding: ReportRendererFindingRow, index: number): string[] {
    const classifications = uniqueReportStrings([
      ...normalizeReportStringArray(finding.cweIds),
      ...(finding.cweId ? [finding.cweId] : []),
      ...normalizeReportStringArray(finding.cveIds),
      ...(finding.cveId ? [finding.cveId] : []),
      ...(finding.owaspCategory ? [finding.owaspCategory] : []),
    ]);
    const metadata = [
      `Severity: ${finding.severity.toUpperCase()}`,
      `State: ${finding.state}`,
      finding.cvssScore !== null && finding.cvssScore !== undefined
        ? `CVSS: ${finding.cvssScore}${finding.cvssVector ? ` (${finding.cvssVector})` : ''}`
        : undefined,
      classifications.length > 0 ? `Classification: ${classifications.join(', ')}` : undefined,
      finding.fixEffort ? `Fix effort: ${finding.fixEffort}` : undefined,
      `First seen: ${toIsoString(finding.firstSeenAt) ?? 'unknown'}`,
      `Last seen: ${toIsoString(finding.lastSeenAt) ?? 'unknown'}`,
    ].filter((line): line is string => Boolean(line));

    const blocks: string[] = [
      `### ${index + 1}. ${finding.title}`,
      '',
      ...metadata.map((line) => `- ${line}`),
      '',
      '#### Summary',
      compactReportText(finding.summary, 1200) ?? 'No summary recorded.',
      '',
    ];

    const sectionPairs: Array<[string, string | undefined]> = [
      ['Business Impact', compactReportBlockText(finding.businessImpact, 1200)],
      ['Technical Analysis', compactReportBlockText(finding.technicalAnalysis, 1600)],
      ['Proof Of Concept', compactReportBlockText(finding.pocDescription, 1400)],
      ['Assumptions', compactReportBlockText(finding.assumptions, 900)],
      ['Remediation', compactReportBlockText(finding.remediation, 1400)],
    ];
    for (const [heading, content] of sectionPairs) {
      if (!content) continue;
      blocks.push(`#### ${heading}`, content, '');
    }
    const pocCode = compactReportText(finding.pocScriptCode, 1600);
    if (pocCode) {
      blocks.push('#### PoC Script Or Command', '```text', pocCode, '```', '');
    }
    const codeLocationLines = this.renderCodeLocationLines(finding);
    if (codeLocationLines.length > 0) {
      blocks.push('#### Affected Code', ...codeLocationLines, '');
    }
    blocks.push('#### Validation Proof - Validated Primitive', ...this.renderValidationProofLines(finding), '');
    blocks.push('#### Demonstrated Impact', ...this.renderDemonstratedImpactLines(finding), '');
    blocks.push('#### Cleanup Status', ...this.renderCleanupStatusLines(finding), '');
    blocks.push('#### Evidence', ...this.renderFindingEvidenceLines(finding), '');
    return blocks;
  }

  private renderInterimBlockerLines(coverage: ReportRendererCoverageSummary): string[] {
    if (coverage.blockers.length === 0 && coverage.openDebts.length === 0) {
      return ['## Interim Blockers', '- No blockers were recorded; this interim closeout was operator or budget driven.'];
    }
    return [
      '## Interim Blockers',
      ...coverage.blockers.map((blocker) => `- ${blocker.title}: ${blocker.detail}`),
      ...coverage.openDebts.map((debt) => `- ${debt}`),
    ];
  }

  private renderScannerOutcomeLines(coverage: ReportRendererCoverageSummary): string[] {
    if (coverage.scannerOutcomes.length === 0) {
      return ['- No scanner shell jobs were recorded in this run.'];
    }
    return coverage.scannerOutcomes.map((job) => {
      const details = [
        `outcome: ${job.outcome}`,
        job.exitCode !== undefined ? `exit: ${job.exitCode}` : undefined,
        job.stdoutPath ? `stdout: ${job.stdoutPath}` : undefined,
        job.stderrPath ? `stderr: ${job.stderrPath}` : undefined,
      ].filter(Boolean);
      return `- ${job.jobId}: ${job.command}${details.length > 0 ? ` (${details.join('; ')})` : ''}`;
    });
  }

  private renderDiscoveryLines(coverage: ReportRendererCoverageSummary): string[] {
    const lines: string[] = [];
    if (coverage.endpoints.length > 0) {
      lines.push('Reachable endpoints:');
      lines.push(
        ...coverage.endpoints.slice(0, 12).map((endpoint) =>
          `- ${endpoint.method ?? 'GET'} ${endpoint.url}${endpoint.statusCode ? ` (${endpoint.statusCode})` : ''}${endpoint.title ? ` - ${endpoint.title}` : ''}`,
        ),
      );
    }
    if (coverage.technologies.length > 0) {
      lines.push('Technology fingerprints:');
      lines.push(
        ...coverage.technologies.slice(0, 12).map((tech) => {
          const details = [tech.version, tech.category, tech.confidence !== undefined ? `confidence ${tech.confidence}` : undefined].filter(Boolean);
          return `- ${tech.product}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
        }),
      );
    }
    return lines.length > 0 ? lines : ['- No endpoint or technology discovery notes were recorded.'];
  }
}
