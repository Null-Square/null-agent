import { describe, expect, it, vi } from 'vitest';
import { SpawnWorker, SubmitWorkerResult, WaitForWorker } from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolContext } from '@/domains/agent-brain/application/tools';
import type {
  EnumerationMissionV1,
  SessionState,
  WorkerTaskRecord,
} from '@/domains/agent-brain/domain/types';
import {
  buildEnumerationAttemptReservation,
  computeEnumerationMissionFingerprint,
} from '@/domains/agent-brain/domain/workers/enumerationContracts';

const hash = (character: string): string => character.repeat(64);

const makeContext = (
  sessionOverrides: Partial<SessionState> = {},
  overrides: Partial<ToolContext> = {},
): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: {} as any,
    sessionStore: {
      get: vi.fn(() => ({
        id: 'session-1',
        messages: [],
        plan: [],
        memory: {
          discoveredFacts: [],
          attemptedTechniques: {},
          failedApproaches: [],
          testedEndpoints: [],
        },
        flags: {},
        workspaceDir: '/tmp/workspace',
        createdAt: Date.now(),
        lastActive: Date.now(),
        turn: 0,
        checkpoints: {},
        agentType: 'executor',
        coordination: { role: 'direct' },
        ...sessionOverrides,
      })),
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
    flags: {},
    planRuntime: {
      getCurrentPlan: vi.fn(() => []),
    } as any,
    workers: {
      spawnWorker: vi.fn(async () => ({
        task: { taskId: 'task-1', status: 'pending', workerType: 'recon_worker' },
        sessionId: 'worker-1',
      })),
      continueWorker: vi.fn(),
      stopWorker: vi.fn(),
      waitForWorker: vi.fn(),
    } as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;

const mission = {
  question: 'What public routes are reachable?',
  why_ready_now: 'The plan selected a recon mission.',
  required_evidence: ['HTTP status codes'],
  expected_artifact: 'Surface map',
  stop_condition: 'Primary routes are mapped or blocked.',
  assigned_skills: ['broad-surface-scan'],
};

describe('workers builtins', () => {
  it('blocks spawn_worker when reporting reserve would be violated', async () => {
    const ctx = makeContext(
      { agentType: 'executor', coordination: { role: 'direct' } as any },
      {
        budget: {
          maxToolCalls: 20,
          usedToolCalls: 15,
          remainingToolCalls: 5,
          reservedToolCalls: 6,
        },
      },
    );

    const result = await SpawnWorker.run(
      {
        workerType: 'recon_worker',
        task: 'Enumerate the surface',
        reason: 'Need broader discovery',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        reserveActive: true,
        error: expect.stringContaining('reserved for required completion work'),
      }),
    );
    expect(ctx.workers?.spawnWorker).not.toHaveBeenCalled();
  });

  it('spawns a worker with no credit state or balance: Null AI charges nothing', async () => {
    const ctx = makeContext(
      {
        agentType: 'executor',
        coordination: { role: 'direct' } as any,
        flags: {
          securityops: { runId: 'run-1' },
          token_usage_history: {
            entries: [{ credits: 0 }, { credits: 0 }, { credits: 0 }],
          },
        },
      },
    );

    const result = await SpawnWorker.run(
      {
        workerType: 'recon_worker',
        task: 'Enumerate the surface',
        reason: 'Need broader discovery',
        mission,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ctx.workers?.spawnWorker).toHaveBeenCalled();
    expect(ctx.workers?.spawnWorker).not.toHaveBeenCalledWith(
      expect.objectContaining({ enumerationCreditReservation: expect.anything() }),
    );
  });

  it('requires a typed mission envelope only for enumeration_worker and attack_worker spawns', async () => {
    const ctx = makeContext({
      agentType: 'executor',
      coordination: { role: 'direct' } as any,
      flags: {
        securityops: { runId: 'run-1' },
      },
    });

    const result = await SpawnWorker.run(
      {
        workerType: 'enumeration_worker',
        task: 'Hunt the surface',
        reason: 'Need bounded enumeration',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('requires a typed mission envelope'),
      }),
    );
    expect(ctx.workers?.spawnWorker).not.toHaveBeenCalled();
  });

  it('advertises compliance worker roles and control assessment phases', () => {
    const schema = SpawnWorker.meta.schema as {
      properties?: Record<string, {
        enum?: string[];
        properties?: Record<string, { enum?: string[] }>;
      }>;
    };
    const workerTypeSchema = schema.properties?.workerType;
    const missionSchema = schema.properties?.mission;

    expect(workerTypeSchema?.enum).toContain('compliance_control_worker');
    expect(missionSchema?.properties?.phase?.enum).toContain('control_assessment');
    expect(SpawnWorker.meta.description).toContain('mission.phase="control_assessment"');
  });

  it('blocks a new SecurityOps worker wave when active workers already meet the cap', async () => {
    const ctx = makeContext({
      agentType: 'executor',
      coordination: { role: 'direct' } as any,
      flags: {
        securityops: { runId: 'run-1', maxActiveWorkers: 2 },
      },
      workerTasks: [
        { taskId: 'task-a', status: 'running', workerType: 'recon_worker' },
        { taskId: 'task-b', status: 'pending', workerType: 'recon_worker' },
      ] as any,
    });

    const result = await SpawnWorker.run(
      {
        workerType: 'recon_worker',
        task: 'Enumerate another host',
        reason: 'Need broader discovery',
        mission,
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        workerAdmissionActive: true,
        activeWorkerCount: 2,
        maxActiveWorkers: 2,
        activeTaskIds: ['task-a', 'task-b'],
        nextAction: 'wait_for_worker',
      }),
    );
    expect(ctx.workers?.spawnWorker).not.toHaveBeenCalled();
  });

  it('passes the graph-lite mission envelope through to worker delegation', async () => {
    const ctx = makeContext({
      agentType: 'executor',
      coordination: { role: 'direct' } as any,
      flags: {
        securityops: { runId: 'run-1' },
      },
    });

    const result = await SpawnWorker.run(
      {
        workerType: 'recon_worker',
        task: 'Enumerate the surface',
        reason: 'Need broader discovery',
        mission,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ctx.workers?.spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        mission: expect.objectContaining({
          question: mission.question,
          whyReadyNow: mission.why_ready_now,
          requiredEvidence: mission.required_evidence,
          expectedArtifact: mission.expected_artifact,
          stopCondition: mission.stop_condition,
        }),
      }),
    );
  });

  it('passes a compliance control assessment worker mission through to worker delegation', async () => {
    const ctx = makeContext({
      agentType: 'executor',
      coordination: { role: 'direct' } as any,
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseKey: 'control_assessment',
        },
      },
    }, {
      workers: {
        spawnWorker: vi.fn(async (input: any) => ({
          task: {
            taskId: 'task-compliance',
            status: 'pending',
            workerType: input.workerType,
            mission: input.mission,
          },
          sessionId: 'worker-compliance',
        })),
        continueWorker: vi.fn(),
        stopWorker: vi.fn(),
        waitForWorker: vi.fn(),
      } as any,
    });

    const result = await SpawnWorker.run(
      {
        workerType: 'compliance_control_worker',
        task: 'Review uploaded evidence for selected SOC 2 controls',
        reason: 'Document review can run as a bounded sidecar.',
        mission: {
          ...mission,
          phase: 'control_assessment',
          question: 'Do uploaded evidence files support selected SOC 2 controls?',
          assigned_skills: ['compliance-evidence-review'],
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ctx.workers?.spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        workerType: 'compliance_control_worker',
        mission: expect.objectContaining({
          phase: 'control_assessment',
          assignedSkills: ['compliance-evidence-review'],
        }),
      }),
    );
  });

  it('accepts enumeration drafts while canonicalizing server-owned bookkeeping', async () => {
    const enumerationMissionBase: EnumerationMissionV1 = {
      schemaVersion: 1,
      kind: 'enumeration_hunt_v1',
      phaseAttemptId: 'phase-b8',
      targetRef: 'http://target.local',
      surface: { kind: 'path_prefix_set', refs: ['/'] },
      techniqueIds: ['PS-CMDI'],
      primarySkill: { slug: 'command-injection', versionHash: hash('a') },
      supportingSkills: [],
      personaRefs: [],
      sourceMode: 'blackbox',
      impactCeiling: 'poc',
      budgets: {
        maxToolCalls: 22,
        maxTargetRequests: 40,
        maxRequestConcurrency: 2,
        maxWallSeconds: 600,
        maxArtifactFiles: 15,
        maxArtifactBytes: 5 * 1024 * 1024,
        maxLeads: 5,
        maxStateChanges: 0,
      },
      stop: {
        whenTechniquesExhausted: true,
        whenBlockedByPolicy: true,
        maxHighConfidenceLeads: 2,
      },
      missionFingerprint: hash('0'),
    };
    const enumerationMission = {
      ...enumerationMissionBase,
      missionFingerprint: computeEnumerationMissionFingerprint('run-b8', enumerationMissionBase),
    };
    const serverAttempt = {
      ...buildEnumerationAttemptReservation(
        enumerationMission,
        'http_payload',
        { url: 'http://target.local/wp-content/plugins/hello.php', method: 'GET' },
        1,
        1_000,
      ),
      completedAt: 2_000,
      status: 'completed' as const,
    };
    const task: WorkerTaskRecord = {
      taskId: '00000000-0000-4000-8000-0000000000b8',
      parentSessionId: 'parent-session',
      workerSessionId: 'worker-session',
      workerType: 'enumeration_worker',
      status: 'running',
      reason: 'B8 enumeration',
      task: 'Enumerate command injection',
      expectedArtifactType: 'enumeration_result/v1',
      executionMode: 'blocking',
      continuationMode: 'spawn',
      mission: {
        phase: 'enumeration',
        question: 'Find command injection leads.',
        whyReadyNow: 'Target is isolated.',
        requiredEvidence: ['/'],
        expectedArtifact: 'enumeration_result/v1',
        stopCondition: 'Lead, negative, or blocker submitted.',
        assignedSkills: ['command-injection'],
        enumeration: enumerationMission,
      },
      budget: enumerationMission.budgets,
      targetRequestsUsed: 1,
      enumerationAttempts: [serverAttempt],
      createdAt: 1,
    };
    const sessions = new Map<string, SessionState>();
    const parentSession = {
      id: 'parent-session',
      messages: [],
      plan: [],
      memory: {
        discoveredFacts: [],
        attemptedTechniques: {},
        failedApproaches: [],
        testedEndpoints: [],
      },
      flags: {},
      workspaceDir: '/tmp/workspace',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 0,
      checkpoints: {},
      agentType: 'executor',
      coordination: { role: 'direct' },
      workerTasks: [task],
    } as SessionState;
    const workerSession = {
      ...parentSession,
      id: 'worker-session',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-session',
        parentTaskId: task.taskId,
        workerType: 'enumeration_worker',
        expectedArtifactType: 'enumeration_result/v1',
      },
      flags: {
        securityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-b8',
        },
      },
      workerTasks: [],
    } as SessionState;
    sessions.set(parentSession.id, parentSession);
    sessions.set(workerSession.id, workerSession);

    const ctx = makeContext(workerSession, {
      sessionId: workerSession.id,
      sandbox: {} as any,
      sessionStore: {
        get: vi.fn((id: string) => sessions.get(id)),
        setAsync: vi.fn(async (id: string, session: SessionState) => {
          sessions.set(id, session);
        }),
        recordSessionCompletedAsync: vi.fn(async (id: string) => {
          const session = sessions.get(id);
          if (!session) return false;
          session.completed = true;
          sessions.set(id, session);
          return true;
        }),
      } as any,
    });

    const result = await SubmitWorkerResult.run(
      {
        summary: 'Command injection lead candidate found from bounded HTTP probing.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: ['http://target.local/'],
        confidence: 0.7,
        enumeration: {
          schemaVersion: 1,
          resultHash: 'model-draft-hash',
          status: 'partial',
          leads: [{
            localId: 'lead-1',
            riskFamily: 'command-injection',
            techniqueId: 'PS-CMDI',
            targetRef: 'http://target.local',
            surfaceRef: '/',
            hypothesis: 'The plugin endpoint may pass user input into command execution.',
            observation: 'A bounded request reached the expected plugin endpoint behavior.',
            validationGoal: 'Validate command execution independently with non-destructive proof.',
            requiredControls: [],
            prerequisites: [],
            evidenceRefs: ['/workspace/.artifacts/tool-results/http-payload.json'],
            evidenceState: 'needs_evidence',
            confidence: 0.7,
            priority: 'high',
            authContextClass: 'anonymous',
          }],
          negativeResults: [{
            localId: 'neg-1',
            surfaceRef: '/',
            techniqueId: 'PS-CMDI',
            controlOrBaseline: 'plain route baseline',
            evidenceRefs: [],
            conclusion: 'Baseline request did not prove exploitability by itself.',
            confidence: 0.5,
          }],
          attempts: [],
          coverage: {
            requested: { surfaceRefs: ['/wrong'], techniqueIds: ['wrong'] },
            counts: { attempts: 99, requests: 99, leads: 99, negativeResults: 99 },
          },
          blockers: [],
          artifacts: [{
            id: 'http-payload-result',
            path: '/workspace/.artifacts/tool-results/http-payload.json',
            sha256: hash('1'),
            bytes: 128,
            contentType: 'application/json',
            purpose: 'server tool result',
            sensitivity: 'internal',
          }],
          recommendedValidationMissions: [{
            leadLocalId: 'lead-1',
            question: 'Can the command injection hypothesis be independently validated?',
            requiredEvidence: ['non-destructive proof'],
            stopCondition: 'Validated, refuted, or blocked.',
            priority: 'high',
          }],
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ success: true, terminal: true }));
    const artifact = (result.data as any).artifact;
    expect(artifact.evidenceRefs).toContain('/workspace/.artifacts/tool-results/http-payload.json');
    expect(artifact.sourceEvidenceRefs).toContain('/workspace/.artifacts/tool-results/http-payload.json');
    expect(artifact.enumeration.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.enumeration.skills).toEqual([{ ...enumerationMission.primarySkill, role: 'primary' }]);
    expect(artifact.enumeration.attempts).toEqual([
      expect.objectContaining({
        fingerprint: serverAttempt.fingerprintsByTechnique['PS-CMDI'],
        requestCount: 1,
      }),
    ]);
    expect(artifact.enumeration.coverage.counts).toEqual({
      attempts: 1,
      requests: 1,
      leads: 1,
      negativeResults: 1,
    });
    expect(artifact.enumeration.leads[0].attemptFingerprints).toEqual([
      serverAttempt.fingerprintsByTechnique['PS-CMDI'],
    ]);
    expect(artifact.enumeration.negativeResults[0].attemptFingerprints).toEqual([
      serverAttempt.fingerprintsByTechnique['PS-CMDI'],
    ]);
    expect(artifact.enumeration.artifacts).toEqual([]);
  });

  it('returns a normal success payload when wait_for_worker is used on a sidecar', async () => {
    const ctx = makeContext({}, {
      workers: {
        spawnWorker: vi.fn(),
        continueWorker: vi.fn(),
        stopWorker: vi.fn(),
        waitForWorker: vi.fn(async () => ({
          task: {
            taskId: 'task-sidecar',
            parentSessionId: 'session-1',
            workerSessionId: 'worker-1',
            workerType: 'recon_worker',
            status: 'running',
            reason: 'Parallel recon branch',
            task: 'Map the public surface.',
            expectedArtifactType: 'surface_map',
            executionMode: 'background',
            dependencyMode: 'sidecar',
            continuationMode: 'spawn',
            createdAt: Date.now(),
          },
          sessionId: 'worker-1',
        })),
      } as any,
    });

    const result = await WaitForWorker.run(
      {
        taskId: 'task-sidecar',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          taskId: 'task-sidecar',
          status: 'running',
        }),
      }),
    );
  });

  it('allows wait_for_worker without taskId to yield until any worker event', async () => {
    const ctx = makeContext({}, {
      workers: {
        spawnWorker: vi.fn(),
        continueWorker: vi.fn(),
        stopWorker: vi.fn(),
        waitForWorker: vi.fn(async () => ({
          task: {
            taskId: 'task-any',
            parentSessionId: 'session-1',
            workerSessionId: 'worker-1',
            workerType: 'recon_worker',
            status: 'completed',
            reason: 'Parallel recon branch',
            task: 'Map the public surface.',
            expectedArtifactType: 'surface_map',
            executionMode: 'background',
            dependencyMode: 'sidecar',
            continuationMode: 'spawn',
            createdAt: Date.now(),
          },
          sessionId: 'worker-1',
        })),
      } as any,
    });

    const result = await WaitForWorker.run({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          taskId: 'task-any',
          status: 'completed',
        }),
      }),
    );
    expect(ctx.workers?.waitForWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-1',
      }),
    );
  });

  it('returns a normal success payload when wait_for_worker() with no taskId waits on any worker', async () => {
    const ctx = makeContext({}, {
      workers: {
        spawnWorker: vi.fn(),
        continueWorker: vi.fn(),
        stopWorker: vi.fn(),
        waitForWorker: vi.fn(async () => ({
          task: {
            taskId: 'task-wave-1',
            parentSessionId: 'session-1',
            workerSessionId: 'worker-1',
            workerType: 'recon_worker',
            status: 'running',
            reason: 'Parallel recon branch',
            task: 'Map the public surface.',
            expectedArtifactType: 'surface_map',
            executionMode: 'background',
            dependencyMode: 'sidecar',
            continuationMode: 'spawn',
            createdAt: Date.now(),
          },
          sessionId: 'worker-1',
        })),
      } as any,
    });

    const result = await WaitForWorker.run({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          taskId: 'task-wave-1',
          status: 'running',
        }),
      }),
    );
  });
});
