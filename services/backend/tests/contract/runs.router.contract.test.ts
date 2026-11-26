import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createRunsRouter } from '@/interfaces/http/controllers/runs.router';
import { GDPR_CONTROLS } from '@/domains/security-ops/compliance/frameworks/gdpr';
import { HIPAA_CONTROLS } from '@/domains/security-ops/compliance/frameworks/hipaa';
import { ISO27001_CONTROLS } from '@/domains/security-ops/compliance/frameworks/iso27001';
import { PCI_DSS_CONTROLS } from '@/domains/security-ops/compliance/frameworks/pci-dss';
import { SOC2_CONTROLS } from '@/domains/security-ops/compliance/frameworks/soc2';
import { AppError, ERROR_CODES } from '@/shared/errors';

const DEFAULT_ASSESSMENT_GOAL =
  'Assess discovered assets for exploitable vulnerabilities and produce validated findings with evidence and remediation guidance.';
const TEST_MODEL = {
  id: '11111111-1111-1111-1111-111111111111',
  selectionCategory: 'medium',
};
const makeComplianceReadinessControls = (state: 'monitored' | 'excluded' = 'monitored') =>
  SOC2_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    status: 'missing',
    verdict: 'not_attempted',
    outcome: state === 'monitored' ? 'not_checked' : 'excluded',
    nextAction: state === 'monitored' ? 'No agent request is open yet.' : 'Excluded from monitoring.',
    actionRequests: [],
    controlChecks: [],
    monitoring: {
      state,
      source: state === 'monitored' ? 'default' : 'explicit',
      exclusionReason: state === 'excluded' ? 'Not applicable to this test scope' : null,
      updatedAt: state === 'monitored' ? null : '2026-06-24T00:00:00.000Z',
    },
    verdictReason: state === 'monitored' ? 'Active control' : 'Not active for this scope',
  }));

const makeIsoComplianceReadinessControls = (state: 'monitored' | 'excluded' = 'monitored') =>
  ISO27001_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    status: 'missing',
    verdict: 'not_attempted',
    outcome: state === 'monitored' ? 'not_checked' : 'excluded',
    nextAction: state === 'monitored' ? 'No agent request is open yet.' : 'Excluded from monitoring.',
    actionRequests: [],
    controlChecks: [],
    monitoring: {
      state,
      source: state === 'monitored' ? 'default' : 'explicit',
      exclusionReason: state === 'excluded' ? 'Not applicable to this test scope' : null,
      updatedAt: state === 'monitored' ? null : '2026-06-24T00:00:00.000Z',
    },
    verdictReason: state === 'monitored' ? 'Active control' : 'Not active for this scope',
  }));

const makeGdprComplianceReadinessControls = (state: 'monitored' | 'excluded' = 'monitored') =>
  GDPR_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    status: 'missing',
    verdict: 'not_attempted',
    outcome: state === 'monitored' ? 'not_checked' : 'excluded',
    nextAction: state === 'monitored' ? 'No agent request is open yet.' : 'Excluded from monitoring.',
    actionRequests: [],
    controlChecks: [],
    monitoring: {
      state,
      source: state === 'monitored' ? 'default' : 'explicit',
      exclusionReason: state === 'excluded' ? 'Not applicable to this test scope' : null,
      updatedAt: state === 'monitored' ? null : '2026-06-24T00:00:00.000Z',
    },
    verdictReason: state === 'monitored' ? 'Active control' : 'Not active for this scope',
  }));

const makeHipaaComplianceReadinessControls = (state: 'monitored' | 'excluded' = 'monitored') =>
  HIPAA_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    implementationSpec: control.implementationSpec ?? null,
    status: 'missing',
    verdict: 'not_attempted',
    outcome: state === 'monitored' ? 'not_checked' : 'excluded',
    nextAction: state === 'monitored' ? 'No agent request is open yet.' : 'Excluded from monitoring.',
    actionRequests: [],
    controlChecks: [],
    monitoring: {
      state,
      source: state === 'monitored' ? 'default' : 'explicit',
      exclusionReason: state === 'excluded' ? 'Not applicable to this test scope' : null,
      updatedAt: state === 'monitored' ? null : '2026-06-24T00:00:00.000Z',
    },
    verdictReason: state === 'monitored' ? 'Active control' : 'Not active for this scope',
  }));

const makePciComplianceReadinessControls = (state: 'monitored' | 'excluded' = 'monitored') =>
  PCI_DSS_CONTROLS.map((control) => ({
    id: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    pciDssRequirement: control.pciDssRequirement ?? null,
    pciDssGoal: control.pciDssGoal ?? null,
    pciDssApproach: control.pciDssApproach ?? null,
    pciDssSaqTypes: control.pciDssSaqTypes ?? null,
    pciDssCdeScope: control.pciDssCdeScope ?? null,
    pciDssAccountData: control.pciDssAccountData ?? null,
    status: 'missing',
    verdict: 'not_attempted',
    outcome: state === 'monitored' ? 'not_checked' : 'excluded',
    nextAction: state === 'monitored' ? 'No agent request is open yet.' : 'Excluded from monitoring.',
    actionRequests: [],
    controlChecks: [],
    monitoring: {
      state,
      source: state === 'monitored' ? 'default' : 'explicit',
      exclusionReason: state === 'excluded' ? 'Not applicable to this test scope' : null,
      updatedAt: state === 'monitored' ? null : '2026-06-24T00:00:00.000Z',
    },
    verdictReason: state === 'monitored' ? 'Active control' : 'Not active for this scope',
  }));

const makeRunPhase = (overrides: Record<string, unknown> = {}) => ({
  id: 'phase-recon',
  runId: 'run-1',
  ordinal: 1,
  phaseKey: 'recon',
  status: 'pending',
  sessionId: null,
  stepIds: ['task-1', 'task-2'],
  assignedSkillSlugs: ['sql-injection', 'xss'],
  phaseProfile: 'phase-recon',
  toolProfile: 'phase-recon',
  promptProfile: 'phase-recon',
  checkpointRef: null,
  ...overrides,
});

const orgServiceMocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
  getOrgContext: vi.fn(),
}));

const scopeServiceMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getScopeContext: vi.fn(),
}));

const runnerServiceMocks = vi.hoisted(() => ({
  resolveRunner: vi.fn(),
  getRunner: vi.fn(),
  listRunners: vi.fn(),
}));

const runServiceMocks = vi.hoisted(() => ({
  countPlanConcurrentRuns: vi.fn(),
  buildRunIdempotencyKey: vi.fn(),
  getByIdempotencyKey: vi.fn(),
  getById: vi.fn(),
  transitionStatus: vi.fn(),
  enforceScopeConcurrencyLimit: vi.fn(),
  enforceRunPrerequisites: vi.fn(),
  buildExtraContextFromParts: vi.fn(),
  buildPriorRunContext: vi.fn(),
  getStrategicNotesForMemorySeed: vi.fn(),
  buildAssignedSkillsContext: vi.fn(),
  buildPhaseCompatibleSkillCatalogContext: vi.fn(),
  createRunRecord: vi.fn(),
  hasPhaseSessionHistory: vi.fn(),
  findNextReadyExecutionPhase: vi.fn(),
  findNextReadyValidationPhase: vi.fn(),
  findNextReadyReportingPhase: vi.fn(),
  findLatestPhaseHandoffBefore: vi.fn(),
  listOpenValidationQueue: vi.fn(),
  markPhaseCompleted: vi.fn(),
  activatePhaseSession: vi.fn(),
  attachValidationQueueToPhase: vi.fn(),
  requestPhaseReplan: vi.fn(),
  cancel: vi.fn(),
  onSessionStatusChange: vi.fn(),
  reconcileBySessionId: vi.fn(),
  recordRunEvent: vi.fn(),
}));

const auditServiceMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const sessionServiceMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

const scopeAccessMaterialServiceMocks = vi.hoisted(() => ({
  listScopeContextMaterials: vi.fn().mockResolvedValue([]),
}));

const writeScopeCredentialsFileMocks = vi.hoisted(() => ({
  writeScopeCredentialsFile: vi.fn().mockResolvedValue(undefined),
}));

const skillWorkspaceSyncMocks = vi.hoisted(() => ({
  syncPlanningSkillIntoWorkspace: vi.fn(),
  syncAssignedSkillsIntoWorkspace: vi.fn(),
}));

const workspaceProjectionServiceMocks = vi.hoisted(() => ({
  projectRunWorkspace: vi.fn(),
}));

const accessControlMocks = vi.hoisted(() => ({
  enforceRunCreation: vi.fn(),
  enforcePrivateRunnerAccess: vi.fn(),
  enforceComplianceAccess: vi.fn(),
  enforceRunObservabilityAccess: vi.fn(),
}));

const modelConfigPortMocks = vi.hoisted(() => ({
  getModel: vi.fn(),
}));

const runActivityServiceMocks = vi.hoisted(() => ({
  getSummaryForRun: vi.fn(),
}));

const runPhaseRepositoryMocks = vi.hoisted(() => ({
  listByRunId: vi.fn(),
}));

