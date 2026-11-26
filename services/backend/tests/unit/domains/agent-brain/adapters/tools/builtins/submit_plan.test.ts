import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/domains/agent-brain/domain/types/session';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';

const runServiceMocks = vi.hoisted(() => ({
  markPlanningComplete: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  notifyAppEvent: vi.fn().mockResolvedValue(undefined),
}));

const dbMocks = vi.hoisted(() => ({
  findingRows: [] as Array<{ id: string }>,
  select: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: dbMocks.select,
  },
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: class MockOrganizationService {},
}));

vi.mock('@/domains/security-ops/scopes/ScopeService', () => ({
  ScopeService: class MockScopeService {},
}));

vi.mock('@/domains/security-ops/runs/RunService', () => ({
  RunService: class MockRunService {
    markPlanningComplete = runServiceMocks.markPlanningComplete;
  },
}));

vi.mock('@/domains/platform/notifications/notificationService', () => ({
  notifyAppEvent: (...args: unknown[]) => notificationMocks.notifyAppEvent(...args),
}));

import { SubmitPlan } from '@/domains/agent-brain/adapters/tools/builtins/submit_plan';

const toolCallMessage = (
  name: string,
  args: Record<string, unknown> = {},
  idx = 1,
): Message => ({
  id: `msg-${idx}`,
  role: 'assistant',
  content: '',
  timestamp: idx,
  tool_calls: [
    {
      id: `tc-${idx}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
  ],
});

const toolResultMessage = (
  toolCallId: string,
  payload: Record<string, unknown>,
  idx = 1,
  outcome: 'succeeded' | 'failed' = payload.ok === false ? 'failed' : 'succeeded',
  toolName = 'test-tool',
): Message => ({
  id: `tool-result-${idx}`,
  role: 'tool',
  content: JSON.stringify(payload),
  timestamp: idx + 100,
  tool_call_id: toolCallId,
  metadata: {
    toolExecution: {
      schema: 'tool-execution-receipt/v1',
      toolName,
      toolCallId,
      outcome,
    },
  },
});

const successfulToolCallMessages = (
  name: string,
  args: Record<string, unknown> = {},
  idx = 1,
): Message[] => [
  toolCallMessage(name, args, idx),
  toolResultMessage(`tc-${idx}`, { totalCount: 0 }, idx, 'succeeded', name),
];

const approachTriedResult = (
  notes: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  ok: true,
  data: {
    notes,
    totalCount: notes.length,
  },
});

const closeoutMissionNode = () => ({
  id: 'task-final',
  question: 'What evidence-backed report narrative and closeout state should be delivered for app.example.com?',
  why_ready_now: 'Testing missions will produce final findings, coverage notes, blockers, and evidence for this scope.',
  required_evidence: [
    'final report_finding and promote_finding state',
    'final coverage and blocker notes',
    'evidence refs for every report claim',
  ],
  expected_artifact: 'prepare_report_context output, authored summary.md/report.md, one run.digest, and finalize_run_artifacts validation.',
  stop_condition: 'prepare_report_context, run.digest, authored summary.md/report.md, and finalize_run_artifacts are complete.',
  assigned_skills: ['security-reporting'],
});

const missionNodes = (
  overrides: Record<string, unknown> = {},
  options: { includeCloseout?: boolean } = {},
) => {
  const includeCloseout = options.includeCloseout ?? true;
  const primary = {
    id: 'task-1',
    question: 'What is the next useful security question for app.example.com?',
    why_ready_now: 'Planner prechecks completed for this scope.',
    required_evidence: ['query_inventory output', 'query_findings output'],
    expected_artifact: 'A bounded execution artifact for task-1.',
    stop_condition: 'The question is answered or a blocker is recorded.',
    assigned_skills: [],
    ...overrides,
  };
  return includeCloseout ? [primary, closeoutMissionNode()] : [primary];
};

const requiredPrecheckMessages = (): Message[] => [
  ...successfulToolCallMessages('query_inventory', {}, 1),
  ...successfulToolCallMessages('query_findings', {}, 2),
  ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
  ...successfulToolCallMessages('query_notes', { ntype: 'approach.tried' }, 4),
  ...successfulToolCallMessages('query_notes', { ntype: 'approach.blocker' }, 5),
  ...successfulToolCallMessages('query_notes', { ntype: 'scan.coverage' }, 6),
  ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'validation', riskFamily: 'generic' }, 7),
  ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'recon', riskFamily: 'surface' }, 8),
  ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'enumeration', riskFamily: 'surface' }, 9),
  ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'evidence', riskFamily: 'evidence' }, 10),
];

const compliancePrecheckMessages = (
  readinessArgs: Record<string, unknown> = {},
): Message[] => [
  ...successfulToolCallMessages('query_compliance_readiness', readinessArgs, 1),
  ...successfulToolCallMessages('query_inventory', {}, 2),
];

const phaseReplanMessage = (): Message => ({
  id: 'phase-replan-request',
  role: 'user',
  content: 'Revise the remaining plan from the completed phase handoff.',
  timestamp: 0,
  metadata: {
    visibility: 'internal',
    source: 'phase_replan_request',
  },
});

const makePlannerSession = (
  messages: Message[],
  options?: {
    extraContext?: string;
    promptProfile?: string;
    securityopsFlags?: Record<string, unknown>;
  },
) => ({
  id: 'session-planner',
  agentType: 'planner' as const,
  promptProfile: options?.promptProfile,
  scopeId: 'scope-1',
  messages,
  extraContext: options?.extraContext,
  flags: options?.securityopsFlags
    ? {
        securityops: options.securityopsFlags,
      }
    : undefined,
});

const makeContext = (
  messages: Message[],
  options?: {
    extraContext?: string;
    promptProfile?: string;
    securityopsFlags?: Record<string, unknown>;
  },
): ToolContext => {
  const session = makePlannerSession(messages, options);
  return ({
    sessionId: 'session-planner',
    workspaceDir: '/tmp/workspace',
    sandbox: {} as never,
    sessionStore: {
      get: vi.fn().mockReturnValue(session),
      setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
      recordSessionCompletedAsync: vi.fn(async () => true),
    } as never,
    streamBroker: { emit: vi.fn() } as never,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() },
      cmdGuard: { validate: vi.fn() },
    } as never,
    policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    planRuntime: {} as never,
    flags: {
      securityops: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
      },
    },
    abortSignal: new AbortController().signal,
  }) as unknown as ToolContext;
};

describe('SubmitPlan precheck gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.findingRows = [];
    dbMocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(dbMocks.findingRows)),
      })),
    }));
    runServiceMocks.markPlanningComplete.mockResolvedValue({
      id: 'run-1',
      title: 'Attack Surface Discovery for app.example.com',
      userId: 'user-1',
      status: 'awaiting_approval',
      assignedSkillSlugs: ['sql-injection'],
    });
  });

  it('returns an idempotent terminal response when planner already submitted a plan', async () => {
    const ctx = makeContext(requiredPrecheckMessages());
    const completedSession = {
      ...makePlannerSession(requiredPrecheckMessages(), {
        securityopsFlags: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
        },
      }),
      completed: true,
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
        },
        session: {
          completed: true,
        },
      },
    };
    (ctx.sessionStore.get as any).mockReturnValue(completedSession);

    const result = await SubmitPlan.run({ plan: '# Duplicate plan' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        alreadySubmitted: true,
        terminal: true,
        runId: 'run-1',
        nextAction: 'stop',
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects submit_plan when required query prechecks are missing', async () => {
    const ctx = makeContext([]);
    const traceWrite = vi.fn().mockResolvedValue(undefined);
    (ctx as unknown as { trace: { write: typeof traceWrite } }).trace = { write: traceWrite };

    const result = await SubmitPlan.run({ plan: '# Attack Surface Discovery for app.example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('planning prechecks incomplete'),
      }),
    );
    expect(traceWrite).toHaveBeenCalledWith(
      'session-planner',
      0,
      expect.objectContaining({
        event: 'submit_plan.gate_blocked',
        severity: 'warn',
        payload: expect.objectContaining({
          gateCode: 'missing_precheck',
          missingPrechecks: expect.arrayContaining(['query_inventory', 'query_findings']),
        }),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('allows submit_plan after required inventory/findings/strategic note queries', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['sql-injection'],
        missions: missionNodes({ assigned_skills: ['sql-injection'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.control).toEqual({
      kind: 'awaiting_approval',
      reason: 'plan_submission',
      runId: 'run-1',
    });
    expect(result.data).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: 'awaiting_approval',
        awaitingPlanApproval: true,
        assignedSkillSlugs: ['sql-injection'],
      }),
    );
    const submittedSession = (ctx.sessionStore.get as any)();
    expect(submittedSession.completed).toBe(true);
    expect(submittedSession.flags.session.completed).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      '# Attack Surface Discovery for app.example.com',
      ['sql-injection', 'security-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({
            id: 'task-1',
            phase: 'validation',
            assigned_skills: ['sql-injection'],
          }),
          expect.objectContaining({
            id: 'task-final',
            phase: 'reporting',
            assigned_skills: ['security-reporting'],
          }),
        ]),
      }),
    );
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[1]).not.toContain('Mission Envelope');
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[1]).not.toContain('why_ready_now');
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({
            assigned_skills: ['security-reporting'],
            phase: 'reporting',
            expected_artifact: expect.stringContaining('prepare_report_context'),
          }),
        ]),
      }),
    );
    expect(notificationMocks.notifyAppEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'action_required',
        title: 'Attack Surface Discovery for app.example.com',
        message: 'The planner submitted a proposed plan. Review it, approve execution, or request changes.',
        link: '/runs/run-1',
        data: expect.objectContaining({
          destination: 'run_detail',
          runId: 'run-1',
          sessionId: 'session-planner',
          ctaLabel: 'Review plan',
          reason: 'plan_approval',
          awaitingPlanApproval: true,
        }),
      }),
    );
  });

  it('accepts the dedicated compliance planner mission shape', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            selectionMode: 'planner',
            supportedControlPack: 'soc2_control_workspace_v1',
            candidateControlIds: ['CC6.1', 'CC6.2', 'CC6.3', 'CC6.6', 'CC6.7', 'CC7.2'],
            candidateProofObligationIds: [
              'soc2-cc6.1-authz-v1',
              'soc2-cc6.2-credential-lifecycle-v1',
              'soc2-cc6.3-access-lifecycle-v1',
              'soc2-cc6.6-unauthorized-access-v1',
              'soc2-cc6.7-transport-encryption-v1',
              'soc2-cc7.2-attack-surface-monitoring-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# SOC 2 Readiness Assessment for app.example.com',
        skillSlugs: ['compliance-access-control', 'compliance-reporting'],
        missions: [
          {
            id: 'task-cc61',
            phase: 'control_assessment',
            question: 'Can SOC 2 CC6.1 and CC6.6 access-control obligations be validated for app.example.com using proof obligations soc2-cc6.1-authz-v1 and soc2-cc6.6-unauthorized-access-v1?',
            why_ready_now: 'The compliance planner selected the highest-value supported controls from the SOC 2 agent-provable candidate pack based on readiness history and available evidence.',
            required_evidence: ['record_control_check result for CC6.1 and CC6.6', 'fresh authorization-boundary evidence'],
            expected_artifact: 'SOC 2 readiness check evidence and record_control_check payloads.',
            stop_condition: 'Call record_control_check for CC6.1 with soc2-cc6.1-authz-v1 and CC6.6 with soc2-cc6.6-unauthorized-access-v1, then submit phase handoff.',
            assigned_skills: ['compliance-access-control'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What compliance readiness report should be delivered from the recorded SOC 2 access-control checks?',
            why_ready_now: 'The control assessment phase records terminal verdicts for the selected access-control controls.',
            required_evidence: ['recorded SOC 2 access-control checks', 'compliance readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-access-control', 'compliance-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({ phase: 'control_assessment', assigned_skills: ['compliance-access-control'] }),
          expect.objectContaining({ phase: 'reporting', assigned_skills: ['compliance-reporting'] }),
        ]),
      }),
    );
  });

  it('accepts technical-readiness compliance controls without pentest mission drift', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            selectionMode: 'planner',
            supportedControlPack: 'soc2_control_workspace_v1',
            candidateControlIds: ['CC6.7', 'CC7.2'],
            candidateProofObligationIds: [
              'soc2-cc6.7-transport-encryption-v1',
              'soc2-cc7.2-attack-surface-monitoring-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# SOC 2 Technical Readiness Assessment for app.example.com',
        skillSlugs: ['compliance-technical-readiness', 'compliance-reporting'],
        missions: [
          {
            id: 'task-technical-controls',
            phase: 'control_assessment',
            question: 'Can SOC 2 CC6.7 and CC7.2 technical readiness be validated for app.example.com using proof obligations soc2-cc6.7-transport-encryption-v1 and soc2-cc7.2-attack-surface-monitoring-v1?',
            why_ready_now: 'The compliance planner selected transport and attack-surface monitoring controls from the candidate pack based on available inventory and scan evidence.',
            required_evidence: ['record_control_check result for CC6.7 and CC7.2', 'fresh transport and inventory evidence'],
            expected_artifact: 'SOC 2 technical readiness check evidence and record_control_check payloads.',
            stop_condition: 'Call record_control_check for CC6.7 with soc2-cc6.7-transport-encryption-v1 and CC7.2 with soc2-cc7.2-attack-surface-monitoring-v1, then submit phase handoff.',
            assigned_skills: ['compliance-technical-readiness'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What compliance readiness report should be delivered from the recorded SOC 2 technical checks?',
            why_ready_now: 'The control assessment phase records terminal verdicts for the selected technical controls.',
            required_evidence: ['recorded SOC 2 technical checks', 'compliance readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-technical-readiness', 'compliance-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({ phase: 'control_assessment', assigned_skills: ['compliance-technical-readiness'] }),
          expect.objectContaining({ phase: 'reporting', assigned_skills: ['compliance-reporting'] }),
        ]),
      }),
    );
  });

  it('accepts ISO 27001 compliance planner missions with ISO proof obligations', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'iso27001',
            selectionMode: 'planner',
            supportedControlPack: 'agent_control_workspace_v1',
            candidateControlIds: ['ISO-A-TECH-IAM', 'ISO-A-TECH-AUTHZ'],
            candidateProofObligationIds: [
              'iso27001-iam-authentication-v1',
              'iso27001-authorization-boundary-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# ISO 27001 Access Readiness Assessment for app.example.com',
        skillSlugs: ['compliance-access-control', 'compliance-reporting'],
        missions: [
          {
            id: 'task-iso-access',
            phase: 'control_assessment',
            question: 'Can ISO 27001 controls ISO-A-TECH-IAM and ISO-A-TECH-AUTHZ be assessed using proof obligations iso27001-iam-authentication-v1 and iso27001-authorization-boundary-v1?',
            why_ready_now: 'The selected ISO 27001 controls have access-control proof obligations and current scope context.',
            required_evidence: ['record_control_check result for ISO-A-TECH-IAM and ISO-A-TECH-AUTHZ'],
            expected_artifact: 'ISO 27001 access-control readiness check evidence and record_control_check payloads.',
            stop_condition: 'Call record_control_check for ISO-A-TECH-IAM with iso27001-iam-authentication-v1 and ISO-A-TECH-AUTHZ with iso27001-authorization-boundary-v1, then submit phase handoff.',
            assigned_skills: ['compliance-access-control'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What ISO 27001 readiness report should be delivered from the recorded access-control checks?',
            why_ready_now: 'The control assessment phase records terminal verdicts for the selected ISO controls.',
            required_evidence: ['recorded ISO 27001 checks', 'compliance readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-access-control', 'compliance-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({ phase: 'control_assessment', assigned_skills: ['compliance-access-control'] }),
          expect.objectContaining({ phase: 'reporting', assigned_skills: ['compliance-reporting'] }),
        ]),
      }),
    );
  });

  it('accepts NIST CSF compliance planner missions with NIST proof obligations', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'nist_csf',
            selectionMode: 'planner',
            supportedControlPack: 'agent_control_workspace_v1',
            candidateControlIds: ['ID.AM', 'ID.RA', 'DE.CM'],
            candidateProofObligationIds: [
              'nist-id.am-inventory-v1',
              'nist-id.ra-risk-assessment-v1',
              'nist-de.cm-monitoring-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# NIST CSF 2.0 Identify and Detect Readiness Assessment',
        skillSlugs: ['compliance-technical-readiness', 'compliance-reporting'],
        missions: [
          {
            id: 'task-nist-technical',
            phase: 'control_assessment',
            question: 'Can NIST CSF Categories ID.AM, ID.RA, and DE.CM be assessed using nist-id.am-inventory-v1, nist-id.ra-risk-assessment-v1, and nist-de.cm-monitoring-v1?',
            why_ready_now: 'The selected NIST CSF Categories have bounded technical proof obligations and current scope context.',
            required_evidence: ['record_control_check results for ID.AM, ID.RA, and DE.CM', 'current inventory, risk, and monitoring evidence'],
            expected_artifact: 'NIST CSF technical readiness checks and durable evidence references.',
            stop_condition: 'Record a terminal check or specific request for ID.AM, ID.RA, and DE.CM, then submit phase handoff.',
            assigned_skills: ['compliance-technical-readiness'],
          },
          {
            id: 'task-nist-report',
            phase: 'reporting',
            question: 'What NIST CSF 2.0 readiness report follows from the recorded Category checks?',
            why_ready_now: 'The control assessment phase records terminal outcomes for the selected NIST Categories.',
            required_evidence: ['recorded NIST CSF checks', 'NIST CSF readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the NIST CSF readiness template.',
            stop_condition: 'NIST CSF summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-technical-readiness', 'compliance-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({ phase: 'control_assessment', assigned_skills: ['compliance-technical-readiness'] }),
          expect.objectContaining({ phase: 'reporting', assigned_skills: ['compliance-reporting'] }),
        ]),
      }),
    );
  });

  it('rejects off-framework compliance missions before worker execution', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages({ framework: 'pci_dss' }),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'pci_dss',
            selectionMode: 'planner',
            supportedControlPack: 'agent_control_workspace_v1',
            candidateControlIds: ['4.2', '8.4.2'],
            candidateProofObligationIds: ['pci-4.2-transmission-crypto-v1', 'evidence-review:pci_dss:8.4.2'],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# PCI DSS Readiness Assessment for app.example.com',
        skillSlugs: ['compliance-technical-readiness', 'compliance-reporting'],
        missions: [
          {
            id: 'cross-framework-assessment',
            phase: 'control_assessment',
            question: 'What is the current readiness posture for HIPAA 164.312(a)(1), SOC 2 CC6.7, and PCI DSS 4.2 using pci-4.2-transmission-crypto-v1?',
            why_ready_now: 'The planner saw prior HIPAA and SOC 2 readiness history and wants to continue those controls.',
            required_evidence: ['record_control_check for 164.312(a)(1), CC6.7, and 4.2'],
            expected_artifact: 'Cross-framework checks.',
            stop_condition: 'Record checks for HIPAA 164.312(a)(1), SOC 2 CC6.7, and PCI DSS 4.2.',
            assigned_skills: ['compliance-technical-readiness'],
          },
          {
            id: 'hipaa-readiness-report',
            phase: 'reporting',
            question: 'What updated HIPAA Security Rule readiness report should be delivered?',
            why_ready_now: 'The run recorded compliance checks.',
            required_evidence: ['HIPAA readiness snapshot'],
            expected_artifact: 'HIPAA summary.md and report.md.',
            stop_condition: 'HIPAA report artifacts are finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('off-framework references'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects compliance recon missions even when inventory is thin', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            selectionMode: 'planner',
            supportedControlPack: 'soc2_control_workspace_v1',
            candidateControlIds: ['CC6.7', 'CC7.2'],
            candidateProofObligationIds: [
              'soc2-cc6.7-transport-encryption-v1',
              'soc2-cc7.2-attack-surface-monitoring-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# SOC 2 Inventory Baseline and Technical Readiness for app.example.com',
        skillSlugs: ['broad-surface-scan', 'compliance-technical-readiness', 'compliance-reporting'],
        missions: [
          {
            id: 'task-inventory-baseline',
            phase: 'recon',
            question: 'What current services and endpoints exist for app.example.com before SOC 2 technical control checks?',
            why_ready_now: 'query_inventory showed the current inventory is too thin for transport and attack-surface monitoring checks.',
            required_evidence: ['fresh service inventory', 'scan.coverage or inventory artifact references'],
            expected_artifact: 'Inventory baseline evidence for later compliance control checks.',
            stop_condition: 'Current in-scope services are recorded or a blocker explains why inventory cannot be refreshed.',
            assigned_skills: ['broad-surface-scan'],
          },
          {
            id: 'task-technical-controls',
            phase: 'control_assessment',
            question: 'Can SOC 2 CC6.7 and CC7.2 technical readiness be validated for app.example.com using proof obligations soc2-cc6.7-transport-encryption-v1 and soc2-cc7.2-attack-surface-monitoring-v1?',
            why_ready_now: 'The recon baseline provides inventory and transport context for the monitored technical controls.',
            required_evidence: ['record_control_check result for CC6.7 and CC7.2', 'fresh transport and inventory evidence'],
            expected_artifact: 'SOC 2 technical readiness check evidence and record_control_check payloads.',
            stop_condition: 'Call record_control_check for CC6.7 with soc2-cc6.7-transport-encryption-v1 and CC7.2 with soc2-cc7.2-attack-surface-monitoring-v1, then submit phase handoff.',
            assigned_skills: ['compliance-technical-readiness'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What compliance readiness report should be delivered from the recorded SOC 2 technical checks?',
            why_ready_now: 'The control assessment phase records terminal verdicts for the selected technical controls.',
            required_evidence: ['recorded SOC 2 technical checks', 'compliance readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('exactly two missions'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('accepts explicit evidence-review compliance controls without human review workflow drift', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            selectionMode: 'explicit',
            supportedControlPack: 'soc2_control_workspace_v1',
            candidateControlIds: ['CC6.1', 'CC6.2'],
            candidateProofObligationIds: ['soc2-cc6.1-authz-v1', 'soc2-cc6.2-credential-lifecycle-v1'],
            controlIds: ['CC1.1'],
            proofObligationIds: ['evidence-review:soc2:cc1.1'],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# SOC 2 Evidence Review for CC1.1',
        skillSlugs: ['compliance-evidence-review', 'compliance-reporting'],
        missions: [
          {
            id: 'task-cc11-evidence',
            phase: 'control_assessment',
            question: 'Can SOC 2 CC1.1 be evaluated from mapped uploaded evidence using evidence-review:soc2:cc1.1?',
            why_ready_now: 'The control was explicitly selected from the control workspace after user evidence was attached.',
            required_evidence: ['record_control_check result for CC1.1', 'mapped compliance-evidence refs'],
            expected_artifact: 'Agent-reviewed evidence verdict for CC1.1.',
            stop_condition: 'Call record_control_check for CC1.1 with evidence-review:soc2:cc1.1, then submit phase handoff.',
            assigned_skills: ['compliance-evidence-review'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What compliance readiness report should be delivered from the recorded SOC 2 evidence review?',
            why_ready_now: 'The control assessment phase records a terminal verdict for the selected evidence-review control.',
            required_evidence: ['recorded SOC 2 evidence-review check', 'compliance readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-evidence-review', 'compliance-reporting'],
      'session-planner',
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({ phase: 'control_assessment', assigned_skills: ['compliance-evidence-review'] }),
          expect.objectContaining({ phase: 'reporting', assigned_skills: ['compliance-reporting'] }),
        ]),
      }),
    );
  });

  it('accepts governance review as a bounded compliance assessment method', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'iso27001',
            selectionMode: 'explicit',
            supportedControlPack: 'agent_control_workspace_v1',
            candidateControlIds: ['ISO-ISMS-5'],
            candidateProofObligationIds: ['evidence-review:iso27001:iso-isms-5'],
            controlIds: ['ISO-ISMS-5'],
            proofObligationIds: ['evidence-review:iso27001:iso-isms-5'],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# ISO 27001 Governance Evidence Review',
        skillSlugs: ['compliance-governance-review', 'compliance-reporting'],
        missions: [
          {
            id: 'task-governance-review',
            phase: 'control_assessment',
            question: 'Does mapped governance evidence support ISO-ISMS-5 under evidence-review:iso27001:iso-isms-5?',
            why_ready_now: 'The selected control has a governance evidence-review obligation.',
            required_evidence: ['mapped governance evidence', 'record_control_check for ISO-ISMS-5'],
            expected_artifact: 'Evidence-bounded governance control verdict.',
            stop_condition: 'Record a check or concrete request for ISO-ISMS-5 using evidence-review:iso27001:iso-isms-5, then submit handoff.',
            assigned_skills: ['compliance-governance-review'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What ISO 27001 readiness report follows from the recorded governance review?',
            why_ready_now: 'The control assessment records a terminal action.',
            required_evidence: ['recorded control check or request'],
            expected_artifact: 'Selected-framework summary.md and report.md.',
            stop_condition: 'Compliance report artifacts are finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      ['compliance-governance-review', 'compliance-reporting'],
      'session-planner',
      expect.any(Object),
    );
  });

  it('rejects compliance recon missions outside the two-phase compliance shape', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            selectionMode: 'planner',
            supportedControlPack: 'soc2_control_workspace_v1',
            candidateControlIds: ['CC6.7'],
            candidateProofObligationIds: ['soc2-cc6.7-transport-encryption-v1'],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# SOC 2 Technical Readiness with Late Recon for app.example.com',
        skillSlugs: ['compliance-technical-readiness', 'broad-surface-scan', 'compliance-reporting'],
        missions: [
          {
            id: 'task-technical-controls',
            phase: 'control_assessment',
            question: 'Can SOC 2 CC6.7 technical readiness be validated for app.example.com using proof obligation soc2-cc6.7-transport-encryption-v1?',
            why_ready_now: 'The planner selected transport encryption for assessment.',
            required_evidence: ['record_control_check result for CC6.7'],
            expected_artifact: 'SOC 2 technical readiness check evidence.',
            stop_condition: 'Call record_control_check for CC6.7 with soc2-cc6.7-transport-encryption-v1.',
            assigned_skills: ['compliance-technical-readiness'],
          },
          {
            id: 'task-late-recon',
            phase: 'recon',
            question: 'What service inventory exists for app.example.com after control assessment?',
            why_ready_now: 'The planner wants more inventory after assessment.',
            required_evidence: ['service inventory'],
            expected_artifact: 'Inventory notes.',
            stop_condition: 'Inventory recorded.',
            assigned_skills: ['broad-surface-scan'],
          },
          {
            id: 'task-compliance-report',
            phase: 'reporting',
            question: 'What compliance readiness report should be delivered?',
            why_ready_now: 'The run is ready for reporting.',
            required_evidence: ['readiness snapshot'],
            expected_artifact: 'summary.md and report.md using the compliance-reporting template.',
            stop_condition: 'Compliance summary and report are authored and finalized.',
            assigned_skills: ['compliance-reporting'],
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('exactly two missions'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects compliance planner runs that submit pentest-style mission graphs', async () => {
    const ctx = makeContext(
      compliancePrecheckMessages(),
      {
        promptProfile: 'compliance-planner',
        securityopsFlags: {
          complianceAssessment: {
            framework: 'soc2',
            controlIds: ['CC6.1', 'CC6.2', 'CC6.3', 'CC6.6'],
            proofObligationIds: [
              'soc2-cc6.1-authz-v1',
              'soc2-cc6.2-credential-lifecycle-v1',
              'soc2-cc6.3-access-lifecycle-v1',
              'soc2-cc6.6-unauthorized-access-v1',
            ],
          },
        },
      },
    );

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['compliance-access-control', 'compliance-reporting'],
        missions: missionNodes({ assigned_skills: ['sql-injection'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('mission assigned_skills includes "sql-injection" but skillSlugs does not'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });
  it('strips accidental mission-envelope sections from the stored display plan', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: [
          '# Attack Surface Discovery for app.example.com',
          '',
          '## Operator Plan',
          '- Map the currently exposed surface.',
          '',
          '## Mission Envelope',
          '```json',
          JSON.stringify({ missions: [{ id: 'leaky-task', assigned_skills: ['sql-injection'] }] }),
          '```',
        ].join('\n'),
        skillSlugs: ['sql-injection'],
        missions: missionNodes({ assigned_skills: ['sql-injection'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const submittedPlan = runServiceMocks.markPlanningComplete.mock.calls[0]?.[1] as string;
    expect(submittedPlan).toContain('## Operator Plan');
    expect(submittedPlan).not.toContain('Mission Envelope');
    expect(submittedPlan).not.toContain('assigned_skills');
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({
            id: 'task-1',
            assigned_skills: ['sql-injection'],
          }),
        ]),
      }),
    );
  });

  it('strips planner-only metadata labels from the stored display plan', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: [
          '# Attack Surface Discovery for app.example.com',
          '',
          '## Tasks',
          '',
          '### Task 1: Broad Surface Scan',
          '**Objective:** Establish baseline inventory of services and endpoints.',
          '**Confidence:** 0.9 - Standard first step for a fresh scope.',
          '**Skills:** broad-surface-scan',
          '**Steps:**',
          '- Run port scanning and service fingerprinting.',
          '- Route any discovered frontend app to js-surface-analysis skill.',
          '**Done when:** scan.coverage note is written and inventory is updated.',
          '',
          '## Notes',
          '- This run follows Playbook A.',
          '- If APIs are found, route follow-up to api-enumeration skill.',
        ].join('\n'),
        skillSlugs: ['broad-surface-scan'],
        missions: missionNodes({ assigned_skills: ['broad-surface-scan'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const submittedPlan = runServiceMocks.markPlanningComplete.mock.calls[0]?.[1] as string;
    expect(submittedPlan).toContain('### Task 1: Broad Surface Scan');
    expect(submittedPlan).toContain('**Objective:** Establish baseline inventory of services and endpoints.');
    expect(submittedPlan).toContain('**Steps:**');
    expect(submittedPlan).toContain('- Run port scanning and service fingerprinting.');
    expect(submittedPlan).toContain('## Notes');
    expect(submittedPlan).not.toContain('**Confidence:**');
    expect(submittedPlan).not.toContain('**Skills:**');
    expect(submittedPlan).not.toContain('**Done when:**');
    expect(submittedPlan).not.toContain('js-surface-analysis');
    expect(submittedPlan).not.toContain('Playbook A');
    expect(submittedPlan).not.toContain('api-enumeration');
  });

  it('keeps a specific H1 title even when it contains an assigned skill slug', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: [
          '# User Enumeration Validation for ctd.mpwh.gov.jo',
          '',
          '## Goal',
          'Validate the known user enumeration finding and preserve blockers for unreachable WordPress targets.',
          '',
          '## Tasks',
          '- Revalidate the employee-number login behavior from fresh HTTP evidence.',
        ].join('\n'),
        skillSlugs: ['validation'],
        missions: missionNodes({
          phase: 'validation',
          assigned_skills: ['validation'],
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const submittedPlan = runServiceMocks.markPlanningComplete.mock.calls[0]?.[1] as string;
    expect(submittedPlan.startsWith('# User Enumeration Validation for ctd.mpwh.gov.jo')).toBe(true);
    expect(submittedPlan).toContain('## Goal');
  });

  it('rejects submit_plan when the plan title is generic', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run({ plan: '# Assessment Plan\n\n## Goal\nAssess auth flows.' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('too generic'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects submit_plan when graph-lite missions are missing', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run({ plan: '# Attack Surface Discovery for app.example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('missions[] is required'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects planner-provided phases that are incompatible with assigned skills', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['sql-injection'],
        missions: missionNodes({
          phase: 'reporting',
          assigned_skills: ['sql-injection'],
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('not compatible with phase "reporting"'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects non-recon goals that stop at discovery without a follow-up or replan mission', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages, {
      extraContext: '=== RUN GOAL ===\nValidate SQL injection on app.example.com',
    });

    const result = await SubmitPlan.run(
      {
        plan: '# SQL Injection Validation for app.example.com',
        missions: missionNodes({
          question: 'What endpoints are reachable?',
          required_evidence: ['reachable routes'],
          expected_artifact: 'Discovery map',
          stop_condition: 'Routes are mapped.',
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('non-recon goals require'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('does not treat a failed canonical query as a completed planning precheck', async () => {
    const messages = requiredPrecheckMessages().map((message) =>
      message.role === 'tool' && message.tool_call_id === 'tc-1'
        ? toolResultMessage('tc-1', { ok: false, data: { error: 'inventory unavailable' } }, 1)
        : message,
    );
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        missions: missionNodes(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('query_inventory'),
    }));
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('accepts successful prechecks after their model-facing result content is compacted', async () => {
    const messages = requiredPrecheckMessages().map((message) =>
      message.role === 'tool'
        ? {
            ...message,
            content: JSON.stringify({ status: 'tool_result_compacted', originalChars: 12_000 }),
          }
        : message,
    );
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        missions: missionNodes(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledTimes(1);
  });

  it('does not accept a payload that claims success without a runtime receipt', async () => {
    const messages = requiredPrecheckMessages().map((message) =>
      message.role === 'tool' && message.tool_call_id === 'tc-1'
        ? {
            ...message,
            content: JSON.stringify({ ok: true, data: { totalCount: 0 } }),
            metadata: undefined,
          }
        : message,
    );
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        missions: missionNodes(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('query_inventory'),
    }));
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('allows a reporting-only graph when a structured phase replan request follows completed work', async () => {
    const ctx = makeContext([phaseReplanMessage(), ...requiredPrecheckMessages()], {
      extraContext: '=== RUN GOAL ===\nValidate SQL injection on app.example.com',
    });

    const result = await SubmitPlan.run(
      {
        plan: '# SQL Injection Closeout for app.example.com',
        missions: [closeoutMissionNode()],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledTimes(1);
  });

  it('does not reuse planner prechecks from before a phase replan request', async () => {
    const ctx = makeContext([...requiredPrecheckMessages(), phaseReplanMessage()], {
      extraContext: '=== RUN GOAL ===\nValidate SQL injection on app.example.com',
    });

    const result = await SubmitPlan.run(
      {
        plan: '# Revised SQL Injection Assessment for app.example.com',
        missions: missionNodes(),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('query_inventory'),
    }));
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects a mission whose declared output tool is unavailable in its phase', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Evidence Backfill for app.example.com',
        missions: [
          {
            ...missionNodes()[0],
            phase: 'evidence',
            expected_artifact: 'A report_finding repair with complete report fields.',
            stop_condition: 'report_finding succeeds or a blocker is recorded.',
          },
          closeoutMissionNode(),
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('phase "evidence" cannot provide those tools'),
    }));
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects an assigned skill when its required tools cannot run in the mission phase', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Evidence Backfill for app.example.com',
        skillSlugs: ['information-disclosure'],
        missions: [
          {
            ...missionNodes()[0],
            phase: 'evidence',
            assigned_skills: ['information-disclosure'],
          },
          closeoutMissionNode(),
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('cannot provide required tools'),
    }));
    expect(result.data).toEqual(expect.objectContaining({
      error: expect.stringContaining('http_payload'),
    }));
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects submit_plan when skillSlugs include an unknown catalog entry', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['sql-injection', 'content-discovery'],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('unknown skillSlugs'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('allows submit_plan when blocked approaches exist but the plan text does not retry them', async () => {
    const approachCallId = 'tc-4';
    const messages = [
      ...successfulToolCallMessages('query_inventory', {}, 1),
      ...successfulToolCallMessages('query_findings', {}, 2),
      ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
      {
        ...toolCallMessage('query_notes', { ntype: 'approach.tried' }, 4),
        tool_calls: [
          {
            id: approachCallId,
            type: 'function' as const,
            function: {
              name: 'query_notes',
              arguments: JSON.stringify({ ntype: 'approach.tried' }),
            },
          },
        ],
      },
      toolResultMessage(
        approachCallId,
        approachTriedResult([
          {
            id: 'note-1',
            data: {
              technique: 'path traversal',
              endpoint: '/download',
              result: 'blocked',
            },
          },
        ]),
        5,
        'succeeded',
        'query_notes',
      ),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.blocker' }, 6),
      ...successfulToolCallMessages('query_notes', { ntype: 'scan.coverage' }, 7),
      ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'validation', riskFamily: 'sql-injection' }, 8),
    ];
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# SQL Injection Assessment for app.example.com\nTry SQL injection on /login',
        missions: missionNodes({
          question: 'Can /login be assessed for SQL injection without retrying blocked traversal?',
          expected_artifact: 'SQL injection triage result for /login.',
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledTimes(1);
  });

  it('rejects submit_plan when the plan retries a blocked approach without retriedApproaches', async () => {
    const approachCallId = 'tc-4';
    const messages = [
      ...successfulToolCallMessages('query_inventory', {}, 1),
      ...successfulToolCallMessages('query_findings', {}, 2),
      ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
      {
        ...toolCallMessage('query_notes', { ntype: 'approach.tried' }, 4),
        tool_calls: [
          {
            id: approachCallId,
            type: 'function' as const,
            function: {
              name: 'query_notes',
              arguments: JSON.stringify({ ntype: 'approach.tried' }),
            },
          },
        ],
      },
      toolResultMessage(
        approachCallId,
        approachTriedResult([
          {
            id: 'note-1',
            data: {
              technique: 'path traversal',
              endpoint: '/download',
              result: 'blocked',
            },
          },
        ]),
        5,
        'succeeded',
        'query_notes',
      ),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.blocker' }, 6),
      ...successfulToolCallMessages('query_notes', { ntype: 'scan.coverage' }, 7),
      ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'validation', riskFamily: 'path-traversal' }, 8),
    ];
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Path Traversal Retest for app.example.com\nRetry path traversal against /download with the same idea.',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('plan appears to retry a previously blocked approach'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('allows submit_plan when a blocked approach retry includes retriedApproaches with new_hypothesis', async () => {
    const approachCallId = 'tc-4';
    const messages = [
      ...successfulToolCallMessages('query_inventory', {}, 1),
      ...successfulToolCallMessages('query_findings', {}, 2),
      ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
      {
        ...toolCallMessage('query_notes', { ntype: 'approach.tried' }, 4),
        tool_calls: [
          {
            id: approachCallId,
            type: 'function' as const,
            function: {
              name: 'query_notes',
              arguments: JSON.stringify({ ntype: 'approach.tried' }),
            },
          },
        ],
      },
      toolResultMessage(
        approachCallId,
        approachTriedResult([
          {
            id: 'note-1',
            data: {
              technique: 'path traversal',
              endpoint: '/download',
              result: 'blocked',
            },
          },
        ]),
        5,
        'succeeded',
        'query_notes',
      ),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.blocker' }, 6),
      ...successfulToolCallMessages('query_notes', { ntype: 'scan.coverage' }, 7),
      ...successfulToolCallMessages('list_relevant_skills', { missionId: 'task-1', phase: 'validation', riskFamily: 'path-traversal' }, 8),
    ];
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Path Traversal Retest for app.example.com\nRetry path traversal on /download after validating a new archive extraction path.',
        missions: missionNodes({
          question: 'Can /download be retested under the new archive-handling hypothesis?',
          required_evidence: ['new archive extraction behavior'],
          expected_artifact: 'Retest outcome for /download path traversal.',
        }),
        retriedApproaches: [
          {
            technique: 'path traversal',
            endpoint: '/download',
            new_hypothesis: 'The archive handling path changed and may expose a new traversal variant.',
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledTimes(1);
  });

  it('rejects submit_plan when retriedApproaches is missing new_hypothesis content', async () => {
    const messages = requiredPrecheckMessages();
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        retriedApproaches: [
          {
            technique: 'path traversal',
            endpoint: '/download',
            new_hypothesis: '   ',
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('retriedApproaches entries require new_hypothesis'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects submit_plan when approach.blocker precheck is missing', async () => {
    const messages = [
      ...successfulToolCallMessages('query_inventory', {}, 1),
      ...successfulToolCallMessages('query_findings', {}, 2),
      ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.tried' }, 4),
      ...successfulToolCallMessages('query_notes', { ntype: 'scan.coverage' }, 5),
    ];
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run({ plan: '# Attack Surface Discovery for app.example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('query_notes(ntype=approach.blocker)'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('rejects submit_plan when scan.coverage precheck is missing', async () => {
    const messages = [
      ...successfulToolCallMessages('query_inventory', {}, 1),
      ...successfulToolCallMessages('query_findings', {}, 2),
      ...successfulToolCallMessages('query_notes', { ntype: 'run.digest' }, 3),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.tried' }, 4),
      ...successfulToolCallMessages('query_notes', { ntype: 'approach.blocker' }, 5),
    ];
    const ctx = makeContext(messages);

    const result = await SubmitPlan.run({ plan: '# Attack Surface Discovery for app.example.com' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('query_notes(ntype=scan.coverage)'),
      }),
    );
  });

  it('rejects normal plans that omit the dedicated security-reporting closeout mission', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['sql-injection'],
        missions: missionNodes({ assigned_skills: ['sql-injection'] }, { includeCloseout: false }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('must end with a dedicated security-reporting closeout mission'),
      }),
    );
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });

  it('auto-injects security-reporting into skillSlugs when the planner authored the closeout mission', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['sql-injection'],
        missions: missionNodes({ assigned_skills: ['sql-injection'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const submittedPlan = runServiceMocks.markPlanningComplete.mock.calls[0]?.[1] as string;
    const submittedSkillSlugs = runServiceMocks.markPlanningComplete.mock.calls[0]?.[2];
    const submittedMissionEnvelope = runServiceMocks.markPlanningComplete.mock.calls[0]?.[4] as { missions?: unknown[] };
    expect(submittedSkillSlugs).toEqual(['sql-injection', 'security-reporting']);
    expect(submittedPlan).not.toContain('"id": "task-final"');
    expect(submittedPlan).not.toContain('"assigned_skills"');
    expect(submittedMissionEnvelope?.missions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-final',
          assigned_skills: ['security-reporting'],
          stop_condition: expect.stringContaining('finalize_run_artifacts'),
        }),
      ]),
    );
  });

  it('rejects planner-only skillSlugs in submit_plan', async () => {
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Attack Surface Discovery for app.example.com',
        skillSlugs: ['securityops-planning'],
        missions: missionNodes({ assigned_skills: ['securityops-planning'] }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('planner-only skillSlugs'),
      }),
    );
  });

  it('allows submit_plan when revalidates_finding_id exists in the current scope', async () => {
    const findingId = '11111111-1111-4111-8111-111111111111';
    dbMocks.findingRows = [{ id: findingId }];
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Internal IP Disclosure Revalidation for app.example.com',
        missions: missionNodes({
          question: 'Can the known internal IP disclosure be revalidated with fresh evidence?',
          required_evidence: ['fresh HTTP response showing the internal IP disclosure'],
          expected_artifact: 'Validated finding update with new evidence.',
          stop_condition: 'The finding is revalidated or a blocker is recorded.',
          revalidates_finding_id: findingId,
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(dbMocks.select).toHaveBeenCalledTimes(1);
    expect(runServiceMocks.markPlanningComplete).toHaveBeenCalledTimes(1);
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[1]).not.toContain('revalidates_finding_id');
    expect(runServiceMocks.markPlanningComplete.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({
        missions: expect.arrayContaining([
          expect.objectContaining({
            revalidates_finding_id: findingId,
          }),
        ]),
      }),
    );
  });

  it('rejects submit_plan when revalidates_finding_id is not found in the current scope', async () => {
    const findingId = '22222222-2222-4222-8222-222222222222';
    const ctx = makeContext(requiredPrecheckMessages());

    const result = await SubmitPlan.run(
      {
        plan: '# Internal IP Disclosure Revalidation for app.example.com',
        missions: missionNodes({
          question: 'Can the known internal IP disclosure be revalidated with fresh evidence?',
          required_evidence: ['fresh HTTP response showing the internal IP disclosure'],
          expected_artifact: 'Validated finding update with new evidence.',
          stop_condition: 'The finding is revalidated or a blocker is recorded.',
          revalidates_finding_id: findingId,
        }),
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: `submit_plan blocked: revalidates_finding_id not found in this scope: ${findingId}.`,
      }),
    );
    expect(dbMocks.select).toHaveBeenCalledTimes(1);
    expect(runServiceMocks.markPlanningComplete).not.toHaveBeenCalled();
  });
});
