import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import type { ToolContext } from '@/domains/agent-brain/application/tools';
import {
  ControlAssessmentHandoffPreflight,
  SubmitPhaseCheckpoint,
  SubmitPhaseHandoff,
  ValidationHandoffPreflight,
} from '@/domains/agent-brain/adapters/tools/builtins/phase';

const phaseRepoMocks = vi.hoisted(() => ({
  findActiveBySessionId: vi.fn(),
  updateStatus: vi.fn(),
}));
const securityOpsMocks = vi.hoisted(() => ({
  reportNote: vi.fn(),
  queryComplianceReadiness: vi.fn(),
  queryNotes: vi.fn(),
  queryFindings: vi.fn(),
  updateValidationLeadPromptMetadata: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {},
}));

vi.mock('@/domains/security-ops/runs/RunPhaseRepository', () => ({
  RunPhaseRepository: class {
    findActiveBySessionId = phaseRepoMocks.findActiveBySessionId;
    updateStatus = phaseRepoMocks.updateStatus;
  },
}));

vi.mock('@/domains/security-ops/tools/SecurityOpsToolService', () => ({
  SecurityOpsToolService: class {
    reportNote = securityOpsMocks.reportNote;
    queryComplianceReadiness = securityOpsMocks.queryComplianceReadiness;
    queryNotes = securityOpsMocks.queryNotes;
    queryFindings = securityOpsMocks.queryFindings;
    updateValidationLeadPromptMetadata = securityOpsMocks.updateValidationLeadPromptMetadata;
  },
}));

const PHASE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const makeActivePhase = (overrides: Record<string, unknown> = {}) => ({
  id: PHASE_ID,
  runId: RUN_ID,
  phaseKey: 'recon',
  status: 'active',
  handoffSchemaVersion: 1,
  ...overrides,
});

const makeContext = (workspaceDir: string, overrides: Partial<ToolContext> = {}): ToolContext => {
  const session = {
    id: SESSION_ID,
    workspaceDir,
    flags: {
      securityops: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: RUN_ID,
      },
    },
    scopeId: 'scope-1',
  };

  return ({
    sessionId: SESSION_ID,
    workspaceDir,
    sandbox: {} as never,
    sessionStore: {
      get: vi.fn(() => session),
      setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
      recordSessionCompletedAsync: vi.fn(async () => true),
    } as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    flags: {
      securityops: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: RUN_ID,
      },
    },
    planRuntime: {} as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;
};

let workspaceDir: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'null-ai-phase-tool-'));
});

afterEach(async () => {
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = undefined;
  }
});