const complianceReadinessServiceMocks = vi.hoisted(() => ({
  getScopeReadiness: vi.fn(),
  getRunReadiness: vi.fn(),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: class MockOrganizationService {
    getForUser = orgServiceMocks.getForUser;
    getOrgContext = orgServiceMocks.getOrgContext;
  },
}));

vi.mock('@/domains/security-ops/scopes/ScopeService', () => ({
  ScopeService: class MockScopeService {
    getById = scopeServiceMocks.getById;
    getScopeContext = scopeServiceMocks.getScopeContext;
  },
}));

vi.mock('@/domains/security-ops/runners/RunnerService', () => ({
  RunnerService: class MockRunnerService {
    resolveRunner = runnerServiceMocks.resolveRunner;
    getRunner = runnerServiceMocks.getRunner;
    listRunners = runnerServiceMocks.listRunners;
  },
}));

vi.mock('@/domains/security-ops/compliance/ComplianceReadinessService', () => ({
  ComplianceReadinessService: class MockComplianceReadinessService {
    getScopeReadiness = complianceReadinessServiceMocks.getScopeReadiness;
    getRunReadiness = complianceReadinessServiceMocks.getRunReadiness;
  },
}));

vi.mock('@/domains/security-ops/scopes/ScopeAccessMaterialService', () => ({
  ScopeAccessMaterialService: class MockScopeAccessMaterialService {
    listScopeContextMaterials = scopeAccessMaterialServiceMocks.listScopeContextMaterials;
  },
}));

vi.mock('@/domains/security-ops/runs/writeScopeCredentialsFile', () => ({
  writeScopeCredentialsFile: writeScopeCredentialsFileMocks.writeScopeCredentialsFile,
}));

vi.mock('@/domains/security-ops/runs/RunService', () => ({
  buildScopeRunContext: vi.fn(
    () =>
      '=== SCOPE CONTEXT ===\nScope: Internal Scope\n\n=== EXECUTION ENVIRONMENT ===\nThis run executes from the cloud-managed environment.',
  ),
  resolvePolicyForRunnerType: vi.fn((runnerType: string | null | undefined) =>
    runnerType === 'private' ? 'sandboxed' : 'network-enabled',
  ),
  deriveRunDisplayState: vi.fn(
    (run: {
      goal?: string | null;
      status?: string | null;
      executorSessionId?: string | null;
      plan?: string | null;
    }) => {
      const awaitingPlanApproval = Boolean(
        run.goal &&
        run.status === 'awaiting_approval' &&
        !run.executorSessionId &&
        typeof run.plan === 'string' &&
        run.plan.trim().length > 0,
      );

      switch (run.status) {
        case 'queued':
        case 'running':
        case 'completed':
        case 'failed':
        case 'cancelled':
          return {
            status: run.status,
            pauseReason: null,
            interactionType: 'none',
            awaitingPlanApproval,
          };
        case 'credits_exhausted':
          return {
            status: 'paused',
            pauseReason: 'credits',
            interactionType: 'none',
            awaitingPlanApproval,
          };
        case 'user_paused':
          return {
            status: 'paused',
            pauseReason: 'manual',
            interactionType: 'none',
            awaitingPlanApproval,
          };
        case 'awaiting_user':
          return {
            status: 'paused',
            pauseReason: 'manual',
            interactionType: 'none',
            awaitingPlanApproval,
          };
        case 'awaiting_approval':
          return {
            status: 'paused',
            pauseReason: awaitingPlanApproval ? 'approval' : 'approval',
            interactionType: awaitingPlanApproval ? 'plan_approval' : 'tool_approval',
            awaitingPlanApproval,
          };
        default:
          return {
            status: 'failed',
            pauseReason: null,
            interactionType: 'none',
            awaitingPlanApproval,
          };
      }
    },
  ),
  isRunAwaitingPlanApproval: vi.fn(
    (run: { goal?: string | null; status?: string | null; executorSessionId?: string | null; plan?: string | null }) =>
      Boolean(
        run.goal &&
        run.status === 'awaiting_approval' &&
        !run.executorSessionId &&
        typeof run.plan === 'string' &&
        run.plan.trim().length > 0,
      ),
  ),
  RunService: class MockRunService {
    countPlanConcurrentRuns = runServiceMocks.countPlanConcurrentRuns;
    buildRunIdempotencyKey = runServiceMocks.buildRunIdempotencyKey;
    getByIdempotencyKey = runServiceMocks.getByIdempotencyKey;
    getById = runServiceMocks.getById;
    transitionStatus = runServiceMocks.transitionStatus;
    enforceScopeConcurrencyLimit = runServiceMocks.enforceScopeConcurrencyLimit;
    enforceRunPrerequisites = runServiceMocks.enforceRunPrerequisites;
    buildExtraContextFromParts = runServiceMocks.buildExtraContextFromParts;
    buildPriorRunContext = runServiceMocks.buildPriorRunContext;
    getStrategicNotesForMemorySeed = runServiceMocks.getStrategicNotesForMemorySeed;
    buildAssignedSkillsContext = runServiceMocks.buildAssignedSkillsContext;
    buildPhaseCompatibleSkillCatalogContext = runServiceMocks.buildPhaseCompatibleSkillCatalogContext;
    createRunRecord = runServiceMocks.createRunRecord;
    hasPhaseSessionHistory = runServiceMocks.hasPhaseSessionHistory;
    findNextReadyExecutionPhase = runServiceMocks.findNextReadyExecutionPhase;
    findNextReadyValidationPhase = runServiceMocks.findNextReadyValidationPhase;
    findNextReadyReportingPhase = runServiceMocks.findNextReadyReportingPhase;
    findLatestPhaseHandoffBefore = runServiceMocks.findLatestPhaseHandoffBefore;
    listOpenValidationQueue = runServiceMocks.listOpenValidationQueue;
    markPhaseCompleted = runServiceMocks.markPhaseCompleted;
    activatePhaseSession = runServiceMocks.activatePhaseSession;
    attachValidationQueueToPhase = runServiceMocks.attachValidationQueueToPhase;
    requestPhaseReplan = runServiceMocks.requestPhaseReplan;
    cancel = runServiceMocks.cancel;
    onSessionStatusChange = runServiceMocks.onSessionStatusChange;
    reconcileBySessionId = runServiceMocks.reconcileBySessionId;
    recordRunEvent = runServiceMocks.recordRunEvent;
  },
}));

vi.mock('@/domains/security-ops/audit/AuditService', () => ({
  AuditService: class MockAuditService {
    log = auditServiceMocks.log;
  },
}));

vi.mock('@/domains/agent-brain/application/services/SessionService', () => ({
  SessionService: class MockSessionService {
    createSession = sessionServiceMocks.createSession;
  },
}));

vi.mock('@/domains/security-ops/runs/skillWorkspaceSync', () => ({
  syncPlanningSkillIntoWorkspace: skillWorkspaceSyncMocks.syncPlanningSkillIntoWorkspace,
  syncAssignedSkillsIntoWorkspace: skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace,
}));

