import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  COMPLIANCE_PLANNER_TOOL_POLICY,
  DEFAULT_PLANNER_TOOL_POLICY,
  readHostedSidecarPhaseFlags,
  StartRunService,
} from '@/domains/security-ops/runs/StartRunService';
import { buildRunContext } from '@/domains/security-ops/runs/RunService';
import { buildCodeReviewManifestHash } from '@/domains/security-ops/runs/codeReviewRunContext';
import type { ScopeContext } from '@/domains/security-ops/scopes/ScopeService';
import type { CloudRunSchedulingConfig } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';

const makeRunDetail = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'run-1',
    organizationId: 'org-1',
    scopeId: 'scope-1',
    userId: 'user-1',
    sessionId: 'planner-session',
    goal: 'Assess API auth',
    status: 'awaiting_approval',
    executorSessionId: null,
    plannerSessionId: 'planner-session',
    assignedSkillSlugs: null,
    plan: '# Attack Surface Discovery\n\n1. Check auth',
    runnerId: null,
    modelId: 'gpt-5',
    ...overrides,
  }) as any;

const makeRunPhase = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'phase-recon',
    runId: 'run-1',
    ordinal: 1,
    phaseKey: 'recon',
    status: 'pending',
    sessionId: null,
    stepIds: ['task-1', 'task-2'],
    assignedSkillSlugs: ['broad-surface-scan'],
    phaseProfile: 'phase-recon',
    toolProfile: 'phase-recon',
    promptProfile: 'phase-recon',
    checkpointRef: null,
    ...overrides,
  }) as any;

describe('Research Lab phase context', () => {
  it('carries the trusted host identity to a child phase bound to the same run', () => {
    expect(readHostedSidecarPhaseFlags({
      securityops: {
        runId: 'run-1',
        runHost: 'research_lab',
        evaluationCaseId: 'code-review-command-injection-positive',
        arbitraryPlannerAuthority: 'must-not-propagate',
      },
    }, 'run-1')).toEqual({
      runHost: 'research_lab',
      evaluationCaseId: 'code-review-command-injection-positive',
    });
  });

  it('rejects a host marker from a different run or an untrusted host', () => {
    expect(readHostedSidecarPhaseFlags({
      securityops: { runId: 'other-run', runHost: 'research_lab' },
    }, 'run-1')).toEqual({});
    expect(readHostedSidecarPhaseFlags({
      securityops: { runId: 'run-1', runHost: 'organization' },
    }, 'run-1')).toEqual({});
  });
});

const buildService = (
  runOverrides: Record<string, unknown> = {},
  options: {
    scopeContextOverrides?: Partial<ScopeContext>;
    scopeAccessMaterialService?: any;
    sessionStoreGet?: any;
    sessionStoreGetOrHydrate?: any;
    createSession?: any;
    sandboxWriteFile?: any;
    sessionRepository?: any;
    runServiceOverrides?: Record<string, unknown>;
    runnerServiceOverrides?: Record<string, unknown>;
    sessionStoreUpdateAsync?: any;
    sessionStoreUpdatePlanAsync?: any;
    sessionStoreRecordInternalContinuationInputAsync?: any;
    sessionStoreRecordInputAndStartRequestedAsync?: any;
    sessionStoreGetJournalProjection?: any;
    workspaceProjectionService?: any;
    cloudScheduling?: {
      config: CloudRunSchedulingConfig;
      queue?: any;
      leases?: any;
    };
  } = {},
) => {
  const scopeContext: ScopeContext = {
    name: 'Internal Scope',
    executionNetwork: 'external',
    attachedRunner: { id: 'runner-1', name: 'Private Runner', status: 'online', type: 'private' },
    targets: [{ type: 'cidr', value: '10.0.0.0/24', verified: true }],
    mission: null,
    impactTolerance: 'non_destructive',
    testingPosture: 'black-box',
    testingPostureReason: 'no source access or credentials attached',
    whiteboxEnabled: false,
    connectedRepoCount: 0,
    connectedRepositories: [],
    accessMaterialCount: 0,
    accessMaterials: [],
    ...options.scopeContextOverrides,
    exclusions: options.scopeContextOverrides?.exclusions ?? [],
    complianceFrameworks: options.scopeContextOverrides?.complianceFrameworks ?? [],
  };
  const createSession = options.createSession ?? vi.fn().mockResolvedValue({
    session: {
      id: 'executor-session',
      workspaceDir: 'C:/tmp/null-workspace',
    },
    model: {
      id: 'resolved-model-id',
      selectionCategory: 'medium',
      modelName: 'resolved-model',
    },
  });
  const processMessage = vi.fn().mockResolvedValue(undefined);
  const getById = vi.fn().mockResolvedValue(makeRunDetail(runOverrides));
  const buildAssignedSkillsContext = vi.fn().mockResolvedValue('=== ASSIGNED METHODOLOGIES ===\nnone');
  const buildPhaseCompatibleSkillCatalogContext = vi.fn().mockResolvedValue('');
  const buildPriorRunContext = vi.fn().mockResolvedValue('=== PRIOR RUN CONTEXT ===\n- blocked sqli @ /api/users');
  const getStrategicNotesForMemorySeed = vi.fn().mockResolvedValue([]);
  const buildRunIdempotencyKey = vi.fn().mockReturnValue('idem-1');
  const getByIdempotencyKey = vi.fn().mockResolvedValue(null);
  const enforceScopeConcurrencyLimit = vi.fn().mockResolvedValue(undefined);
  const enforceRunPrerequisites = vi.fn().mockResolvedValue([]);
  const buildExtraContextFromParts = vi.fn(
    async (
      _orgId: string,
      providedScopeContext: ScopeContext,
      executionTarget: 'cloud' | 'scope_runner' = 'cloud',
      recipient: 'planner' | 'executor' | 'reporting' = 'planner',
    ) => buildRunContext(
      { name: 'Acme', context: 'Handles customer data' },
      providedScopeContext,
      executionTarget,
      recipient,
    ),
  );
  const createRunRecord = vi.fn().mockResolvedValue({
    created: true,
    run: {
      ...makeRunDetail(runOverrides),
      id: 'run-1',
      sessionId: 'executor-session',
      plannerSessionId: 'executor-session',
      status: 'running',
    },
  });
  const attachSessionToAdmittedRun = vi.fn().mockResolvedValue({
    ...makeRunDetail(runOverrides),
    id: 'run-1',
    sessionId: 'executor-session',
    plannerSessionId: 'executor-session',
    status: 'queued',
    admittedAt: new Date(),
  });
  const reconcileBySessionId = vi.fn().mockResolvedValue({
    ...makeRunDetail(runOverrides),
    sessionId: 'executor-session',
    executorSessionId: 'executor-session',
    status: 'running',
  });
  const findNextReadyReportingPhase = vi.fn().mockResolvedValue(null);
  const findNextReadyValidationPhase = vi.fn().mockResolvedValue(null);
  const findNextReadyExecutionPhase = vi.fn().mockResolvedValue(makeRunPhase());
  const listRunningRunsReadyForPhaseStart = vi.fn().mockResolvedValue([]);
  const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue(null);
  const listOpenValidationQueue = vi.fn().mockResolvedValue([]);
  const listOpenValidationLeads = vi.fn().mockResolvedValue([]);
  const getPhaseDiscoveryReplanSignals = vi.fn().mockResolvedValue({
    newRoutes: 0,
    newParameterizedRoutes: 0,
    newHighPriorityLeads: 0,
    openHighPriorityLeads: 0,
    openHighPriorityLeadFamilies: [],
    priorResourceBlocker: null,
  });
  const attachValidationQueueToPhase = vi.fn().mockResolvedValue([]);
  const markPhaseCompleted = vi.fn().mockResolvedValue(null);
  const updatePhaseAssignedSkills = vi.fn().mockResolvedValue(null);
  const recordRunEvent = vi.fn().mockResolvedValue(undefined);
  const recordPhaseHandoffReconciliation = vi.fn().mockResolvedValue(undefined);
  const hasOpenPhaseReplan = vi.fn().mockResolvedValue(false);
  const hasAppliedPhaseReplan = vi.fn().mockResolvedValue(false);
  const findOpenPhaseReplan = vi.fn().mockResolvedValue({
    id: 'replan-1',
    runId: 'run-1',
    phaseId: 'phase-enumeration',
    status: 'open',
    requestedPhaseStatus: 'completed',
    handoffRef: '.artifacts/phase-handoffs/phase-enumeration.json',
    reason: 'Phase handoff requires planner revision.',
    dispatchAttempts: 0,
    lastDispatchAt: null,
    lastDispatchError: null,
    requestedAt: new Date(),
    appliedAt: null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const hasPhaseSessionHistory = vi.fn().mockResolvedValue(false);
  const requestPhaseReplan = vi.fn().mockResolvedValue({
    ...makeRunDetail(runOverrides),
    status: 'running',
    sessionId: 'planner-session',
    executorSessionId: null,
  });
  const transitionStatus = vi.fn().mockResolvedValue({
    ...makeRunDetail(runOverrides),
    status: 'running',
  });
  const activatePhaseSession = vi.fn().mockResolvedValue({
    ...makeRunDetail(runOverrides),
    sessionId: 'executor-session',
    executorSessionId: 'executor-session',
    status: 'running',
  });
  const listRunPhases = vi.fn().mockResolvedValue([]);
  const replaceRunPhasesForReportOnlyRun = vi.fn().mockResolvedValue([]);
  const sessionStoreSetAsync = vi.fn().mockResolvedValue(undefined);
  const sessionStoreUpdateAsync =
    options.sessionStoreUpdateAsync ?? vi.fn().mockResolvedValue(true);
  const sessionStoreUpdatePlanAsync =
    options.sessionStoreUpdatePlanAsync ?? vi.fn().mockResolvedValue(true);
  const abortCurrentTurnAsync = vi.fn().mockResolvedValue(undefined);
  const cleanupRunWorkspaceAsync = vi.fn().mockResolvedValue({
    cleaned: true,
    workspaceDirs: ['/tmp/ns-run-run-1'],
    activeSessionIds: [],
    errors: 0,
  });
  const assignRunWorkspaceAsync = vi.fn().mockResolvedValue(undefined);
  const mergeFlagNamespaceAsync = vi.fn().mockResolvedValue(undefined);
  const removeAsync = vi.fn().mockResolvedValue(true);
  const setCompleted = vi.fn().mockResolvedValue(true);
  const setBlockedReason = vi.fn().mockResolvedValue(true);
  const clearBlockedReason = vi.fn().mockResolvedValue(true);
  const sandboxWriteFile = options.sandboxWriteFile ?? vi.fn().mockResolvedValue(undefined);
  const sandboxDestroy = vi.fn().mockResolvedValue(undefined);

  const service = new StartRunService({
    runService: {
      getById,
      buildRunIdempotencyKey,
      getByIdempotencyKey,
      enforceScopeConcurrencyLimit,
      enforceRunPrerequisites,
      buildExtraContextFromParts,
      buildAssignedSkillsContext,
      buildPhaseCompatibleSkillCatalogContext,
      buildPriorRunContext,
      getStrategicNotesForMemorySeed,
      createRunRecord,
      attachSessionToAdmittedRun,
      reconcileBySessionId,
      findNextReadyReportingPhase,
      findNextReadyValidationPhase,
      findNextReadyExecutionPhase,
      listRunningRunsReadyForPhaseStart,
      findLatestPhaseHandoffBefore,
      listOpenValidationQueue,
      listOpenValidationLeads,
      getPhaseDiscoveryReplanSignals,
      attachValidationQueueToPhase,
      activatePhaseSession,
      listRunPhases,
      replaceRunPhasesForReportOnlyRun,
      markPhaseCompleted,
      updatePhaseAssignedSkills,
      recordRunEvent,
      recordPhaseHandoffReconciliation,
      hasOpenPhaseReplan,
      hasAppliedPhaseReplan,
      findOpenPhaseReplan,
      hasPhaseSessionHistory,
      requestPhaseReplan,
      transitionStatus,
      ...(options.runServiceOverrides ?? {}),
    } as any,
    scopeService: {
      getById: vi.fn().mockResolvedValue({ scope: { executionNetwork: 'external' } }),
      getScopeContext: vi.fn().mockResolvedValue(scopeContext),
    } as any,
    runnerService: {
      getAttachedRunner: vi.fn().mockResolvedValue(null),
      resolveRunner: vi.fn().mockResolvedValue({
        id: 'runner-1',
        name: 'Private Runner',
        type: 'private',
        status: 'online',
      }),
      getRunner: vi.fn().mockResolvedValue({
        id: 'runner-1',
        name: 'Private Runner',
        type: 'private',
        status: 'online',
      }),
      ...(options.runnerServiceOverrides ?? {}),
    } as any,
    sessionService: {
      createSession,
    } as any,
    agentServices: {
      sessionStore: {
        get: options.sessionStoreGet ?? vi.fn().mockReturnValue(null),
        getOrHydrate: options.sessionStoreGetOrHydrate ?? vi.fn().mockResolvedValue(null),
        setAsync: sessionStoreSetAsync,
        updateSessionAsync: sessionStoreUpdateAsync,
        updatePlanAsync: sessionStoreUpdatePlanAsync,
        recordInternalContinuationInputAsync:
          options.sessionStoreRecordInternalContinuationInputAsync,
        recordInputAndStartRequestedAsync:
          options.sessionStoreRecordInputAndStartRequestedAsync,
        recordSessionCompletedAsync: vi.fn().mockResolvedValue(false),
        getJournalProjection: options.sessionStoreGetJournalProjection,
        abortCurrentTurnAsync,
        assignRunWorkspaceAsync,
        mergeFlagNamespaceAsync,
        removeAsync,
        setMemoryAsync: vi.fn().mockResolvedValue(undefined),
        recordTimelineEntryAsync: vi.fn().mockResolvedValue(true),
        cleanupRunWorkspaceAsync,
      },
      orchestrator: {
        processMessage,
      },
      sandbox: {
        writeFile: sandboxWriteFile,
        destroy: sandboxDestroy,
      },
    } as any,
    sessionRepository: options.sessionRepository ?? {
      setCompleted,
      setBlockedReason,
      clearBlockedReason,
    },
    scopeAccessMaterialService: options.scopeAccessMaterialService,
    workspaceProjectionService: options.workspaceProjectionService,
    cloudScheduling: options.cloudScheduling,
  });

  return {
    service,
    mocks: {
      createSession,
      buildAssignedSkillsContext,
      buildPhaseCompatibleSkillCatalogContext,
      buildPriorRunContext,
      getStrategicNotesForMemorySeed,
      buildRunIdempotencyKey,
      getByIdempotencyKey,
      enforceScopeConcurrencyLimit,
      enforceRunPrerequisites,
      buildExtraContextFromParts,
      createRunRecord,
      attachSessionToAdmittedRun,
      processMessage,
      sandboxWriteFile,
      sandboxDestroy,
      sessionStoreSetAsync,
      sessionStoreUpdateAsync,
      sessionStoreRecordInternalContinuationInputAsync:
        options.sessionStoreRecordInternalContinuationInputAsync,
      sessionStoreRecordInputAndStartRequestedAsync:
        options.sessionStoreRecordInputAndStartRequestedAsync,
      abortCurrentTurnAsync,
      cleanupRunWorkspaceAsync,
      assignRunWorkspaceAsync,
      mergeFlagNamespaceAsync,
      removeAsync,
      setCompleted,
      setBlockedReason,
      clearBlockedReason,
      findNextReadyReportingPhase,
      findNextReadyValidationPhase,
      findNextReadyExecutionPhase,
      listRunningRunsReadyForPhaseStart,
      findLatestPhaseHandoffBefore,
      listOpenValidationQueue,
      listOpenValidationLeads,
      getPhaseDiscoveryReplanSignals,
      attachValidationQueueToPhase,
      activatePhaseSession,
      listRunPhases,
      replaceRunPhasesForReportOnlyRun,
      markPhaseCompleted,
      updatePhaseAssignedSkills,
      recordRunEvent,
      recordPhaseHandoffReconciliation,
      hasOpenPhaseReplan,
      hasAppliedPhaseReplan,
      findOpenPhaseReplan,
      hasPhaseSessionHistory,
      requestPhaseReplan,
      transitionStatus,
      workspaceProjectionService: options.workspaceProjectionService,
    },
  };
};

describe('StartRunService cloud admission boundary', () => {
  it('persists launch intent without creating a session or sandbox before automatic admission', async () => {
    const createSession = vi.fn();
    const queuedRun = makeRunDetail({
      status: 'queued',
      sessionId: null,
      plannerSessionId: null,
      runnerId: null,
      admissionEpoch: 1,
      launchPayload: { version: 1, kind: 'planner', params: {} },
    });
    const createQueuedRun = vi.fn().mockResolvedValue({ created: true, run: queuedRun });
    const config: CloudRunSchedulingConfig = {
      queueCloudRuns: true,
      runnerName: 'test-cloud',
      claimTtlMs: 60_000,
      heartbeatMaxAgeMs: 90_000,
      planStarvationMs: 60_000,
      backlogByClass: { free: 1, paid: 3, pro: 5, internal: 10 },
      profiles: {
        control: { version: 1, memoryMb: 0, containerSlots: 0, cpuMillis: null, pidLimit: null },
        standard: { version: 1, memoryMb: 1_024, containerSlots: 1, cpuMillis: 1_000, pidLimit: 256 },
        heavy: { version: 1, memoryMb: 2_048, containerSlots: 2, cpuMillis: 2_000, pidLimit: 512 },
      },
    };
    const { service } = buildService({}, {
      createSession,
      cloudScheduling: { config },
      runServiceOverrides: { createRunRecord: createQueuedRun },
    });

    const result = await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess the target safely',
      trigger: 'manual',
      executionTarget: 'cloud',
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
      maxConcurrentRuns: 1,
      schedulingClass: 'free',
    });

    expect(result.run.status).toBe('queued');
    expect(result.sessionId).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(createQueuedRun).toHaveBeenCalledWith(expect.objectContaining({
      initialStatus: 'queued',
      sessionId: null,
      capacityProfile: 'heavy',
      maxConcurrentRuns: 1,
      maxQueuedBacklog: 1,
      launchPayload: expect.objectContaining({ version: 1, kind: 'planner' }),
    }));
  });

  it('uses a scheduler key to create a new Run after a failed idempotent attempt', async () => {
    const config: CloudRunSchedulingConfig = {
      queueCloudRuns: true,
      runnerName: 'test-cloud',
      claimTtlMs: 60_000,
      heartbeatMaxAgeMs: 90_000,
      planStarvationMs: 60_000,
      backlogByClass: { free: 1, paid: 3, pro: 5, internal: 10 },
      profiles: {
        control: { version: 1, memoryMb: 0, containerSlots: 0, cpuMillis: null, pidLimit: null },
        standard: { version: 1, memoryMb: 1_024, containerSlots: 1, cpuMillis: 1_000, pidLimit: 256 },
        heavy: { version: 1, memoryMb: 2_048, containerSlots: 2, cpuMillis: 2_000, pidLimit: 512 },
      },
    };
    const failedRun = makeRunDetail({ status: 'failed', idempotencyKey: 'watch-assessment:period-1' });
    const getByIdempotencyKey = vi.fn().mockResolvedValue(failedRun);
    const createRunRecord = vi.fn().mockResolvedValue({
      created: true,
      run: makeRunDetail({
        id: 'replacement-run',
        status: 'queued',
        idempotencyKey: 'watch-assessment:period-1',
      }),
    });
    const { service, mocks } = buildService({}, {
      cloudScheduling: { config },
      runServiceOverrides: { getByIdempotencyKey, createRunRecord },
    });

    const result = await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Run the bounded Website Watch assessment',
      trigger: 'watch_scheduled',
      executionTarget: 'cloud',
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
      idempotencyKey: 'watch-assessment:period-1',
      replaceFailedIdempotentRun: true,
      maxConcurrentRuns: 1,
      schedulingClass: 'paid',
    });

    expect(result.run.id).toBe('replacement-run');
    expect(getByIdempotencyKey).toHaveBeenCalledWith('org-1', 'watch-assessment:period-1');
    expect(mocks.buildRunIdempotencyKey).not.toHaveBeenCalled();
    expect(createRunRecord).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'watch-assessment:period-1',
      replaceFailedIdempotentRun: true,
    }));
  });

  it('does not make an admitted Run reject the scope slot it already reserved', async () => {
    vi.useFakeTimers();
    const config: CloudRunSchedulingConfig = {
      queueCloudRuns: true,
      runnerName: 'test-cloud',
      claimTtlMs: 60_000,
      heartbeatMaxAgeMs: 90_000,
      planStarvationMs: 60_000,
      backlogByClass: { free: 1, paid: 3, pro: 5, internal: 10 },
      profiles: {
        control: { version: 1, memoryMb: 0, containerSlots: 0, cpuMillis: null, pidLimit: null },
        standard: { version: 1, memoryMb: 1_024, containerSlots: 1, cpuMillis: 1_000, pidLimit: 256 },
        heavy: { version: 1, memoryMb: 2_048, containerSlots: 2, cpuMillis: 2_000, pidLimit: 512 },
      },
    };
    const markStarted = vi.fn().mockResolvedValue(makeRunDetail({
      status: 'running',
      sessionId: 'executor-session',
      plannerSessionId: 'executor-session',
      executionTarget: 'cloud',
    }));
    const activateLease = vi.fn().mockResolvedValue(undefined);
    const { service, mocks } = buildService({ executionTarget: 'cloud' }, {
      cloudScheduling: {
        config,
        queue: { markStarted },
        leases: { activateLease },
      },
    });

    const result = await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess the target safely',
      trigger: 'manual',
      executionTarget: 'cloud',
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
      admission: {
        runId: 'run-1',
        admissionEpoch: 1,
        claimOwner: 'worker-a',
        leaseId: 'lease-1',
        runner: { id: 'platform-runner', name: 'cloud', type: 'cloud', status: 'online' } as any,
      },
    });

    expect(result.run.status).toBe('running');
    expect(mocks.enforceScopeConcurrencyLimit).not.toHaveBeenCalled();
    expect(mocks.attachSessionToAdmittedRun).toHaveBeenCalledOnce();
    expect(activateLease).toHaveBeenCalledWith({ leaseId: 'lease-1', sessionId: 'executor-session' });
    expect(markStarted).toHaveBeenCalledWith({
      runId: 'run-1',
      owner: 'worker-a',
      sessionId: 'executor-session',
    });
    vi.clearAllTimers();
  });

});

