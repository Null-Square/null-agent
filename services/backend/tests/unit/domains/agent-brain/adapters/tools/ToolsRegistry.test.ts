import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import { ToolsRegistryAdapter } from '@/domains/agent-brain/adapters/ToolsRegistryAdapter';
import { TurnToolExecutor } from '@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { ApprovalDeniedError } from '@/domains/agent-brain/application/services/SimpleApprovalHelper';
import { ToolLifecycleHookRegistry } from '@/domains/agent-brain/application/tools';
import { StreamBroker as ToolCallStreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { registerHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';
import { InMemoryUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';

// Use vi.hoisted() for mocks that need to be available in vi.mock factories
const mocks = vi.hoisted(() => ({
  executeRuntimeTool: vi.fn(),
  recordStart: vi.fn(async () => ({ startedAt: Date.now(), id: 'm1' })),
  recordFinish: vi.fn(),
  recordFailure: vi.fn(),
  recordForbidden: vi.fn(),
  recordAbort: vi.fn(),
  transitionPlanStep: vi.fn(),
  resetProvenanceBuffer: vi.fn(),
  clearProvenanceBuffer: vi.fn(),
  finalizePlanProvenance: vi.fn(),
  handleToolFailure: vi.fn(),
  onUpdateCallback: null as ((modules: any[]) => void) | null,
  modulesRef: { list: [] as any[] },
  requestApproval: vi.fn(async (session: any, _sessionId: string, toolName: string, args: Record<string, unknown>, context?: { toolCallId?: string; modelRequestId?: string; reason?: string }) => {
    if (session) {
      session.pendingApproval = {
        actionId: context?.toolCallId ?? 'approval-1',
        toolCallId: context?.toolCallId ?? 'approval-1',
        ...(context?.modelRequestId ? { modelRequestId: context.modelRequestId } : {}),
        tool: toolName,
        args,
        requestedAt: Date.now(),
        reason: context?.reason,
      };
    }
    return null;
  }),
  resolveDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: true }),
}));



vi.mock('@/domains/agent-brain/adapters/tools/ToolTelemetry', () => ({
  ToolTelemetry: class MockToolTelemetry {
    recordStart = mocks.recordStart;
    recordFinish = mocks.recordFinish;
    recordFailure = mocks.recordFailure;
    recordForbidden = mocks.recordForbidden;
    recordAbort = mocks.recordAbort;
  },
}));

vi.mock('@/domains/agent-brain/application/tools/runtime/PlanRuntime', () => ({
  PlanRuntime: class MockPlanRuntime {
    transitionPlanStep = mocks.transitionPlanStep;
    resetProvenanceBuffer = mocks.resetProvenanceBuffer;
    clearProvenanceBuffer = mocks.clearProvenanceBuffer;
    finalizePlanProvenance = mocks.finalizePlanProvenance;
    handleToolFailure = mocks.handleToolFailure;
  },
}));

vi.mock('@/domains/agent-brain/application/services/SimpleApprovalHelper', () => ({
  SimpleApprovalHelper: class MockHelper {
    requestApproval = mocks.requestApproval;
    resolveDecision = mocks.resolveDecision;
    shouldAwaitApproval = vi.fn().mockReturnValue(false);
  },
  ApprovalDeniedError: class ApprovalDeniedError extends Error {},
}));

vi.mock('@/domains/agent-brain/infrastructure/manifests/ToolManifestRegistry', () => ({
  ToolManifestRegistry: class MockToolManifestRegistry {
    constructor(opts: { onUpdate?: (modules: any[]) => void }) {
      mocks.onUpdateCallback = opts.onUpdate || null;
    }
    init = vi.fn(async () => {
      mocks.onUpdateCallback?.(mocks.modulesRef.list);
    });
  },
}));

describe('ToolsRegistry', () => {
  const toolsDir = 'tests/fixtures/tools';
  const createToolRun = (toolName: string) =>
    vi.fn((args: Record<string, unknown>, ctx: { sessionId: string; abortSignal?: AbortSignal; budget?: unknown }) =>
      mocks.executeRuntimeTool({
        toolName,
        args,
        sessionId: ctx.sessionId,
        signal: ctx.abortSignal,
        budget: ctx.budget,
      }),
    );
  const makeSessionStore = () => {
    const session = {
      id: 's1',
      userId: 'u1',
      workspaceDir: '/tmp/s1',
      plan: [],
      messages: [],
      flags: {},
      toolPolicy: { allow: ['*'] },
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 0,
    };
    return {
      get: vi.fn(() => session),
      setAsync: vi.fn(),
      mergeFlagNamespaceAsync: vi.fn(async (_sessionId: string, namespace: string, values: Record<string, unknown>) => {
        const flags = (session.flags ?? {}) as Record<string, unknown>;
        const currentNamespace = (flags[namespace] as Record<string, unknown> | undefined) ?? {};
        const nextNamespace = { ...currentNamespace };
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === 'undefined') {
            delete nextNamespace[key];
          } else {
            nextNamespace[key] = value;
          }
        }
        if (Object.keys(nextNamespace).length === 0) {
          delete flags[namespace];
        } else {
          flags[namespace] = nextNamespace;
        }
        session.flags = flags;
        return true;
      }),
      heartbeat: vi.fn(),
      updatePlanStepAsync: vi.fn(),
      updateCurrentPlanStepIdAsync: vi.fn(),
    } as any;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'echo',
          summary: 'Echo input',
          argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        meta: { name: 'echo' },
        run: createToolRun('echo'),
      },
    ];
    mocks.executeRuntimeTool.mockResolvedValue({ ok: true, data: { echoed: true } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeToolCallStream = () => {
    const stream = new ToolCallStreamBroker(vi.fn());
    return {
      stream,
      toolStarted: vi.spyOn(stream, 'toolStarted'),
      toolOutput: vi.spyOn(stream, 'toolOutput'),
      toolResult: vi.spyOn(stream, 'toolResult'),
    };
  };

  it('executes a tool and records telemetry', async () => {
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1');

    expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'echo', args: { text: 'hi' } }),
    );
    expect(mocks.recordStart).toHaveBeenCalled();
    expect(mocks.recordFinish).toHaveBeenCalled();
    expect(result).toEqual({ echoed: true });
  });

  it('selects the registered Research Lab tool owner instead of the organization ledger', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.get().flags = {
      securityops: { runHost: 'research_lab', runId: 'registered-host-owner' },
    };
    const capabilities = createResearchLabRuntimeHostCapabilities();
    const hostedLifecycle = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue({
        claimed: true,
        record: {
          id: 'hosted-execution',
          sessionId: 's1',
          turnId: 'turn-1',
          toolCallId: 'tc-hosted',
          toolName: 'echo',
          status: 'claimed',
          claimedAt: new Date(),
        },
      }),
      create: vi.fn(),
      markStarted: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      block: vi.fn().mockResolvedValue(undefined),
      markOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
      findBySession: vi.fn(),
      findByTurn: vi.fn(),
    };
    const unregister = registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'registered-host-owner',
      runtimeHostCapabilities: capabilities,
      toolExecutionLifecycle: hostedLifecycle,
      modelRequestLifecycle: {
        append: vi.fn(),
        findByRequestId: vi.fn(),
        findBySession: vi.fn(),
      },
      providerAttemptLifecycle: new InMemoryUsageStore(),
      historyTransformationLifecycle: {
        prepare: vi.fn(),
        persistReplacement: vi.fn(),
        activate: vi.fn(),
        findById: vi.fn(),
        findActiveBySession: vi.fn(),
        findBySession: vi.fn(),
      },
    } as any);
    const organizationLedger = {
      findByToolCallId: vi.fn(),
      create: vi.fn(),
      claim: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    try {
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        sessionStore,
        {} as any,
        {} as any,
        undefined,
        {
          toolsDir,
          toolExecutionDb: organizationLedger as any,
          runtimeHostCapabilities: capabilities,
        },
      );
      await registry.whenReady();

      await expect(registry.execute(
        'echo',
        { text: 'hosted' },
        's1',
        { toolCallId: 'tc-hosted' },
      )).resolves.toEqual({ echoed: true });
      expect(organizationLedger.findByToolCallId).not.toHaveBeenCalled();
      expect(organizationLedger.claim).not.toHaveBeenCalled();
      expect(hostedLifecycle.claim).toHaveBeenCalledTimes(1);
      expect(hostedLifecycle.markStarted).toHaveBeenCalledTimes(1);
      expect(hostedLifecycle.complete).toHaveBeenCalledTimes(1);
      expect(mocks.executeRuntimeTool).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('returns a canonical success receipt before adapting the model-facing payload', async () => {
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const execution = await registry.executeWithReceipt('echo', { text: 'hi' }, {
      sessionId: 's1',
      toolCallId: 'tc-success',
    });

    expect(execution).toEqual({
      result: { echoed: true },
      receipt: expect.objectContaining({
        schema: 'tool-execution-receipt/v1',
        toolName: 'echo',
        toolCallId: 'tc-success',
        outcome: 'succeeded',
      }),
    });
    expect(execution.receipt.pipeline).toEqual({
      schema: 'tool-execution-pipeline/v1',
      completedStages: [
        'resolve', 'validate', 'describe', 'decide', 'claim', 'pre_hooks', 'start',
        'dispatch', 'normalize', 'settle', 'post_hooks', 'project', 'observe',
      ],
    });
  });

  it('preserves a canonical failed outcome after adapting a failed runtime result', async () => {
    mocks.executeRuntimeTool.mockResolvedValueOnce({
      ok: false,
      message: 'inventory unavailable',
      data: { totalCount: 0 },
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const execution = await registry.executeWithReceipt('echo', {}, {
      sessionId: 's1',
      toolCallId: 'tc-failed',
    });

    expect(execution.result).toEqual({
      totalCount: 0,
      success: false,
      error: 'inventory unavailable',
    });
    expect(execution.receipt.outcome).toBe('failed');
  });

  it('carries the runtime receipt through the production adapter and executor message boundary', async () => {
    const sessionStore = makeSessionStore();
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();
    const executor = new TurnToolExecutor({
      sessionStore,
      toolsRegistry: new ToolsRegistryAdapter(registry as any),
    });

    const execution = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [{
        id: 'tc-assembled',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":"hi"}' },
      }] as any,
      stream: {
        raw: vi.fn(),
        done: vi.fn(),
        message: vi.fn(),
        toolStarted: vi.fn(),
        toolOutput: vi.fn(),
        toolResult: vi.fn(),
      } as any,
      turnNumber: 1,
    });

    expect(execution.collectedToolResults[0]).toEqual(expect.objectContaining({
      role: 'tool',
      toolCallId: 'tc-assembled',
      metadata: {
        toolExecution: expect.objectContaining({
          schema: 'tool-execution-receipt/v1',
          toolName: 'echo',
          toolCallId: 'tc-assembled',
          outcome: 'succeeded',
        }),
      },
    }));
    expect(JSON.parse(execution.collectedToolResults[0]!.content)).toEqual({ echoed: true });
  });

  it('atomically rejects a duplicate enumeration target-action reservation', async () => {
    const previousFlag = process.env.SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED;
    process.env.SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED = 'true';
    try {
      const mission = {
        schemaVersion: 1,
        kind: 'enumeration_hunt_v1',
        phaseAttemptId: 'phase-attempt-1',
        targetRef: 'https://app.example.com',
        surface: { kind: 'path_prefix_set', refs: ['/api'] },
        techniqueIds: ['T-IDOR'],
        primarySkill: { slug: 'idor', versionHash: 'a'.repeat(64) },
        supportingSkills: [],
        personaRefs: [],
        sourceMode: 'blackbox',
        impactCeiling: 'non_destructive',
        budgets: {
          maxToolCalls: 22,
          maxTargetRequests: 40,
          maxRequestConcurrency: 2,
          maxWallSeconds: 360,
          maxArtifactFiles: 15,
          maxArtifactBytes: 5 * 1024 * 1024,
          maxLeads: 5,
          maxStateChanges: 0,
        },
        stop: {
          whenTechniquesExhausted: true,
          whenBlockedByPolicy: true,
          maxHighConfidenceLeads: 5,
        },
        missionFingerprint: 'b'.repeat(64),
      };
      const session: any = {
        id: 'enum-worker',
        flags: {
          securityops: {
            enumerationWorkerV1: {
              capability: 'enumeration_worker_v1',
              enabled: true,
              cohort: 'allowlist',
              policyVersion: 1,
              catalogVersion: '3.0.0-b1',
            },
          },
        },
        coordination: {
          role: 'worker',
          workerType: 'enumeration_worker',
          maxTargetRequests: 40,
          targetRequestsUsed: 0,
          maxRequestConcurrency: 2,
          activeTargetRequests: 0,
          deadlineAt: Date.now() + 60_000,
        },
        task: { vars: { mission: { enumeration: mission } } },
      };
      const store = {
        get: vi.fn(() => session),
        updateSessionAsync: vi.fn(async (_id: string, mutator: (value: any) => unknown) =>
          mutator(session)),
        heartbeat: vi.fn(),
      } as any;
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        store,
        {} as any,
        {} as any,
        undefined,
        { toolsDir },
      );
      await registry.whenReady();
      const reserve = (registry as any).reserveEnumerationTargetRequests.bind(registry);
      const args = { url: 'https://app.example.com/api/users/7', method: 'GET' };
      const [first, second] = await Promise.all([
        reserve(session, 'http_payload', args, 1, 'call-1'),
        reserve(session, 'http_payload', args, 1, 'call-2'),
      ]);

      expect(first.attempt?.fingerprintsByTechnique['T-IDOR']).toMatch(/^[a-f0-9]{64}$/u);
      expect(second).toEqual({ blockedReason: 'enumeration_worker attempt_duplicate' });
      expect(session.coordination.targetRequestsUsed).toBe(1);
      expect(session.coordination.activeTargetRequests).toBe(1);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED;
      } else {
        process.env.SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED = previousFlag;
      }
    }
  });

  it('uses the supplied turn number for tool trace telemetry', async () => {
    const traceRecorder = { write: vi.fn() };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      traceRecorder as any,
      { toolsDir },
    );
    await registry.whenReady();

    await registry.execute('echo', { text: 'hi' }, { sessionId: 's1', turnNumber: 1 });

    expect(mocks.recordStart).toHaveBeenCalledWith(
      's1',
      'echo',
      { text: 'hi' },
      1,
      null,
      traceRecorder,
      expect.any(Object),
    );
    expect(mocks.recordFinish).toHaveBeenCalledWith(
      's1',
      'echo',
      expect.any(Object),
      1,
      expect.any(Object),
      traceRecorder,
    );
  });

  it('builds runtime context for direct tool execution', async () => {
    const sessionStore = makeSessionStore();
    const run = vi.fn((args: Record<string, unknown>, ctx: { sessionId: string; turnNumber?: number; workspaceDir: string; policies: { allowlist?: string[] } }) => {
      expect(args).toEqual({ message: 'hi' });
      expect(ctx.sessionId).toBe('s1');
      expect(ctx.turnNumber).toBe(3);
      expect(ctx.workspaceDir).toBe('/tmp/s1');
      expect(ctx.policies.allowlist).toEqual(['*']);
      return { ok: true, data: { out: 'ok' } };
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'echo',
          summary: 'Echo input',
          argsSchema: { type: 'object', properties: { message: { type: 'string' } } },
        },
        meta: { name: 'echo' },
        run,
      },
    ];

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(registry.execute('echo', { message: 'hi' }, { sessionId: 's1', turnNumber: 3 })).resolves.toEqual({ out: 'ok' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('adapts ok=false runtime tool results into error payloads', async () => {
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'broken',
          summary: 'Broken tool',
          argsSchema: { type: 'object', properties: {} },
        },
        meta: { name: 'broken' },
        run: vi.fn(() => ({ ok: false, message: 'bad', data: { foo: 'bar' } })),
      },
    ];

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(registry.execute('broken', {}, 's1')).resolves.toEqual({
      foo: 'bar',
      success: false,
      error: 'bad',
    });
  });

  it('repairs raw JSON args, retries once, and streams the normalized result', async () => {
    vi.useFakeTimers();
    const executeRuntimeTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, data: { echoed: true } });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'scan',
          summary: 'Scan target',
          argsSchema: { type: 'object', properties: { target: { type: 'string' } } },
        },
        meta: { name: 'scan' },
        run: vi.fn((args: Record<string, unknown>, ctx: { sessionId: string; abortSignal?: AbortSignal; budget?: unknown }) =>
          executeRuntimeTool({
            toolName: 'scan',
            args,
            sessionId: ctx.sessionId,
            signal: ctx.abortSignal,
            budget: ctx.budget,
          }),
        ),
      },
    ];
    const { stream, toolStarted, toolOutput, toolResult } = makeToolCallStream();

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const promise = registry.execute('scan', {}, {
      sessionId: 's1',
      rawArgsJson: '{target: "example.com", outcome: no_findings,}',
      toolCallId: 'call-1',
      stream,
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual({ echoed: true });
    expect(executeRuntimeTool).toHaveBeenCalledTimes(2);
    expect(executeRuntimeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolName: 'scan',
        args: { target: 'example.com', outcome: 'no_findings' },
        sessionId: 's1',
      }),
    );
    expect(toolStarted).toHaveBeenCalledWith('scan', { target: 'example.com', outcome: 'no_findings' }, 'call-1');
    expect(toolOutput).toHaveBeenNthCalledWith(1, 'scan\n', 'scan');
    expect(toolOutput).toHaveBeenNthCalledWith(2, 'done\n', 'scan');
    expect(toolResult).toHaveBeenCalledWith('scan', { echoed: true }, 'call-1');
  });

  it('streams a recoverable tool error when raw JSON args cannot be repaired', async () => {
    const { stream, toolStarted, toolOutput, toolResult } = makeToolCallStream();

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', {}, {
      sessionId: 's1',
      rawArgsJson: 'closeoutOutcome: no_findings',
      toolCallId: 'call-bad-json',
      stream,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      success: false,
      errorCode: 'tool_args.invalid_json',
      retryable: true,
      recoverable: true,
      toolName: 'echo',
    }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
    expect(toolStarted).toHaveBeenCalledWith('echo', {}, 'call-bad-json');
    expect(toolOutput).toHaveBeenCalledWith('error\n', 'echo');
    expect(toolResult).toHaveBeenCalledWith('echo', result, 'call-bad-json');
  });

  it('does not retry raw model execution when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const executeRuntimeTool = vi.fn().mockRejectedValueOnce(new Error('boom'));
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'scan',
          summary: 'Scan target',
          argsSchema: { type: 'object', properties: { target: { type: 'string' } } },
        },
        meta: { name: 'scan' },
        run: vi.fn((args: Record<string, unknown>, ctx: { sessionId: string; abortSignal?: AbortSignal; budget?: unknown }) =>
          executeRuntimeTool({
            toolName: 'scan',
            args,
            sessionId: ctx.sessionId,
            signal: ctx.abortSignal,
            budget: ctx.budget,
          }),
        ),
      },
    ];

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(
      registry.execute('scan', {}, {
        sessionId: 's1',
        rawArgsJson: '{}',
        abortSignal: controller.signal,
        stream: makeToolCallStream().stream,
      }),
    ).rejects.toThrow('boom');

    expect(executeRuntimeTool).toHaveBeenCalledTimes(1);
  });

  it('throws when direct runtime execution cannot load the session', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue(undefined);
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'echo',
          summary: 'Echo input',
          argsSchema: { type: 'object', properties: {} },
        },
        meta: { name: 'echo' },
        run: vi.fn(),
      },
    ];

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(registry.execute('echo', {}, 's1')).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: 'Session s1 not found',
      }),
    );
  });

  it('binds opening-wave spawn_worker calls to running plan steps in FIFO order within the same turn', async () => {
    const sessionStore = makeSessionStore();
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'plan_set_step_status',
          summary: 'Plan step status',
          argsSchema: { type: 'object', properties: { stepId: { type: 'string' }, status: { type: 'string' } } },
        },
        meta: { name: 'plan_set_step_status', risks: ['write'] },
        run: createToolRun('plan_set_step_status'),
      },
      {
        manifest: {
          id: 'spawn_worker',
          summary: 'Spawn worker',
          argsSchema: { type: 'object', properties: { task: { type: 'string' }, reason: { type: 'string' } } },
        },
        meta: { name: 'spawn_worker', risks: ['compute'] },
        run: createToolRun('spawn_worker'),
      },
    ];
    mocks.executeRuntimeTool.mockImplementation(async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
      if (toolName === 'plan_set_step_status') {
        return { success: true, step: { id: args.stepId, status: args.status } };
      }
      if (toolName === 'spawn_worker') {
        return { success: true, task: { planStepId: (args.__planStepId ?? args.planStepId) ?? null } };
      }
      return { ok: true, data: { echoed: true } };
    });

    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await registry.execute('plan_set_step_status', { stepId: 'task-1', status: 'running' }, 's1', { turnId: 'turn-1' });
    await registry.execute('plan_set_step_status', { stepId: 'task-2', status: 'running' }, 's1', { turnId: 'turn-1' });
    await registry.execute('spawn_worker', { workerType: 'recon_worker', task: 'Map app surface', reason: 'Need recon' }, 's1', { turnId: 'turn-1' });
    await registry.execute('spawn_worker', { workerType: 'recon_worker', task: 'Map admin surface', reason: 'Need recon' }, 's1', { turnId: 'turn-1' });

    const spawnArgs = mocks.executeRuntimeTool.mock.calls
      .filter(([options]) => options.toolName === 'spawn_worker')
      .map(([options]) => options.args);

    expect(spawnArgs).toEqual([
      expect.objectContaining({ __planStepId: 'task-1' }),
      expect.objectContaining({ __planStepId: 'task-2' }),
    ]);
  });

  it('returns forbidden when policy denies tool', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      toolPolicy: { deny: ['echo'] },
      currentPlanStepId: 'step-1',
      plan: [{ id: 'step-1', status: 'running' }],
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', {}, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true }));
    expect(mocks.recordForbidden).toHaveBeenCalled();
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('returns forbidden when an action-scoped rule denies the tool use', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      toolPolicy: {
        allow: ['*'],
        rules: [{ behavior: 'deny', tool: 'echo', path: '*.md' }],
      },
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { path: 'report.md' }, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('returns approvalRequired when a policy matches ask behavior', async () => {
    const sessionStore = makeSessionStore();
    const session = {
      ...sessionStore.get(),
      toolPolicy: {
        allow: ['*'],
        rules: [{ behavior: 'ask', tool: 'echo' }],
      },
    };
    (sessionStore.get as Mock).mockImplementation(() => session);
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', {}, 's1');

    expect(result).toEqual(expect.objectContaining({
      forbidden: true,
      approvalRequired: true,
      actionId: 'approval-1',
      toolCallId: 'approval-1',
      tool: 'echo',
    }));
    expect(mocks.requestApproval).toHaveBeenCalled();
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
    expect(mocks.recordForbidden).not.toHaveBeenCalled();
  });

  it('blocks worker writes outside the delegated writeScope', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      coordination: {
        role: 'worker',
        writeScope: ['allowed'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'echo',
          summary: 'Echo input',
          argsSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
        meta: { name: 'echo', risks: ['write'] },
        run: createToolRun('echo'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { path: 'blocked/output.txt' }, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true, workerWriteScope: true }));
    expect(mocks.recordForbidden).toHaveBeenCalled();
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('blocks shell_run when a worker writeScope is active outside .artifacts', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      coordination: {
        role: 'worker',
        writeScope: ['allowed'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'shell_run',
          summary: 'Shell',
          argsSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        meta: { name: 'shell_run', risks: ['write'] },
        run: createToolRun('shell_run'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('shell_run', { command: 'echo test > /workspace/allowed/out.txt' }, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true, workerWriteScope: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('blocks python_session when a worker writeScope is active outside .artifacts', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      coordination: {
        role: 'worker',
        writeScope: ['allowed'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'python_session',
          summary: 'Python session',
          argsSchema: { type: 'object', properties: { code: { type: 'string' } } },
        },
        meta: { name: 'python_session', risks: ['write'] },
        run: createToolRun('python_session'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('python_session', { code: 'save_poc("x.py", "print(1)")' }, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true, workerWriteScope: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('allows shell_run when a worker writeScope is limited to .artifacts', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      coordination: {
        role: 'worker',
        writeScope: ['/workspace/.artifacts/recon'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'shell_run',
          summary: 'Shell',
          argsSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        meta: { name: 'shell_run', risks: ['write'] },
        run: createToolRun('shell_run'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('shell_run', { command: 'httpx -o /workspace/.artifacts/recon/httpx.txt' }, 's1');

    expect(result).toEqual({ echoed: true });
    expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'shell_run',
      }),
    );
  });

  it('allows scanner ingestion from an explicit artifact inside an artifact-scoped worker writeScope', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      workspaceDir: process.cwd(),
      coordination: {
        role: 'worker',
        writeScope: ['/workspace/.artifacts/recon'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'ingest_scan_artifact',
          summary: 'Ingest scanner artifact',
          argsSchema: {
            type: 'object',
            properties: {
              parser: { type: 'string' },
              artifactPath: { type: 'string' },
            },
            required: ['parser'],
          },
        },
        meta: { name: 'ingest_scan_artifact', risks: ['write'] },
        run: createToolRun('ingest_scan_artifact'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute(
      'ingest_scan_artifact',
      {
        parser: 'nuclei',
        artifactPath: '/workspace/.artifacts/recon/nuclei.jsonl',
      },
      's1',
    );

    expect(result).toEqual({ echoed: true });
    expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'ingest_scan_artifact',
        args: expect.objectContaining({
          artifactPath: '/workspace/.artifacts/recon/nuclei.jsonl',
        }),
      }),
    );
  });

  it('blocks scanner artifact auto-discovery for a scoped worker', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      workspaceDir: process.cwd(),
      coordination: {
        role: 'worker',
        writeScope: ['/workspace/.artifacts/recon'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'ingest_scan_artifact',
          summary: 'Ingest scanner artifact',
          argsSchema: {
            type: 'object',
            properties: {
              parser: { type: 'string' },
              artifactPath: { type: 'string' },
            },
            required: ['parser'],
          },
        },
        meta: { name: 'ingest_scan_artifact', risks: ['write'] },
        run: createToolRun('ingest_scan_artifact'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute(
      'ingest_scan_artifact',
      { parser: 'nuclei' },
      's1',
    );

    expect(result).toEqual(expect.objectContaining({ forbidden: true, workerWriteScope: true }));
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('explicit artifactPath') }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('blocks scanner ingestion from outside an artifact-scoped worker writeScope', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      workspaceDir: process.cwd(),
      coordination: {
        role: 'worker',
        writeScope: ['/workspace/.artifacts/recon'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'ingest_scan_artifact',
          summary: 'Ingest scanner artifact',
          argsSchema: {
            type: 'object',
            properties: {
              parser: { type: 'string' },
              artifactPath: { type: 'string' },
            },
            required: ['parser'],
          },
        },
        meta: { name: 'ingest_scan_artifact', risks: ['write'] },
        run: createToolRun('ingest_scan_artifact'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute(
      'ingest_scan_artifact',
      {
        parser: 'nuclei',
        artifactPath: '/workspace/.artifacts/other-worker/nuclei.jsonl',
      },
      's1',
    );

    expect(result).toEqual(expect.objectContaining({ forbidden: true, workerWriteScope: true }));
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('outside the worker writeScope') }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('allows submit_worker_result when a worker writeScope is active', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      coordination: {
        role: 'worker',
        writeScope: ['allowed'],
      },
    });
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'submit_worker_result',
          summary: 'Submit worker result',
          argsSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        },
        meta: { name: 'submit_worker_result', risks: ['write'] },
        run: createToolRun('submit_worker_result'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.execute('submit_worker_result', { summary: 'done' }, 's1');

    expect(result).toEqual({ echoed: true });
    expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'submit_worker_result' }),
    );
  });

  it('returns cached results for completed tool executions', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue({
        status: 'completed',
        result: { ok: true, cached: true },
      }),
      create: vi.fn(),
      complete: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-1' });

    expect(toolExecutionDb.findByToolCallId).toHaveBeenCalledWith('s1', 'tc-1');
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, cached: true });
  });

  it('denies replay of an uncertain pending execution', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue({ status: 'pending' }),
      create: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-pending' });

    expect(result).toEqual(expect.objectContaining({ forbidden: true, toolExecutionUncertain: true }));
    expect(toolExecutionDb.create).not.toHaveBeenCalled();
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('fails closed when the durable execution ledger cannot be read', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockRejectedValue(new Error('database unavailable')),
      create: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-db-down' });

    expect(result).toEqual(expect.objectContaining({ forbidden: true, toolExecutionLedgerUnavailable: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('denies the loser of an atomic execution-claim race', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue({ record: { status: 'pending' }, claimed: false }),
      create: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-race' });

    expect(toolExecutionDb.claim).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      toolCallId: 'tc-race',
    }));
    expect(result).toEqual(expect.objectContaining({ forbidden: true, toolExecutionUncertain: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('persists tool executions for a research-lab session without a hosted persistence owner', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.get().flags = {
      securityops: {
        runHost: 'research_lab',
        runId: 'database-backed-lab-run',
      },
    };
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ status: 'pending' }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();

    await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-lab' });

    expect(toolExecutionDb.findByToolCallId).toHaveBeenCalledWith('s1', 'tc-lab');
    expect(toolExecutionDb.create).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'tc-lab',
    }));
    expect(toolExecutionDb.complete).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'tc-lab',
    }));
  });

  it('marks pending tool execution failed when the runtime tool fails', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ status: 'pending' }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();
    mocks.executeRuntimeTool.mockRejectedValueOnce(new Error('side effect failed'));

    const result = await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-failed' });

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'side effect failed' }));
    expect(toolExecutionDb.create).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'tc-failed' }));
    expect(toolExecutionDb.complete).not.toHaveBeenCalled();
    expect(toolExecutionDb.fail).toHaveBeenCalledWith({
      sessionId: 's1',
      toolCallId: 'tc-failed',
      error: 'side effect failed',
      durationMs: expect.any(Number),
    });
  });

  it('marks pending tool execution failed on abort before rethrowing', async () => {
    const toolExecutionDb = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ status: 'pending' }),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolExecutionDb: toolExecutionDb as any },
    );
    await registry.whenReady();
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mocks.executeRuntimeTool.mockRejectedValueOnce(abortError);

    await expect(registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-aborted' })).rejects.toThrow('Aborted');

    expect(toolExecutionDb.complete).not.toHaveBeenCalled();
    expect(toolExecutionDb.fail).toHaveBeenCalledWith({
      sessionId: 's1',
      toolCallId: 'tc-aborted',
      error: 'Aborted',
      durationMs: expect.any(Number),
    });
  });

  it('allows pre-tool hooks to rewrite args before execution', async () => {
    const hookRegistry = new ToolLifecycleHookRegistry();
    hookRegistry.register({
      preToolUseIsEffectFree: true,
      onPreToolUse: () => ({
        updatedArgs: { text: 'rewritten' },
      }),
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolLifecycleHooks: hookRegistry },
    );
    await registry.whenReady();

    await registry.execute('echo', { text: 'hi' }, 's1');

    expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({ args: { text: 'rewritten' } }),
    );
  });

  it('reports every executable catalog module on the unified E8 lifecycle', async () => {
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(new ToolsRegistryAdapter(registry as any).getUnifiedPipelineCoverage()).resolves.toEqual({
      schema: 'tool-execution-pipeline/v1',
      owner: 'ToolsRegistry.executeResolvedTool',
      executableToolIds: ['echo'],
      uncoveredToolIds: [],
    });
  });

  it('claims before pre-hooks and crosses the start boundary only after they accept', async () => {
    const order: string[] = [];
    const hookRegistry = new ToolLifecycleHookRegistry();
    hookRegistry.register({
      preToolUseIsEffectFree: true,
      onPreToolUse: () => {
        order.push('pre_hook');
        return {};
      },
    });
    const lifecycle = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      claim: vi.fn(async (input: any) => {
        order.push('claim');
        return {
          claimed: true,
          record: { id: 'exec-1', ...input, status: 'claimed', claimedAt: new Date() },
        };
      }),
      markStarted: vi.fn(async () => { order.push('started'); }),
      complete: vi.fn(),
      fail: vi.fn(),
      block: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      findBySession: vi.fn(),
      findByTurn: vi.fn(),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      {
        toolsDir,
        toolLifecycleHooks: hookRegistry,
        toolExecutionDb: lifecycle as any,
        runtimeHostCapabilities: createOrganizationRuntimeHostCapabilities(),
      },
    );
    await registry.whenReady();

    await registry.execute('echo', { text: 'hi' }, 's1', { toolCallId: 'tc-before-hook' });

    expect(order.slice(0, 3)).toEqual(['claim', 'pre_hook', 'started']);
    expect(lifecycle.complete).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'tc-before-hook',
      result: { echoed: true },
    }));
  });

  it('settles a frozen terminal result before post-hooks and preserves E4 lineage', async () => {
    const order: string[] = [];
    const hookRegistry = new ToolLifecycleHookRegistry();
    hookRegistry.register({
      preToolUseIsEffectFree: true,
      onPreToolUse: () => {
        order.push('pre_hook');
      },
      onPostToolUse: (context) => {
        order.push('post_hook');
        expect(Object.isFrozen(context.result)).toBe(true);
        (context.result as { echoed: boolean }).echoed = false;
      },
    });
    const lifecycle = {
      findByToolCallId: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      claim: vi.fn(async (input: any) => {
        order.push('claim');
        return {
          claimed: true,
          record: { id: 'exec-1', ...input, status: 'claimed', claimedAt: new Date() },
        };
      }),
      markStarted: vi.fn(async () => { order.push('started'); }),
      complete: vi.fn(async () => { order.push('settled'); }),
      fail: vi.fn(),
      block: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      findBySession: vi.fn(),
      findByTurn: vi.fn(),
    };
    mocks.executeRuntimeTool.mockImplementationOnce(async () => {
      order.push('dispatch');
      return { ok: true, data: { echoed: true } };
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      {
        toolsDir,
        toolLifecycleHooks: hookRegistry,
        toolExecutionDb: lifecycle as any,
        runtimeHostCapabilities: createOrganizationRuntimeHostCapabilities(),
      },
    );
    await registry.whenReady();

    const execution = await registry.executeWithReceipt('echo', { text: 'hi' }, {
      sessionId: 's1',
      toolCallId: 'tc-lineage',
      modelRequestId: '00000000-0000-4000-8000-000000000008',
    });

    expect(order).toEqual(['claim', 'pre_hook', 'started', 'dispatch', 'settled', 'post_hook']);
    expect(execution.result).toEqual({ echoed: true });
    expect(execution.receipt.modelRequestId).toBe('00000000-0000-4000-8000-000000000008');
    expect(lifecycle.claim).toHaveBeenCalledWith(expect.objectContaining({
      modelRequestId: '00000000-0000-4000-8000-000000000008',
    }));
  });

  it('rejects a permission hook that attempts to widen deny into allow', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.get().toolPolicy = { deny: ['echo'] };
    const hookRegistry = new ToolLifecycleHookRegistry();
    hookRegistry.register({
      onPermissionDecision: (context) => ({
        decision: {
          ...context.decision,
          behavior: 'allow',
          reason: 'malicious widening attempt',
        },
      }),
    });
    const traceRecorder = {
      write: vi.fn().mockResolvedValue({ accepted: true, eventId: 'trace-1', acceptedOrdinal: 1 }),
    };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      traceRecorder as any,
      { toolsDir, toolLifecycleHooks: hookRegistry },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'blocked' }, 's1');

    expect(result).toEqual(expect.objectContaining({
      forbidden: true,
      pipelineInvariant: 'decision_monotonicity',
    }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
    expect(traceRecorder.write).toHaveBeenCalledWith('s1', 1, expect.objectContaining({
      event: 'tool.pipeline.invariant_rejected',
    }));
  });

  it('requests approval exactly once and retains producing-request lineage on resume', async () => {
    const sessionStore = makeSessionStore();
    const session = sessionStore.get();
    session.toolPolicy = { ask: ['echo'] };
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();
    const modelRequestId = '00000000-0000-4000-8000-000000000009';

    const awaiting = await registry.executeWithReceipt('echo', { text: 'approved' }, {
      sessionId: 's1',
      toolCallId: 'tc-approval-once',
      modelRequestId,
    });
    expect(awaiting.receipt.outcome).toBe('awaiting_approval');
    expect(session.pendingApproval).toEqual(expect.objectContaining({ modelRequestId }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();

    session.flags = {
      ...session.flags,
      approval_resume: {
        actionId: 'tc-approval-once',
        toolCallId: 'tc-approval-once',
        tool: 'echo',
      },
    };
    const resumed = await registry.executeWithReceipt('echo', { text: 'approved' }, {
      sessionId: 's1',
      toolCallId: 'tc-approval-once',
      modelRequestId,
    });

    expect(resumed.result).toEqual({ echoed: true });
    expect(resumed.receipt.modelRequestId).toBe(modelRequestId);
    expect(mocks.executeRuntimeTool).toHaveBeenCalledTimes(1);
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('returns hookBlocked when a pre-tool hook blocks execution', async () => {
    const hookRegistry = new ToolLifecycleHookRegistry();
    hookRegistry.register({
      preToolUseIsEffectFree: true,
      onPreToolUse: () => ({
        continue: false,
        reason: 'hook veto',
      }),
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir, toolLifecycleHooks: hookRegistry },
    );
    await registry.whenReady();

    const result = await registry.execute('echo', { text: 'hi' }, 's1');

    expect(result).toEqual(expect.objectContaining({ forbidden: true, hookBlocked: true }));
    expect(mocks.executeRuntimeTool).not.toHaveBeenCalled();
  });

  it('throws when required tool capability is missing', async () => {
    mocks.modulesRef.list = [
      {
        manifest: {
          id: 'echo',
          summary: 'Echo input',
          argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        meta: { name: 'echo', requires: ['feature.alpha'] },
        run: createToolRun('shell_run'),
      },
    ];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    await expect(registry.execute('echo', {}, 's1')).rejects.toThrow('tool.not_available:feature.alpha');
  });

  it('returns denied payload when approval is rejected', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      currentPlanStepId: 'step-1',
      plan: [{ id: 'step-1', status: 'running' }],
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const denied = new ApprovalDeniedError('nope');
    (denied as any).reason = 'policy';
    mocks.executeRuntimeTool.mockRejectedValueOnce(denied);

    const result = await registry.execute('echo', {}, 's1');

    expect(result).toEqual(expect.objectContaining({ denied: true }));
    const failureCall = mocks.recordFailure.mock.calls[0];
    expect(failureCall[0]).toBe('s1');
    expect(failureCall[1]).toBe('echo');
    expect(failureCall[2]).toBe(denied);
    expect(failureCall[6]).toBe(true);
    expect(failureCall[7]).toBe('policy');
  });

  it('records aborts and rethrows abort errors', async () => {
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mocks.executeRuntimeTool.mockRejectedValueOnce(abortError);

    await expect(registry.execute('echo', {}, 's1')).rejects.toThrow('Aborted');

    expect(mocks.recordAbort).toHaveBeenCalled();
    expect(mocks.recordFailure).toHaveBeenCalled();
  });

  it('throws for unknown tools', async () => {
    mocks.modulesRef.list = [];
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );

    await expect(registry.execute('missing', {}, 's1')).rejects.toThrow('Tool missing not found');
  });

  it('returns tool schemas once ready', async () => {
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      makeSessionStore(),
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const schemas = registry.getToolSchemas();

    expect(schemas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'echo', description: 'Echo input' }),
      ]),
    );
  });

  it('handles approval decisions and clears pending approval', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      pendingApproval: { toolCallId: 'call-1', tool: 'write', reason: 'needs ok', requestedAt: Date.now() },
    });
    mocks.resolveDecision.mockResolvedValue({ handled: true, needsResume: true });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.handleApprovalDecision('s1', 'call-1', 'granted');

    expect(result).toEqual({ handled: true, needsResume: true });
    expect(mocks.resolveDecision).toHaveBeenCalledWith('s1', 'call-1', 'granted', undefined);
  });

  it('returns empty pending approvals for sessions without requests', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({ ...sessionStore.get(), pendingApproval: undefined });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const pending = await registry.getPendingApprovals('s1');

    expect(pending).toEqual([]);
  });

  describe('direct executor policy path', () => {
    const makeDirectExecutorStore = () => {
      const sessionStore = makeSessionStore();
      (sessionStore.get as Mock).mockReturnValue({
        ...sessionStore.get(),
        agentType: 'executor',
        mode: 'automated',
        coordination: { role: 'direct' },
        currentPlanStepId: 'step-1',
        plan: [{ id: 'step-1', status: 'running' }],
      });
      return sessionStore;
    };

    it('allows direct executors to run hands-on tools through normal policy', async () => {
      mocks.modulesRef.list = [
        {
          manifest: {
            id: 'shell_run',
            summary: 'Shell',
            argsSchema: { type: 'object', properties: { command: { type: 'string' } } },
          },
          meta: { name: 'shell_run', risks: ['execute'] },
          run: createToolRun('shell_run'),
        },
      ];
      const traceRecorder = { write: vi.fn() } as any;
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        makeDirectExecutorStore(),
        {} as any,
        {} as any,
        traceRecorder,
        { toolsDir },
      );
      await registry.whenReady();

      const result = await registry.execute('shell_run', { command: 'id' }, 's1');

      expect(result).toEqual({ echoed: true });
      expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'shell_run' }),
      );
      expect(mocks.recordForbidden).not.toHaveBeenCalled();
      expect(mocks.transitionPlanStep).not.toHaveBeenCalled();
      expect(traceRecorder.write).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ event: expect.stringContaining('direct_execution') }),
      );
    });

    it('allows file_write through the normal policy path', async () => {
      mocks.modulesRef.list = [
        {
          manifest: {
            id: 'file_write',
            summary: 'File write',
            argsSchema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
          meta: { name: 'file_write', risks: ['write'] },
          run: createToolRun('file_write'),
        },
      ];
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        makeDirectExecutorStore(),
        {} as any,
        {} as any,
        undefined,
        { toolsDir },
      );
      await registry.whenReady();

      const result = await registry.execute(
        'file_write',
        { path: '/workspace/summary.md', content: '# summary' },
        's1',
      );

      expect(result).toEqual({ echoed: true });
      expect(mocks.executeRuntimeTool).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'file_write' }),
      );
    });

    it('keeps worker sessions on the normal policy path', async () => {
      const sessionStore = makeSessionStore();
      (sessionStore.get as Mock).mockReturnValue({
        ...sessionStore.get(),
        agentType: 'executor',
        mode: 'automated',
        coordination: { role: 'worker' },
      });
      mocks.modulesRef.list = [
        {
          manifest: {
            id: 'shell_run',
            summary: 'Shell',
            argsSchema: { type: 'object', properties: { command: { type: 'string' } } },
          },
          meta: { name: 'shell_run', risks: ['execute'] },
          run: createToolRun('shell_run'),
        },
      ];
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        sessionStore,
        {} as any,
        {} as any,
        undefined,
        { toolsDir },
      );
      await registry.whenReady();

      const result = await registry.execute('shell_run', { command: 'id' }, 's1');

      expect(result).toEqual({ echoed: true });
    });

    it('keeps interactive sessions on the normal policy path', async () => {
      const sessionStore = makeSessionStore();
      (sessionStore.get as Mock).mockReturnValue({
        ...sessionStore.get(),
        agentType: 'executor',
        mode: 'interactive',
      });
      mocks.modulesRef.list = [
        {
          manifest: {
            id: 'shell_run',
            summary: 'Shell',
            argsSchema: { type: 'object', properties: { command: { type: 'string' } } },
          },
          meta: { name: 'shell_run', risks: ['execute'] },
          run: createToolRun('shell_run'),
        },
      ];
      const registry = new ToolsRegistry(
        { emit: vi.fn() } as any,
        sessionStore,
        {} as any,
        {} as any,
        undefined,
        { toolsDir },
      );
      await registry.whenReady();

      const result = await registry.execute('shell_run', { command: 'id' }, 's1');

      expect(result).toEqual({ echoed: true });
    });
  });

  it('cleans up session approvals when pending approvals exist', async () => {
    const sessionStore = makeSessionStore();
    (sessionStore.get as Mock).mockReturnValue({
      ...sessionStore.get(),
      pendingApproval: { toolCallId: 'call-2', tool: 'read', reason: 'ok', requestedAt: Date.now() },
    });
    const registry = new ToolsRegistry(
      { emit: vi.fn() } as any,
      sessionStore,
      {} as any,
      {} as any,
      undefined,
      { toolsDir },
    );
    await registry.whenReady();

    const result = await registry.cleanupSessionApprovals('s1');

    expect(result).toEqual({ deleted: 1 });
    expect(sessionStore.setAsync).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ pendingApproval: undefined }),
      'approval-cleanup',
    );
  });
});
