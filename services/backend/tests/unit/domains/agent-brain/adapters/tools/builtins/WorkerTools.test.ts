import { describe, expect, it, vi } from 'vitest';

const securityOpsMocks = vi.hoisted(() => ({
  reportNote: vi.fn(),
  queryNotes: vi.fn(async () => ({ notes: [] })),
  flushProjection: vi.fn(async () => ({})),
}));

vi.mock(
  '@/domains/agent-brain/adapters/tools/builtins/securityopsServiceRegistry',
  () => ({
    getSecurityOpsService: () => ({
      reportNote: securityOpsMocks.reportNote,
      queryNotes: securityOpsMocks.queryNotes,
    }),
  }),
);

vi.mock(
  '@/domains/security-ops/workspace/workspaceProjectionRuntime',
  () => ({
    flushWorkspaceProjectionForTool: securityOpsMocks.flushProjection,
  }),
);

import {
  SubmitEnumerationDisposition,
  SubmitWorkerResult,
} from '@/domains/agent-brain/adapters/tools/builtins/workers';
import { makeSession, createInMemorySessionStore } from '../../../../../helpers/mockSession.helper';

const buildEnumerationParent = () => makeSession({
  id: 'parent-1',
  userId: 'user-1',
  agentType: 'executor',
  mode: 'automated',
  flags: {
    securityops: {
      activePhaseKey: 'enumeration',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      runId: 'run-1',
    },
  },
  coordination: { role: 'direct' },
  workerTasks: [{
    taskId: '00000000-0000-4000-8000-000000000001',
    parentSessionId: 'parent-1',
    workerSessionId: 'worker-1',
    workerType: 'enumeration_worker',
    status: 'completed',
    reason: 'bounded hunt',
    task: 'enumerate one endpoint',
    expectedArtifactType: 'enumeration_result/v1',
    executionMode: 'background',
    continuationMode: 'spawn',
    createdAt: 1,
    artifact: {
      taskId: '00000000-0000-4000-8000-000000000001',
      workerType: 'enumeration_worker',
      summary: 'one lead',
      findings: [],
      evidenceRefs: ['/workspace/.artifacts/evidence.json'],
      touchedTargets: [],
      enumeration: {
        schemaVersion: 1,
        missionFingerprint: 'a'.repeat(64),
        resultHash: 'b'.repeat(64),
        status: 'completed',
        targetRef: 'https://app.example.com',
        surfaceRefs: ['/api/users/{id}'],
        skills: [],
        leads: [{
          localId: 'lead-1',
          serverFingerprint: 'c'.repeat(64),
          riskFamily: 'idor',
          techniqueId: 'T-IDOR',
          targetRef: 'https://app.example.com',
          surfaceRef: '/api/users/{id}',
          hypothesis: 'Object authorization may drift.',
          observation: 'Responses differ.',
          validationGoal: 'Reproduce with two users.',
          requiredControls: [],
          prerequisites: [],
          evidenceRefs: ['/workspace/.artifacts/evidence.json'],
          evidenceState: 'durable',
          confidence: 0.8,
          priority: 'high',
          authContextClass: 'anonymous',
          attemptFingerprints: [],
        }],
        negativeResults: [],
        attempts: [],
        coverage: {
          requested: { surfaceRefs: [], techniqueIds: [], personaClasses: [] },
          attempted: { surfaceRefs: [], techniqueIds: [], personaClasses: [] },
          counts: { attempts: 0, requests: 0, leads: 1, negativeResults: 0 },
          uncovered: [],
        },
        blockers: [],
        artifacts: [],
        recommendedValidationMissions: [],
      },
    },
  }],
} as any);

