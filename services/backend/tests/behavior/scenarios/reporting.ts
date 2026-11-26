import { FileRead, FileWrite } from '../../../src/domains/agent-brain/adapters/tools/builtins/file';
import { SubmitPhaseHandoff } from '../../../src/domains/agent-brain/adapters/tools/builtins/phase';
import {
  FinalizeRunArtifacts,
  PrepareReportContext,
  ReportFinding,
  ReportFinalizerPreflight,
} from '../../../src/domains/agent-brain/adapters/tools/builtins/securityops';
import {
  asString,
  firstTool,
  normalizedPath,
  requireContentNeedles,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

export const reportingScenarios: BehaviorScenario[] = [
  {
    id: 'reporting-reads-assigned-methodology-before-preflight',
    title: 'Reporting phase reads its assigned methodology before preflight',
    why: 'Ensures an assigned reporting skill is activated instead of remaining an unread workspace path.',
    tools: [FileRead, ReportFinalizerPreflight],
    prompt: [
      'You are starting the dedicated reporting phase.',
      'TARGET CONTEXT assigns exactly one reporting methodology:',
      '- security-reporting: /workspace/.skills/security-reporting/methodology.md',
      'The reporting methodology has not been read in this session.',
      'After orientation, the mandatory reporting tool order begins with report_finalizer_preflight.',
      'Take exactly the next harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_read') {
        errors.push(`expected file_read before reporting preflight, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (targetPath !== '/workspace/.skills/security-reporting/methodology.md') {
        errors.push(`expected assigned security-reporting methodology path, observed ${targetPath || '<missing>'}`);
      }
      return errors;
    },
  },
  {
    id: 'reporting-preflight-first',
    title: 'Reporting phase calls finalizer preflight before drafting/finalizing',
    why: 'Catches the V2.1 reporting order regression before a long run reaches closeout.',
    tools: [ReportFinalizerPreflight, PrepareReportContext, FileWrite, FinalizeRunArtifacts],
    prompt: [
      'You are the dedicated reporting phase executor.',
      'The assigned reporting methodology has already been read for this session.',
      'The reporting phase just started. No report_finalizer_preflight result exists in session flags.',
      'Canonical state says: 1 potential Risk has durable HTTP evidence; no confirmed Risks exist yet.',
      'The candidate is missing remediation guidance.',
      'The tool description says the mandatory order is preflight, report context, file_write summary/report, phase handoff, finalize.',
      'Take exactly the next harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (call && call.name !== 'report_finalizer_preflight') {
        errors.push(`expected report_finalizer_preflight, observed ${call.name}`);
      }
      return errors;
    },
  },
  {
    id: 'reporting-interim-report-with-remediation-warning',
    title: 'Reporter writes interim report content when preflight blocks final mode',
    why: 'Catches the missing-remediation and interim-report behavior without running a full product evaluation.',
    tools: [FileWrite, ReportFinalizerPreflight, FinalizeRunArtifacts],
    prompt: [
      'You are the dedicated reporting phase executor.',
      'report_finalizer_preflight already ran and returned:',
      JSON.stringify({
        canFinalizeFinal: false,
        canFinalizeInterim: true,
        requiredMode: 'interim',
        intendedMode: 'interim',
        candidateCount: 1,
        reportableCount: 0,
        findingWarnings: [
          'finding finding-1 (IDOR candidate: orderId variance) missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
        ],
        finalizerBlockers: [
          '1 finding candidate(s) have durable evidence but are not promoted',
        ],
        exportExpectations: {
          summaryPath: 'summary.md',
          reportPath: 'report.md',
        },
      }, null, 2),
      'summary.md already exists. report.md is missing.',
      'Write the next required artifact only. The report must be honest that this is interim, validation is incomplete, and canonical report fields are missing.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_write') {
        errors.push(`expected file_write, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (!targetPath.endsWith('report.md')) {
        errors.push(`expected file_write path report.md, observed ${targetPath || '<missing>'}`);
      }
      errors.push(...requireContentNeedles(asString(call.args.content), ['interim', 'validation', 'missing'], 'report content'));
      return errors;
    },
  },
  {
    id: 'reporting-backfills-missing-remediation-before-draft',
    title: 'Reporter backfills canonical report fields before drafting when preflight warns',
    why: 'Catches the V2.1.5 finding-quality failure where evidence reached reporting but remediation stayed empty.',
    tools: [ReportFinding, FileWrite, ReportFinalizerPreflight, PrepareReportContext],
    prompt: [
      'You are the dedicated reporting phase executor.',
      'report_finalizer_preflight already ran and returned:',
      JSON.stringify({
        canFinalizeFinal: false,
        canFinalizeInterim: true,
        findingWarnings: [
          'finding finding-1 (IDOR candidate: orderId variance) missing report fields: businessImpact, technicalAnalysis, pocDescription, assumptions, remediation',
        ],
        missingReportFieldBlockers: [
          {
            id: 'finding-1',
            title: 'IDOR candidate: orderId variance',
            missingReportFields: ['businessImpact', 'technicalAnalysis', 'pocDescription', 'assumptions', 'remediation'],
            repairInstruction: 'Call report_finding with validatesFindingId="finding-1" and backfill evidence-specific business impact, technical analysis, proof of concept / validation steps, assumptions, remediation. Avoid generic placeholder prose.',
          },
        ],
      }, null, 2),
      'Canonical finding finding-1 already has durable HTTP evidence and this missing field can be fixed now.',
      JSON.stringify({
        findingId: 'finding-1',
        title: 'IDOR candidate: orderId variance',
        affectedEndpoint: 'GET /api/orders/{orderId}',
        rootCause: 'object ownership was not enforced before returning order details',
        impact: 'authenticated users can read orders that belong to another account by changing orderId',
        evidence: 'same-session GET /api/orders/1001 returned Alice order details while GET /api/orders/1002 returned Bob order details instead of 403',
        assumptions: 'attacker has any valid account and can guess or observe sequential order identifiers',
        recommendedFix: 'Enforce server-side ownership checks on order reads; derive order scope from the authenticated principal and return 403 for cross-user IDs. Add regression tests for same-user and cross-user order reads.',
      }, null, 2),
      'Take exactly one next harness action. Backfill businessImpact, technicalAnalysis, pocDescription, assumptions, and remediation on the existing finding before writing report.md. Do not draft the report yet.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'report_finding') {
        errors.push(`expected report_finding to backfill remediation, observed ${call.name}`);
      }
      if (call.args.validatesFindingId !== 'finding-1') {
        errors.push('expected report_finding(validatesFindingId="finding-1") to update the existing finding');
      }
      const remediation = asString(call.args.remediation);
      errors.push(...requireContentNeedles(remediation, ['ownership', '403', 'regression'], 'remediation'));
      if (remediation.length < 80) {
        errors.push('expected concrete remediation text, not a placeholder');
      }
      const businessImpact = asString(call.args.businessImpact);
      errors.push(...requireContentNeedles(businessImpact, ['orders', 'account'], 'businessImpact'));
      if (businessImpact.length < 60) {
        errors.push('expected concrete businessImpact text, not a placeholder');
      }
      const technicalAnalysis = asString(call.args.technicalAnalysis);
      errors.push(...requireContentNeedles(technicalAnalysis, ['ownership', 'orderId', '403'], 'technicalAnalysis'));
      if (technicalAnalysis.length < 80) {
        errors.push('expected concrete technicalAnalysis text, not a placeholder');
      }
      const pocDescription = asString(call.args.pocDescription);
      errors.push(...requireContentNeedles(pocDescription, ['GET', 'order', '403'], 'pocDescription'));
      if (pocDescription.length < 60) {
        errors.push('expected concrete pocDescription text, not a placeholder');
      }
      const assumptions = asString(call.args.assumptions);
      errors.push(...requireContentNeedles(assumptions, ['valid account', 'order'], 'assumptions'));
      if (assumptions.length < 40) {
        errors.push('expected concrete assumptions text, not a placeholder');
      }
      return errors;
    },
  },
  {
    id: 'reporting-no-findings-summary',
    title: 'Reporter writes an honest no-findings summary without inventing issues',
    why: 'Checks the empty-findings path where the model should report coverage and limitations, not create vulnerabilities.',
    tools: [FileWrite, PrepareReportContext, FinalizeRunArtifacts],
    prompt: [
      'You are the dedicated reporting phase executor.',
      'report_finalizer_preflight and prepare_report_context already ran.',
      'Canonical report context:',
      JSON.stringify({
        candidateFindings: [],
        reportableFindings: [],
        coverage: ['recon completed', 'enumeration completed', 'validation queue empty'],
        limitations: ['authenticated testing was not available'],
        exportExpectations: {
          summaryPath: 'summary.md',
          reportPath: 'report.md',
        },
      }, null, 2),
      'No authored artifacts exist yet. Write summary.md only.',
      'The summary must clearly say no confirmed findings were identified and must mention limitations. Do not invent a vulnerability.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_write') {
        errors.push(`expected file_write, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (!targetPath.endsWith('summary.md')) {
        errors.push(`expected file_write path summary.md, observed ${targetPath || '<missing>'}`);
      }
      const content = asString(call.args.content);
      errors.push(...requireContentNeedles(content, ['no confirmed findings', 'limitations'], 'summary content'));
      const lower = content.toLowerCase();
      if (lower.includes('critical vulnerability') || lower.includes('confirmed idor') || lower.includes('confirmed xss')) {
        errors.push('summary appears to invent a confirmed vulnerability');
      }
      return errors;
    },
  },
  {
    id: 'reporting-system-audit-uses-useful-relationship-map',
    title: 'Reporter maps a non-trivial audited system when relationships clarify risk',
    why: 'Detects reporters that reduce a multi-tier system audit to prose even though the supported report surface can communicate the evidenced trust boundaries and finding path more clearly.',
    tools: [FileWrite],
    prompt: [
      'You are the dedicated reporting phase executor with the assigned security-reporting methodology loaded.',
      'report_finalizer_preflight and prepare_report_context already ran and final mode is allowed.',
      'The authored Markdown surface supports Mermaid, but visuals are optional: use them only when they clarify actual evidence rather than decorate the report.',
      'Canonical report context:',
      JSON.stringify({
        scope: 'https://portal.example.test',
        inventory: [
          { asset: 'portal.example.test', role: 'public web application', evidenceRef: 'inventory://portal-web' },
          { asset: 'api.example.test', role: 'REST API behind the web application', evidenceRef: 'inventory://portal-api' },
          { asset: 'auth.example.test', role: 'OIDC identity provider used by the portal and API', evidenceRef: 'inventory://oidc-provider' },
          { asset: 'files.example.test', role: 'object storage reached through API-issued download URLs', evidenceRef: 'inventory://object-storage' },
        ],
        observedRelationships: [
          { from: 'Browser', to: 'portal.example.test', interaction: 'GET /app', evidenceRef: 'http://surface/portal' },
          { from: 'portal.example.test', to: 'auth.example.test', interaction: 'OIDC authorization-code login', evidenceRef: 'http://surface/oidc-redirect' },
          { from: 'portal.example.test', to: 'api.example.test', interaction: 'Bearer-token API calls', evidenceRef: 'http://surface/api-call' },
          { from: 'api.example.test', to: 'files.example.test', interaction: 'issues object download URL', evidenceRef: 'http://surface/download-url' },
        ],
        trustBoundaries: [
          'Internet client to public portal',
          'Portal/API to external OIDC provider',
          'API authorization decision before object storage access',
        ],
        findings: [
          {
            id: 'F-17',
            title: 'Cross-tenant export download through object-key substitution',
            severity: 'high',
            evidenceRefs: ['http://finding-17/owner', 'http://finding-17/cross-tenant'],
            path: 'Browser -> portal.example.test -> api.example.test GET /exports/{objectKey} -> files.example.test',
          },
        ],
        limitations: ['No administrative identity was available; admin-only routes were not audited.'],
      }, null, 2),
      'No authored report.md exists. Write report.md now with a concise, evidence-bound system/attack-surface audit, the confirmed finding path, and the material limitation.',
      'Do not invent components, controls, or data flows that are absent from the canonical context.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'file_write') {
        errors.push(`expected file_write, observed ${call.name}`);
      }
      const targetPath = normalizedPath(call.args.path);
      if (!targetPath.endsWith('report.md')) {
        errors.push(`expected file_write path report.md, observed ${targetPath || '<missing>'}`);
      }

      const content = asString(call.args.content);
      errors.push(...requireContentNeedles(
        content,
        ['portal.example.test', 'api.example.test', 'auth.example.test', 'files.example.test', 'F-17', 'trust bound', 'admin'],
        'system audit report',
      ));

      const mermaidBody = content.match(/```mermaid\s*\n([\s\S]*?)```/iu)?.[1] ?? '';
      if (!mermaidBody) {
        errors.push('expected the topology-rich system audit to include a fenced Mermaid relationship map');
      } else {
        if (!/\b(?:flowchart|graph|sequenceDiagram)\b/iu.test(mermaidBody)) {
          errors.push('expected the Mermaid block to declare a supported relationship diagram type');
        }
        const relationshipCount = mermaidBody.match(/-->|->>|-->>/gu)?.length ?? 0;
        if (relationshipCount < 4) {
          errors.push(`expected the Mermaid map to show at least four evidenced relationships, observed ${relationshipCount}`);
        }
        errors.push(...requireContentNeedles(
          mermaidBody,
          ['portal.example.test', 'api.example.test', 'auth.example.test', 'files.example.test'],
          'Mermaid relationship map',
        ));
      }
      return errors;
    },
  },
  {
    id: 'reporting-finalize-interim-after-artifacts',
    title: 'Reporter finalizes interim mode after artifacts and handoff are complete',
    why: 'Catches the post-reporting pause class: once interim artifacts are authored and handoff accepted, closeout should finalize instead of looping.',
    tools: [FinalizeRunArtifacts, FileWrite, SubmitPhaseHandoff, ReportFinalizerPreflight],
    prompt: [
      'You are the dedicated reporting phase executor.',
      'report_finalizer_preflight returned requiredMode=interim and canFinalizeInterim=true.',
      'prepare_report_context already ran.',
      'summary.md and report.md already exist and include interim wording.',
      'submit_phase_handoff for the reporting phase already succeeded with status=completed and closeoutOutcome=interim_blocked.',
      'Take the next required harness action only.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'finalize_run_artifacts') {
        errors.push(`expected finalize_run_artifacts, observed ${call.name}`);
      }
      if (call.args.mode !== 'interim') {
        errors.push(`expected mode interim, observed ${String(call.args.mode ?? '<missing>')}`);
      }
      return errors;
    },
  },
];