describe('runs.router contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    orgServiceMocks.getForUser.mockResolvedValue({ id: 'org-1' });
    orgServiceMocks.getOrgContext.mockResolvedValue({
      name: 'NullSquare',
      context: null,
    });
    scopeServiceMocks.getById.mockResolvedValue({
      scope: {
        id: 'scope-1',
        name: 'Internal Scope',
        safeMode: false,
      },
    });
    scopeServiceMocks.getScopeContext.mockResolvedValue({
      name: 'Internal Scope',
      executionNetwork: 'external',
      attachedRunner: null,
      targets: [{ type: 'domain', value: 'app.example.com', verified: true }],
      mission: null,
      stealthPosture: 'coordinated',
      impactTolerance: 'non_destructive',
      rateLimitRps: null,
      blastWindow: null,
      roeDocument: 'No destructive testing.',
      testingPosture: 'black-box',
      testingPostureReason: 'no source access or credentials attached',
      whiteboxEnabled: false,
      connectedRepoCount: 0,
      connectedRepositories: [],
      accessMaterialCount: 0,
      accessMaterials: [],
    });

    runnerServiceMocks.resolveRunner.mockResolvedValue({
      id: 'runner-1',
      name: 'Private Runner',
      type: 'private',
      status: 'online',
    });
    runnerServiceMocks.getRunner.mockResolvedValue({
      id: 'runner-1',
      name: 'Private Runner',
      type: 'private',
      status: 'online',
    });
    runnerServiceMocks.listRunners.mockResolvedValue([]);

    runServiceMocks.buildRunIdempotencyKey.mockReturnValue('idem-1');
    runServiceMocks.countPlanConcurrentRuns.mockResolvedValue(0);
    runServiceMocks.getByIdempotencyKey.mockResolvedValue(null);
    runServiceMocks.getById.mockResolvedValue({
      id: 'run-1',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
    });
    runServiceMocks.transitionStatus.mockResolvedValue({
      id: 'run-1',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      plannerSessionId: 'session-1',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
    });
    runServiceMocks.enforceScopeConcurrencyLimit.mockResolvedValue(undefined);
    runServiceMocks.enforceRunPrerequisites.mockResolvedValue([]);
    runServiceMocks.buildExtraContextFromParts.mockResolvedValue('run context');
    runServiceMocks.buildPriorRunContext.mockResolvedValue('');
    runServiceMocks.getStrategicNotesForMemorySeed.mockResolvedValue([]);
    runServiceMocks.buildAssignedSkillsContext.mockResolvedValue(
      '=== ASSIGNED METHODOLOGIES ===\n- sql-injection: /workspace/.skills/sql-injection/methodology.md',
    );
    runServiceMocks.onSessionStatusChange.mockResolvedValue(undefined);
    runServiceMocks.createRunRecord.mockResolvedValue({
      created: true,
      run: {
        id: 'run-1',
        scopeId: 'scope-1',
        sessionId: 'session-1',
        status: 'running',
        trigger: 'manual',
        goal: DEFAULT_ASSESSMENT_GOAL,
        runnerId: 'runner-1',
      },
    });
    runServiceMocks.hasPhaseSessionHistory.mockResolvedValue(false);
    runServiceMocks.findNextReadyExecutionPhase.mockResolvedValue(makeRunPhase());
    runServiceMocks.findNextReadyValidationPhase.mockResolvedValue(null);
    runServiceMocks.findNextReadyReportingPhase.mockResolvedValue(null);
    runServiceMocks.findLatestPhaseHandoffBefore.mockResolvedValue(null);
    runServiceMocks.listOpenValidationQueue.mockResolvedValue([]);
    runServiceMocks.markPhaseCompleted.mockResolvedValue(null);
    runServiceMocks.activatePhaseSession.mockResolvedValue({
      id: 'run-1',
      scopeId: 'scope-1',
      sessionId: 'session-phase',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
      executorSessionId: 'session-phase',
    });
    runServiceMocks.attachValidationQueueToPhase.mockResolvedValue([]);
    runServiceMocks.requestPhaseReplan.mockResolvedValue({
      id: 'run-1',
      scopeId: 'scope-1',
      sessionId: 'session-1',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
      executorSessionId: null,
    });
    runServiceMocks.cancel.mockResolvedValue(undefined);
    runServiceMocks.reconcileBySessionId.mockResolvedValue(null);
    runServiceMocks.recordRunEvent.mockResolvedValue(undefined);
    runServiceMocks.buildPhaseCompatibleSkillCatalogContext.mockResolvedValue('');
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValue({
      frameworks: [
        {
          key: 'soc2',
          selected: true,
          supported: true,
          controls: makeComplianceReadinessControls(),
        },
      ],
    });
    complianceReadinessServiceMocks.getRunReadiness.mockResolvedValue({
      frameworks: [],
    });

    sessionServiceMocks.createSession.mockResolvedValue({
      session: { id: 'session-1', workspaceDir: '/tmp/workspace-default' },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'kickoff' },
    });
    workspaceProjectionServiceMocks.projectRunWorkspace.mockResolvedValue({
      success: true,
      written: ['AGENTS.md', 'journal/model.md'],
      skipped: [],
      warnings: [],
      modelSummaryPath: 'journal/model.md',
    });
    skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace.mockResolvedValue([]);
    accessControlMocks.enforceRunCreation.mockResolvedValue({
      plan: {
        slug: 'control',
        limits: { maxConcurrentRuns: 3 },
      },
    });
    accessControlMocks.enforcePrivateRunnerAccess.mockResolvedValue(undefined);
    accessControlMocks.enforceComplianceAccess.mockResolvedValue(undefined);
    accessControlMocks.enforceRunObservabilityAccess.mockResolvedValue(undefined);
    modelConfigPortMocks.getModel.mockResolvedValue(TEST_MODEL);
  });

  const createAccessControlMock = () => ({
    enforceRunCreation: accessControlMocks.enforceRunCreation,
    enforcePrivateRunnerAccess: accessControlMocks.enforcePrivateRunnerAccess,
    enforceComplianceAccess: accessControlMocks.enforceComplianceAccess,
    enforceRunObservabilityAccess: accessControlMocks.enforceRunObservabilityAccess,
  });

  const createModelConfigPortMock = () => ({
    getModel: modelConfigPortMocks.getModel,
  });

  const createTestApp = (options?: {
    sessionStore?: Record<string, unknown>;
    sessionRepository?: Record<string, unknown>;
    agentEngine?: Record<string, unknown>;
    orchestrator?: { processMessage: ReturnType<typeof vi.fn> };
    runActivityService?: { getSummaryForRun: ReturnType<typeof vi.fn> };
    runPhaseRepository?: { listByRunId: ReturnType<typeof vi.fn> };
  }) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/app/runs',
      createRunsRouter({
        services: {
          sessionStore: {
            get: vi.fn().mockReturnValue(undefined),
            setAsync: vi.fn().mockResolvedValue(undefined),
            mergeFlagNamespaceAsync: vi.fn().mockResolvedValue(undefined),
            recordTimelineEntryAsync: vi.fn().mockResolvedValue(true),
            assignRunWorkspaceAsync: vi.fn().mockResolvedValue(undefined),
            recordInternalContinuationInputAsync: vi.fn().mockResolvedValue(true),
            recordInputAndStartRequestedAsync: vi.fn().mockResolvedValue(true),
            cleanupRunWorkspaceAsync: vi.fn().mockResolvedValue({
              cleaned: true,
              workspaceDirs: ['/tmp/ns-run-run-1'],
              activeSessionIds: [],
              errors: 0,
            }),
            remove: vi.fn(),
            ...(options?.sessionStore ?? {}),
          },
          orchestrator: options?.orchestrator ?? {
            processMessage: vi.fn().mockResolvedValue(undefined),
          },
          sandbox: { destroy: vi.fn().mockResolvedValue(undefined) },
          sandboxProfileRegistry: {},
          ports: {},
          agentEngine: options?.agentEngine ?? {},
          policyResolver: {},
          traceRecorder: {},
          policyFacade: {},
        } as never,
        repositories: {
          sessionRepository: (options?.sessionRepository ?? {}) as never,
          messageRepository: {} as never,
          artifactRepository: {} as never,
          policyRepository: {} as never,
        },
        kernel: { accessControl: createAccessControlMock() } as never,
        subscriptionPort: {} as never,
        modelConfigPort: createModelConfigPortMock() as never,
        runActivityService: options?.runActivityService as never,
        runPhaseRepository: options?.runPhaseRepository as never,
        workspaceProjectionService: workspaceProjectionServiceMocks as never,
        appRole: 'worker',
        enableWorkers: true,
      }),
    );
    return app;
  };

  it('returns phase sessions for workbench navigation', async () => {
    runServiceMocks.getById.mockResolvedValueOnce({
      id: 'run-phases-1',
      scopeId: 'scope-1',
      sessionId: 'session-enumeration',
      executorSessionId: 'session-enumeration',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
    });
    runPhaseRepositoryMocks.listByRunId.mockResolvedValueOnce([
      makeRunPhase({
        id: 'phase-recon',
        runId: 'run-phases-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: 'session-recon',
        startedAt: new Date('2026-04-02T10:00:00.000Z'),
        completedAt: new Date('2026-04-02T10:05:00.000Z'),
      }),
      makeRunPhase({
        id: 'phase-enumeration',
        runId: 'run-phases-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'active',
        sessionId: 'session-enumeration',
        startedAt: new Date('2026-04-02T10:06:00.000Z'),
      }),
      makeRunPhase({
        id: 'phase-validation',
        runId: 'run-phases-1',
        ordinal: 3,
        phaseKey: 'validation',
        status: 'pending',
        sessionId: null,
      }),
    ]);

    const app = createTestApp({ runPhaseRepository: runPhaseRepositoryMocks });
    const response = await request(app).get('/api/app/runs/run-phases-1/phases');

    expect(response.status).toBe(200);
    expect(runServiceMocks.getById).toHaveBeenCalledWith('org-1', 'run-phases-1');
    expect(runPhaseRepositoryMocks.listByRunId).toHaveBeenCalledWith('run-phases-1');
    expect(response.body).toMatchObject([
      {
        id: 'phase-recon',
        phase: 'recon',
        label: 'Recon',
        ordinal: 1,
        status: 'completed',
        rawStatus: 'completed',
        sessionId: 'session-recon',
        durationMs: 300000,
      },
      {
        id: 'phase-enumeration',
        phase: 'enumeration',
        label: 'Enumeration',
        ordinal: 2,
        status: 'running',
        rawStatus: 'active',
        sessionId: 'session-enumeration',
      },
      {
        id: 'phase-validation',
        phase: 'validation',
        label: 'Validation',
        ordinal: 3,
        status: 'pending',
        rawStatus: 'pending',
        sessionId: null,
      },
    ]);
  });

  it('returns stale unfinished phases as completed when the run is completed', async () => {
    runServiceMocks.getById.mockResolvedValueOnce({
      id: 'run-phases-completed',
      scopeId: 'scope-1',
      sessionId: 'session-reporting',
      executorSessionId: 'session-reporting',
      status: 'completed',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
    });
    runPhaseRepositoryMocks.listByRunId.mockResolvedValueOnce([
      makeRunPhase({
        id: 'phase-validation',
        runId: 'run-phases-completed',
        ordinal: 3,
        phaseKey: 'validation',
        status: 'handoff_submitted',
        sessionId: 'session-validation',
      }),
      makeRunPhase({
        id: 'phase-reporting',
        runId: 'run-phases-completed',
        ordinal: 4,
        phaseKey: 'reporting',
        status: 'active',
        sessionId: 'session-reporting',
      }),
    ]);

    const app = createTestApp({ runPhaseRepository: runPhaseRepositoryMocks });
    const response = await request(app).get('/api/app/runs/run-phases-completed/phases');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([
      {
        id: 'phase-validation',
        phase: 'validation',
        status: 'completed',
        rawStatus: 'completed',
      },
      {
        id: 'phase-reporting',
        phase: 'reporting',
        status: 'completed',
        rawStatus: 'completed',
      },
    ]);
  });

  it('returns run detail with merged planner and executor usage totals', async () => {
    runnerServiceMocks.listRunners.mockResolvedValueOnce([
      {
        id: 'runner-1',
        name: 'Private Runner',
      },
    ]);
    runServiceMocks.getById.mockResolvedValueOnce({
      id: 'run-usage-1',
      scopeId: 'scope-1',
      sessionId: 'session-executor',
      plannerSessionId: 'session-planner',
      executorSessionId: 'session-executor',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      runnerId: 'runner-1',
      findingsCount: 2,
      inventoryAdded: 1,
      usageSummary: {
        total: {
          promptTokens: 350,
          cachedPromptTokens: 15,
          completionTokens: 170,
          totalTokens: 520,
          nativeCost: 0.6,
          overhead: 0.03,
          platformCost: 0.63,
          platformPrice: 0.75,
          credits: 8.25,
          entries: 3,
        },
        planner: {
          sessionId: 'session-planner',
          promptTokens: 100,
          cachedPromptTokens: 5,
          completionTokens: 50,
          totalTokens: 150,
          nativeCost: 0.2,
          overhead: 0.01,
          platformCost: 0.21,
          platformPrice: 0.25,
          credits: 2.5,
          entries: 1,
        },
        executor: {
          sessionId: 'session-executor',
          promptTokens: 250,
          cachedPromptTokens: 10,
          completionTokens: 120,
          totalTokens: 370,
          nativeCost: 0.4,
          overhead: 0.02,
          platformCost: 0.42,
          platformPrice: 0.5,
          credits: 5.75,
          entries: 2,
        },
      },
    });

    const app = createTestApp();
    const response = await request(app).get('/api/app/runs/run-usage-1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'run-usage-1',
      activeSessionId: 'session-executor',
      awaitingPlanApproval: false,
      scopeName: 'Internal Scope',
      runnerName: 'Private Runner',
      usageSummary: {
        total: {
          credits: 8.25,
          totalTokens: 520,
          entries: 3,
        },
        planner: {
          sessionId: 'session-planner',
          credits: 2.5,
        },
        executor: {
          sessionId: 'session-executor',
          credits: 5.75,
        },
      },
    });
  });

  it('returns summarized run activity for the activity dashboard', async () => {
    const activitySummary = {
      totals: {
        requests: 12,
        uniqueHosts: 3,
        uniqueEndpoints: 5,
        failures: 2,
        blockedActions: 1,
        averageDurationMs: 420,
      },
      distributions: {
        statusCodes: [{ key: '2xx', label: '2xx', count: 9, percentage: 75 }],
        methods: [{ key: 'GET', label: 'GET', count: 12, percentage: 100 }],
        responseTimes: [{ key: '100_500ms', label: '100-500ms', count: 12, percentage: 100 }],
      },
      timeline: {
        buckets: [
          {
            ts: '2026-04-02T10:00:00.000Z',
            hosts: [{ host: 'api.example.com', count: 4 }],
          },
        ],
        hosts: ['api.example.com'],
      },
      topEndpoints: [
        {
          id: 'api.example.com/api/users',
          host: 'api.example.com',
          path: '/api/users',
          requestCount: 9,
          failureCount: 1,
          methods: [{ method: 'GET', count: 9 }],
          statusBand: '2xx',
        },
      ],
      topHosts: [
        {
          host: 'api.example.com',
          requestCount: 9,
          failureCount: 1,
          firstSeenAt: '2026-04-02T10:00:00.000Z',
          lastSeenAt: '2026-04-02T10:10:00.000Z',
        },
      ],
      coverage: {
        source: 'action.summary',
        limitations: [
          'Coverage combines action.summary telemetry with http_payload history and sandbox proxy capture when available.',
        ],
      },
      generatedAt: '2026-04-02T10:15:00.000Z',
    };
    runActivityServiceMocks.getSummaryForRun.mockResolvedValueOnce(activitySummary);

    const app = createTestApp({
      runActivityService: {
        getSummaryForRun: runActivityServiceMocks.getSummaryForRun,
      },
    });
    const response = await request(app).get('/api/app/runs/run-1/activity');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(activitySummary);
    expect(runActivityServiceMocks.getSummaryForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-1',
        sessionId: 'session-1',
      }),
    );
  });

  it('creates a planner run from goal input', async () => {
    const sessionStore = {
      mergeFlagNamespaceAsync: vi.fn().mockResolvedValue(undefined),
      recordTimelineEntryAsync: vi.fn().mockResolvedValue(true),
      assignRunWorkspaceAsync: vi.fn().mockResolvedValue(undefined),
      recordInternalContinuationInputAsync: vi.fn().mockResolvedValue(true),
      remove: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/api/app/runs',
      createRunsRouter({
        services: {
          sessionStore,
          orchestrator: {
            processMessage: vi.fn().mockResolvedValue(undefined),
          },
          sandboxProfileRegistry: {},
          ports: {},
          agentEngine: {},
          policyResolver: {},
          traceRecorder: {},
          policyFacade: {},
        } as never,
        repositories: {
          sessionRepository: {} as never,
          messageRepository: {} as never,
          artifactRepository: {} as never,
          policyRepository: {} as never,
        },
        kernel: { accessControl: createAccessControlMock() } as never,
        subscriptionPort: {} as never,
        modelConfigPort: createModelConfigPortMock() as never,
        workspaceProjectionService: workspaceProjectionServiceMocks as never,
        appRole: 'worker',
        enableWorkers: true,
      }),
    );

    const response = await request(app)
      .post('/api/app/runs')
      .send({
        scopeId: 'scope-1',
        goal: DEFAULT_ASSESSMENT_GOAL,
        modelId: '11111111-1111-1111-1111-111111111111',
        vars: {
          scan_depth: 'deep',
          custom_flag: true,
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-1');
    expect(response.body.run.activeSessionId).toBe('session-1');
    expect(response.body.runner.id).toBe('runner-1');
    expect(response.body.warnings).toEqual([]);

    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'scope-1',
        modelId: '11111111-1111-1111-1111-111111111111',
        mode: 'automated',
        agentType: 'planner',
        toolPolicy: expect.objectContaining({
          allow: expect.arrayContaining([
            'submit_plan',
            'query_inventory',
            'query_findings',
            'query_notes',
            'file_read',
            'list_relevant_skills',
          ]),
        }),
        extraContext: expect.stringContaining(`=== RUN GOAL ===\n${DEFAULT_ASSESSMENT_GOAL}`),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('"scan_depth": "deep"'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: DEFAULT_ASSESSMENT_GOAL,
        modelId: '11111111-1111-1111-1111-111111111111',
      }),
    );

    expect(sessionStore.mergeFlagNamespaceAsync).toHaveBeenCalledWith(
      'session-1',
      'securityops',
      expect.objectContaining({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        executionTarget: 'cloud',
      }),
    );
    const cloudSecurityOpsFlags = sessionStore.mergeFlagNamespaceAsync.mock.calls.find(
      ([sessionId, namespace]) => sessionId === 'session-1' && namespace === 'securityops',
    )?.[2] as Record<string, unknown> | undefined;
    expect(cloudSecurityOpsFlags).not.toHaveProperty('runnerId');
    expect(cloudSecurityOpsFlags).not.toHaveProperty('runnerName');
    expect(sessionStore.recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'run-kickoff:run-1:session-1',
        role: 'user',
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
  });

  it('creates a dedicated SOC 2 readiness compliance assessment run with planner-selected controls', async () => {
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-compliance-planner',
        workspaceDir: '/tmp/workspace-compliance',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'compliance planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-compliance-1',
        scopeId: 'scope-1',
        sessionId: 'session-compliance-planner',
        plannerSessionId: 'session-compliance-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Dedicated SOC 2 readiness assessment.',
        runnerId: 'runner-1',
      },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'soc2',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-compliance-1');
    expect(response.body.complianceAssessment).toEqual(
      expect.objectContaining({
        framework: 'soc2',
        selectionMode: 'planner',
        supportedControlPack: 'agent_control_workspace_v1',
        candidateControlIds: expect.arrayContaining([
          'CC1.1',
          'CC4.1',
          'CC4.2',
          'CC5.2',
          'CC6.1',
          'CC6.2',
          'CC6.3',
          'CC6.6',
          'CC6.7',
          'CC6.8',
          'CC7.1',
          'CC7.2',
          'CC7.3',
          'CC9.2',
        ]),
        controlIds: expect.arrayContaining(['CC1.1', 'CC6.1', 'CC7.3', 'CC9.2']),
        candidateProofObligationIds: expect.arrayContaining([
          'evidence-review:soc2:cc1.1',
          'soc2-cc4.1-continuous-monitoring-v1',
          'soc2-cc4.2-deficiency-communication-v1',
          'soc2-cc5.2-technical-control-coverage-v1',
          'soc2-cc6.1-authz-v1',
          'soc2-cc6.2-credential-lifecycle-v1',
          'soc2-cc6.3-access-lifecycle-v1',
          'soc2-cc6.6-unauthorized-access-v1',
          'soc2-cc6.7-transport-encryption-v1',
          'soc2-cc6.8-malicious-code-detection-v1',
          'soc2-cc7.1-vulnerability-detection-v1',
          'soc2-cc7.2-attack-surface-monitoring-v1',
          'soc2-cc7.3-security-event-evaluation-v1',
          'evidence-review:soc2:cc9.2',
        ]),
        proofObligationIds: expect.arrayContaining([
          'evidence-review:soc2:cc1.1',
          'soc2-cc6.1-authz-v1',
          'evidence-review:soc2:cc9.2',
        ]),
        candidateProofObligations: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'CC1.1',
            id: 'evidence-review:soc2:cc1.1',
            assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
          }),
          expect.objectContaining({
            controlId: 'CC6.1',
            id: 'soc2-cc6.1-authz-v1',
          }),
          expect.objectContaining({
            controlId: 'CC6.7',
            id: 'soc2-cc6.7-transport-encryption-v1',
          }),
          expect.objectContaining({
            controlId: 'CC7.2',
            id: 'soc2-cc7.2-attack-surface-monitoring-v1',
          }),
          expect.objectContaining({
            controlId: 'CC6.6',
            id: 'soc2-cc6.6-unauthorized-access-v1',
          }),
          expect.objectContaining({
            controlId: 'CC9.2',
            id: 'evidence-review:soc2:cc9.2',
          }),
        ]),
        controlReadiness: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'CC1.1',
            supportLevel: 'manual_evidence_required',
          }),
          expect.objectContaining({
            controlId: 'CC6.1',
            supportLevel: 'automated_testable',
          }),
          expect.objectContaining({
            controlId: 'CC9.2',
            supportLevel: 'integration_required',
          }),
        ]),
      }),
    );
    expect(complianceReadinessServiceMocks.getScopeReadiness).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: 'scope-1',
    });
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'planner',
        promptProfile: 'compliance-planner',
        toolPolicy: expect.objectContaining({
          allow: expect.arrayContaining([
            'submit_plan',
            'query_compliance_readiness',
            'query_inventory',
            'query_findings',
            'file_read',
          ]),
        }),
        extraContext: expect.stringContaining('=== COMPLIANCE ASSESSMENT MISSION ==='),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('soc2-cc6.1-authz-v1'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('soc2-cc6.6-unauthorized-access-v1'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('evidence-review:soc2:cc1.1'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['compliance-planning'],
      '/tmp/workspace-compliance',
    );
  });

  it('creates a dedicated GDPR readiness assessment run with privacy and security controls', async () => {
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'gdpr',
          selected: true,
          supported: true,
          controls: makeGdprComplianceReadinessControls(),
        },
      ],
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-gdpr-planner',
        workspaceDir: '/tmp/workspace-gdpr',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'gdpr compliance planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-gdpr-1',
        scopeId: 'scope-1',
        sessionId: 'session-gdpr-planner',
        plannerSessionId: 'session-gdpr-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Dedicated GDPR Readiness assessment.',
        runnerId: 'runner-1',
      },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'gdpr',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-gdpr-1');
    expect(response.body.complianceAssessment).toEqual(
      expect.objectContaining({
        framework: 'gdpr',
        selectionMode: 'planner',
        supportedControlPack: 'agent_control_workspace_v1',
        candidateControlIds: expect.arrayContaining([
          'GDPR-SCOPE-APPLICABILITY',
          'GDPR-DATA-ROPA',
          'GDPR-LAW-LAWFUL-BASIS',
          'GDPR-TRANS-NOTICE',
          'GDPR-RIGHTS-DSR',
          'GDPR-RISK-DPIA',
          'GDPR-THIRD-PROCESSORS',
          'GDPR-SEC-PROCESSING',
          'GDPR-SEC-ACCESS-CONTROL',
          'GDPR-SEC-ENCRYPTION-RESILIENCE',
        ]),
        controlIds: expect.arrayContaining([
          'GDPR-SCOPE-APPLICABILITY',
          'GDPR-DATA-ROPA',
          'GDPR-TRANS-NOTICE',
          'GDPR-SEC-ACCESS-CONTROL',
        ]),
        candidateProofObligationIds: expect.arrayContaining([
          'evidence-review:gdpr:gdpr-scope-applicability',
          'evidence-review:gdpr:gdpr-data-ropa',
          'evidence-review:gdpr:gdpr-law-lawful-basis',
          'gdpr-trans-notice-v1',
          'evidence-review:gdpr:gdpr-rights-dsr',
          'evidence-review:gdpr:gdpr-risk-dpia',
          'evidence-review:gdpr:gdpr-third-processors',
          'gdpr-sec-processing-v1',
          'gdpr-sec-access-control-v1',
          'gdpr-sec-encryption-resilience-v1',
        ]),
        proofObligationIds: expect.arrayContaining([
          'evidence-review:gdpr:gdpr-scope-applicability',
          'evidence-review:gdpr:gdpr-data-ropa',
          'gdpr-trans-notice-v1',
          'gdpr-sec-access-control-v1',
        ]),
        candidateProofObligations: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'GDPR-SCOPE-APPLICABILITY',
            id: 'evidence-review:gdpr:gdpr-scope-applicability',
            assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
          }),
          expect.objectContaining({
            controlId: 'GDPR-DATA-ROPA',
            id: 'evidence-review:gdpr:gdpr-data-ropa',
            assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
          }),
          expect.objectContaining({
            controlId: 'GDPR-TRANS-NOTICE',
            id: 'gdpr-trans-notice-v1',
          }),
          expect.objectContaining({
            controlId: 'GDPR-SEC-ACCESS-CONTROL',
            id: 'gdpr-sec-access-control-v1',
          }),
        ]),
        controlReadiness: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'GDPR-SCOPE-APPLICABILITY',
            supportLevel: 'manual_evidence_required',
          }),
          expect.objectContaining({
            controlId: 'GDPR-TRANS-NOTICE',
            supportLevel: 'automated_testable',
          }),
          expect.objectContaining({
            controlId: 'GDPR-SEC-ACCESS-CONTROL',
            supportLevel: 'automated_testable',
          }),
        ]),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'planner',
        promptProfile: 'compliance-planner',
        extraContext: expect.stringContaining('GDPR Readiness'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('gdpr-sec-access-control-v1'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'gdpr',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['compliance-planning'],
      '/tmp/workspace-gdpr',
    );
  });

  it('creates a dedicated ISO 27001 readiness compliance assessment run with planner-selected controls', async () => {
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'iso27001',
          selected: true,
          supported: true,
          controls: makeIsoComplianceReadinessControls(),
        },
      ],
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-iso-planner',
        workspaceDir: '/tmp/workspace-iso',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'iso compliance planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-iso-1',
        scopeId: 'scope-1',
        sessionId: 'session-iso-planner',
        plannerSessionId: 'session-iso-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Dedicated ISO 27001 readiness assessment.',
        runnerId: 'runner-1',
      },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'iso27001',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-iso-1');
    expect(response.body.complianceAssessment).toEqual(
      expect.objectContaining({
        framework: 'iso27001',
        selectionMode: 'planner',
        supportedControlPack: 'agent_control_workspace_v1',
        candidateControlIds: expect.arrayContaining([
          'ISO-ISMS-4',
          'ISO-ISMS-5',
          'ISO-A-ORG-ASSETS',
          'ISO-A-TECH-IAM',
          'ISO-A-TECH-AUTHZ',
          'ISO-A-TECH-CRYPTO',
          'ISO-A-TECH-NETWORK',
          'ISO-A-TECH-VULN',
          'ISO-A-TECH-SUPPLYCHAIN',
        ]),
        controlIds: expect.arrayContaining(['ISO-ISMS-5', 'ISO-A-ORG-ASSETS', 'ISO-A-TECH-IAM', 'ISO-A-TECH-VULN']),
        candidateProofObligationIds: expect.arrayContaining([
          'evidence-review:iso27001:iso-isms-5',
          'iso27001-asset-inventory-v1',
          'iso27001-iam-authentication-v1',
          'iso27001-authorization-boundary-v1',
          'iso27001-crypto-transport-v1',
          'iso27001-network-exposure-v1',
          'iso27001-vulnerability-management-v1',
          'iso27001-supply-chain-scanning-v1',
        ]),
        proofObligationIds: expect.arrayContaining([
          'evidence-review:iso27001:iso-isms-5',
          'iso27001-asset-inventory-v1',
          'iso27001-iam-authentication-v1',
        ]),
        candidateProofObligations: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'ISO-ISMS-5',
            id: 'evidence-review:iso27001:iso-isms-5',
            assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
          }),
          expect.objectContaining({
            controlId: 'ISO-A-ORG-ASSETS',
            id: 'iso27001-asset-inventory-v1',
          }),
          expect.objectContaining({
            controlId: 'ISO-A-TECH-IAM',
            id: 'iso27001-iam-authentication-v1',
          }),
          expect.objectContaining({
            controlId: 'ISO-A-TECH-VULN',
            id: 'iso27001-vulnerability-management-v1',
          }),
        ]),
        controlReadiness: expect.arrayContaining([
          expect.objectContaining({
            controlId: 'ISO-ISMS-5',
            supportLevel: 'manual_evidence_required',
          }),
          expect.objectContaining({
            controlId: 'ISO-A-ORG-ASSETS',
            supportLevel: 'automated_testable',
          }),
          expect.objectContaining({
            controlId: 'ISO-A-TECH-IAM',
            supportLevel: 'automated_testable',
          }),
        ]),
      }),
    );
    expect(complianceReadinessServiceMocks.getScopeReadiness).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId: 'scope-1',
    });
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'planner',
        promptProfile: 'compliance-planner',
        extraContext: expect.stringContaining('ISO 27001 Readiness'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('iso27001-asset-inventory-v1'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('evidence-review:iso27001:iso-isms-5'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['compliance-planning'],
      '/tmp/workspace-iso',
    );
  });

  it('creates a dedicated HIPAA Security Rule readiness assessment run with planner-selected safeguards', async () => {
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'hipaa',
          selected: true,
          supported: true,
          controls: makeHipaaComplianceReadinessControls(),
        },
      ],
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-hipaa-planner',
        workspaceDir: '/tmp/workspace-hipaa',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'hipaa compliance planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-hipaa-1',
        scopeId: 'scope-1',
        sessionId: 'session-hipaa-planner',
        plannerSessionId: 'session-hipaa-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Dedicated HIPAA Security Rule readiness assessment.',
        runnerId: 'runner-1',
      },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'hipaa',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-hipaa-1');
    expect(response.body.complianceAssessment).toEqual(
      expect.objectContaining({
        framework: 'hipaa',
        selectionMode: 'planner',
        supportedControlPack: 'agent_control_workspace_v1',
        candidateControlIds: expect.arrayContaining([
          '164.308(a)(1)',
          '164.310(a)(1)',
          '164.312(a)(1)',
          '164.312(e)(2)(ii)',
          '164.314(a)',
          '164.316',
        ]),
        candidateProofObligationIds: expect.arrayContaining([
          'evidence-review:hipaa:164.308(a)(1)',
          'hipaa-164.312-a1-access-v1',
          'hipaa-164.312-b-audit-controls-v1',
          'hipaa-164.312-e2ii-transmission-encryption-v1',
        ]),
        candidateProofObligations: expect.arrayContaining([
          expect.objectContaining({
            controlId: '164.308(a)(1)',
            id: 'evidence-review:hipaa:164.308(a)(1)',
            implementationSpec: 'required',
            assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
          }),
          expect.objectContaining({
            controlId: '164.312(e)(2)(ii)',
            id: 'hipaa-164.312-e2ii-transmission-encryption-v1',
            implementationSpec: 'addressable',
          }),
        ]),
        controlReadiness: expect.arrayContaining([
          expect.objectContaining({
            controlId: '164.308(a)(1)',
            supportLevel: 'manual_evidence_required',
            implementationSpec: 'required',
          }),
          expect.objectContaining({
            controlId: '164.308(a)(7)',
            supportLevel: 'manual_evidence_required',
            implementationSpec: 'mixed',
          }),
          expect.objectContaining({
            controlId: '164.312(e)(2)(ii)',
            supportLevel: 'automated_testable',
            implementationSpec: 'addressable',
          }),
        ]),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'planner',
        promptProfile: 'compliance-planner',
        extraContext: expect.stringContaining('HIPAA Security Rule Readiness'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('hipaa-164.312-e2ii-transmission-encryption-v1'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'hipaa',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['compliance-planning'],
      '/tmp/workspace-hipaa',
    );
  });

  it('creates a dedicated PCI DSS v4.0.1 readiness assessment run with CDE and SAQ metadata', async () => {
    scopeServiceMocks.getById.mockResolvedValueOnce({
      scope: {
        id: 'scope-1',
        name: 'Checkout Scope',
        safeMode: true,
        mission: 'PCI DSS SAQ A-EP assessment for checkout and payment pages for a level 4 merchant.',
        roeDocument:
          'CDE profile: payment page redirects to processor-hosted checkout. SAQ A-EP candidate; merchant level 4.',
      },
      targets: [{ type: 'domain', value: 'checkout.example.com' }],
    });
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'pci_dss',
          selected: true,
          supported: true,
          controls: makePciComplianceReadinessControls(),
        },
      ],
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-pci-planner',
        workspaceDir: '/tmp/workspace-pci',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'pci compliance planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-pci-1',
        scopeId: 'scope-1',
        sessionId: 'session-pci-planner',
        plannerSessionId: 'session-pci-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Dedicated PCI DSS v4.0.1 readiness assessment.',
        runnerId: 'runner-1',
      },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'pci_dss',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-pci-1');
    const assessment = response.body.complianceAssessment;
    expect(assessment.framework).toBe('pci_dss');
    expect(assessment.selectionMode).toBe('planner');
    expect(assessment.supportedControlPack).toBe('agent_control_workspace_v1');
    expect(assessment.pciDssProfileStatus).toEqual(expect.objectContaining({
      cdeDeclared: true,
      saqDeclared: true,
      hasProfileContext: true,
      missing: [],
    }));
    expect(assessment.candidateControlIds).toEqual(expect.arrayContaining([
      '1.2',
      '3.3',
      '4.2',
      '6.4.3',
      '8.4.2',
      '11.3.2',
      '11.4',
      '11.6.1',
      '12.3.2',
    ]));
    expect(assessment.candidateProofObligationIds).toEqual(expect.arrayContaining([
      'pci-1.2-network-controls-v1',
      'pci-4.2-transmission-crypto-v1',
      'pci-8.4.2-cde-mfa-v1',
      'pci-11.3.2-external-scan-readiness-v1',
      'pci-11.6.1-payment-page-tamper-v1',
      'evidence-review:pci_dss:12.3.2',
    ]));
    const proofByControlId = new Map(
      response.body.complianceAssessment.candidateProofObligations.map(
        (proof: { controlId: string }) => [proof.controlId, proof],
      ),
    );
    expect(proofByControlId.get('3.3')).toEqual(expect.objectContaining({
      id: 'evidence-review:pci_dss:3.3',
      pciDssRequirement: '3',
      pciDssAccountData: 'sad',
    }));
    expect(proofByControlId.get('11.6.1')).toEqual(expect.objectContaining({
      id: 'pci-11.6.1-payment-page-tamper-v1',
      pciDssRequirement: '11',
      pciDssCdeScope: 'payment_page',
      pciDssSaqTypes: expect.arrayContaining(['A', 'A-EP']),
    }));
    expect(proofByControlId.get('12.3.2')).toEqual(expect.objectContaining({
      id: 'evidence-review:pci_dss:12.3.2',
      pciDssApproach: 'customized_eligible',
      assessmentSkillSlugs: ['compliance-governance-review', 'compliance-evidence-review'],
    }));
    const readinessByControlId = new Map(
      response.body.complianceAssessment.controlReadiness.map(
        (readiness: { controlId: string }) => [readiness.controlId, readiness],
      ),
    );
    expect(readinessByControlId.get('3.3')).toEqual(expect.objectContaining({
      supportLevel: 'manual_evidence_required',
      pciDssAccountData: 'sad',
    }));
    expect(readinessByControlId.get('4.2')).toEqual(expect.objectContaining({
      supportLevel: 'automated_testable',
      pciDssRequirement: '4',
    }));
    expect(readinessByControlId.get('12.3.2')).toEqual(expect.objectContaining({
      supportLevel: 'manual_evidence_required',
      pciDssApproach: 'customized_eligible',
    }));
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'planner',
        promptProfile: 'compliance-planner',
        extraContext: expect.stringContaining('PCI DSS v4.0.1 Readiness'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('CDE and SAQ profile context appears declared'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('pci-11.6.1-payment-page-tamper-v1'),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('customized_eligible'),
      }),
    );
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'pci_dss',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['compliance-planning'],
      '/tmp/workspace-pci',
    );
  });

  it('blocks planner-selected compliance assessment when no controls are monitored', async () => {
    complianceReadinessServiceMocks.getScopeReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'soc2',
          selected: true,
          supported: true,
          controls: makeComplianceReadinessControls('excluded'),
        },
      ],
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/compliance-assessments').send({
      scopeId: 'scope-1',
      framework: 'soc2',
    });

    expect(response.status).toBe(400);
    expect(response.body.userMessage ?? response.body.message).toContain('No monitored SOC 2 Readiness controls');
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ promptProfile: 'compliance-planner' }),
    );
  });

  it('retires the old compliance baseline and gap launch routes', async () => {
    const app = createTestApp();

    const baseline = await request(app).post('/api/app/runs/compliance-baseline-assessment').send({
      scopeId: 'scope-1',
    });
    const gap = await request(app).post('/api/app/runs/compliance-gap-assessment').send({
      scopeId: 'scope-1',
    });

    expect(baseline.status).toBe(410);
    expect(gap.status).toBe(410);
    expect(baseline.body.message).toContain('/api/app/runs/compliance-assessments');
    expect(gap.body.message).toContain('/api/app/runs/compliance-assessments');
  });

  it('returns 429 instead of creating a resumable run when run-start projection exhausts workspace storage', async () => {
    workspaceProjectionServiceMocks.projectRunWorkspace.mockRejectedValueOnce(
      new Error('write failed: cat: write error: No space left on device'),
    );

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: DEFAULT_ASSESSMENT_GOAL,
    });

    expect(response.status).toBe(429);
    expect(response.body.code).toBe(ERROR_CODES.RESOURCE_QUOTA_EXCEEDED);
    expect(response.body.message).toContain('start the run again');
    expect(runServiceMocks.transitionStatus).toHaveBeenCalledWith('org-1', 'run-1', 'failed');
    expect(runServiceMocks.recordRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        type: 'failed',
        note: expect.stringContaining('run_start_workspace_projection_failed'),
      }),
    );
  });

  it('creates a goal-based planner run and kicks off submit_plan flow', async () => {
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-planner',
        workspaceDir: '/tmp/workspace-planner',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-goal-1',
        scopeId: 'scope-1',
        sessionId: 'session-planner',
        plannerSessionId: 'session-planner',
        status: 'running',
        trigger: 'manual',
        goal: 'Assess authentication attack surface',
        runnerId: null,
      },
    });

    const orchestrator = {
      processMessage: vi.fn().mockResolvedValue(undefined),
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const app = createTestApp({
      orchestrator,
      sessionStore: { recordInternalContinuationInputAsync },
    });

    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: 'Assess authentication attack surface',
    });

    expect(response.status).toBe(201);
    expect(response.body.run.id).toBe('run-goal-1');
    expect(response.body.runner?.id).toBe('runner-1');
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'scope-1',
        mode: 'automated',
        agentType: 'planner',
        extraContext: expect.stringContaining('=== RUN GOAL ===\nAssess authentication attack surface'),
        toolPolicy: expect.objectContaining({
          allow: expect.arrayContaining([
            'submit_plan',
            'query_inventory',
            'query_findings',
            'query_notes',
            'file_read',
          ]),
        }),
      }),
    );
    expect(sessionServiceMocks.createSession.mock.calls[0]?.[0]?.extraContext)
      .not.toContain('=== AVAILABLE SKILLS ===');
    expect(runServiceMocks.createRunRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        plannerSessionId: 'session-planner',
        goal: 'Assess authentication attack surface',
        runnerId: 'runner-1',
      }),
    );

    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      'session-planner',
      expect.objectContaining({
        id: 'run-kickoff:run-goal-1:session-planner',
        content: expect.stringContaining('submit_plan'),
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    expect(runServiceMocks.reconcileBySessionId).not.toHaveBeenCalled();
  });

  it('leaves plan submission and auto-approval to the durable planner turn', async () => {
    sessionServiceMocks.createSession
      .mockResolvedValueOnce({
        session: {
          id: 'session-planner-auto',
          workspaceDir: '/tmp/workspace-planner-auto',
        },
        model: TEST_MODEL,
        preparation: { starterPrompt: 'planner kickoff' },
      })
      .mockResolvedValueOnce({
        session: {
          id: 'session-executor-auto',
          workspaceDir: '/tmp/workspace-executor-auto',
        },
        model: TEST_MODEL,
        preparation: { starterPrompt: 'executor kickoff' },
      });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-goal-auto',
        scopeId: 'scope-1',
        sessionId: 'session-planner-auto',
        plannerSessionId: 'session-planner-auto',
        status: 'running',
        trigger: 'manual',
        goal: 'Assess this target',
        runnerId: null,
      },
    });

    const awaitingApprovalRun = {
      id: 'run-goal-auto',
      scopeId: 'scope-1',
      sessionId: 'session-planner-auto',
      plannerSessionId: 'session-planner-auto',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Benchmark this target',
      plan: '# Auto Approved Plan',
      assignedSkillSlugs: ['xss'],
      runnerId: null,
      executorSessionId: null,
    };

    runServiceMocks.reconcileBySessionId.mockResolvedValueOnce(awaitingApprovalRun);
    runServiceMocks.getById.mockResolvedValue(awaitingApprovalRun);
    runServiceMocks.findNextReadyExecutionPhase.mockResolvedValueOnce(
      makeRunPhase({
        id: 'phase-recon-auto',
        runId: 'run-goal-auto',
        stepIds: ['task-1'],
        assignedSkillSlugs: ['xss'],
      }),
    );
    runServiceMocks.activatePhaseSession.mockResolvedValueOnce({
      ...awaitingApprovalRun,
      sessionId: 'session-executor-auto',
      status: 'running',
      executorSessionId: 'session-executor-auto',
    });

    const orchestrator = {
      processMessage: vi.fn().mockResolvedValue(undefined),
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const app = createTestApp({
      orchestrator,
      sessionStore: { recordInternalContinuationInputAsync },
    });

    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: 'Benchmark this target',
    });

    expect(response.status).toBe(201);

    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      'session-planner-auto',
      expect.objectContaining({
        id: 'run-kickoff:run-goal-auto:session-planner-auto',
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    expect(runServiceMocks.reconcileBySessionId).not.toHaveBeenCalled();
    expect(runServiceMocks.activatePhaseSession).not.toHaveBeenCalled();
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).not.toHaveBeenCalledWith(
      ['xss'],
      '/tmp/workspace-executor-auto',
    );
    expect(runServiceMocks.recordRunEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-goal-auto', type: 'plan_approved' }),
    );
  });

  it('keeps manual runs awaiting approval when the scope requires it, even if a legacy bypass is sent', async () => {
    scopeServiceMocks.getById.mockResolvedValueOnce({
      scope: {
        id: 'scope-1',
        name: 'Internal Scope',
        safeMode: true,
      },
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-planner-safe',
        workspaceDir: '/tmp/workspace-planner-safe',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'planner kickoff' },
    });
    runServiceMocks.createRunRecord.mockResolvedValueOnce({
      created: true,
      run: {
        id: 'run-goal-safe',
        scopeId: 'scope-1',
        sessionId: 'session-planner-safe',
        plannerSessionId: 'session-planner-safe',
        status: 'running',
        trigger: 'manual',
        goal: 'Manual safe-mode run',
        runnerId: null,
      },
    });
    runServiceMocks.reconcileBySessionId.mockResolvedValueOnce({
      id: 'run-goal-safe',
      scopeId: 'scope-1',
      sessionId: 'session-planner-safe',
      plannerSessionId: 'session-planner-safe',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Manual safe-mode run',
      plan: '# Approval Required Plan',
      assignedSkillSlugs: ['xss'],
      runnerId: null,
      executorSessionId: null,
    });

    const orchestrator = {
      processMessage: vi.fn().mockResolvedValue(undefined),
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const app = createTestApp({
      orchestrator,
      sessionStore: { recordInternalContinuationInputAsync },
    });

    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: 'Manual safe-mode run',
      autoApproveOnPlanning: true,
    });

    expect(response.status).toBe(201);
    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      'session-planner-safe',
      expect.objectContaining({
        id: 'run-kickoff:run-goal-safe:session-planner-safe',
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    expect(runServiceMocks.reconcileBySessionId).not.toHaveBeenCalled();
    expect(runServiceMocks.activatePhaseSession).not.toHaveBeenCalled();
    expect(runServiceMocks.recordRunEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-goal-safe',
        type: 'plan_approved',
      }),
    );
  });

  it('approves an awaiting planner run and starts executor session', async () => {
    const runDetail = {
      id: 'run-goal-approve',
      scopeId: 'scope-1',
      sessionId: 'session-planner',
      modelId: '11111111-1111-1111-1111-111111111111',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Approved Plan',
      assignedSkillSlugs: ['sql-injection', 'xss'],
      runnerId: null,
    };
    runServiceMocks.getById.mockResolvedValue(runDetail);
    runServiceMocks.findNextReadyExecutionPhase.mockResolvedValueOnce(
      makeRunPhase({
        id: 'phase-recon-approve',
        runId: 'run-goal-approve',
        assignedSkillSlugs: ['sql-injection', 'xss'],
      }),
    );
    runServiceMocks.activatePhaseSession.mockResolvedValueOnce({
      id: 'run-goal-approve',
      scopeId: 'scope-1',
      sessionId: 'session-executor',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Approved Plan',
      runnerId: null,
      executorSessionId: 'session-executor',
    });
    sessionServiceMocks.createSession.mockResolvedValueOnce({
      session: {
        id: 'session-executor',
        workspaceDir: '/tmp/workspace-executor',
      },
      model: TEST_MODEL,
      preparation: { starterPrompt: 'executor kickoff' },
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/run-goal-approve/approve').send({});

    expect(response.status).toBe(200);
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'scope-1',
        modelId: '11111111-1111-1111-1111-111111111111',
        mode: 'automated',
        agentType: 'executor',
        promptProfile: 'phase-recon',
        extraContext: expect.stringContaining('=== ACTIVE RUN PHASE ==='),
        toolPolicy: expect.objectContaining({
          allow: expect.arrayContaining(['shell_run', 'ingest_scan_artifact', 'submit_phase_handoff']),
        }),
      }),
    );
    expect(sessionServiceMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        extraContext: expect.stringContaining('=== ASSIGNED METHODOLOGIES ==='),
      }),
    );
    expect(runServiceMocks.buildAssignedSkillsContext).toHaveBeenCalledWith('org-1', 'scope-1', [
      'sql-injection',
      'xss',
    ]);
    expect(runServiceMocks.activatePhaseSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-goal-approve',
        phaseId: 'phase-recon-approve',
        sessionId: 'session-executor',
      }),
    );
    expect(skillWorkspaceSyncMocks.syncAssignedSkillsIntoWorkspace).toHaveBeenCalledWith(
      ['sql-injection', 'xss'],
      '/tmp/workspace-executor',
    );
    expect(runServiceMocks.recordRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-goal-approve',
        type: 'plan_approved',
        note: expect.stringContaining('"source":"user"'),
      }),
    );
  });

  it('rejects legacy delegation mode on approval', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/app/runs/run-goal-approve-legacy-mode/approve')
      .send({ delegationMode: 'coordinator' });

    expect(response.status).toBe(400);
    expect(runServiceMocks.getById).not.toHaveBeenCalled();
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects an awaiting planner run', async () => {
    runServiceMocks.getById.mockResolvedValueOnce({
      id: 'run-goal-reject',
      scopeId: 'scope-1',
      sessionId: 'session-planner',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Plan',
      runnerId: null,
    });

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs/run-goal-reject/reject').send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(runServiceMocks.cancel).toHaveBeenCalledWith('org-1', 'run-goal-reject');
  });

  it('waits for live turn settlement before cancelling a run', async () => {
    const session = {
      id: 'session-1',
      turn: 4,
      stateMachine: {
        getState: vi.fn().mockReturnValue('processing'),
        stopProcessing: vi.fn(),
      },
    };
    const abortCurrentTurnAsync = vi.fn().mockResolvedValue(undefined);
    const waitForCurrentTurnToSettleAsync = vi.fn().mockResolvedValue(true);
    const stopSandbox = vi.fn().mockResolvedValue(undefined);

    const app = createTestApp({
      sessionStore: {
        abortCurrentTurnAsync,
        recordStopRequestedAsync: vi.fn().mockResolvedValue(true),
        waitForCurrentTurnToSettleAsync,
        getOrHydrate: vi.fn().mockResolvedValue(session),
      },
      sessionRepository: {
        listIdsByRunId: vi.fn().mockResolvedValue(['session-1']),
        setBlockedReason: vi.fn().mockResolvedValue(true),
      },
      agentEngine: { stopSandbox },
    });
    const response = await request(app).post('/api/app/runs/run-1/cancel').send({});

    expect(response.status).toBe(200);
    expect(abortCurrentTurnAsync).toHaveBeenCalledWith(
      'session-1',
      'run_cancelled_by_operator',
    );
    expect(waitForCurrentTurnToSettleAsync).toHaveBeenCalledWith('session-1');
    expect(stopSandbox).toHaveBeenCalledWith(session, 'run_cancelled_by_operator');
    expect(waitForCurrentTurnToSettleAsync.mock.invocationCallOrder[0]).toBeLessThan(
      runServiceMocks.cancel.mock.invocationCallOrder[0]!,
    );
  });

  it('requests planner changes for an awaiting approval run', async () => {
    const awaitingApprovalRun = {
      id: 'run-goal-feedback',
      scopeId: 'scope-1',
      sessionId: 'session-planner',
      plannerSessionId: 'session-planner',
      status: 'awaiting_approval',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Existing Plan',
      runnerId: null,
    };
    runServiceMocks.getById.mockResolvedValueOnce(awaitingApprovalRun).mockResolvedValueOnce(awaitingApprovalRun);
    runServiceMocks.transitionStatus.mockResolvedValueOnce({
      id: 'run-goal-feedback',
      scopeId: 'scope-1',
      sessionId: 'session-planner',
      plannerSessionId: 'session-planner',
      status: 'running',
      trigger: 'manual',
      goal: 'Assess API auth flow',
      plan: '# Existing Plan',
      runnerId: null,
    });

    const orchestrator = {
      processMessage: vi.fn().mockResolvedValue(undefined),
    };
    const recordInputAndStartRequestedAsync = vi.fn().mockResolvedValue(true);
    const app = createTestApp({
      orchestrator,
      sessionStore: { recordInputAndStartRequestedAsync },
    });
    const response = await request(app).post('/api/app/runs/run-goal-feedback/plan-feedback').send({
      feedback: 'Narrow the plan to auth flows and justify the retry.',
    });

    expect(response.status).toBe(202);
    expect(response.body.success).toBe(true);
    expect(response.body.run.activeSessionId).toBe('session-planner');
    expect(response.body.run.awaitingPlanApproval).toBe(false);
    expect(runServiceMocks.transitionStatus).toHaveBeenCalledWith('org-1', 'run-goal-feedback', 'running');
    expect(recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      'session-planner',
      expect.objectContaining({
        content: expect.stringContaining('Narrow the plan to auth flows and justify the retry.'),
        metadata: { visibility: 'internal', source: 'plan_feedback' },
      }),
      'plan_feedback',
      'operator',
    );
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    expect(auditServiceMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'run.plan_feedback_requested',
        resourceId: 'run-goal-feedback',
      }),
    );
  });

  it('preserves credits_exhausted when kickoff fails with credit exhaustion', async () => {
    scopeServiceMocks.getById.mockResolvedValue({
      scope: {
        id: 'scope-1',
        name: 'External Scope',
      },
    });
    scopeServiceMocks.getScopeContext.mockResolvedValue({
      name: 'External Scope',
      executionNetwork: 'external',
      attachedRunner: null,
      targets: [{ type: 'domain', value: 'app.example.com', verified: true }],
      mission: null,
      stealthPosture: 'coordinated',
      impactTolerance: 'non_destructive',
      rateLimitRps: null,
      blastWindow: null,
      roeDocument: 'No destructive testing.',
      testingPosture: 'black-box',
      testingPostureReason: 'no source access or credentials attached',
      whiteboxEnabled: false,
      connectedRepoCount: 0,
      connectedRepositories: [],
      accessMaterialCount: 0,
      accessMaterials: [],
    });
    runServiceMocks.createRunRecord.mockResolvedValue({
      created: true,
      run: {
        id: 'run-credits',
        scopeId: 'scope-1',
        sessionId: 'session-1',
        status: 'running',
        trigger: 'manual',
        goal: DEFAULT_ASSESSMENT_GOAL,
        runnerId: null,
      },
    });
    runServiceMocks.reconcileBySessionId.mockResolvedValue({
      status: 'running',
    });

    const orchestrator = {
      processMessage: vi
        .fn()
        .mockRejectedValue(new AppError(ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED, 'Credits exhausted')),
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/app/runs',
      createRunsRouter({
        services: {
          sessionStore: {
            mergeFlagNamespaceAsync: vi.fn().mockResolvedValue(undefined),
            recordTimelineEntryAsync: vi.fn().mockResolvedValue(true),
            assignRunWorkspaceAsync: vi.fn().mockResolvedValue(undefined),
            recordInternalContinuationInputAsync,
            remove: vi.fn(),
          },
          orchestrator,
          sandboxProfileRegistry: {},
          ports: {},
          agentEngine: {},
          policyResolver: {},
          traceRecorder: {},
          policyFacade: {},
        } as never,
        repositories: {
          sessionRepository: {} as never,
          messageRepository: {} as never,
          artifactRepository: {} as never,
          policyRepository: {} as never,
        },
        kernel: { accessControl: createAccessControlMock() } as never,
        subscriptionPort: {} as never,
        modelConfigPort: createModelConfigPortMock() as never,
        workspaceProjectionService: workspaceProjectionServiceMocks as never,
        appRole: 'worker',
        enableWorkers: true,
      }),
    );

    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: DEFAULT_ASSESSMENT_GOAL,
    });

    expect(response.status).toBe(201);

    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'run-kickoff:run-credits:session-1',
        metadata: { visibility: 'internal', source: 'planner_kickoff' },
      }),
    );
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    expect(runServiceMocks.onSessionStatusChange).not.toHaveBeenCalled();
  });

  it('blocks run creation when the scope target is not verified', async () => {
    runServiceMocks.enforceRunPrerequisites.mockRejectedValueOnce(
      new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Target ownership must be verified before starting a run.',
      ),
    );

    const app = createTestApp();
    const response = await request(app).post('/api/app/runs').send({
      scopeId: 'scope-1',
      goal: 'Assess authentication attack surface',
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Target ownership must be verified before starting a run.');
    expect(sessionServiceMocks.createSession).not.toHaveBeenCalled();
    expect(runServiceMocks.createRunRecord).not.toHaveBeenCalled();
  });
});