describe('StartRunService executor prior run context', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('applies focused disposition authorization flags to the current session atomically', async () => {
    vi.useFakeTimers();
    const workspaceDir = await mkdtemp(join(tmpdir(), 'null-ai-finding-disposition-context-'));
    try {
      const staleCreationSnapshot = {
        id: 'disposition-session',
        version: 0,
        workspaceDir,
        flags: {},
        messages: [],
        plan: [],
        extraContext: '',
        completed: false,
      };
      const currentSession: any = {
        ...staleCreationSnapshot,
        version: 3,
        flags: {
          policy_base: { toolPolicy: null },
          securityops: { runId: 'run-1' },
        },
      };
      const updateSessionAsync = vi.fn(async (
        sessionId: string,
        mutator: (session: any) => unknown,
      ) => {
        expect(sessionId).toBe('disposition-session');
        return mutator(currentSession);
      });
      const validationPhase = makeRunPhase({
        id: 'phase-validation',
        phaseKey: 'validation',
        ordinal: 1,
        stepIds: ['verify-finding-finding-1'],
        assignedSkillSlugs: ['validation'],
        phaseProfile: 'phase-validation',
        toolProfile: 'phase-validation',
        promptProfile: 'phase-validation',
      });
      const createSession = vi.fn().mockResolvedValue({
        session: staleCreationSnapshot,
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const { service, mocks } = buildService(
        {
          workflowDiscipline: 'pentest',
          idempotencyKey: 'finding-disposition:verification-1',
        },
        {
          createSession,
          sessionStoreGet: vi.fn().mockReturnValue(currentSession),
          sessionStoreGetOrHydrate: vi.fn().mockResolvedValue(currentSession),
          sessionStoreUpdateAsync: updateSessionAsync,
          sessionStoreUpdatePlanAsync: vi.fn(async (sessionId: string, plan: unknown[]) => {
            expect(sessionId).toBe('disposition-session');
            currentSession.plan = plan;
            return true;
          }),
          runServiceOverrides: {
            listRunPhases: vi.fn().mockResolvedValue([validationPhase]),
          },
        },
      );

      await service.startFindingDispositionVerificationRun({
        orgId: 'org-1',
        userId: 'user-1',
        scopeId: 'scope-1',
        findingId: 'finding-1',
        verificationId: 'verification-1',
        requestedState: 'dismissed',
        launchKey: 'finding-disposition:verification-1',
        reason: 'Scanner claim did not reproduce.',
        snapshot: {
          schemaVersion: 1,
          finding: {
            id: 'finding-1',
            title: 'Possible command injection',
            summary: 'Scanner-only claim.',
            severity: 'high',
            state: 'potential',
            lifecycleVersion: 1,
            assetId: 'asset-1',
            pocDescription: 'Replay the historical payload.',
            assumptions: 'Target routing and command runner are healthy.',
          },
          asset: { id: 'asset-1', kind: 'web', value: 'http://target.test' },
          targets: [
            {
              id: 'target-1',
              type: 'url',
              value: 'http://target.test',
              verified: true,
            },
            {
              id: 'target-unverified',
              type: 'domain',
              value: 'unverified-secret.example',
              verified: false,
            },
            {
              id: 'target-other-verified',
              type: 'domain',
              value: 'other-verified.example',
              verified: true,
            },
          ],
          capturedAt: '2026-07-30T00:00:00.000Z',
        },
      });

      expect(updateSessionAsync).toHaveBeenCalledOnce();
      expect(currentSession.flags.securityops).toMatchObject({
        runId: 'run-1',
        findingDispositionVerificationId: 'verification-1',
        findingId: 'finding-1',
        requestedRiskState: 'dismissed',
        activePhaseId: 'phase-validation',
        activePhaseKey: 'validation',
      });
      expect(currentSession.extraContext).toContain('FINDING DISPOSITION VERIFICATION CONTRACT');
      expect(currentSession.extraContext).toContain('http://target.test');
      expect(currentSession.extraContext).toContain('"verifiedScopeTargetCount": 2');
      expect(currentSession.extraContext).toContain('"unverifiedTargetCount": 1');
      expect(currentSession.extraContext).not.toContain('unverified-secret.example');
      expect(currentSession.extraContext).not.toContain('other-verified.example');
      expect(currentSession.extraContext).not.toContain('10.0.0.0/24');
      expect(currentSession.plan).toHaveLength(1);
      expect(mocks.sessionStoreSetAsync).not.toHaveBeenCalledWith(
        'disposition-session',
        expect.anything(),
        'securityops.finding_disposition_context_ready',
      );
    } finally {
      vi.clearAllTimers();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('does not launch a new phase while the run is system-paused', async () => {
    const { service, mocks } = buildService({ status: 'system_paused' });

    await expect(service.startNextExecutionPhase({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    })).resolves.toBeNull();

    expect(mocks.findNextReadyExecutionPhase).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('fails standalone Code Review before session creation when immutable manifest input is absent', async () => {
    const { service, mocks } = buildService();
    const codeReviewContext = {
      operation: 'repository_review' as const,
      repository: {
        provider: 'github' as const,
        installationId: 'installation-1',
        repositoryId: 'repository-1',
        fullName: 'nullsquare/backend',
        visibility: 'private' as const,
        immutableCommitSha: 'a'.repeat(40),
        requestedRef: 'main',
        defaultBranch: 'main',
      },
      reviewScope: {
        mode: 'repository' as const,
        allowedPaths: [],
        excludedPaths: [],
        contextReadPolicy: 'immutable_manifest_only',
        manifestHash: 'b'.repeat(64),
        completeness: 'complete' as const,
      },
      policySnapshot: {
        version: 'code-review/v1',
        toolProfile: 'code-review-read-only-v1',
        pathPolicy: 'immutable-manifest-bound',
        networkPolicy: 'github-read-only',
        publicationPolicy: 'none',
      },
    };

    await expect(service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Review the repository',
      trigger: 'manual',
      toolPolicy: { allow: [] },
      workflowDiscipline: 'code_review',
      codeReviewOperation: 'repository_review',
      codeReviewContext,
    })).rejects.toThrow(/requires the immutable repository manifest/iu);

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.createRunRecord).not.toHaveBeenCalled();
  });

  it('terminalizes a created Code Review run when its immutable memory snapshot cannot persist', async () => {
    const manifestFiles = [{ path: 'src/auth.ts', blobSha: 'c'.repeat(40), size: 120 }];
    const codeReviewContext = {
      operation: 'repository_review' as const,
      repository: {
        provider: 'github' as const,
        installationId: 'installation-1',
        repositoryId: 'repository-1',
        fullName: 'nullsquare/backend',
        visibility: 'private' as const,
        immutableCommitSha: 'a'.repeat(40),
        requestedRef: 'main',
        defaultBranch: 'main',
      },
      reviewScope: {
        mode: 'repository' as const,
        allowedPaths: [],
        excludedPaths: [],
        contextReadPolicy: 'immutable_manifest_only',
        manifestHash: buildCodeReviewManifestHash({
          immutableCommitSha: 'a'.repeat(40),
          files: manifestFiles,
          allowedPaths: [],
          excludedPaths: [],
        }),
        completeness: 'complete' as const,
      },
      policySnapshot: {
        version: 'code-review/v1',
        toolProfile: 'code-review-read-only-v1',
        pathPolicy: 'immutable-manifest-bound',
        networkPolicy: 'github-read-only',
        publicationPolicy: 'none',
      },
    };
    const persistCodeReviewMemorySnapshot = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const { service, mocks } = buildService({}, {
      scopeContextOverrides: {
        connectedRepoCount: 1,
        connectedRepositories: [{
          id: 'repository-1',
          fullName: 'nullsquare/backend',
          defaultBranch: 'main',
          ownerLogin: 'nullsquare',
          name: 'backend',
          htmlUrl: 'https://github.com/nullsquare/backend',
        }],
      },
      runServiceOverrides: {
        buildCodeReviewMemorySnapshot: vi.fn().mockResolvedValue({
          promptText: '=== PRIOR CODE REVIEW MEMORY ===',
          counts: {
            considered: 0,
            current: 0,
            needsRecheck: 0,
            superseded: 0,
            historical: 0,
            outOfScope: 0,
          },
          records: [],
        }),
        persistCodeReviewMemorySnapshot,
      },
    });

    await expect(service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Review the repository',
      trigger: 'manual',
      toolPolicy: { allow: [] },
      workflowDiscipline: 'code_review',
      codeReviewOperation: 'repository_review',
      codeReviewContext,
      codeReviewManifestFiles: manifestFiles,
    })).rejects.toThrow(/memory snapshot could not be persisted/iu);

    expect(persistCodeReviewMemorySnapshot).toHaveBeenCalled();
    expect(mocks.transitionStatus).toHaveBeenCalledWith('org-1', 'run-1', 'failed');
    expect(mocks.setBlockedReason).toHaveBeenCalledWith(
      'executor-session',
      'error',
      expect.objectContaining({
        code: 'code_review_memory_snapshot_failed',
        reason: 'run_start_code_review_memory_snapshot_failed',
      }),
    );
    expect(mocks.sandboxDestroy).toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('injects prior run context into executor extraContext for normal runs', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    expect(mocks.buildPriorRunContext).toHaveBeenCalledWith(
      'org-1',
      'scope-1',
      'pentest',
      null,
    );
    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.agentType).toBe('executor');
    expect(createSessionArgs?.promptProfile).toBe('phase-recon');
    expect(createSessionArgs?.toolPolicy?.allow).toEqual(expect.arrayContaining([
      'shell_run',
      'ingest_scan_artifact',
      'submit_phase_handoff',
      'spawn_worker',
      'wait_for_worker',
    ]));
    expect(createSessionArgs?.extraContext).toContain('=== SCOPE CONTEXT ===');
    expect(createSessionArgs?.extraContext).toContain('Selected Execution Target: cloud');
    expect(createSessionArgs?.extraContext).toContain('=== PRIOR RUN CONTEXT ===');
    expect(createSessionArgs?.extraContext).toContain('=== ACTIVE RUN PHASE ===');
    expect(createSessionArgs?.planSeed).toEqual([
      expect.objectContaining({ id: 'task-1', title: 'Check auth' }),
    ]);

    vi.clearAllTimers();
  });

  it('completes phase workspace preparation before durable phase activation', async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), 'null-ai-phase-order-'));
    const projectRunWorkspace = vi.fn().mockResolvedValue({
      success: true,
      written: ['AGENTS.md'],
      skipped: [],
      warnings: [],
    });
    try {
      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'prepared-executor-session',
          workspaceDir: workspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail({ status: 'running' }),
        sessionId: 'prepared-executor-session',
        executorSessionId: 'prepared-executor-session',
      });
      const { service, mocks } = buildService({}, {
        createSession,
        workspaceProjectionService: { projectRunWorkspace },
        runServiceOverrides: { activatePhaseSession },
      });

      await service.startNextExecutionPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(projectRunWorkspace).toHaveBeenCalledOnce();
      expect(activatePhaseSession).toHaveBeenCalledOnce();
      expect(projectRunWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        activatePhaseSession.mock.invocationCallOrder[0],
      );
      expect(activatePhaseSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.processMessage.mock.invocationCallOrder[0],
      );
    } finally {
      vi.clearAllTimers();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the phase pending when transient workspace preparation exhausts its retries', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'null-ai-phase-failure-'));
    const projectRunWorkspace = vi
      .fn()
      .mockRejectedValue(new Error('temporary sandbox file transport failure'));
    try {
      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'unprepared-executor-session',
          workspaceDir: workspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const activatePhaseSession = vi.fn();
      const { service, mocks } = buildService({}, {
        createSession,
        workspaceProjectionService: { projectRunWorkspace },
        runServiceOverrides: { activatePhaseSession },
      });

      await expect(service.startNextExecutionPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      })).rejects.toMatchObject({
        code: 'internal.dependency_failed',
        retryable: true,
      });

      expect(projectRunWorkspace).toHaveBeenCalledTimes(3);
      expect(activatePhaseSession).not.toHaveBeenCalled();
      expect(mocks.processMessage).not.toHaveBeenCalled();
      expect(mocks.setBlockedReason).toHaveBeenCalledWith(
        'unprepared-executor-session',
        'phase_preparation_failed',
        expect.objectContaining({
          runId: 'run-1',
          phaseId: 'phase-recon',
          phaseKey: 'recon',
        }),
      );
      expect(mocks.setCompleted).toHaveBeenCalledWith(
        'unprepared-executor-session',
        true,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('passes the stored intelligence category to executor sessions instead of forcing the resolved planner model id', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({
      modelId: 'medium-model-id',
      modelCategory: 'high',
    });

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.agentType).toBe('executor');
    expect(createSessionArgs?.modelCategory).toBe('high');
    expect(createSessionArgs?.modelId).toBeUndefined();

    vi.clearAllTimers();
  });

  it('reopens a completed planner through the atomic journal input boundary', async () => {
    const plannerSession = {
      id: 'planner-session',
      flags: {
        session: { completed: true },
        blocked_reason: 'awaiting_approval',
      },
      completed: true,
      blockedReason: 'awaiting_approval',
      blockedMeta: { reason: 'awaiting_approval' },
      pendingApproval: { toolCallId: 'approval-1' },
    };
    const recordInputAndStartRequestedAsync = vi.fn().mockResolvedValue(true);
    const { service, mocks } = buildService({}, {
      sessionStoreGetOrHydrate: vi.fn().mockResolvedValue(plannerSession),
      sessionStoreRecordInputAndStartRequestedAsync: recordInputAndStartRequestedAsync,
    });

    await service.requestPlanFeedback({
      orgId: 'org-1',
      runId: 'run-1',
      feedback: 'Narrow the plan to auth flows.',
    });

    expect(mocks.sessionStoreSetAsync).not.toHaveBeenCalledWith(
      'planner-session',
      plannerSession,
      'plan_feedback.reopen_planner',
    );
    expect(mocks.setCompleted).not.toHaveBeenCalled();
    expect(mocks.clearBlockedReason).not.toHaveBeenCalled();
    expect(mocks.transitionStatus).toHaveBeenCalledWith('org-1', 'run-1', 'running');
    expect(recordInputAndStartRequestedAsync).toHaveBeenCalledWith(
      'planner-session',
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Narrow the plan to auth flows.'),
        metadata: {
          visibility: 'internal',
          source: 'plan_feedback',
        },
      }),
      'plan_feedback',
      'operator',
    );
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('uses bounded routing without injecting the planning skill or global catalog', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess API auth',
      modelCategory: 'extra_high',
      trigger: 'manual',
      toolPolicy: { allow: ['submit_plan'] },
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.agentType).toBe('planner');
    expect(createSessionArgs?.modelCategory).toBe('extra_high');
    expect(createSessionArgs?.flags.securityops.activePhaseKey).toBe('planning');
    expect(mocks.mergeFlagNamespaceAsync).toHaveBeenCalledWith(
      'executor-session',
      'securityops',
      expect.objectContaining({
        runId: 'run-1',
        activePhaseKey: 'planning',
      }),
    );
    expect(createSessionArgs?.extraContext).not.toContain('=== SECURITYOPS PLANNING SKILL ===');
    expect(createSessionArgs?.extraContext).not.toContain('=== AVAILABLE SKILLS ===');
    const kickoffPrompt = mocks.processMessage.mock.calls[0]?.[1];
    expect(kickoffPrompt).toContain('Reserve the final mission for reporting closeout');
    expect(kickoffPrompt).toContain('assigned_skills=["security-reporting"]');
    expect(kickoffPrompt).toContain('query_notes({ ntype: "approach.blocker" })');
    expect(kickoffPrompt).toContain('list_relevant_skills({ missionId, phase');
    expect(kickoffPrompt).toContain('Treat prior blockers as targets');
    expect(kickoffPrompt).toContain('new_hypothesis');
    expect(mocks.enforceRunPrerequisites).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: 'cloud',
      networkActivityRequired: true,
    }));

    vi.clearAllTimers();
  });

  it('starts exposure verification with its own profile, skill, trigger flag, and terminal contract', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({}, {
      scopeContextOverrides: {
        targets: [
          { type: 'domain', value: 'other.example.com', verified: true },
          { type: 'domain', value: 'unverified.example.com', verified: false },
        ],
        mission: 'Assess every host and service in the scope.',
      },
    });

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Verify CVE-2026-0001 against widget.example.com',
      trigger: 'exposure_verification',
      vars: {
        exposureMatchId: 'match-1',
        advisoryId: 'CVE-2026-0001',
        assetValue: 'widget.example.com',
      },
      toolPolicy: {
        allow: ['http_payload', 'file_write', 'submit_exposure_verification'],
        deny: ['submit_plan'],
      },
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.agentType).toBe('planner');
    expect(createSessionArgs?.promptProfile).toBe('exposure-verification');
    expect(createSessionArgs?.flags.securityops).toEqual(expect.objectContaining({
      activePhaseKey: 'planning',
      runTrigger: 'exposure_verification',
    }));
    expect(createSessionArgs?.extraContext).toContain('=== ASSIGNED METHODOLOGIES ===');
    expect(createSessionArgs?.extraContext).toContain('=== OPERATOR VARS ===');
    expect(createSessionArgs?.extraContext).toContain('widget.example.com (domain)');
    expect(createSessionArgs?.extraContext).not.toContain('other.example.com');
    expect(createSessionArgs?.extraContext).not.toContain('unverified.example.com');
    expect(createSessionArgs?.extraContext).not.toContain('Assess every host and service');
    expect(createSessionArgs?.extraContext).not.toContain('=== PRIOR RUN CONTEXT ===');
    expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith(
      'org-1',
      'scope-1',
      ['cve-verification'],
    );
    expect(mocks.mergeFlagNamespaceAsync).toHaveBeenCalledWith(
      'executor-session',
      'securityops',
      expect.objectContaining({
        runId: 'run-1',
        runTrigger: 'exposure_verification',
      }),
    );
    expect(mocks.processMessage).toHaveBeenCalledWith(
      'executor-session',
      expect.stringContaining('submit_exposure_verification'),
      undefined,
      undefined,
      expect.objectContaining({ source: 'planner_kickoff' }),
    );
    expect(mocks.processMessage.mock.calls[0]?.[1]).toContain('do not call submit_plan');

    vi.clearAllTimers();
  });

  it('fails run creation and skips planner kickoff when run-start projection exhausts workspace storage', async () => {
    vi.useFakeTimers();
    const workspaceProjectionService = {
      projectRunWorkspace: vi.fn().mockRejectedValue(
        new Error('write failed: cat: write error: No space left on device'),
      ),
    };
    const transitionStatus = vi.fn().mockResolvedValue({
      ...makeRunDetail(),
      id: 'run-1',
      sessionId: 'executor-session',
      plannerSessionId: 'executor-session',
      status: 'failed',
    });
    const { service, mocks } = buildService({}, {
      workspaceProjectionService,
      runServiceOverrides: { transitionStatus },
    });

    await expect(service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess API auth',
      modelCategory: 'extra_high',
      trigger: 'manual',
      toolPolicy: { allow: ['submit_plan'] },
    })).rejects.toMatchObject({
      code: 'resource.quota_exceeded',
      httpStatus: 429,
      userMessage: expect.stringContaining('start the run again'),
    });

    expect(workspaceProjectionService.projectRunWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'run_start',
      runId: 'run-1',
      sessionId: 'executor-session',
    }));
    expect(transitionStatus).toHaveBeenCalledWith('org-1', 'run-1', 'failed');
    expect(mocks.setBlockedReason).toHaveBeenCalledWith(
      'executor-session',
      'error',
      expect.objectContaining({
        code: 'workspace_storage_pressure',
        reason: 'run_start_workspace_projection_failed',
        recoverable: false,
      }),
    );
    expect(mocks.cleanupRunWorkspaceAsync).toHaveBeenCalledWith('run-1', {
      reason: 'run_start_workspace_projection_failed',
      force: true,
      persist: false,
    });
    expect(mocks.processMessage).not.toHaveBeenCalled();
    expect(mocks.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      type: 'failed',
      note: expect.stringContaining('run_start_workspace_projection_failed'),
    }));

    vi.clearAllTimers();
  });

  it('does not inject compliance planner context into normal pentest planner context', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();
    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Close SOC 2 agent-provable gaps',
      modelCategory: 'extra_high',
      trigger: 'manual',
      toolPolicy: { allow: ['submit_plan'] },
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.promptProfile).toBe('planner');
    expect(createSessionArgs?.extraContext).not.toContain('=== COMPLIANCE ASSESSMENT MISSION ===');

    vi.clearAllTimers();
  });

  it('starts dedicated compliance planner runs with compliance skills and mission context', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Run SOC 2 readiness assessment and let the planner choose supported controls',
      modelCategory: 'extra_high',
      trigger: 'manual',
      toolPolicy: COMPLIANCE_PLANNER_TOOL_POLICY,
      workflowDiscipline: 'compliance',
      complianceFrameworkKey: 'soc2',
      plannerPromptProfile: 'compliance-planner',
      planningSkillSlugs: ['compliance-planning'],
      securityOpsFlags: {
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
      vars: {
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
    });

    expect(mocks.enforceScopeConcurrencyLimit).toHaveBeenCalledWith('org-1', 'scope-1', 'compliance');
    expect(mocks.createRunRecord).toHaveBeenCalledWith(expect.objectContaining({
      workflowDiscipline: 'compliance',
    }));
    expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith('org-1', 'scope-1', ['compliance-planning']);
    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.promptProfile).toBe('compliance-planner');
    expect(createSessionArgs?.toolPolicy?.allow).toEqual(expect.arrayContaining([
      'submit_plan',
      'query_compliance_readiness',
      'query_inventory',
    ]));
    expect(createSessionArgs?.toolPolicy?.allow).not.toContain('spawn_worker');
    expect(createSessionArgs?.extraContext).toContain('=== COMPLIANCE ASSESSMENT MISSION ===');
    expect(createSessionArgs?.extraContext).toContain('soc2-cc6.1-authz-v1');
    expect(createSessionArgs?.extraContext).toContain('soc2-cc7.2-attack-surface-monitoring-v1');
    expect(createSessionArgs?.extraContext).toContain('do not create a recon mission');
    expect(createSessionArgs?.extraContext).toContain('control_assessment mission assigned to compliance-access-control, compliance-technical-readiness, compliance-evidence-review, compliance-governance-review, or the needed combination, with no other skills');
    expect(createSessionArgs?.extraContext).toContain('=== OPERATOR VARS ===');
    expect(mocks.processMessage).toHaveBeenCalledWith(
      'executor-session',
      expect.stringContaining('assigned compliance-planning methodology'),
      undefined,
      undefined,
      expect.objectContaining({ source: 'planner_kickoff' }),
    );
    expect(mocks.processMessage.mock.calls[0]?.[1]).not.toContain('securityops-planning');

    vi.clearAllTimers();
  });

  it('uses the compliance framework key as planner context fallback when flags are absent', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Run PCI DSS readiness assessment',
      modelCategory: 'extra_high',
      trigger: 'manual',
      toolPolicy: COMPLIANCE_PLANNER_TOOL_POLICY,
      workflowDiscipline: 'compliance',
      complianceFrameworkKey: 'pci_dss',
      plannerPromptProfile: 'compliance-planner',
      planningSkillSlugs: ['compliance-planning'],
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.extraContext).toContain('"framework": "pci_dss"');
    expect(createSessionArgs?.flags.securityops).toEqual(expect.objectContaining({
      workflowDiscipline: 'compliance',
      complianceAssessment: { framework: 'pci_dss' },
    }));
    expect(mocks.createRunRecord).toHaveBeenCalledWith(expect.objectContaining({
      workflowDiscipline: 'compliance',
      complianceFrameworkKey: 'pci_dss',
    }));

    vi.clearAllTimers();
  });

  it('withholds planner repository and write tools when the scope has no connected repositories', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess API auth',
      trigger: 'manual',
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
    });

    const allow = mocks.createSession.mock.calls[0]?.[0]?.toolPolicy?.allow ?? [];
    expect(allow).toEqual(expect.arrayContaining([
      'submit_plan',
      'query_inventory',
      'query_findings',
      'query_notes',
      'file_read',
    ]));
    expect(allow).not.toContain('file_write');
    expect(allow).not.toContain('list_connected_repositories');
    expect(allow).not.toContain('search_connected_repository');
    expect(allow).not.toContain('read_connected_repository_file');

    vi.clearAllTimers();
  });

  it('keeps repository-wide review tools out of Pentest planning when repositories are connected', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({}, {
      scopeContextOverrides: {
        whiteboxEnabled: true,
        connectedRepoCount: 1,
        connectedRepositories: [
          { id: 'repo-1', fullName: 'org/app', defaultBranch: 'main' },
        ] as any,
      },
    });

    await service.startPlannerRun({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-1',
      goal: 'Assess API auth',
      trigger: 'manual',
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
    });

    const allow = mocks.createSession.mock.calls[0]?.[0]?.toolPolicy?.allow ?? [];
    expect(allow).not.toContain('list_connected_repositories');
    expect(allow).not.toContain('search_connected_repository');
    expect(allow).not.toContain('read_connected_repository_file');

    vi.clearAllTimers();
  });

  it('grounds executor sessions with the selected private-runner environment', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({
      executionTarget: 'scope_runner',
      runnerId: 'runner-1',
    });

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.extraContext).toContain('=== EXECUTION ENVIRONMENT ===');
    expect(createSessionArgs?.extraContext).toContain('private runner');
    expect(createSessionArgs?.extraContext).toContain('Stay within the verified targets and Rules of Engagement');

    vi.clearAllTimers();
  });

  it('starts approved runs with a phase-profile kickoff', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService();

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const kickoffPrompt = mocks.processMessage.mock.calls[0]?.[1];
    expect(kickoffPrompt).toContain('Start the recon phase');
    expect(kickoffPrompt).toContain('recon Markdown prompt profile');
    expect(kickoffPrompt).not.toContain('Work through each task in sequence.');
    const sessionFlags = mocks.createSession.mock.calls[0]?.[0]?.flags?.securityops;
    expect(sessionFlags).toEqual(expect.objectContaining({
      workflowDiscipline: 'pentest',
      activePhaseKey: 'recon',
    }));
    expect(sessionFlags).not.toHaveProperty('complianceAssessment');
    expect(sessionFlags).not.toHaveProperty('complianceReport');

    vi.clearAllTimers();
  });

  it('carries the selected compliance framework into control assessment executor flags', async () => {
    vi.useFakeTimers();
    const findNextReadyExecutionPhase = vi.fn().mockResolvedValue(makeRunPhase({
      id: 'phase-control',
      phaseKey: 'control_assessment',
      stepIds: ['task-control'],
      assignedSkillSlugs: ['compliance-technical-readiness'],
      phaseProfile: 'phase-control-assessment',
      toolProfile: 'phase-control-assessment',
      promptProfile: 'phase-control-assessment',
    }));
    const { service, mocks } = buildService(
      {
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'pci_dss',
        assignedSkillSlugs: ['compliance-planning'],
        plan: '# PCI DSS readiness\n\n1. Assess PCI DSS controls.',
        missionEnvelope: {
          missions: [
            {
              id: 'task-control',
              phase: 'control_assessment',
              question: 'Which PCI DSS controls can be assessed from available evidence?',
              why_ready_now: 'The planner selected PCI DSS readiness.',
              required_evidence: ['record_control_check or record_control_request'],
              expected_artifact: 'control checks and requests',
              stop_condition: 'PCI DSS control assessment complete.',
              assigned_skills: ['compliance-technical-readiness'],
            },
          ],
        },
      },
      {
        runServiceOverrides: {
          findNextReadyExecutionPhase,
        },
      },
    );

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const sessionFlags = mocks.createSession.mock.calls[0]?.[0]?.flags?.securityops;
    expect(sessionFlags).toEqual(expect.objectContaining({
      workflowDiscipline: 'compliance',
      activePhaseKey: 'control_assessment',
      complianceAssessment: { framework: 'pci_dss' },
    }));
    expect(sessionFlags).not.toHaveProperty('complianceReport');
    const executorContext = mocks.createSession.mock.calls[0]?.[0]?.extraContext;
    expect(executorContext).not.toContain('=== WORKSPACE PROJECTION STATE ===');
    expect(executorContext).not.toContain('The factual live model is recited in the system prompt.');

    vi.clearAllTimers();
  });

  it('writes scope credentials for phase executor sessions when the scope has access material', async () => {
    vi.useFakeTimers();
    const scopeAccessMaterialService = {
      listScopeContextMaterials: vi.fn().mockResolvedValue([
        {
          id: 'material-1',
          kind: 'login_credential',
          label: 'Admin login',
          username: 'admin@example.com',
          headerName: null,
          notes: null,
          appliesToHosts: ['app.example.com'],
        },
      ]),
      resolveSecretById: vi.fn().mockResolvedValue('super-secret'),
    };
    const { service, mocks } = buildService(
      {},
      {
        scopeContextOverrides: {
          accessMaterialCount: 1,
          accessMaterials: [
            {
              id: 'material-1',
              kind: 'login_credential',
              label: 'Admin login',
              username: 'admin@example.com',
              headerName: null,
              notes: null,
              appliesToHosts: ['app.example.com'],
            },
          ],
        },
        scopeAccessMaterialService,
      },
    );

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    expect(scopeAccessMaterialService.listScopeContextMaterials).toHaveBeenCalledWith('scope-1');
    expect(scopeAccessMaterialService.resolveSecretById).toHaveBeenCalledWith('org-1', 'scope-1', 'material-1');
    expect(mocks.processMessage.mock.calls[0]?.[1]).not.toContain('/workspace/.credentials');

    vi.clearAllTimers();
  });

  it('seeds phase plan steps from approved markdown when mission envelope metadata is absent', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({
      assignedSkillSlugs: ['broad-surface-scan'],
      plan: [
        '# Vulnerability Assessment for api.example.com',
        '',
        '1. Validate CVE-2025-1234 auth bypass on api.example.com',
        '2. Package evidence and remediation notes',
      ].join('\n'),
    });

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.executionMode).toBe('discovery');
    expect(createSessionArgs?.planSeed).toEqual([
      {
        id: 'task-1',
        title: 'Validate CVE-2025-1234 auth bypass on api.example.com',
        status: 'pending',
      },
      {
        id: 'task-2',
        title: 'Package evidence and remediation notes',
        status: 'pending',
      },
    ]);
    expect(
      mocks.processMessage.mock.calls[0]?.[1],
    ).toContain('Start the recon phase');

    vi.clearAllTimers();
  });

  it('seeds executor plan steps from internal mission envelope metadata', async () => {
    vi.useFakeTimers();
    const { service, mocks } = buildService({
      assignedSkillSlugs: ['broad-surface-scan', 'security-reporting'],
      plan: [
        '# Attack Surface Discovery for app.example.com',
        '',
        '## Tasks',
        '- Map the public surface.',
        '- Produce a closeout report.',
      ].join('\n'),
      missionEnvelope: {
        missions: [
          {
            id: 'task-1',
            question: 'What public surface is actually reachable?',
            why_ready_now: 'Inventory prechecks identified app.example.com.',
            required_evidence: ['reachable routes', 'status codes'],
            expected_artifact: 'Surface map',
            stop_condition: 'Primary routes are mapped or blocked.',
            assigned_skills: ['broad-surface-scan'],
          },
          {
            id: 'task-final',
            question: 'What closeout report should be delivered?',
            why_ready_now: 'Task evidence exists.',
            required_evidence: ['coverage notes', 'evidence refs'],
            expected_artifact: 'report_finalizer_preflight, prepare_report_context output, run.digest, authored summary.md/report.md, and final validation',
            stop_condition: 'report_finalizer_preflight, prepare_report_context, run.digest, authored summary.md/report.md, and finalize_run_artifacts complete.',
            assigned_skills: ['security-reporting'],
          },
        ],
      },
    });

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    const createSessionArgs = mocks.createSession.mock.calls[0]?.[0];
    expect(createSessionArgs?.extraContext).toContain('What public surface is actually reachable?');
    expect(createSessionArgs?.extraContext).not.toContain('assigned_skills');
    expect(createSessionArgs?.planSeed).toEqual([
      expect.objectContaining({
        id: 'task-1',
        title: 'What public surface is actually reachable?',
        notes: 'Inventory prechecks identified app.example.com.',
        mission: expect.objectContaining({
          assignedSkills: ['broad-surface-scan'],
        }),
      }),
    ]);

    vi.clearAllTimers();
  });

  it('starts ready reporting phases as fresh reporting-only sessions', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const reportingWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-reporting-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-1.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Validation completed and one finding was promoted.',
          artifacts: ['.artifacts/evidence/root.txt'],
          canonicalWrites: { findings: ['finding-1'], notes: ['note-1'], assets: [], services: [] },
          evidenceRefs: ['finding-1'],
        }),
      );

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'reporting-session',
          workspaceDir: reportingWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyReportingPhase = vi.fn().mockResolvedValue({
        id: 'phase-reporting',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-final'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-1',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'validation',
        status: 'handoff_submitted',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-1.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        sessionId: 'reporting-session',
        executorSessionId: 'reporting-session',
        status: 'running',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );
      const { service, mocks } = buildService(
        {
          assignedSkillSlugs: ['broad-surface-scan', 'security-reporting'],
          plan: [
            '# Validation and Closeout for app.example.com',
            '',
            '1. Validate finding.',
            '2. Produce closeout report.',
          ].join('\n'),
          missionEnvelope: {
            missions: [
              {
                id: 'task-1',
                phase: 'validation',
                question: 'Can the finding be reproduced?',
                why_ready_now: 'A candidate finding exists.',
                required_evidence: ['fresh reproduction'],
                expected_artifact: 'validation evidence',
                stop_condition: 'Finding validated or rejected.',
                assigned_skills: ['vulnerability-analysis'],
              },
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                why_ready_now: 'Validation is complete.',
                required_evidence: ['canonical findings', 'coverage notes'],
                expected_artifact: 'summary.md, report.md, run.digest, and final validation',
                stop_condition: 'report_finalizer_preflight, prepare_report_context, submit_phase_handoff, and finalize_run_artifacts complete.',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyReportingPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.sessionId).toBe('reporting-session');
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'executor',
          executionMode: 'evidence',
          toolPolicy: expect.objectContaining({
            allow: expect.arrayContaining([
              'report_finalizer_preflight',
              'prepare_report_context',
              'finalize_run_artifacts',
              'report_note',
              'submit_phase_handoff',
            ]),
          }),
          planSeed: [
            expect.objectContaining({
              id: 'task-final',
              mission: expect.objectContaining({ phase: 'reporting' }),
            }),
          ],
        }),
      );
      const createSessionArgs = createSession.mock.calls[0]?.[0];
      expect(createSessionArgs.promptProfile).toBe('phase-reporting');
      expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith(
        'org-1',
        'scope-1',
        ['security-reporting'],
      );
      expect(createSessionArgs.toolPolicy.allow).not.toContain('shell_run');
      expect(createSessionArgs.toolPolicy.allow).not.toContain('spawn_worker');
      expect(createSessionArgs.flags.securityops).toEqual(
        expect.objectContaining({
          activePhaseId: 'phase-reporting',
          activePhaseKey: 'reporting',
          phaseHandoffSubmitted: false,
          handoffInRef: '.artifacts/phase-handoffs/phase-1.json',
        }),
      );
      expect(createSessionArgs.extraContext).toContain('Validation completed and one finding was promoted.');
      expect(activatePhaseSession).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-reporting',
          sessionId: 'reporting-session',
          handoffInRef: '.artifacts/phase-handoffs/phase-1.json',
          previousPhaseId: 'phase-1',
          previousPhaseStatus: 'completed',
        }),
      );
      expect(mocks.processMessage.mock.calls[0]?.[1]).toContain('reporting Markdown prompt profile');
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(reportingWorkspace, { recursive: true, force: true });
    }
  });

  it('marks a created phase session unused when activation loses the phase race', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const reportingWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-unused-reporting-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-1.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Validation completed.',
          artifacts: [],
          canonicalWrites: { findings: [], notes: [], assets: [], services: [] },
          evidenceRefs: [],
        }),
      );

      const createdSession = {
        id: 'unused-reporting-session',
        workspaceDir: reportingWorkspace,
        flags: {},
      };
      const createSession = vi.fn().mockResolvedValue({
        session: createdSession,
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyReportingPhase = vi.fn().mockResolvedValue({
        id: 'phase-reporting',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-final'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-1',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'validation',
        status: 'handoff_submitted',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-1.json',
      });
      const activatePhaseSession = vi.fn().mockRejectedValue(new Error('Phase is no longer pending and cannot be activated'));
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );

      const { service, mocks } = buildService(
        {
          plan: '# Closeout',
          missionEnvelope: {
            missions: [
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                why_ready_now: 'Validation is complete.',
                required_evidence: ['canonical evidence'],
                expected_artifact: 'summary.md, report.md, run.digest, and final validation',
                stop_condition: 'report_finalizer_preflight, prepare_report_context, submit_phase_handoff, and finalize_run_artifacts complete.',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyReportingPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
          },
        },
      );

      await expect(
        service.startNextReportingPhase({
          orgId: 'org-1',
          runId: 'run-1',
          userId: 'user-1',
        }),
      ).rejects.toThrow(/Phase is no longer pending/);

      expect(mocks.setBlockedReason).toHaveBeenCalledWith(
        'unused-reporting-session',
        'phase_activation_failed',
        expect.objectContaining({
          runId: 'run-1',
          phaseId: 'phase-reporting',
          phaseKey: 'reporting',
        }),
      );
      expect(mocks.setCompleted).toHaveBeenCalledWith('unused-reporting-session', true);
      expect(mocks.sessionStoreSetAsync).toHaveBeenCalledWith(
        'unused-reporting-session',
        expect.objectContaining({
          completed: true,
          blockedReason: 'phase_activation_failed',
          flags: expect.objectContaining({
            blocked_reason: 'phase_activation_failed',
            phaseLifecycle: expect.objectContaining({ unused: true }),
          }),
        }),
        'securityops.phase_session_unused',
      );
      expect(mocks.processMessage).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(reportingWorkspace, { recursive: true, force: true });
    }
  });

  it('hard-stops a terminalized previous phase session before starting reporting', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const reportingWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-report-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-control.json'),
        JSON.stringify({
          status: 'blocked',
          summary: 'Control assessment blocked after recording available checks.',
          artifacts: [],
          canonicalWrites: { findings: [], notes: [], assets: [], services: [] },
          evidenceRefs: [],
        }),
      );

      const previousSession = {
        id: 'control-session',
        workspaceDir: sourceWorkspace,
        turn: 9,
        flags: {},
        stateMachine: {
          stopProcessing: vi.fn(),
        },
      };
      const reportingSession = {
        id: 'reporting-session',
        workspaceDir: reportingWorkspace,
        flags: {},
      };
      const createSession = vi.fn().mockResolvedValue({
        session: reportingSession,
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyReportingPhase = vi.fn().mockResolvedValue({
        id: 'phase-reporting',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-final'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-control',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'control_assessment',
        status: 'handoff_submitted',
        sessionId: 'control-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-control.json',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'control-session' ? previousSession : null,
      );
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail({ status: 'running' }),
        sessionId: 'reporting-session',
        executorSessionId: 'reporting-session',
      });
      const { service, mocks } = buildService(
        {
          status: 'running',
          workflowDiscipline: 'compliance',
          complianceFrameworkKey: 'pci_dss',
          plan: '# SOC 2 readiness\n\n1. Check controls.\n2. Report.',
          missionEnvelope: {
            missions: [
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What compliance report should be delivered?',
                why_ready_now: 'Control assessment is terminalized.',
                required_evidence: ['recorded control checks'],
                expected_artifact: 'summary.md and report.md',
                stop_condition: 'compliance reporting complete.',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyReportingPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toEqual(expect.objectContaining({
        sessionId: 'reporting-session',
        phaseId: 'phase-reporting',
      }));
      const reportingSessionArgs = createSession.mock.calls[0]?.[0];
      expect(reportingSessionArgs.promptProfile).toBe('compliance-reporting');
      expect(reportingSessionArgs.flags.securityops).toEqual(expect.objectContaining({
        workflowDiscipline: 'compliance',
        activePhaseKey: 'reporting',
        complianceAssessment: { framework: 'pci_dss' },
        complianceReport: {
          framework: 'pci_dss',
          source: 'assessment-run',
          sourceRunId: 'run-1',
        },
      }));
      expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith(
        'org-1',
        'scope-1',
        ['compliance-reporting'],
      );
      expect(mocks.setBlockedReason).toHaveBeenCalledWith(
        'control-session',
        'phase_terminalized',
        expect.objectContaining({
          reason: 'phase_terminalized_before_next_phase',
          runId: 'run-1',
          phaseId: 'phase-control',
          phaseKey: 'control_assessment',
          terminalStatus: 'blocked',
          nextPhaseKey: 'reporting',
        }),
      );
      expect(mocks.abortCurrentTurnAsync).toHaveBeenCalledWith(
        'control-session',
        'phase_terminalized_before_next_phase',
      );
      expect(previousSession.stateMachine.stopProcessing).toHaveBeenCalledWith(
        'phase_terminalized',
        9,
        'securityops.reporting_phase_start',
      );
      expect(mocks.sessionStoreSetAsync).toHaveBeenCalledWith(
        'control-session',
        expect.objectContaining({
          blockedReason: 'phase_terminalized',
          blockedMeta: expect.objectContaining({
            phaseId: 'phase-control',
            nextPhaseKey: 'reporting',
          }),
          flags: expect.objectContaining({
            blocked_reason: 'phase_terminalized',
            phaseLifecycle: expect.objectContaining({
              terminalizedBeforeNextPhase: true,
              phaseId: 'phase-control',
              nextPhaseKey: 'reporting',
            }),
          }),
        }),
        'securityops.phase_terminalized',
      );
      expect(mocks.sandboxDestroy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'control-session' }),
      );
      expect(activatePhaseSession).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-reporting',
          sessionId: 'reporting-session',
          previousPhaseId: 'phase-control',
          previousPhaseStatus: 'blocked',
        }),
      );
      expect(mocks.abortCurrentTurnAsync.mock.invocationCallOrder[0]).toBeLessThan(
        activatePhaseSession.mock.invocationCallOrder[0],
      );
      expect(mocks.sandboxDestroy.mock.invocationCallOrder[0]).toBeLessThan(
        activatePhaseSession.mock.invocationCallOrder[0],
      );
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(reportingWorkspace, { recursive: true, force: true });
    }
  });

  it('requests replan instead of reporting when handoff carries validation targets', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-enumeration.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Enumeration found parameterized routes that need validation.',
          canonicalWrites: { findings: [], notes: ['lead-1'], assets: [], services: [] },
          validationTargets: [
            {
              riskFamily: 'idor',
              method: 'GET',
              path: '/api/runs/{runId}',
              parameter: 'runId',
              hypothesis: 'runId may cross authorization boundaries.',
            },
          ],
        }),
      );

      const createSession = vi.fn();
      const findNextReadyReportingPhase = vi.fn().mockResolvedValue({
        id: 'phase-reporting',
        runId: 'run-1',
        ordinal: 3,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-final'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'completed',
        sessionId: 'enumeration-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-enumeration.json',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'enumeration-session'
          ? { id: 'enumeration-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );
      const requestPhaseReplan = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        status: 'running',
      });
      const { service, mocks } = buildService(
        {
          status: 'running',
          plannerSessionId: 'planner-session',
          plan: '# Enumeration and Closeout\n\n1. Enumerate API.\n2. Report.',
          missionEnvelope: {
            missions: [
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                why_ready_now: 'Enumeration completed.',
                required_evidence: ['canonical notes'],
                expected_artifact: 'summary.md and report.md',
                stop_condition: 'Report finalized.',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyReportingPhase,
            findLatestPhaseHandoffBefore,
            requestPhaseReplan,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(requestPhaseReplan).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration',
          handoffRef: '.artifacts/phase-handoffs/phase-enumeration.json',
          reason: expect.stringContaining('validation target'),
        }),
      );
      expect(mocks.processMessage).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
    }
  });

  it('does not reopen a phase replan every lifecycle poll while one is already pending', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-enumeration.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Enumeration already requested a replan.',
          canonicalWrites: { findings: [], notes: ['lead-1'], assets: [], services: [] },
          validationTargets: [{ riskFamily: 'idor', hypothesis: 'new lead' }],
        }),
      );

      const createSession = vi.fn();
      const requestPhaseReplan = vi.fn();
      const { service, mocks } = buildService(
        {
          status: 'running',
          plannerSessionId: 'planner-session',
          plan: '# Enumeration and Closeout\n\n1. Enumerate API.\n2. Report.',
          missionEnvelope: {
            missions: [{
              id: 'task-final',
              phase: 'reporting',
              question: 'What report should be delivered?',
              why_ready_now: 'Enumeration completed.',
              required_evidence: ['canonical notes'],
              expected_artifact: 'summary.md and report.md',
              stop_condition: 'Report finalized.',
              assigned_skills: ['security-reporting'],
            }],
          },
        },
        {
          createSession,
          sessionStoreGet: vi.fn((sessionId: string) =>
            sessionId === 'enumeration-session'
              ? { id: 'enumeration-session', workspaceDir: sourceWorkspace, flags: {} }
              : null,
          ),
          runServiceOverrides: {
            findNextReadyReportingPhase: vi.fn().mockResolvedValue({
              id: 'phase-reporting',
              runId: 'run-1',
              ordinal: 3,
              phaseKey: 'reporting',
              status: 'pending',
              sessionId: null,
              stepIds: ['task-final'],
              assignedSkillSlugs: ['security-reporting'],
              phaseProfile: 'phase-reporting',
              toolProfile: 'phase-reporting',
              promptProfile: 'phase-reporting',
            }),
            findLatestPhaseHandoffBefore: vi.fn().mockResolvedValue({
              id: 'phase-enumeration',
              runId: 'run-1',
              ordinal: 2,
              phaseKey: 'enumeration',
              status: 'completed',
              sessionId: 'enumeration-session',
              handoffOutRef: '.artifacts/phase-handoffs/phase-enumeration.json',
            }),
            hasOpenPhaseReplan: vi.fn().mockResolvedValue(true),
            requestPhaseReplan,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(requestPhaseReplan).not.toHaveBeenCalled();
      expect(mocks.recordPhaseHandoffReconciliation).not.toHaveBeenCalled();
      expect(mocks.processMessage).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
    }
  });

  it('does not open another phase replan when replan-state lookup fails', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-enumeration.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Enumeration produced plan-changing discovery.',
          canonicalWrites: { findings: [], notes: ['lead-1'], assets: [], services: [] },
          validationTargets: [{ riskFamily: 'idor', hypothesis: 'new lead' }],
        }),
      );

      const createSession = vi.fn();
      const requestPhaseReplan = vi.fn();
      const { service, mocks } = buildService(
        {
          status: 'running',
          plannerSessionId: 'planner-session',
          plan: '# Enumeration and Closeout\n\n1. Enumerate API.\n2. Report.',
          missionEnvelope: {
            missions: [{
              id: 'task-final',
              phase: 'reporting',
              question: 'What report should be delivered?',
              why_ready_now: 'Enumeration completed.',
              required_evidence: ['canonical notes'],
              expected_artifact: 'summary.md and report.md',
              stop_condition: 'Report finalized.',
              assigned_skills: ['security-reporting'],
            }],
          },
        },
        {
          createSession,
          sessionStoreGet: vi.fn((sessionId: string) =>
            sessionId === 'enumeration-session'
              ? { id: 'enumeration-session', workspaceDir: sourceWorkspace, flags: {} }
              : null,
          ),
          runServiceOverrides: {
            findNextReadyReportingPhase: vi.fn().mockResolvedValue({
              id: 'phase-reporting',
              runId: 'run-1',
              ordinal: 3,
              phaseKey: 'reporting',
              status: 'pending',
              sessionId: null,
              stepIds: ['task-final'],
              assignedSkillSlugs: ['security-reporting'],
              phaseProfile: 'phase-reporting',
              toolProfile: 'phase-reporting',
              promptProfile: 'phase-reporting',
            }),
            findLatestPhaseHandoffBefore: vi.fn().mockResolvedValue({
              id: 'phase-enumeration',
              runId: 'run-1',
              ordinal: 2,
              phaseKey: 'enumeration',
              status: 'completed',
              sessionId: 'enumeration-session',
              handoffOutRef: '.artifacts/phase-handoffs/phase-enumeration.json',
            }),
            hasOpenPhaseReplan: vi.fn().mockRejectedValue(new Error('replan state unavailable')),
            requestPhaseReplan,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(requestPhaseReplan).not.toHaveBeenCalled();
      expect(mocks.recordPhaseHandoffReconciliation).not.toHaveBeenCalled();
      expect(mocks.processMessage).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
    }
  });

  it('requests replan when enumeration resolves a prior resource-endpoint blocker with new parameterized routes', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-enumeration.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Enumeration recovered the OpenAPI catalogue and found 88 parameterized routes.',
          canonicalWrites: { findings: [], notes: ['catalogue-note'], assets: [], services: [] },
        }),
      );

      const createSession = vi.fn();
      const findNextReadyReportingPhase = vi.fn().mockResolvedValue({
        id: 'phase-reporting',
        runId: 'run-1',
        ordinal: 3,
        phaseKey: 'reporting',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-final'],
        assignedSkillSlugs: ['security-reporting'],
        phaseProfile: 'phase-reporting',
        toolProfile: 'phase-reporting',
        promptProfile: 'phase-reporting',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'completed',
        sessionId: 'enumeration-session',
        startedAt: new Date('2026-03-21T04:00:00.000Z'),
        handoffOutRef: '.artifacts/phase-handoffs/phase-enumeration.json',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'enumeration-session'
          ? { id: 'enumeration-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );
      const requestPhaseReplan = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        status: 'running',
      });
      const getPhaseDiscoveryReplanSignals = vi.fn().mockResolvedValue({
        newRoutes: 88,
        newParameterizedRoutes: 88,
        newHighPriorityLeads: 6,
        openHighPriorityLeads: 6,
        openHighPriorityLeadFamilies: ['idor', 'admin-boundary'],
        priorResourceBlocker: 'IDOR testing blocked - no resource endpoints were discovered.',
      });
      const { service, mocks } = buildService(
        {
          status: 'running',
          plannerSessionId: 'planner-session',
          plan: '# Enumeration and Closeout\n\n1. Enumerate API.\n2. Report.',
          missionEnvelope: {
            missions: [
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                why_ready_now: 'Enumeration completed.',
                required_evidence: ['canonical notes'],
                expected_artifact: 'summary.md and report.md',
                stop_condition: 'Report finalized.',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyReportingPhase,
            findLatestPhaseHandoffBefore,
            requestPhaseReplan,
            getPhaseDiscoveryReplanSignals,
          },
        },
      );

      const result = await service.startNextReportingPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(getPhaseDiscoveryReplanSignals).toHaveBeenCalledWith({
        orgId: 'org-1',
        scopeId: 'scope-1',
        since: new Date('2026-03-21T04:00:00.000Z'),
      });
      expect(requestPhaseReplan).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration',
          reason: expect.stringContaining('prior resource-endpoint blocker was resolved by 88 parameterized route'),
        }),
      );
      expect(mocks.recordPhaseHandoffReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration',
          replanned: true,
          reason: expect.stringContaining('newParameterizedRoutes=88'),
        }),
      );
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
    }
  });

  it('starts ready validation phases with the durable validation queue', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const validationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-validation-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-1.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Discovery found one candidate authorization bypass.',
          canonicalWrites: { findings: ['finding-1'], notes: [], assets: [], services: [] },
          evidenceRefs: ['finding-1'],
          recommendedNextPhase: 'validation',
          recommendedNextSkills: ['broken-auth'],
        }),
      );

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'validation-session',
          workspaceDir: validationWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyValidationPhase = vi.fn().mockResolvedValue({
        id: 'phase-validation',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'validation',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-validate'],
        assignedSkillSlugs: ['idor'],
        phaseProfile: 'phase-validation',
        toolProfile: 'phase-validation',
        promptProfile: 'phase-validation',
      });
      const listOpenValidationQueue = vi.fn().mockResolvedValue([
        {
          id: 'queue-1',
          runId: 'run-1',
          findingId: 'finding-1',
          rationale: 'Durable HTTP evidence suggests cross-tenant access.',
          status: 'queued',
        },
      ]);
      const listOpenValidationLeads = vi.fn().mockResolvedValue([
        {
          id: 'lead-1',
          riskFamily: 'idor',
          priority: 'high',
          target: 'https://api.example.com/api/runs/{runId}',
          method: 'GET',
          path: '/api/runs/{runId}',
          parameter: 'runId',
          hypothesis: 'runId may cross authorization boundaries.',
          status: 'open',
          firstSeenAt: '2026-03-21T04:00:00.000Z',
        },
      ]);
      const attachValidationQueueToPhase = vi.fn().mockResolvedValue([
        {
          id: 'queue-1',
          runId: 'run-1',
          findingId: 'finding-1',
          status: 'in_progress',
        },
      ]);
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-1',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-1.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        sessionId: 'validation-session',
        executorSessionId: 'validation-session',
        status: 'running',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );
      const { service, mocks } = buildService(
        {
          assignedSkillSlugs: ['broad-surface-scan', 'idor', 'security-reporting'],
          plan: [
            '# Authorization Validation for app.example.com',
            '',
            '1. Discover candidate issue.',
            '2. Validate candidate issue.',
            '3. Produce closeout report.',
          ].join('\n'),
          missionEnvelope: {
            missions: [
              {
                id: 'task-recon',
                phase: 'recon',
                question: 'What candidate auth issues exist?',
                why_ready_now: 'Scope is verified.',
                required_evidence: ['candidate evidence'],
                expected_artifact: 'candidate finding',
                stop_condition: 'Candidate recorded or blocked.',
                assigned_skills: ['broad-surface-scan'],
              },
              {
                id: 'task-validate',
                phase: 'validation',
                question: 'Can the candidate authorization bypass be reproduced?',
                why_ready_now: 'A queued finding has durable evidence.',
                required_evidence: ['fresh reproduction evidence', 'submit_validation_outcome'],
                expected_artifact: 'validation outcome',
                stop_condition: 'Queued finding is validated, rejected, or inconclusive.',
                assigned_skills: ['idor'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyValidationPhase,
            findLatestPhaseHandoffBefore,
            listOpenValidationQueue,
            listOpenValidationLeads,
            attachValidationQueueToPhase,
            activatePhaseSession,
          },
        },
      );

      const result = await service.startNextValidationPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.sessionId).toBe('validation-session');
      expect(result?.queuedFindingIds).toEqual(['finding-1']);
      const createSessionArgs = createSession.mock.calls[0]?.[0];
      expect(createSessionArgs).toEqual(
        expect.objectContaining({
          agentType: 'executor',
          executionMode: 'validation',
          toolPolicy: expect.objectContaining({
            allow: expect.arrayContaining([
              'query_findings',
              'report_finding',
              'submit_validation_outcome',
              'submit_phase_handoff',
              'spawn_worker',
              'wait_for_worker',
            ]),
          }),
        }),
      );
      expect(createSessionArgs.toolPolicy.allow).not.toContain('prepare_report_context');
      expect(createSessionArgs.flags.securityops).toEqual(
        expect.objectContaining({
          activePhaseId: 'phase-validation',
          activePhaseKey: 'validation',
          phaseHandoffSubmitted: false,
          phaseAssignedSkillSlugs: ['idor', 'broken-auth', 'validation'],
          validationQueueFindingIds: ['finding-1'],
          openValidationLeadIds: ['lead-1'],
          openValidationLeadCount: 1,
        }),
      );
      expect(mocks.updatePhaseAssignedSkills).toHaveBeenCalledWith('phase-validation', [
        'idor',
        'broken-auth',
      ]);
      expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith('org-1', 'scope-1', [
        'idor',
        'broken-auth',
        'validation',
      ]);
      expect(createSessionArgs.extraContext).toContain('findingId=finding-1');
      expect(createSessionArgs.extraContext).toContain('=== OPEN CANONICAL VALIDATION LEADS ===');
      expect(createSessionArgs.extraContext).toContain('leadId=lead-1 riskFamily=idor priority=high status=open');
      expect(createSessionArgs.extraContext).toContain('target: GET /api/runs/{runId} parameter=runId');
      expect(createSessionArgs.extraContext).toContain('Discovery found one candidate authorization bypass.');
      expect(attachValidationQueueToPhase).toHaveBeenCalledWith({
        runId: 'run-1',
        phaseId: 'phase-validation',
        sessionId: 'validation-session',
      });
      expect(mocks.processMessage.mock.calls[0]?.[1]).toContain('validation Markdown prompt profile');
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(validationWorkspace, { recursive: true, force: true });
    }
  });

  it('starts ready enumeration phases in the shared run workspace', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const enumerationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-enumeration-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-checkpoints'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-recon.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Recon mapped app.example.com and found API surface.',
          canonicalWrites: { assets: ['asset-1'], services: ['service-1'], notes: ['note-1'], findings: [] },
          artifacts: ['.artifacts/phases/recon/httpx.json'],
          evidenceRefs: ['note-1'],
        }),
      );
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-checkpoints', 'phase-enumeration.json'),
        JSON.stringify({
          summary: 'Enumeration checkpoint captured known API roots.',
          pendingObjectives: ['Enumerate authenticated API routes.'],
          canonicalWrites: { assets: [], services: [], notes: ['note-2'], findings: [] },
          evidenceRefs: ['note-2'],
        }),
      );
      await mkdir(join(sourceWorkspace, '.artifacts', 'phases', 'recon'), { recursive: true });
      await mkdir(join(sourceWorkspace, '.artifacts', 'scans', 'broad'), { recursive: true });
      await mkdir(join(sourceWorkspace, '.artifacts', 'shell-jobs', 'job-1'), { recursive: true });
      await mkdir(join(sourceWorkspace, '.artifacts', 'proxy'), { recursive: true });
      await writeFile(join(sourceWorkspace, '.artifacts', 'phases', 'recon', 'httpx.json'), '{"url":"https://app.example.com"}\n');
      await writeFile(join(sourceWorkspace, '.artifacts', 'scans', 'broad', 'httpx.jsonl'), '{"url":"https://app.example.com"}\n');
      await writeFile(join(sourceWorkspace, '.artifacts', 'shell-jobs', 'job-1', 'stdout.log'), 'old stdout\n');
      await writeFile(join(sourceWorkspace, '.artifacts', 'shell-jobs', 'job-1', 'runner.sh'), '#!/usr/bin/env bash\n');
      await writeFile(join(sourceWorkspace, '.artifacts', 'proxy', 'mitmproxy.log'), 'proxy started\n');

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'enumeration-session',
          workspaceDir: sourceWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyExecutionPhase = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-enumerate'],
        assignedSkillSlugs: ['api-enumeration', 'tooling-katana'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
        checkpointRef: '.artifacts/phase-checkpoints/phase-enumeration.json',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-recon',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-recon.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        sessionId: 'enumeration-session',
        executorSessionId: 'enumeration-session',
        status: 'running',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'planner-session'
          ? {
              id: 'planner-session',
              flags: {
                securityops: {
                  runId: 'run-1',
                  runHost: 'research_lab',
                  evaluationCaseId: 'code-review-command-injection-positive',
                },
              },
            }
          : sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : sessionId === 'enumeration-session'
            ? {
                id: 'enumeration-session',
                workspaceDir: sourceWorkspace,
                flags: {
                  securityops: {
                    executionTarget: 'scope_runner',
                    runnerId: 'runner-1',
                  },
                },
              }
            : null,
      );
      const { service, mocks } = buildService(
        {
          assignedSkillSlugs: ['broad-surface-scan', 'api-enumeration', 'tooling-katana', 'security-reporting'],
          missionEnvelope: {
            missions: [
              {
                id: 'task-recon',
                phase: 'recon',
                question: 'What public surface is reachable?',
                why_ready_now: 'Scope is verified.',
                required_evidence: ['subdomain inventory'],
                expected_artifact: 'recon inventory',
                stop_condition: 'Live app surface is mapped.',
                assigned_skills: ['broad-surface-scan'],
              },
              {
                id: 'task-enumerate',
                phase: 'enumeration',
                question: 'Which API routes expose interesting behavior?',
                why_ready_now: 'Recon identified app.example.com API roots.',
                required_evidence: ['route inventory', 'coverage note'],
                expected_artifact: 'API route inventory',
                stop_condition: 'Routes are inventoried or blocked.',
                assigned_skills: ['api-enumeration', 'tooling-katana'],
              },
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyExecutionPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
          },
        },
      );

      const result = await service.startNextExecutionPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.sessionId).toBe('enumeration-session');
      expect(result?.phaseKey).toBe('enumeration');
      expect(mocks.buildAssignedSkillsContext).toHaveBeenCalledWith(
        'org-1',
        'scope-1',
        ['api-enumeration', 'tooling-katana'],
      );
      const createSessionArgs = createSession.mock.calls[0]?.[0];
      expect(createSessionArgs).toEqual(
        expect.objectContaining({
          agentType: 'executor',
          executionMode: 'discovery',
          toolPolicy: expect.objectContaining({
            allow: expect.arrayContaining([
              'query_inventory',
              'shell_run',
              'ingest_scan_artifact',
              'submit_phase_handoff',
              'spawn_worker',
              'wait_for_worker',
            ]),
          }),
          planSeed: [
            expect.objectContaining({
              id: 'task-enumerate',
              mission: expect.objectContaining({ phase: 'enumeration' }),
            }),
          ],
        }),
      );
      expect(createSessionArgs.toolPolicy.allow).not.toContain('prepare_report_context');
      expect(createSessionArgs.extraContext).toContain('Recon mapped app.example.com');
      expect(createSessionArgs.extraContext).toContain('Enumeration checkpoint captured known API roots.');
      expect(createSessionArgs.extraContext).toContain('=== WORKSPACE PROJECTION STATE ===');
      expect(createSessionArgs.extraContext).toContain('The factual live model is recited in the system prompt.');
      expect(createSessionArgs.extraContext).not.toContain('/workspace/journal/model.md');
      expect(createSessionArgs.extraContext).not.toContain('Open findings: 1');
      expect(createSessionArgs.extraContext).not.toContain('What report should be delivered?');
      await expect(readFile(join(sourceWorkspace, '.artifacts', 'scans', 'broad', 'httpx.jsonl'), 'utf8')).resolves.toContain('app.example.com');
      await expect(readFile(join(sourceWorkspace, '.artifacts', 'shell-jobs', 'job-1', 'stdout.log'), 'utf8')).resolves.toContain('old stdout');
      await expect(readFile(join(sourceWorkspace, '.artifacts', 'proxy', 'mitmproxy.log'), 'utf8')).resolves.toContain('proxy started');
      expect(mocks.sandboxWriteFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'enumeration-session' }),
        '.artifacts/scans/broad/httpx.jsonl',
        expect.any(Buffer),
      );
      expect(mocks.sandboxWriteFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'enumeration-session' }),
        '.artifacts/shell-jobs/job-1/stdout.log',
        expect.any(Buffer),
      );
      expect(mocks.sandboxWriteFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'enumeration-session' }),
        '.artifacts/proxy/mitmproxy.log',
        expect.any(Buffer),
      );
      expect(createSessionArgs.flags.securityops).toEqual(
        expect.objectContaining({
          activePhaseId: 'phase-enumeration',
          activePhaseKey: 'enumeration',
          phaseHandoffSubmitted: false,
          handoffInRef: '.artifacts/phase-handoffs/phase-recon.json',
          checkpointRef: '.artifacts/phase-checkpoints/phase-enumeration.json',
          runHost: 'research_lab',
          evaluationCaseId: 'code-review-command-injection-positive',
        }),
      );
      expect(activatePhaseSession).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration',
          sessionId: 'enumeration-session',
          handoffInRef: '.artifacts/phase-handoffs/phase-recon.json',
          previousPhaseId: 'phase-recon',
          previousPhaseStatus: 'completed',
        }),
      );
      expect(mocks.processMessage.mock.calls[0]?.[1]).toContain('enumeration Markdown prompt profile');
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(enumerationWorkspace, { recursive: true, force: true });
    }
  });

  it('continues the approved phase graph when recommendedNextPhase is only advisory', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const enumerationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-enumeration-advisory-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-recon.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Recon found an app surface and suggested validation next.',
          canonicalWrites: { assets: ['asset-1'], services: [], notes: ['note-1'], findings: [] },
          evidenceRefs: ['note-1'],
          recommendedNextPhase: 'validation',
        }),
      );

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'enumeration-session',
          workspaceDir: enumerationWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyExecutionPhase = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-enumerate'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-recon',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-recon.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail({ status: 'running' }),
        sessionId: 'enumeration-session',
        executorSessionId: 'enumeration-session',
      });
      const requestPhaseReplan = vi.fn();
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : sessionId === 'enumeration-session'
            ? {
                id: 'enumeration-session',
                workspaceDir: enumerationWorkspace,
                flags: {
                  securityops: {
                    executionTarget: 'scope_runner',
                    runnerId: 'runner-1',
                  },
                },
              }
            : null,
      );
      const { service, mocks } = buildService(
        {
          status: 'running',
          sessionId: 'executor-session',
          executorSessionId: 'executor-session',
          plannerSessionId: 'planner-session',
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyExecutionPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
            requestPhaseReplan,
          },
        },
      );

      const result = await service.startNextExecutionPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.phaseKey).toBe('enumeration');
      expect(result?.sessionId).toBe('enumeration-session');
      expect(requestPhaseReplan).not.toHaveBeenCalled();
      expect(mocks.recordPhaseHandoffReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-recon',
          phaseKey: 'recon',
          replanned: false,
          reason: 'ignored advisory recommendedNextPhase "validation"; continuing approved next phase "enumeration"',
        }),
      );
      expect(activatePhaseSession).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration',
          sessionId: 'enumeration-session',
          previousPhaseStatus: 'completed',
        }),
      );
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(enumerationWorkspace, { recursive: true, force: true });
    }
  });

  it('routes phase handoff replan requests back to the planner without starting the next phase', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-recon.json'),
        JSON.stringify({
          status: 'blocked',
          summary: 'Recon found the API is only reachable with a missing customer VPN route.',
          unresolvedQuestions: ['Which internal host should replace the public API target?'],
          canonicalWrites: { assets: ['asset-1'], services: [], notes: ['note-1'], findings: [] },
          artifacts: ['.artifacts/phases/recon/httpx.json'],
          evidenceRefs: ['note-1'],
          replanRequest: {
            needed: true,
            reason: 'The approved enumeration target is unreachable from the selected execution origin.',
          },
        }),
      );

      const createSession = vi.fn();
      const findNextReadyExecutionPhase = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-enumerate'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-recon',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'handoff_submitted',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-recon.json',
      });
      const requestPhaseReplan = vi.fn().mockResolvedValue({
        ...makeRunDetail({ status: 'running' }),
        sessionId: 'planner-session',
        executorSessionId: null,
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : null,
      );
      const { service, mocks } = buildService(
        {
          status: 'running',
          sessionId: 'executor-session',
          executorSessionId: 'executor-session',
          plannerSessionId: 'planner-session',
          plan: '# API Enumeration for app.example.com\n\n1. Enumerate the public API.',
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyExecutionPhase,
            findLatestPhaseHandoffBefore,
            requestPhaseReplan,
          },
        },
      );

      const result = await service.startNextExecutionPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result).toBeNull();
      expect(createSession).not.toHaveBeenCalled();
      expect(requestPhaseReplan).toHaveBeenCalledWith({
        orgId: 'org-1',
        runId: 'run-1',
        phaseId: 'phase-recon',
        phaseStatus: 'blocked',
        handoffRef: '.artifacts/phase-handoffs/phase-recon.json',
        reason: 'The approved enumeration target is unreachable from the selected execution origin.',
      });
      expect(mocks.processMessage).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
    }
  });

  it('starts the revised next phase instead of replaying an already-applied handoff replan request', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const validationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-validation-after-replan-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-enumeration.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Enumeration completed but requested a planner revision for an environment blocker.',
          canonicalWrites: { assets: [], services: [], notes: ['blocker-1'], findings: [] },
          replanRequest: {
            needed: true,
            reason: 'HTTP proxy capture blocked HTTP validation tools.',
          },
        }),
      );

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'validation-session',
          workspaceDir: validationWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyValidationPhase = vi.fn().mockResolvedValue({
        id: 'phase-validation',
        runId: 'run-1',
        ordinal: 3,
        phaseKey: 'validation',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-validate'],
        assignedSkillSlugs: null,
        phaseProfile: 'phase-validation',
        toolProfile: 'phase-validation',
        promptProfile: 'phase-validation',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-enumeration',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'completed',
        sessionId: 'enumeration-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-enumeration.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail({ status: 'running' }),
        sessionId: 'validation-session',
        executorSessionId: 'validation-session',
      });
      const requestPhaseReplan = vi.fn();
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'enumeration-session'
          ? { id: 'enumeration-session', workspaceDir: sourceWorkspace, flags: {} }
          : sessionId === 'validation-session'
            ? {
                id: 'validation-session',
                workspaceDir: validationWorkspace,
                flags: {
                  securityops: {
                    executionTarget: 'scope_runner',
                    runnerId: 'runner-1',
                  },
                },
              }
            : null,
      );
      const { service, mocks } = buildService(
        {
          status: 'running',
          sessionId: 'planner-session',
          executorSessionId: null,
          plannerSessionId: 'planner-session',
          missionEnvelope: {
            missions: [
              {
                id: 'task-validate',
                phase: 'validation',
                question: 'Can the revised validation task proceed after the applied replan?',
                why_ready_now: 'The planner already revised the phase graph from the enumeration handoff.',
                required_evidence: ['fresh validation evidence'],
                expected_artifact: 'validation notes',
                stop_condition: 'Validation is attempted or cleanly blocked.',
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            findNextReadyValidationPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
            requestPhaseReplan,
            hasAppliedPhaseReplan: vi.fn().mockResolvedValue(true),
          },
        },
      );

      const result = await service.startNextValidationPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.phaseId).toBe('phase-validation');
      expect(result?.sessionId).toBe('validation-session');
      expect(requestPhaseReplan).not.toHaveBeenCalled();
      expect(mocks.recordPhaseHandoffReconciliation).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(validationWorkspace, { recursive: true, force: true });
    }
  });

  it('approves replanned runs by starting the next fresh phase session', async () => {
    vi.useFakeTimers();
    const sourceWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-source-'));
    const enumerationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-replan-enumeration-'));
    try {
      await mkdir(join(sourceWorkspace, '.artifacts', 'phase-handoffs'), { recursive: true });
      await writeFile(
        join(sourceWorkspace, '.artifacts', 'phase-handoffs', 'phase-recon.json'),
        JSON.stringify({
          status: 'completed',
          summary: 'Recon completed and planner submitted a revised remaining graph.',
          canonicalWrites: { assets: ['asset-1'], services: [], notes: ['note-1'], findings: [] },
          artifacts: ['.artifacts/phases/recon/httpx.json'],
          evidenceRefs: ['note-1'],
        }),
      );

      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'enumeration-session',
          workspaceDir: enumerationWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const findNextReadyExecutionPhase = vi.fn().mockResolvedValue({
        id: 'phase-enumeration-new',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'enumeration',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-enumerate-new'],
        assignedSkillSlugs: ['api-enumeration'],
        phaseProfile: 'phase-enumeration',
        toolProfile: 'phase-enumeration',
        promptProfile: 'phase-enumeration',
      });
      const findLatestPhaseHandoffBefore = vi.fn().mockResolvedValue({
        id: 'phase-recon',
        runId: 'run-1',
        ordinal: 1,
        phaseKey: 'recon',
        status: 'completed',
        sessionId: 'executor-session',
        handoffOutRef: '.artifacts/phase-handoffs/phase-recon.json',
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        sessionId: 'enumeration-session',
        executorSessionId: 'enumeration-session',
        status: 'running',
      });
      const sessionStoreGet = vi.fn((sessionId: string) =>
        sessionId === 'executor-session'
          ? { id: 'executor-session', workspaceDir: sourceWorkspace, flags: {} }
          : sessionId === 'enumeration-session'
            ? {
                id: 'enumeration-session',
                workspaceDir: enumerationWorkspace,
                flags: {
                  securityops: {
                    executionTarget: 'scope_runner',
                    runnerId: 'runner-1',
                  },
                },
              }
          : null,
      );
      const { service, mocks } = buildService(
        {
          status: 'awaiting_approval',
          sessionId: 'planner-session',
          executorSessionId: null,
          plannerSessionId: 'planner-session',
          assignedSkillSlugs: ['api-enumeration', 'security-reporting'],
          plan: '# Revised API Enumeration for app.example.com\n\n1. Enumerate the reachable API.',
          missionEnvelope: {
            missions: [
              {
                id: 'task-enumerate-new',
                phase: 'enumeration',
                question: 'Which reachable API routes expose interesting behavior?',
                why_ready_now: 'Recon identified the reachable API host.',
                required_evidence: ['route inventory'],
                expected_artifact: 'API route inventory',
                stop_condition: 'Routes are inventoried or blocked.',
                assigned_skills: ['api-enumeration'],
              },
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What report should be delivered?',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          sessionStoreGet,
          runServiceOverrides: {
            hasPhaseSessionHistory: vi.fn().mockResolvedValue(true),
            findNextReadyExecutionPhase,
            findLatestPhaseHandoffBefore,
            activatePhaseSession,
          },
        },
      );

      const result = await service.approveRun({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result.sessionId).toBe('enumeration-session');
      expect(mocks.buildPriorRunContext).not.toHaveBeenCalled();
      const createSessionArgs = createSession.mock.calls[0]?.[0];
      expect(createSessionArgs?.agentType).toBe('executor');
      expect(createSessionArgs?.extraContext).toContain('=== ACTIVE RUN PHASE ===');
      expect(createSessionArgs?.extraContext).toContain('Recon completed and planner submitted a revised remaining graph.');
      expect(activatePhaseSession).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: 'phase-enumeration-new',
          sessionId: 'enumeration-session',
          handoffInRef: '.artifacts/phase-handoffs/phase-recon.json',
        }),
      );
    } finally {
      vi.clearAllTimers();
      await rm(sourceWorkspace, { recursive: true, force: true });
      await rm(enumerationWorkspace, { recursive: true, force: true });
    }
  });

  it('starts ready pending phases for running runs after startup or reconciliation', async () => {
    vi.useFakeTimers();
    const listRunningRunsReadyForPhaseStart = vi.fn().mockResolvedValue([
      makeRunDetail({
        status: 'running',
        organizationId: 'org-1',
        userId: 'user-1',
      }),
    ]);
    const { service, mocks } = buildService(
      { status: 'running' },
      {
        runServiceOverrides: {
          listRunningRunsReadyForPhaseStart,
        },
      },
    );

    const result = await service.startReadyPhaseRuns();

    expect(result).toEqual({
      attempted: 1,
      started: 1,
      skipped: 0,
      failed: 0,
      inFlight: false,
    });
    expect(listRunningRunsReadyForPhaseStart).toHaveBeenCalledWith(25);
    expect(mocks.findNextReadyExecutionPhase).toHaveBeenCalledWith('run-1');
    expect(mocks.activatePhaseSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        phaseId: 'phase-recon',
        sessionId: 'executor-session',
      }),
    );
    expect(mocks.processMessage).toHaveBeenCalledWith(
      'executor-session',
      expect.stringContaining('Start the recon phase'),
      undefined,
      undefined,
      expect.objectContaining({ source: 'executor_kickoff' }),
    );

    vi.clearAllTimers();
  });

  it('repairs an active phase whose process crashed before its first durable input', async () => {
    const executorSession = {
      id: 'executor-repair',
      createdAt: 1_725_000_000_000,
      completed: false,
      messages: [],
      flags: { securityops: {} },
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const repairRun = makeRunDetail({
      status: 'running',
      workflowDiscipline: 'pentest',
      trigger: 'manual',
    });
    const { service, mocks } = buildService(
      { status: 'running' },
      {
        sessionStoreGet: vi.fn((sessionId: string) =>
          sessionId === executorSession.id ? executorSession : null),
        sessionStoreGetOrHydrate: vi.fn(async (sessionId: string) =>
          sessionId === executorSession.id ? executorSession : null),
        sessionStoreGetJournalProjection: vi.fn().mockResolvedValue({ messages: [] }),
        sessionStoreRecordInternalContinuationInputAsync: recordInternalContinuationInputAsync,
        runServiceOverrides: {
          listRunningRunsForKickoffRepair: vi.fn().mockResolvedValue([repairRun]),
          listRunPhases: vi.fn().mockResolvedValue([
            makeRunPhase({
              status: 'active',
              sessionId: executorSession.id,
            }),
          ]),
          listRunningRunsReadyForPhaseStart: vi.fn().mockResolvedValue([]),
        },
      },
    );

    const result = await service.startReadyPhaseRuns();

    expect(result).toEqual({
      attempted: 0,
      started: 0,
      skipped: 0,
      failed: 0,
      inFlight: false,
    });
    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      executorSession.id,
      expect.objectContaining({
        id: `run-kickoff:${repairRun.id}:${executorSession.id}`,
        content: expect.stringContaining('Start the recon phase'),
        timestamp: executorSession.createdAt,
        metadata: {
          visibility: 'internal',
          source: 'executor_kickoff',
        },
      }),
    );
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('repairs a planner kickoff but never duplicates a journaled first input', async () => {
    const plannerSession = {
      id: 'planner-repair',
      createdAt: 1_725_000_100_000,
      completed: false,
      messages: [],
      flags: { securityops: {} },
    };
    const recordInternalContinuationInputAsync = vi.fn().mockResolvedValue(true);
    const repairRun = makeRunDetail({
      status: 'running',
      plannerSessionId: plannerSession.id,
      workflowDiscipline: 'code_review',
      trigger: 'manual',
    });
    const journalProjection = vi.fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [{ id: 'existing', role: 'user', content: 'already durable', timestamp: 1 }],
      });
    const { service } = buildService(
      { status: 'running' },
      {
        sessionStoreGet: vi.fn(() => plannerSession),
        sessionStoreGetOrHydrate: vi.fn(async () => plannerSession),
        sessionStoreGetJournalProjection: journalProjection,
        sessionStoreRecordInternalContinuationInputAsync: recordInternalContinuationInputAsync,
        runServiceOverrides: {
          listRunningRunsForKickoffRepair: vi.fn().mockResolvedValue([repairRun]),
          listRunPhases: vi.fn().mockResolvedValue([]),
          listRunningRunsReadyForPhaseStart: vi.fn().mockResolvedValue([]),
        },
      },
    );

    await service.startReadyPhaseRuns();
    await service.startReadyPhaseRuns();

    expect(recordInternalContinuationInputAsync).toHaveBeenCalledTimes(1);
    expect(recordInternalContinuationInputAsync).toHaveBeenCalledWith(
      plannerSession.id,
      expect.objectContaining({
        content: expect.stringContaining('Code Review planner'),
        metadata: {
          visibility: 'internal',
          source: 'planner_kickoff',
        },
      }),
    );
  });

  it('starts ready validation phases with planner missions even when no findings were queued', async () => {
    vi.useFakeTimers();
    const validationWorkspace = await mkdtemp(join(tmpdir(), 'null-ai-validation-empty-queue-'));
    try {
      const findNextReadyValidationPhase = vi.fn().mockResolvedValue({
        id: 'phase-validation-empty-queue',
        runId: 'run-1',
        ordinal: 2,
        phaseKey: 'validation',
        status: 'pending',
        sessionId: null,
        stepIds: ['task-validate'],
        assignedSkillSlugs: ['idor'],
        phaseProfile: 'phase-validation',
        toolProfile: 'phase-validation',
        promptProfile: 'phase-validation',
      });
      const listOpenValidationQueue = vi.fn().mockResolvedValue([]);
      const createSession = vi.fn().mockResolvedValue({
        session: {
          id: 'validation-session-empty-queue',
          workspaceDir: validationWorkspace,
        },
        model: {
          id: 'resolved-model-id',
          selectionCategory: 'medium',
          modelName: 'resolved-model',
        },
      });
      const activatePhaseSession = vi.fn().mockResolvedValue({
        ...makeRunDetail(),
        sessionId: 'validation-session-empty-queue',
        executorSessionId: 'validation-session-empty-queue',
        status: 'running',
      });

      const { service, mocks } = buildService(
        {
          assignedSkillSlugs: ['idor', 'security-reporting'],
          plan: '# Validation Plan\n\n1. Test direct object authorization.\n2. Report results.',
          missionEnvelope: {
            missions: [
              {
                id: 'task-validate',
                phase: 'validation',
                question: 'Can the direct object authorization hypothesis be tested on this scope?',
                why_ready_now: 'Planner selected validation from existing inventory and notes.',
                required_evidence: ['fresh HTTP evidence or blocker note'],
                expected_artifact: 'validation outcome and evidence notes',
                stop_condition: 'Hypothesis is validated, rejected, or blocked.',
                assigned_skills: ['idor'],
              },
              {
                id: 'task-final',
                phase: 'reporting',
                question: 'What final report should be delivered?',
                assigned_skills: ['security-reporting'],
              },
            ],
          },
        },
        {
          createSession,
          runServiceOverrides: {
            findNextReadyValidationPhase,
            listOpenValidationQueue,
            activatePhaseSession,
          },
        },
      );

      const result = await service.startNextValidationPhase({
        orgId: 'org-1',
        runId: 'run-1',
        userId: 'user-1',
      });

      expect(result?.sessionId).toBe('validation-session-empty-queue');
      expect(result?.queuedFindingIds).toEqual([]);
      expect(mocks.markPhaseCompleted).not.toHaveBeenCalled();
      const createSessionArgs = createSession.mock.calls[0]?.[0];
      expect(createSessionArgs?.planSeed).toEqual([
        expect.objectContaining({
          id: 'task-validate',
          mission: expect.objectContaining({ phase: 'validation' }),
        }),
      ]);
      expect(createSessionArgs?.flags.securityops).toEqual(
        expect.objectContaining({
          activePhaseId: 'phase-validation-empty-queue',
          activePhaseKey: 'validation',
          validationQueueFindingIds: [],
        }),
      );
      expect(createSessionArgs?.extraContext).toContain('No queued findings are currently open.');
      expect(createSessionArgs?.extraContext).toContain('Can the direct object authorization hypothesis be tested');
      expect(createSessionArgs?.extraContext).not.toContain('What final report should be delivered?');
      expect(mocks.attachValidationQueueToPhase).toHaveBeenCalledWith({
        runId: 'run-1',
        phaseId: 'phase-validation-empty-queue',
        sessionId: 'validation-session-empty-queue',
      });
      expect(mocks.processMessage.mock.calls[0]?.[1]).toContain('validation mission or queued-finding');
    } finally {
      vi.clearAllTimers();
      await rm(validationWorkspace, { recursive: true, force: true });
    }
  });

  it('auto-completes a ready validation phase only when it has no queued findings or mission work', async () => {
    vi.useFakeTimers();

    const findNextReadyValidationPhase = vi.fn().mockResolvedValue({
      id: 'phase-validation-empty',
      runId: 'run-1',
      ordinal: 2,
      phaseKey: 'validation',
      status: 'pending',
      sessionId: null,
      stepIds: [],
      assignedSkillSlugs: ['idor'],
      phaseProfile: 'phase-validation',
      toolProfile: 'phase-validation',
      promptProfile: 'phase-validation',
    });
    const listOpenValidationQueue = vi.fn().mockResolvedValue([]);
    const createSession = vi.fn();

    const { service, mocks } = buildService(
      {
        plan: '',
        missionEnvelope: { missions: [] },
      },
      {
        createSession,
        runServiceOverrides: {
          findNextReadyValidationPhase,
          listOpenValidationQueue,
        },
      },
    );

    const result = await service.startNextValidationPhase({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
    });

    expect(result).toBeNull();
    expect(mocks.markPhaseCompleted).toHaveBeenCalledWith('phase-validation-empty');
    expect(createSession).not.toHaveBeenCalled();

    vi.clearAllTimers();
  });

});