describe('SubmitWorkerResult', () => {
  it('persists a structured artifact and completes the worker session', async () => {
    const session = makeSession({
      id: 'worker-1',
      agentType: 'executor',
      mode: 'automated',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
      pendingApproval: {
        actionId: 'approval-1',
        tool: 'browser_action',
        toolCallId: 'approval-1',
      },
    });
    const sessionStore = createInMemorySessionStore([session as any]);

    const result = await SubmitWorkerResult.run(
      {
        summary: 'Mapped the public auth surface area.',
        findings: ['Found login and reset forms'],
        evidenceRefs: ['https://target.test/login'],
        touchedTargets: ['/login', '/forgot-password'],
        recommendedNextAction: 'Send a validator worker to reproduce reset flow issues.',
        confidence: 0.87,
      },
      {
        sessionId: session.id,
        sessionStore: sessionStore as any,
        approvals: { require: vi.fn() },
        policies: {
          requireApproval: false,
          maxStdoutBytes: 1024,
          timeoutMs: 1000,
        },
      } as any,
    );

    const updated = sessionStore.get(session.id);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          success: true,
          terminal: true,
          nextAction: 'stop',
          artifact: expect.objectContaining({
            taskId: 'task-1',
            workerType: 'recon_worker',
            summary: 'Mapped the public auth surface area.',
          }),
        }),
      }),
    );
    expect(updated?.completed).toBe(true);
    expect(updated?.summary).toBe('Mapped the public auth surface area.');
    expect(updated?.pendingApproval).toBeUndefined();
    expect((updated?.flags?.session as Record<string, unknown> | undefined)?.completed).toBe(true);
  });

  it('rejects repeat submissions without overwriting the recorded worker artifact', async () => {
    const session = makeSession({
      id: 'worker-1',
      agentType: 'executor',
      mode: 'automated',
      completed: true,
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
      workerResult: {
        taskId: 'task-1',
        workerType: 'recon_worker',
        summary: 'Original artifact',
        findings: ['original'],
        evidenceRefs: ['/workspace/.artifacts/original.json'],
        touchedTargets: ['/login'],
      },
    });
    const sessionStore = createInMemorySessionStore([session as any]);

    const result = await SubmitWorkerResult.run(
      {
        summary: 'Overwritten artifact',
        findings: ['new'],
        evidenceRefs: ['/workspace/.artifacts/new.json'],
        touchedTargets: ['/admin'],
      },
      {
        sessionId: session.id,
        sessionStore: sessionStore as any,
        approvals: { require: vi.fn() },
        policies: {
          requireApproval: false,
          maxStdoutBytes: 1024,
          timeoutMs: 1000,
        },
      } as any,
    );

    const updated = sessionStore.get(session.id);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          success: false,
          alreadySubmitted: true,
          terminal: true,
          nextAction: 'stop',
          artifact: expect.objectContaining({ summary: 'Original artifact' }),
        }),
      }),
    );
    expect(updated?.workerResult?.summary).toBe('Original artifact');
  });
});