describe('phase builtins', () => {
  it('returns the recorded handoff when submit_phase_handoff is called after a successful handoff', async () => {
    const session = {
      id: SESSION_ID,
      workspaceDir: workspaceDir!,
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: RUN_ID,
          activePhaseId: PHASE_ID,
          activePhaseKey: 'recon',
          phaseHandoffSubmitted: true,
          phaseHandoffRef: '.artifacts/phase-handoffs/recon.json',
          phaseHandoffStatus: 'completed',
        },
      },
      scopeId: 'scope-1',
    };
    const ctx = makeContext(workspaceDir!, {
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(),
        recordSessionCompletedAsync: vi.fn(async () => true),
      } as any,
    });

    const result = await SubmitPhaseHandoff.run(
      { status: 'completed', summary: 'Duplicate closeout.' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        alreadySubmitted: true,
        terminal: true,
        handoffAccepted: true,
        handoffRef: '.artifacts/phase-handoffs/recon.json',
        nextAction: 'stop',
      }),
    );
    expect(phaseRepoMocks.findActiveBySessionId).not.toHaveBeenCalled();
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('persists a handoff artifact and records replan flags on the session', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase());
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'blocked',
        summary: 'Blocked by missing VPN route.',
        completedObjectives: ['Resolved public perimeter.'],
        unresolvedQuestions: ['VPN-only host remains unreachable.'],
        artifacts: ['.artifacts/phases/recon/httpx.json'],
        canonicalWrites: {
          notes: ['note-1'],
          findings: [],
          assets: ['asset-1'],
          services: [],
        },
        evidenceRefs: ['note-1'],
        replanRequest: {
          needed: true,
          reason: 'Target requires a new VPN route.',
        },
      },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        success: true,
        runId: RUN_ID,
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'blocked',
        handoffRef: '.artifacts/phase-handoffs/11111111-1111-4111-8111-111111111111.json',
        handoffAccepted: true,
      }),
    });
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: 'blocked',
      handoffOutRef: '.artifacts/phase-handoffs/11111111-1111-4111-8111-111111111111.json',
      lastError: 'Blocked by missing VPN route.',
    });

    const artifact = JSON.parse(
      await fs.readFile(path.join(workspaceDir!, '.artifacts', 'phase-handoffs', `${PHASE_ID}.json`), 'utf8'),
    );
    expect(artifact).toEqual(expect.objectContaining({
      schemaVersion: 1,
      phaseId: PHASE_ID,
      phase: 'recon',
      runId: RUN_ID,
      replanRequest: {
        needed: true,
        reason: 'Target requires a new VPN route.',
      },
    }));
    expect(ctx.sessionStore.setAsync).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        completed: true,
        flags: expect.objectContaining({
          session: expect.objectContaining({
            completed: true,
          }),
          securityops: expect.objectContaining({
            activePhaseId: PHASE_ID,
            activePhaseKey: 'recon',
            phaseHandoffSubmitted: true,
            phaseHandoffStatus: 'blocked',
            phaseReplanRequested: true,
            phaseReplanReason: 'Target requires a new VPN route.',
          }),
        }),
      }),
      'phase_handoff_submitted',
    );
  });

  it('marks matching live plan steps completed when handoff is accepted', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ stepIds: ['mission-1'] }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.plan = [
      { id: 'mission-1', title: 'Run recon', status: 'running' },
      { id: 'mission-2', title: 'Run enumeration', status: 'pending' },
    ];
    session.currentPlanStepId = 'mission-1';

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'completed',
        summary: 'Recon objectives complete.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const updatedSession = ctx.sessionStore.get(SESSION_ID) as any;
    expect(updatedSession.plan[0]).toEqual(
      expect.objectContaining({
        id: 'mission-1',
        status: 'completed',
        outputSnippet: 'Recon objectives complete.',
        artifactLinks: ['.artifacts/phase-handoffs/11111111-1111-4111-8111-111111111111.json'],
        completedAt: expect.any(Number),
      }),
    );
    expect(updatedSession.plan[1]).toEqual(expect.objectContaining({ id: 'mission-2', status: 'pending' }));
    expect(updatedSession.currentPlanStepId).toBeUndefined();
    expect(ctx.streamBroker.emit).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        type: 'plan_update',
        data: expect.arrayContaining([
          expect.objectContaining({ id: 'mission-1', status: 'completed' }),
        ]),
      }),
    );
  });

  it('applies terminal handoff flags to the current cache object after plan close replaces it', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ stepIds: ['mission-1'] }));
    let currentSession: any = {
      id: SESSION_ID,
      workspaceDir: workspaceDir!,
      plan: [{ id: 'mission-1', title: 'Run recon', status: 'running' }],
      currentPlanStepId: 'mission-1',
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: RUN_ID,
        },
      },
      scopeId: 'scope-1',
    };
    const sessionStore = {
      get: vi.fn(() => currentSession),
      setAsync: vi.fn(async (_sessionId: string, updated: any) => {
        currentSession = { ...updated, flags: { ...(updated.flags ?? {}) } };
      }),
      recordSessionCompletedAsync: vi.fn(async () => true),
    };
    const ctx = makeContext(workspaceDir!, { sessionStore: sessionStore as any });

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'completed',
        summary: 'Recon objectives complete.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(currentSession).toEqual(expect.objectContaining({
      completed: true,
      currentPlanStepId: undefined,
      flags: expect.objectContaining({
        session: expect.objectContaining({ completed: true }),
        securityops: expect.objectContaining({
          phaseHandoffSubmitted: true,
          phaseHandoffStatus: 'completed',
        }),
      }),
    }));
    expect(currentSession.plan[0]).toEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('persists a checkpoint artifact while leaving the phase active', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase());
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseCheckpoint.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        summary: 'Partial recon complete.',
        completedObjectives: ['Resolved public perimeter.'],
        pendingObjectives: ['Enumerate API surface.'],
        canonicalWrites: {
          notes: ['note-1'],
          findings: [],
          assets: ['asset-1'],
          services: [],
        },
        evidenceRefs: ['note-1'],
        nextSuggestedAction: 'Run API enumeration.',
      },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      data: {
        success: true,
        runId: RUN_ID,
        phaseId: PHASE_ID,
        phase: 'recon',
        checkpointRef: '.artifacts/phase-checkpoints/11111111-1111-4111-8111-111111111111.json',
      },
    });
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: 'active',
      checkpointRef: '.artifacts/phase-checkpoints/11111111-1111-4111-8111-111111111111.json',
    });

    const artifact = JSON.parse(
      await fs.readFile(path.join(workspaceDir!, '.artifacts', 'phase-checkpoints', `${PHASE_ID}.json`), 'utf8'),
    );
    expect(artifact).toEqual(expect.objectContaining({
      phaseId: PHASE_ID,
      phase: 'recon',
      runId: RUN_ID,
      summary: 'Partial recon complete.',
      pendingObjectives: ['Enumerate API surface.'],
    }));
  });

  it('rejects handoffs that do not match the active phase', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase());
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'validation',
        status: 'completed',
        summary: 'Done.',
      },
      ctx,
    );

    expect(result).toEqual({
      ok: false,
      data: expect.objectContaining({
        error: 'phase does not match active phase recon',
        gate: expect.objectContaining({
          code: 'active_phase_key_mismatch',
          expectedShape: { phase: 'recon' },
        }),
        gateFailureCount: 1,
        circuitBreaker: false,
      }),
    });
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('blocks phase handoff while delegated worker tasks are still live', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase());
    const session = {
      id: SESSION_ID,
      workspaceDir: workspaceDir!,
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: RUN_ID,
        },
      },
      scopeId: 'scope-1',
      workerTasks: [
        {
          taskId: 'worker-task-1',
          parentSessionId: SESSION_ID,
          workerSessionId: '44444444-4444-4444-8444-444444444444',
          workerType: 'recon_worker',
          status: 'running',
          reason: 'JS bundle review',
          task: 'Review JavaScript bundles',
          expectedArtifactType: 'JS secret scan results',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
      ],
    };
    const ctx = makeContext(workspaceDir!, {
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
        recordSessionCompletedAsync: vi.fn(async () => true),
      } as any,
    });

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'completed',
        summary: 'Recon complete.',
      },
      ctx,
    );

    expect(result).toEqual({
      ok: false,
      data: expect.objectContaining({
        error: expect.stringContaining('delegated worker task(s) are still live'),
        gate: expect.objectContaining({
          code: 'live_worker_tasks',
          suggestedTool: 'wait_for_worker',
          currentState: expect.objectContaining({
            liveWorkerTasks: [
              expect.objectContaining({
                taskId: 'worker-task-1',
                workerSessionId: '44444444-4444-4444-8444-444444444444',
                status: 'running',
              }),
            ],
          }),
        }),
      }),
    });
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('syncs worker tasks before the phase handoff live-worker gate', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase());
    const session = {
      id: SESSION_ID,
      workspaceDir: workspaceDir!,
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: RUN_ID,
        },
      },
      scopeId: 'scope-1',
      workerTasks: [
        {
          taskId: 'worker-task-1',
          parentSessionId: SESSION_ID,
          workerSessionId: '44444444-4444-4444-8444-444444444444',
          workerType: 'recon_worker',
          status: 'running',
          reason: 'JS bundle review',
          task: 'Review JavaScript bundles',
          expectedArtifactType: 'JS secret scan results',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
      ],
    };
    const ctx = makeContext(workspaceDir!, {
      sessionStore: {
        get: vi.fn(() => session),
        setAsync: vi.fn(async (_sessionId: string, updated: unknown) => Object.assign(session, updated)),
        recordSessionCompletedAsync: vi.fn(async () => true),
      } as any,
      workers: {
        syncWorkerTasks: vi.fn(async () => {
          session.workerTasks = session.workerTasks.map((task) => ({
            ...task,
            status: 'completed',
            artifact: {
              taskId: task.taskId,
              workerType: task.workerType,
              summary: 'Worker result already submitted.',
              findings: [],
              evidenceRefs: [],
              touchedTargets: [],
            },
          }));
          return session.workerTasks as any;
        }),
      } as any,
    });

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'recon',
        status: 'completed',
        summary: 'Recon complete.',
      },
      ctx,
    );

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(ctx.workers?.syncWorkerTasks).toHaveBeenCalledWith(SESSION_ID);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(expect.objectContaining({
      phaseId: PHASE_ID,
      status: 'completed',
    }));
  });

  it('sets a one-turn repair nudge after repeated identical handoff gate failures', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValue(makeActivePhase());
    const ctx = makeContext(workspaceDir!);
    const payload = {
      phaseId: PHASE_ID,
      phase: 'validation',
      status: 'completed',
      summary: 'Done.',
    };

    await SubmitPhaseHandoff.run(payload, ctx);
    const result = await SubmitPhaseHandoff.run(payload, ctx);

    expect(result).toEqual({
      ok: false,
      data: expect.objectContaining({
        gate: expect.objectContaining({ code: 'active_phase_key_mismatch' }),
        gateFailureCount: 2,
        circuitBreaker: false,
      }),
    });
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    expect(session.flags.lifecycleGateFailures.phaseHandoff).toEqual(
      expect.objectContaining({
        code: 'active_phase_key_mismatch',
        count: 2,
      }),
    );
    expect(session.flags.ephemeralNudge).toContain('PHASE HANDOFF REPAIR REQUIRED');
    expect(session.flags.ephemeralNudge).toContain('active_phase_key_mismatch');
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('trips the phase handoff circuit breaker after repeated identical gate failures', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValue(makeActivePhase());
    const ctx = makeContext(workspaceDir!);
    const payload = {
      phaseId: PHASE_ID,
      phase: 'validation',
      status: 'completed',
      summary: 'Done.',
    };

    const first = await SubmitPhaseHandoff.run(payload, ctx);
    const second = await SubmitPhaseHandoff.run(payload, ctx);
    const third = await SubmitPhaseHandoff.run(payload, ctx);

    expect(first).toEqual({
      ok: false,
      data: expect.objectContaining({
        gate: expect.objectContaining({ code: 'active_phase_key_mismatch' }),
        gateFailureCount: 1,
        circuitBreaker: false,
      }),
    });
    expect(second).toEqual({
      ok: false,
      data: expect.objectContaining({
        gate: expect.objectContaining({ code: 'active_phase_key_mismatch' }),
        gateFailureCount: 2,
        circuitBreaker: false,
      }),
    });
    expect(third).toEqual({
      ok: false,
      data: expect.objectContaining({
        gate: expect.objectContaining({ code: 'active_phase_key_mismatch' }),
        gateFailureCount: 3,
        circuitBreaker: true,
      }),
    });

    const session = ctx.sessionStore.get(SESSION_ID) as any;
    expect(session.flags.lifecycleGateFailures.phaseHandoff).toEqual(
      expect.objectContaining({
        code: 'active_phase_key_mismatch',
        count: 3,
        circuitBreaker: true,
      }),
    );
    expect(session.flags.ephemeralNudge).toContain('PHASE HANDOFF REPAIR REQUIRED');
    expect(session.flags.ephemeralNudge).toContain('active_phase_key_mismatch');
    expect(session.flags.ephemeralNudge).toContain('Stop retrying the same completed handoff');
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('materializes validationTargets as validation.lead notes', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    securityOpsMocks.reportNote.mockResolvedValueOnce({
      noteId: 'lead-note-1',
      created: true,
      dedupeKey: 'dedupe-1',
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration found order route parameters.',
        validationTargets: [
          {
            riskFamily: 'idor',
            priority: 'high',
            method: 'GET',
            path: '/api/orders/{orderId}',
            parameter: 'orderId',
            hypothesis: 'orderId may be readable across users.',
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(securityOpsMocks.reportNote).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        input: expect.objectContaining({
          ntype: 'validation.lead',
          data: expect.objectContaining({
            source: 'phase-handoff:enumeration',
            riskFamily: 'idor',
            priority: 'high',
            method: 'GET',
            path: '/api/orders/{orderId}',
            parameter: 'orderId',
            status: 'open',
          }),
          evidence: [
            {
              path: '.artifacts/phase-handoffs/11111111-1111-4111-8111-111111111111.json',
              label: 'phase handoff',
            },
          ],
        }),
      }),
    );
    expect(securityOpsMocks.updateValidationLeadPromptMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        leadId: 'lead-note-1',
        promptPath: '.artifacts/lead-prompts/lead-note-1.md',
        promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        normalizedLead: expect.objectContaining({
          id: 'lead-note-1',
          promptPath: '.artifacts/lead-prompts/lead-note-1.md',
        }),
      }),
    );
    await expect(
      fs.readFile(path.join(workspaceDir!, '.artifacts', 'lead-prompts', 'lead-note-1.md'), 'utf8'),
    ).resolves.toContain('Prompt SHA256:');
    const artifact = JSON.parse(
      await fs.readFile(path.join(workspaceDir!, '.artifacts', 'phase-handoffs', `${PHASE_ID}.json`), 'utf8'),
    );
    expect(artifact.canonicalWrites.notes).toContain('lead-note-1');
    expect(result.data).toEqual(
      expect.objectContaining({
        materializedValidationLeadNoteIds: ['lead-note-1'],
      }),
    );
  });

  it('rejects unknown recommendedNextSkills with live-catalog guidance', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration found parameterized API routes.',
        recommendedNextPhase: 'validation',
        recommendedNextSkills: ['api-idor-testing'],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Unknown recommendedNextSkills: api-idor-testing'),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects phase-incompatible recommendedNextSkills unless a replan is requested', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration stayed in enumeration but requested validation tooling.',
        recommendedNextPhase: 'enumeration',
        recommendedNextSkills: ['broken-auth'],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Phase-incompatible recommended skills require replanRequest.needed=true'),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects completed reporting handoff that recommends another phase', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'reporting' }));
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'reporting',
        status: 'completed',
        summary: 'Report drafted.',
        recommendedNextPhase: 'validation',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('reporting cannot complete with recommendedNextPhase'),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('requires an explicit closeout outcome for zero-finding reporting completion', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'reporting' }));
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'reporting',
        status: 'completed',
        summary: 'No findings were reportable.',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('requires closeoutOutcome'),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('does not require pentest zero-finding closeout outcome for compliance reporting', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'reporting' }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.flags.securityops.workflowDiscipline = 'compliance';

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'reporting',
        status: 'completed',
        summary: 'Compliance readiness report completed with no security findings expected.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseId: PHASE_ID,
        status: 'completed',
      }),
    );
  });

  it('accepts zero-finding reporting completion when closeoutOutcome is explicit', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'reporting' }));
    const ctx = makeContext(workspaceDir!);

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'reporting',
        status: 'completed',
        summary: 'No findings were reportable after coverage was reviewed.',
        closeoutOutcome: 'no_findings_after_coverage',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseId: PHASE_ID,
        status: 'completed',
      }),
    );
  });

  it('blocks completed handoff when scanner output was not ingested or waived', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.flags.shellJobs = {
      'job-1': {
        jobId: 'job-1',
        status: 'completed',
        commandFinished: true,
        command:
          'ffuf -u https://api.example.com/FUZZ -w words.txt -of json -o /workspace/.artifacts/phases/enumeration/ffuf.json',
      },
    };

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration found candidate routes.',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('unresolved scanner ingest debt'),
      }),
    );
    expect((result.data as { error: string }).error).toContain('.artifacts/phases/enumeration/ffuf.json (parser=ffuf)');
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('allows scanner ingest debt when the handoff records an explicit waiver', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.flags.shellJobs = {
      'job-1': {
        jobId: 'job-1',
        status: 'completed',
        commandFinished: true,
        command:
          'ffuf -u https://api.example.com/FUZZ -w words.txt -of json -o /workspace/.artifacts/phases/enumeration/ffuf.json',
      },
    };

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration found no new routes; ffuf output was an empty JSON skeleton.',
        scannerIngestWaivers: [
          {
            parser: 'ffuf',
            artifactPath: '.artifacts/phases/enumeration/ffuf.json',
            reason: 'Empty scanner output; no endpoints to ingest.',
            nextStep: 'Continue with manual API route validation from canonical inventory.',
          },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseId: PHASE_ID,
        status: 'completed',
      }),
    );
  });

  it('allows scanner ingest debt when the artifact was already ingested', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'enumeration' }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.flags.securityops.ingestedScannerArtifacts = [
      {
        parser: 'ffuf',
        artifactPath: '.artifacts/phases/enumeration/ffuf.json',
      },
    ];
    session.flags.shellJobs = {
      'job-1': {
        jobId: 'job-1',
        status: 'completed',
        commandFinished: true,
        command:
          'ffuf -u https://api.example.com/FUZZ -w words.txt -of json -o /workspace/.artifacts/phases/enumeration/ffuf.json',
      },
    };

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'enumeration',
        status: 'completed',
        summary: 'Enumeration ingested its ffuf output.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseId: PHASE_ID,
        status: 'completed',
      }),
    );
  });

  it('surfaces scanner budget and partial-ingestion state in handoff preflight', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.flags.securityops.scannerBudget = {
      'job-1': {
        jobId: 'job-1',
        scannerFamily: 'nuclei',
        phaseKey: 'validation',
        status: 'completed',
        elapsedMs: 181_000,
        maxScannerWallSeconds: 180,
        budgetExceeded: true,
        partialIngestionSuggestedAt: '2026-05-26T00:00:00.000Z',
      },
    };
    session.flags.shellJobs = {
      'job-1': {
        jobId: 'job-1',
        status: 'completed',
        commandFinished: true,
        command: 'nuclei -u https://api.example.com -jsonl -o /workspace/.artifacts/phases/validation/nuclei.jsonl',
      },
    };

    const result = await ValidationHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Validation scanner completed with output.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result.data as any).failureCodes).toContain('scanner_ingest_debt');
    expect((result.data as any).scannerIngest).toMatchObject({
      unresolvedCount: 1,
      budgetExceededCount: 1,
      unresolved: [
        {
          parser: 'nuclei',
          artifactPath: '.artifacts/phases/validation/nuclei.jsonl',
          budgetExceeded: true,
          partialIngestionSuggested: true,
        },
      ],
    });
  });

  it('blocks validation completion while rendered canonical leads remain open', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    securityOpsMocks.queryNotes.mockResolvedValueOnce({
      notes: [
        {
          id: 'lead-1',
          data: {
            riskFamily: 'idor',
            status: 'open',
          },
        },
        {
          id: 'lead-2',
          data: {
            riskFamily: 'broken-auth',
            status: 'validated',
          },
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.openValidationLeadIds = ['lead-1', 'lead-2'];

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'validation',
        status: 'completed',
        summary: 'Validation finished.',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('rendered validation leads remain open'),
      }),
    );
    expect((result.data as { error: string }).error).toContain('lead-1 (idor)');
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('preflights validation completion without closing the phase', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    securityOpsMocks.queryNotes.mockResolvedValueOnce({
      notes: [
        {
          id: 'lead-1',
          data: {
            riskFamily: 'idor',
            status: 'open',
          },
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.openValidationLeadIds = ['lead-1'];

    const result = await ValidationHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Validation looks complete.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        phase: 'validation',
        canSubmit: false,
        failureCodes: ['open_validation_leads'],
        submitTool: 'submit_phase_handoff',
        handoffPayloadSkeleton: expect.objectContaining({
          phase: 'validation',
        }),
      }),
    );
    expect((result.data as any).failures[0]).toEqual(
      expect.objectContaining({
        code: 'open_validation_leads',
        suggestedTool: 'submit_validation_lead_outcome',
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('blocks control assessment completion until every selected control has a check', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'control_assessment' }));
    securityOpsMocks.queryComplianceReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'soc2',
          controls: [
            {
              id: 'CC6.1',
              controlChecks: [{ runId: RUN_ID, fresh: true }],
            },
            {
              id: 'CC6.2',
              controlChecks: [],
            },
          ],
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.complianceAssessment = {
      framework: 'soc2',
      controlIds: ['CC6.1', 'CC6.2'],
      proofObligationIds: ['soc2-cc6.1-authz-v1', 'soc2-cc6.2-credential-lifecycle-v1'],
    };

    const result = await ControlAssessmentHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Control assessment finished.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        phase: 'control_assessment',
        canSubmit: false,
        failureCodes: ['missing_control_checks'],
      }),
    );
    expect((result.data as any).failures[0]).toEqual(
      expect.objectContaining({
        code: 'missing_control_checks',
        suggestedTool: 'record_control_check',
        currentState: expect.objectContaining({
          missingControlIds: ['CC6.2'],
        }),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('uses the selected framework when gating ISO control assessment completion', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'control_assessment' }));
    securityOpsMocks.queryComplianceReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'iso27001',
          controls: [
            {
              id: 'ISO-A-TECH-IAM',
              controlChecks: [{ runId: RUN_ID, fresh: true }],
            },
            {
              id: 'ISO-A-TECH-AUTHZ',
              controlChecks: [],
            },
          ],
        },
        {
          key: 'soc2',
          controls: [
            {
              id: 'CC6.1',
              controlChecks: [{ runId: RUN_ID, fresh: true }],
            },
          ],
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.complianceAssessment = {
      framework: 'iso27001',
      controlIds: ['ISO-A-TECH-IAM', 'iso-a-tech-authz'],
      proofObligationIds: ['iso27001-iam-authentication-v1', 'iso27001-authorization-boundary-v1'],
    };

    const result = await ControlAssessmentHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'ISO control assessment finished.',
      },
      ctx,
    );

    expect(securityOpsMocks.queryComplianceReadiness).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ framework: 'iso27001' }),
    }));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        phase: 'control_assessment',
        canSubmit: false,
        failureCodes: ['missing_control_checks'],
      }),
    );
    expect((result.data as any).failures[0]).toEqual(
      expect.objectContaining({
        code: 'missing_control_checks',
        currentState: expect.objectContaining({
          selectedControlIds: ['ISO-A-TECH-IAM', 'ISO-A-TECH-AUTHZ'],
          missingControlIds: ['ISO-A-TECH-AUTHZ'],
        }),
        expectedShape: expect.objectContaining({
          record_control_check: expect.objectContaining({ frameworkKey: 'iso27001' }),
        }),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('uses only NIST CSF Category checks when gating NIST control assessment completion', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'control_assessment' }));
    securityOpsMocks.queryComplianceReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'nist_csf',
          controls: [
            { id: 'ID.AM', controlChecks: [{ runId: RUN_ID, fresh: true }] },
            { id: 'DE.CM', controlChecks: [] },
          ],
        },
        {
          key: 'iso27001',
          controls: [{ id: 'ISO-A-ORG-ASSETS', controlChecks: [{ runId: RUN_ID, fresh: true }] }],
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.complianceAssessment = {
      framework: 'nist_csf',
      controlIds: ['id.am', 'DE.CM'],
      proofObligationIds: ['nist-id.am-inventory-v1', 'nist-de.cm-monitoring-v1'],
    };

    const result = await ControlAssessmentHandoffPreflight.run(
      { status: 'completed', summary: 'NIST CSF control assessment finished.' },
      ctx,
    );

    expect(securityOpsMocks.queryComplianceReadiness).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ framework: 'nist_csf' }),
    }));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      success: true,
      phase: 'control_assessment',
      canSubmit: false,
      failureCodes: ['missing_control_checks'],
    }));
    expect((result.data as any).failures[0]).toEqual(expect.objectContaining({
      currentState: expect.objectContaining({
        selectedControlIds: ['ID.AM', 'DE.CM'],
        missingControlIds: ['DE.CM'],
      }),
      expectedShape: expect.objectContaining({
        record_control_check: expect.objectContaining({ frameworkKey: 'nist_csf' }),
      }),
    }));
  });

  it('canonicalizes selected control ids before evaluating control assessment completion', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'control_assessment' }));
    securityOpsMocks.queryComplianceReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'soc2',
          controls: [
            {
              id: 'CC6.1',
              controlChecks: [{ runId: RUN_ID, fresh: true }],
            },
            {
              id: 'CC6.2',
              controlChecks: [{ runId: RUN_ID, fresh: true }],
            },
          ],
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.complianceAssessment = {
      framework: 'soc2',
      controlIds: ['CC6.1', 'cc6.1', 'cc6.2', 'CC6.2'],
      proofObligationIds: ['soc2-cc6.1-authz-v1', 'SOC2-CC6.1-AUTHZ-V1'],
    };

    const result = await ControlAssessmentHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Control assessment finished.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        phase: 'control_assessment',
        canSubmit: true,
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('allows control assessment preflight when a selected control has an actionable request from the run', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'control_assessment' }));
    securityOpsMocks.queryComplianceReadiness.mockResolvedValueOnce({
      frameworks: [
        {
          key: 'soc2',
          controls: [
            {
              id: 'CC1.1',
              controlChecks: [],
              actionRequests: [{ runId: RUN_ID, status: 'open' }],
            },
          ],
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.complianceAssessment = {
      framework: 'soc2',
      controlIds: ['CC1.1'],
      proofObligationIds: ['evidence-review:soc2:cc1.1'],
    };

    const result = await ControlAssessmentHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Control assessment finished with a user evidence request.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        phase: 'control_assessment',
        canSubmit: true,
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('blocks validation completion when touched candidate Risks remain potential or verifying', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    securityOpsMocks.queryFindings.mockResolvedValueOnce({
      findings: [
        {
          id: 'finding-1',
          title: 'Reproduced exposure',
          severity: 'high',
          state: 'potential',
          missingReportFields: ['businessImpact'],
        },
      ],
      totalCount: 1,
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.candidateFindingIds = ['finding-1'];
    session.flags.securityops.candidateFindingCount = 1;

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'validation',
        status: 'completed',
        summary: 'Validation reproduced the candidate.',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('candidate Risks touched by this session remain potential or verifying'),
        gate: expect.objectContaining({
          code: 'unclosed_validation_findings',
          suggestedTool: 'submit_validation_outcome',
        }),
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('preflights validation finding disposition without closing the phase', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    securityOpsMocks.queryFindings.mockResolvedValueOnce({
      findings: [
        {
          id: 'finding-1',
          title: 'Reproduced exposure',
          severity: 'high',
          state: 'potential',
          missingReportFields: ['businessImpact'],
        },
      ],
      totalCount: 1,
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.candidateFindingIds = ['finding-1'];
    session.flags.securityops.candidateFindingCount = 1;

    const result = await ValidationHandoffPreflight.run(
      {
        status: 'completed',
        summary: 'Validation looks complete.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        canSubmit: false,
        failureCodes: ['unclosed_validation_findings'],
      }),
    );
    expect((result.data as any).failures[0]).toEqual(
      expect.objectContaining({
        code: 'unclosed_validation_findings',
        suggestedTool: 'submit_validation_outcome',
      }),
    );
    expect(phaseRepoMocks.updateStatus).not.toHaveBeenCalled();
  });

  it('accepts validation completion when terminal successor notes supersede rendered leads', async () => {
    phaseRepoMocks.findActiveBySessionId.mockResolvedValueOnce(makeActivePhase({ phaseKey: 'validation' }));
    securityOpsMocks.queryNotes.mockResolvedValueOnce({
      notes: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          data: {
            riskFamily: 'idor',
            status: 'open',
          },
        },
        {
          id: 'successor-1',
          title: 'Lead 11111111 - IDOR validation resolved',
          data: {
            riskFamily: 'idor',
            status: 'validated',
            supersedesLeadId: '11111111-1111-4111-8111-111111111111',
          },
        },
      ],
    });
    const ctx = makeContext(workspaceDir!);
    const session = ctx.sessionStore.get(SESSION_ID) as any;
    session.userId = 'user-1';
    session.flags.securityops.openValidationLeadIds = ['11111111-1111-4111-8111-111111111111'];

    const result = await SubmitPhaseHandoff.run(
      {
        phaseId: PHASE_ID,
        phase: 'validation',
        status: 'completed',
        summary: 'Validation finished and terminal successor notes resolved the rendered lead.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(phaseRepoMocks.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseId: PHASE_ID,
        status: 'completed',
      }),
    );
  });
});