describe('StartRunService plan approval observability (H-2026-05-28-010)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('records an attributable plan_approved event for explicit user approval', async () => {
    const { service, mocks } = buildService();

    await service.approveRun({ orgId: 'org-1', runId: 'run-1', userId: 'user-1', approvalSource: 'user' });

    expect(mocks.recordRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', type: 'plan_approved' }),
    );
    const note = JSON.parse(mocks.recordRunEvent.mock.calls[0][0].note);
    expect(note).toMatchObject({ source: 'user', actor: 'user-1' });
  });

  it('records source=auto with the auto-approval reason for unattended runs', async () => {
    const { service, mocks } = buildService();

    await service.approveRun({
      orgId: 'org-1',
      runId: 'run-1',
      userId: 'user-1',
      approvalSource: 'auto',
      approvalReason: 'auto_approve_on_planning',
    });

    const note = JSON.parse(mocks.recordRunEvent.mock.calls[0][0].note);
    expect(note).toMatchObject({ source: 'auto', reason: 'auto_approve_on_planning' });
  });

  it('defaults source to user when the caller does not specify one', async () => {
    const { service, mocks } = buildService();

    await service.approveRun({ orgId: 'org-1', runId: 'run-1', userId: 'user-1' });

    const note = JSON.parse(mocks.recordRunEvent.mock.calls[0][0].note);
    expect(note.source).toBe('user');
  });
});

/**
 * The gate that separates control from permission.
 *
 * Target verification proves the customer controls a DNS record; it says
 * nothing about whether anyone permits the testing. These two facts are checked
 * separately because they diverge exactly where a claim would arise.
 */