describe('SubmitEnumerationDisposition', () => {
  it('requires an exhaustive lead disposition before canonical writes', async () => {
    const session = makeSession({
      id: 'parent-1',
      userId: 'user-1',
      agentType: 'executor',
      mode: 'automated',
      flags: {
        securityops: {
          activePhaseKey: 'enumeration',
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
        },
      },
      coordination: { role: 'direct' },
      workerTasks: [{
        taskId: '00000000-0000-4000-8000-000000000001',
        parentSessionId: 'parent-1',
        workerSessionId: 'worker-1',
        workerType: 'enumeration_worker',
        status: 'completed',
        reason: 'bounded hunt',
        task: 'enumerate one endpoint',
        expectedArtifactType: 'enumeration_result/v1',
        executionMode: 'background',
        continuationMode: 'spawn',
        createdAt: 1,
        artifact: {
          taskId: '00000000-0000-4000-8000-000000000001',
          workerType: 'enumeration_worker',
          summary: 'one lead',
          findings: [],
          evidenceRefs: [],
          touchedTargets: [],
          enumeration: {
            schemaVersion: 1,
            missionFingerprint: 'a'.repeat(64),
            resultHash: 'b'.repeat(64),
            status: 'completed',
            targetRef: 'https://app.example.com',
            surfaceRefs: ['/api/users/{id}'],
            skills: [],
            leads: [{
              localId: 'lead-1',
              riskFamily: 'idor',
              techniqueId: 'T-IDOR',
              targetRef: 'https://app.example.com',
              surfaceRef: '/api/users/{id}',
              hypothesis: 'Object authorization may drift.',
              observation: 'Responses differ.',
              validationGoal: 'Reproduce with two users.',
              requiredControls: [],
              prerequisites: [],
              evidenceRefs: [],
              evidenceState: 'needs_evidence',
              confidence: 0.6,
              priority: 'medium',
              authContextClass: 'anonymous',
              attemptFingerprints: [],
            }],
            negativeResults: [],
            attempts: [],
            coverage: {
              requested: { surfaceRefs: [], techniqueIds: [], personaClasses: [] },
              attempted: { surfaceRefs: [], techniqueIds: [], personaClasses: [] },
              counts: { attempts: 0, requests: 0, leads: 1, negativeResults: 0 },
              uncovered: [],
            },
            blockers: [],
            artifacts: [],
            recommendedValidationMissions: [],
          },
        },
      }],
    } as any);
    const sessionStore = createInMemorySessionStore([session as any]);

    const result = await SubmitEnumerationDisposition.run(
      {
        action: 'disposition',
        taskId: '00000000-0000-4000-8000-000000000001',
        resultHash: 'b'.repeat(64),
        leadDispositions: [],
        coverageAcknowledged: true,
        negativeResultsAcknowledged: true,
      },
      {
        sessionId: session.id,
        sessionStore: sessionStore as any,
        workers: { syncWorkerTasks: vi.fn().mockResolvedValue([]) },
        approvals: { require: vi.fn() },
        policies: {
          requireApproval: false,
          maxStdoutBytes: 1024,
          timeoutMs: 1000,
        },
      } as any,
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      data: expect.objectContaining({
        error: expect.stringMatching(/every returned lead/u),
      }),
    }));
    expect(sessionStore.get(session.id)?.workerTasks?.[0]?.enumerationDisposition)
      .toBeUndefined();
  });

  it('commits one canonical lead path under concurrent identical disposition calls', async () => {
    securityOpsMocks.reportNote.mockReset();
    securityOpsMocks.flushProjection.mockClear();
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    securityOpsMocks.reportNote.mockImplementation(async (params: any) => {
      if (securityOpsMocks.reportNote.mock.calls.length === 1) {
        await firstWriteGate;
      }
      return {
        noteId:
          params.input.ntype === 'validation.lead'
            ? '00000000-0000-4000-8000-000000000010'
            : '00000000-0000-4000-8000-000000000011',
        created: true,
        dedupeKey: 'dedupe',
      };
    });

    const session = buildEnumerationParent();
    const baseStore = createInMemorySessionStore([session as any]);
    let lock = Promise.resolve();
    const sessionStore = {
      ...baseStore,
      updateSessionAsync: <T>(
        id: string,
        mutator: (current: any) => Promise<T> | T,
      ): Promise<T | undefined> => {
        const operation = lock.then(async () => {
          const current = baseStore.get(id);
          return current ? mutator(current) : undefined;
        });
        lock = operation.then(() => undefined, () => undefined);
        return operation;
      },
    };
    const args = {
      action: 'disposition',
      taskId: '00000000-0000-4000-8000-000000000001',
      resultHash: 'b'.repeat(64),
      leadDispositions: [{ leadLocalId: 'lead-1', action: 'accept' }],
      coverageAcknowledged: true,
      negativeResultsAcknowledged: true,
    };
    const context = (toolCallId: string) => ({
      sessionId: session.id,
      toolCallId,
      sessionStore: sessionStore as any,
      workers: { syncWorkerTasks: vi.fn().mockResolvedValue([]) },
      approvals: { require: vi.fn() },
      policies: {
        requireApproval: false,
        maxStdoutBytes: 1024,
        timeoutMs: 1000,
      },
    } as any);

    const first = SubmitEnumerationDisposition.run(args, context('disposition-1'));
    await vi.waitFor(() => expect(securityOpsMocks.reportNote).toHaveBeenCalledTimes(1));
    const concurrent = await SubmitEnumerationDisposition.run(
      args,
      context('disposition-2'),
    );
    expect(concurrent).toEqual(expect.objectContaining({
      ok: false,
      data: expect.objectContaining({ error: expect.stringMatching(/already in progress/u) }),
    }));

    releaseFirstWrite();
    const completed = await first;
    expect(completed).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        disposition: expect.objectContaining({
          canonicalLeadIds: ['00000000-0000-4000-8000-000000000010'],
          validatorEligibleLeadIds: ['00000000-0000-4000-8000-000000000010'],
        }),
      }),
    }));
    expect(securityOpsMocks.reportNote).toHaveBeenCalledTimes(2);

    const replay = await SubmitEnumerationDisposition.run(args, context('disposition-3'));
    expect(replay).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ idempotent: true }),
    }));
    expect(securityOpsMocks.reportNote).toHaveBeenCalledTimes(2);
  });
});
