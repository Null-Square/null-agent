import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import {
  isEnumerationTargetAuthorized,
  WorkerDelegationService,
} from '@/domains/agent-brain/application/services/WorkerDelegationService';
import { buildPhaseWorkerContext } from '@/domains/agent-brain/application/services/worker/WorkerDelegationShared';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('isEnumerationTargetAuthorized', () => {
  it('inherits domain authorization downward without authorizing parents or siblings', () => {
    expect(isEnumerationTargetAuthorized('https://api.example.com/v1', 'example.com')).toBe(true);
    expect(isEnumerationTargetAuthorized('a.b.example.com', 'https://example.com')).toBe(true);
    expect(isEnumerationTargetAuthorized('example.com', 'app.example.com')).toBe(false);
    expect(isEnumerationTargetAuthorized('admin.example.com', 'app.example.com')).toBe(false);
    expect(isEnumerationTargetAuthorized('notexample.com', 'example.com')).toBe(false);
    expect(isEnumerationTargetAuthorized(
      'api.payments.example.com',
      'example.com',
      [{ type: 'domain', value: 'payments.example.com' }],
    )).toBe(false);
  });

  it('admits contained CIDR targets but not unrelated addresses', () => {
    expect(isEnumerationTargetAuthorized('https://192.0.2.25', '192.0.2.0/24')).toBe(true);
    expect(isEnumerationTargetAuthorized('198.51.100.25', '192.0.2.0/24')).toBe(false);
  });
});

describe('WorkerDelegationService', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  it('passes the exact evaluation candidate digest into enumeration resolution', async () => {
    const resolve = vi.fn().mockResolvedValue({
      primary: { slug: 'access-control', riskTier: 'standard' },
      supporting: [],
      catalogVersion: '3.0.0-b1',
      catalogDigest: 'a'.repeat(64),
    });
    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    (service as any).enumerationSkillResolver = { resolve };
    const mission = { targetRef: 'https://app.example.com' };

    await (service as any).resolveWorkerSkillSlugs(
      {
        flags: {
          securityops: {
            enumerationSourceMode: 'blackbox',
            enumerationImpactTolerance: 'poc',
            enumerationEvaluationCandidateCatalogDigest: 'a'.repeat(64),
          },
        },
        workerTasks: [],
      },
      {
        workerType: 'enumeration_worker',
        mission: { enumeration: mission },
        toolPreflight: { executableTools: ['http_payload', 'submit_worker_result'] },
      },
      {},
    );

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      mission,
      runtimeSourceMode: 'blackbox',
      runImpactTolerance: 'poc',
      catalogAdmission: {
        kind: 'evaluation_candidate',
        expectedCatalogDigest: 'a'.repeat(64),
      },
    }));
  });

  it('keeps hosted repository authority while omitting unrelated parent missions', () => {
    const context = buildPhaseWorkerContext({
      extraContext: [
        '=== CODE REVIEW RUN CONTEXT ===',
        '{"repository":"local-review"}',
        '',
        '=== HOST BOUNDARY ===',
        'Local clone only. No network or publication authority.',
        '',
        '=== PHASE MISSIONS ===',
        '[{"id":"unrelated-parent-mission"}]',
      ].join('\n'),
      flags: {
        securityops: { activePhaseKey: 'review_analysis', activePhaseId: 'phase-review' },
      },
    } as any, 'review_analysis');

    expect(context).toContain('=== CODE REVIEW RUN CONTEXT ===');
    expect(context).toContain('=== HOST BOUNDARY ===');
    expect(context).toContain('Local clone only');
    expect(context).not.toContain('unrelated-parent-mission');
  });

  it('spawns a child worker session and syncs its artifact back to the parent task', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'browser_action', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
        ask: ['browser_action'],
      },
      flags: {
        securityops: { runId: 'run-1' },
        artifacts: { hasReport: true },
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon worker mapped the login and reset routes.',
        findings: ['Found /login and /forgot-password'],
        evidenceRefs: ['https://target.test/login'],
        touchedTargets: ['/login', '/forgot-password'],
        confidence: 0.92,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.completed');
    });

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the unauthenticated surface area for the target.',
      reason: 'Need a bounded recon pass before validation.',
      executionMode: 'blocking',
    });

    const parentAfter = store.get(parent.id)!;
    const child = store.get(result.sessionId)!;

    expect(initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ id: result.sessionId }),
      }),
    );
    expect(processMessage).toHaveBeenCalledWith(
      result.sessionId,
      expect.stringContaining('submit_worker_result'),
      undefined,
    );
    expect(processMessage).toHaveBeenCalledWith(
      result.sessionId,
      expect.stringContaining('Available tools in this worker session:'),
      undefined,
    );
    expect(processMessage).toHaveBeenCalledWith(
      result.sessionId,
      expect.stringContaining('Withheld tools in this worker session:'),
      undefined,
    );
    expect(parentAfter.coordination).toEqual({ role: 'direct' });
    expect(parentAfter.workerTasks).toHaveLength(1);
    expect(parentAfter.workerTasks?.[0]).toMatchObject({
      taskId: result.task.taskId,
      workerType: 'recon_worker',
      status: 'completed',
      dependencyMode: 'dependency',
      summary: 'Recon worker mapped the login and reset routes.',
    });
    expect(parentAfter.workerTasks?.[0].artifact).toEqual(result.artifact);
    expect(child.coordination).toMatchObject({
      role: 'worker',
      parentSessionId: parent.id,
      parentTaskId: result.task.taskId,
      workerType: 'recon_worker',
    });
    expect(child.toolPolicy?.allow).toEqual(
      expect.arrayContaining(['web_search', 'browser_action', 'file_read', 'submit_worker_result']),
    );
    expect(child.toolPolicy?.deny).toEqual(
      expect.arrayContaining(['spawn_worker', 'continue_worker', 'stop_worker']),
    );
    expect(child.toolPolicy?.ask).toEqual(['browser_action']);
    expect(child.flags?.artifacts).toBeUndefined();
    expect((child.flags?.securityops as Record<string, unknown> | undefined)?.runId).toBe('run-1');
    expect((child.flags?.session as Record<string, unknown> | undefined)?.completed).toBe(true);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.spawned',
        payload: expect.objectContaining({
          advertisedTools: expect.arrayContaining(['web_search', 'browser_action', 'file_read', 'submit_worker_result']),
          executableTools: expect.arrayContaining(['web_search', 'browser_action', 'file_read', 'submit_worker_result']),
          withheldTools: expect.arrayContaining([
            expect.objectContaining({
              tool: 'shell_run',
              reason: expect.stringContaining('parent session policy'),
            }),
          ]),
          waveContext: expect.objectContaining({
            openingWave: true,
            waveIndex: 0,
            priorSettledWorkers: 0,
            concurrentWorkerCount: 1,
          }),
        }),
      }),
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.wave.spawned',
        payload: expect.objectContaining({
          openingWave: true,
          waveIndex: 0,
          workerType: 'recon_worker',
        }),
      }),
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      result.sessionId,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.session.started',
        payload: expect.objectContaining({
          advertisedTools: expect.arrayContaining(['web_search', 'browser_action', 'file_read', 'submit_worker_result']),
          executableTools: expect.arrayContaining(['web_search', 'browser_action', 'file_read', 'submit_worker_result']),
        }),
      }),
    );

    const traceCalls = (traceRecorder.write as any).mock.calls as Array<[string, number, Record<string, unknown>]>;
    const spawnedTrace = traceCalls.find(
      ([traceSessionId, , trace]: [string, number, Record<string, unknown>]) =>
        traceSessionId === parent.id && trace?.event === 'worker.task.spawned',
    )?.[2];
    expect((spawnedTrace?.payload as Record<string, unknown>).advertisedTools).not.toContain('shell_run');

    const workerStartedTrace = traceCalls.find(
      ([traceSessionId, , trace]: [string, number, Record<string, unknown>]) =>
        traceSessionId === result.sessionId && trace?.event === 'worker.session.started',
    )?.[2];
    expect((workerStartedTrace?.payload as Record<string, unknown>).advertisedTools).not.toContain('shell_run');
  });

  it('inherits the parent model for workers', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'frontier-model',
      modelContextWindow: 200_000,
      modelMaxOutputTokens: 16_000,
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
      flags: {
        model_selection: {
          requestedCategory: 'extra_high',
          resolvedCategory: 'extra_high',
          resolvedModelName: 'frontier-model',
        },
      },
    });

    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon pass completed on inherited model.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: ['target.test'],
        confidence: 0.7,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.parent_model_completed');
    });

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(
      store,
      new ToolPolicyChecker(),
      traceRecorder as any,
    );
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the target surface.',
      reason: 'Need bounded recon.',
      executionMode: 'blocking',
    });

    const child = store.get(result.sessionId)!;
    const task = store.get(parent.id)!.workerTasks?.[0];
    expect(child.modelName).toBe('frontier-model');
    expect(child.modelContextWindow).toBe(200_000);
    expect(child.modelMaxOutputTokens).toBe(16_000);
    expect(task?.workerSessionId).toBe(result.sessionId);
  });
  it('uses the shared run workspace for worker skills and credentials', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      extraContext: [
        '=== ASSIGNED METHODOLOGIES ===',
        '- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md',
      ].join('\n'),
      flags: {
        securityops: { runId: 'run-shared-skills' },
      },
      toolPolicy: {
        allow: ['file_read', 'shell_run', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });

    await fs.mkdir(path.resolve(parent.workspaceDir, '.skills', 'broad-surface-scan'), { recursive: true });
    await fs.writeFile(
      path.resolve(parent.workspaceDir, '.credentials'),
      'API_TOKEN=test-token\n',
      'utf8',
    );

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Completed bounded worker task.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.5,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Use the assigned skill methodology to map the broad surface.',
      reason: 'Need a bounded recon pass before validation.',
      executionMode: 'blocking',
    });

    const child = store.get(result.sessionId)!;
    expect(processMessage).toHaveBeenCalledWith(
      result.sessionId,
      expect.stringContaining('Task ID:'),
      undefined,
    );
    expect(child.extraContext).toContain('- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md');
    await expect(
      fs.access(path.resolve(child.workspaceDir, '.skills', 'broad-surface-scan', 'methodology.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.resolve(child.workspaceDir, '.credentials'), 'utf8'),
    ).resolves.toContain('API_TOKEN=test-token');
  });

  it('narrows phase worker context and blocks worker types outside the active phase profile', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      extraContext: [
        '=== ORGANIZATION CONTEXT ===',
        'Organization: Acme',
        '',
        '=== ORGANIZATION BRIEF ===',
        'Never test the payment processor.',
        '',
        '=== SCOPE CONTEXT ===',
        'Scope: Test Scope',
        '',
        '=== AUTHORITY BOUNDARY ===',
        'Backend policy and verified targets are authoritative.',
        '',
        '=== AUTHORIZED TARGETS ===',
        '  - app.example.com (domain)',
        '',
        '=== UNVERIFIED OBSERVATIONS (NOT AUTHORIZED) ===',
        '  - observed.example.net (domain)',
        '',
        '=== EXECUTION ENVIRONMENT ===',
        'This run executes from the cloud-managed environment.',
        '',
        '# Full Approved Plan',
        '1. Recon app.example.com.',
        '2. Later reporting closeout with security-reporting.',
        '',
        '=== ASSIGNED METHODOLOGIES ===',
        '- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md',
        '- security-reporting: /workspace/.skills/security-reporting/methodology.md',
        '',
        '=== PRIOR PHASE HANDOFF ===',
        '{"summary":"DNS and HTTP reachability confirmed","evidenceRefs":["artifact:recon-1"]}',
      ].join('\n'),
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseKey: 'recon',
          activePhaseId: 'phase-recon',
          phaseAssignedSkillSlugs: ['broad-surface-scan'],
        },
      },
      toolPolicy: {
        allow: [
          'file_read',
          'shell_run',
          'query_inventory',
          'query_findings',
          'query_notes',
          'ingest_scan_artifact',
          'submit_worker_result',
          'spawn_worker',
          'continue_worker',
          'stop_worker',
        ],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon phase worker stayed bounded.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: ['app.example.com'],
        confidence: 0.7,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.phase_context_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    await expect(
      service.spawnWorker({
        parentSessionId: parent.id,
        workerType: 'validator_worker',
        task: 'Validate a finding from recon.',
        reason: 'Wrong worker type for recon.',
        executionMode: 'blocking',
        mission: {
          phase: 'recon',
          question: 'Can the surface be mapped?',
          whyReadyNow: 'Recon is active.',
          requiredEvidence: ['surface inventory'],
          expectedArtifact: 'surface map',
          stopCondition: 'Surface mapped or blocked.',
          assignedSkills: ['broad-surface-scan'],
        },
      }),
    ).rejects.toThrow('not allowed in phase "recon"');

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map app.example.com and return a surface map.',
      reason: 'Need phase-scoped recon coverage.',
      executionMode: 'blocking',
      mission: {
        phase: 'recon',
        question: 'Can app.example.com surface be mapped?',
        whyReadyNow: 'Recon is active.',
        requiredEvidence: ['surface inventory'],
        expectedArtifact: 'surface map',
        stopCondition: 'Surface mapped or blocked.',
        assignedSkills: ['broad-surface-scan'],
      },
    });

    const child = store.get(result.sessionId)!;
    const childContext = child.extraContext ?? '';
    expect(childContext).toContain('=== ACTIVE RUN PHASE ===');
    expect(childContext).toContain('phase: recon');
    expect(childContext).toContain('=== AUTHORITY BOUNDARY ===');
    expect(childContext).toContain('=== AUTHORIZED TARGETS ===');
    expect(childContext).toContain('Never test the payment processor.');
    expect(childContext).toContain('Can app.example.com surface be mapped?');
    expect(childContext.match(/Can app\.example\.com surface be mapped\?/g)).toHaveLength(1);
    expect(childContext).toContain('DNS and HTTP reachability confirmed');
    expect(childContext).not.toContain('Later reporting closeout');
    expect(childContext).not.toContain('observed.example.net');
    expect(childContext).not.toContain('security-reporting');
    await expect(
      fs.access(path.resolve(child.workspaceDir, '.skills', 'broad-surface-scan', 'methodology.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(child.workspaceDir, '.skills', 'security-reporting')),
    ).rejects.toBeTruthy();
  });

  it('uses the compliance prompt profile for compliance control workers', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          runId: 'run-compliance',
          workflowDiscipline: 'compliance',
          activePhaseKey: 'control_assessment',
          activePhaseId: 'phase-control-assessment',
          phaseAssignedSkillSlugs: ['compliance-access-control'],
        },
      },
      toolPolicy: {
        allow: [
          'query_compliance_readiness',
          'query_compliance_evidence',
          'query_inventory',
          'query_findings',
          'file_read',
          'file_write',
          'browser_action',
          'http_payload',
          'http_raw_send',
          'http_differential',
          'http_list',
          'http_view',
          'http_repeat',
          'authz_replay',
          'record_control_check',
          'record_control_request',
          'submit_worker_result',
          'spawn_worker',
          'continue_worker',
          'stop_worker',
        ],
      },
    });

    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Control evidence reviewed.',
        findings: [],
        evidenceRefs: ['compliance-evidence:evidence-1'],
        touchedTargets: ['CC6.1'],
        confidence: 0.8,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.compliance_worker.completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'compliance_control_worker',
      task: 'Assess CC6.1 using the selected evidence and return a concise control-check handoff.',
      reason: 'Need a bounded compliance control check.',
      executionMode: 'blocking',
      mission: {
        phase: 'control_assessment',
        question: 'Can CC6.1 be assessed from current evidence?',
        whyReadyNow: 'Compliance assessment phase is active.',
        requiredEvidence: ['mapped evidence or request'],
        expectedArtifact: 'control-check handoff',
        stopCondition: 'Return pass/fail/needs_context support or request details.',
        assignedSkills: ['compliance-access-control'],
      },
    });

    const child = store.get(result.sessionId)!;
    expect(child.promptProfile).toBe('phase-control-assessment');
    expect((child.flags?.securityops as Record<string, unknown> | undefined)?.workflowDiscipline).toBe('compliance');
  });

  it('rejects worker mission skills outside the active phase skill set', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseKey: 'validation',
          activePhaseId: 'phase-validation',
          phaseAssignedSkillSlugs: ['validation'],
        },
      },
      toolPolicy: {
        allow: [
          'file_read',
          'http_payload',
          'query_inventory',
          'query_findings',
          'query_notes',
          'report_finding',
          'submit_validation_outcome',
          'submit_worker_result',
          'spawn_worker',
          'continue_worker',
          'stop_worker',
        ],
      },
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage: vi.fn().mockResolvedValue(undefined) } as any,
    });

    await expect(
      service.spawnWorker({
        parentSessionId: parent.id,
        workerType: 'validator_worker',
        task: 'Validate the finding and write final report copy.',
        reason: 'Skill should be rejected before the child session is created.',
        executionMode: 'blocking',
        mission: {
          phase: 'validation',
          question: 'Can the finding be reproduced?',
          whyReadyNow: 'Validation queue is active.',
          requiredEvidence: ['fresh HTTP evidence'],
          expectedArtifact: 'validation outcome',
          stopCondition: 'Finding validated, rejected, or inconclusive.',
          assignedSkills: ['security-reporting'],
        },
      }),
    ).rejects.toThrow('outside the active phase skill catalog');
  });

  it('accepts phase-compatible worker mission skills that were not planner-assigned', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseKey: 'validation',
          activePhaseId: 'phase-validation',
          phaseAssignedSkillSlugs: ['validation'],
        },
      },
      toolPolicy: {
        allow: [
          'file_read',
          'http_payload',
          'http_differential',
          'query_inventory',
          'query_findings',
          'query_notes',
          'report_finding',
          'submit_validation_outcome',
          'submit_worker_result',
          'spawn_worker',
          'continue_worker',
          'stop_worker',
        ],
      },
    });

    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'IDOR validation complete.',
        findings: [],
        evidenceRefs: ['/workspace/.artifacts/validation/idor-result.json'],
        touchedTargets: ['/api/orders/{orderId}'],
        confidence: 0.7,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.phase_compatible_skill_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'validator_worker',
      task: 'Validate object-reference authorization controls on the order endpoint.',
      reason: 'The validation phase catalog exposes the idor skill even though only validation was planner-assigned.',
      executionMode: 'blocking',
      mission: {
        phase: 'validation',
        question: 'Can the suspected IDOR be reproduced?',
        whyReadyNow: 'Validation queue is active.',
        requiredEvidence: ['fresh cross-account HTTP evidence'],
        expectedArtifact: 'validation outcome',
        stopCondition: 'Finding validated, rejected, or inconclusive.',
        assignedSkills: ['idor'],
      },
    });

    const child = store.get(result.sessionId)!;
    expect(child.workspaceDir).toBe(parent.workspaceDir);
    expect(child.extraContext).toContain('idor');
    expect((child.flags?.securityops as Record<string, unknown>).phaseAssignedSkillSlugs).toEqual(['idor']);
    await expect(
      fs.access(path.resolve(child.workspaceDir, '.skills', 'idor', 'methodology.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.resolve(child.workspaceDir, '.skills', 'validation', 'methodology.md')),
    ).rejects.toBeTruthy();
  });

  it('withholds validator file_write unless the parent provides writeScope', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'file_write', 'http_payload', 'shell_run', 'python_session', 'report_finding', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Validation complete.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.5,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.validator_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const withoutWriteScope = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'validator_worker',
      task: 'Validate the auth bypass path.',
      reason: 'Need fresh-context confirmation.',
      executionMode: 'blocking',
    });
    const childWithoutWriteScope = store.get(withoutWriteScope.sessionId)!;
    expect(childWithoutWriteScope.toolPolicy?.allow).not.toContain('file_write');
    expect(childWithoutWriteScope.toolPolicy?.allow).toContain('shell_run');
    expect(childWithoutWriteScope.toolPolicy?.allow).toContain('python_session');
    expect(childWithoutWriteScope.toolPolicy?.allow).toContain('report_finding');
    expect(withoutWriteScope.task.toolPreflight).toMatchObject({
      advertisedTools: expect.arrayContaining(['shell_run', 'python_session', 'report_finding']),
      executableTools: expect.arrayContaining(['shell_run', 'python_session', 'report_finding']),
      withheldTools: expect.arrayContaining([
        expect.objectContaining({
          tool: 'file_write',
        }),
      ]),
    });

    const withWriteScope = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'validator_worker',
      task: 'Validate the auth bypass path and save a minimal PoC.',
      reason: 'Need fresh-context confirmation plus a bounded PoC.',
      executionMode: 'blocking',
      writeScope: ['/workspace/poc'],
    });
    const childWithWriteScope = store.get(withWriteScope.sessionId)!;
    expect(childWithWriteScope.toolPolicy?.allow).toContain('file_write');
    expect(childWithWriteScope.toolPolicy?.allow).not.toContain('shell_run');
    expect(childWithWriteScope.toolPolicy?.allow).not.toContain('python_session');
    expect(childWithWriteScope.toolPolicy?.allow).not.toContain('report_finding');
    expect(childWithWriteScope.coordination?.writeScope).toEqual(['/workspace/poc']);
    expect(withWriteScope.task.toolPreflight).toMatchObject({
      advertisedTools: expect.arrayContaining(['file_write']),
      executableTools: expect.arrayContaining(['file_write']),
      withheldTools: expect.arrayContaining([
        expect.objectContaining({
          tool: 'shell_run',
          reason: expect.stringContaining('writeScope is not limited'),
        }),
        expect.objectContaining({
          tool: 'python_session',
          reason: expect.stringContaining('writeScope is not limited'),
        }),
        expect.objectContaining({
          tool: 'report_finding',
          reason: expect.stringContaining('canonical write with no workspace path'),
        }),
      ]),
    });
    expect(withWriteScope.task.toolPreflight?.advertisedTools).not.toContain('report_finding');
    expect(withWriteScope.task.toolPreflight?.executableTools).not.toContain('report_finding');
  });

  it('keeps shell_run available when worker writeScope is limited to .artifacts', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'file_write', 'http_payload', 'ingest_scan_artifact', 'shell_run', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string, _prompt: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon scan completed.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.5,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.artifact_scope_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Run a bounded scanner pass and save outputs under /workspace/.artifacts/recon.',
      reason: 'Need scanner-backed recon with artifact handoff.',
      executionMode: 'blocking',
      writeScope: ['/workspace/.artifacts/recon'],
    });

    const child = store.get(result.sessionId)!;
    expect(child.toolPolicy?.allow).toContain('shell_run');
    expect(child.toolPolicy?.allow).toContain('file_read');
    expect(child.toolPolicy?.allow).toContain('ingest_scan_artifact');
    expect(child.coordination?.writeScope).toEqual(['/workspace/.artifacts/recon']);
    expect(result.task.toolPreflight).toMatchObject({
      advertisedTools: expect.arrayContaining(['shell_run', 'file_read', 'ingest_scan_artifact', 'submit_worker_result']),
      executableTools: expect.arrayContaining(['shell_run', 'file_read', 'ingest_scan_artifact', 'submit_worker_result']),
    });
    expect(result.task.toolPreflight?.withheldTools ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'shell_run',
        }),
      ]),
    );
    expect(result.task.toolPreflight?.withheldTools ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'ingest_scan_artifact',
        }),
      ]),
    );
    expect(processMessage.mock.calls[0]?.[1]).toContain(
      'always pass the exact artifactPath inside the allowed write scope',
    );
  });

  it('warns when a validator returns a confirmed artifact without filing report_finding', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'http_payload', 'report_finding', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: '[CONFIRMED] IDOR reproduced with cross-tenant data exposure.',
        findings: ['Exact request and response pair captured in evidence.'],
        evidenceRefs: ['/workspace/evidence/idor.txt'],
        touchedTargets: ['/api/users/42'],
        confidence: 0.98,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.validator_confirmed');
    });

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'validator_worker',
      task: 'Validate cross-tenant IDOR and file the finding if independently confirmed.',
      reason: 'Need fresh-context confirmation plus direct finding submission.',
      executionMode: 'blocking',
    });

    expect(result.task.status).toBe('completed');
    expect(result.task.lastStatusReason).toBe(
      'Worker completed with a [CONFIRMED] validation artifact, but no report_finding call was recorded.',
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.finding_submission_missing',
      }),
    );
    expect(traceRecorder.write).toHaveBeenCalledWith(
      result.sessionId,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.finding_submission_missing',
      }),
    );
  });

  it('normalizes worker evidence refs without copying inside a shared run workspace', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: { runId: 'run-shared-worker' },
      },
      toolPolicy: {
        allow: ['file_read', 'shell_run', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      await fs.mkdir(path.resolve(child.workspaceDir, 'broad'), { recursive: true });
      await fs.writeFile(path.resolve(child.workspaceDir, 'broad', 'httpx.txt'), 'https://target.test [200]\n', 'utf8');
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Mapped the HTTP surface.',
        findings: ['Main site responds on 200'],
        evidenceRefs: ['/workspace/broad/httpx.txt', 'https://target.test/login'],
        touchedTargets: ['target.test'],
        confidence: 0.93,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.completed_with_files');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the HTTP surface and return concrete evidence files.',
      reason: 'Need a bounded recon pass before validation.',
      executionMode: 'blocking',
    });

    expect(result.artifact?.sourceSessionId).toBe(result.sessionId);
    expect(result.artifact?.sourceEvidenceRefs).toEqual([
      '/workspace/broad/httpx.txt',
      'https://target.test/login',
    ]);
    expect(result.artifact?.parentReadableManifestPath).toBeUndefined();
    expect(result.artifact?.parentReadableEvidenceRefs).toEqual(['/workspace/broad/httpx.txt']);
    expect(result.artifact?.evidenceRefs).toEqual([
      '/workspace/broad/httpx.txt',
      'https://target.test/login',
    ]);

    await expect(
      fs.readFile(
        path.resolve(parent.workspaceDir, 'broad', 'httpx.txt'),
        'utf8',
      ),
    ).resolves.toContain('https://target.test [200]');
    await expect(
      fs.stat(path.resolve(parent.workspaceDir, '.artifacts', 'worker-' + 'handoffs')),
    ).rejects.toThrow();
  });

  it('defaults workers to background mode and durably schedules the parent when they finish', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
      flags: {
        securityops: { runId: 'run-2' },
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      if (sessionId === parent.id) {
        return;
      }
      const child = store.get(sessionId)!;
      await fs.mkdir(path.resolve(child.workspaceDir, 'surface'), { recursive: true });
      await fs.writeFile(path.resolve(child.workspaceDir, 'surface', 'login.txt'), 'login endpoint mapped\n', 'utf8');
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Background worker finished reconnaissance.',
        findings: ['Mapped the login entrypoint'],
        evidenceRefs: ['/workspace/surface/login.txt', 'https://target.test/login'],
        touchedTargets: ['/login'],
        confidence: 0.81,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.background_completed');
    });

    const scheduleParent = vi
      .spyOn(store, 'recordInternalContinuationInputAsync')
      .mockResolvedValue(true);
    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the public login surface.',
      reason: 'Need independent reconnaissance before planning follow-up validation.',
    });

    expect(result.task.executionMode).toBe('background');
    expect(result.task.dependencyMode).toBe('sidecar');

    await vi.waitFor(() => {
      expect(scheduleParent).toHaveBeenCalledWith(
        parent.id,
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('A background worker task changed state.'),
          metadata: expect.objectContaining({ visibility: 'internal' }),
        }),
      );
    });

    const parentAfter = store.get(parent.id)!;
    expect(parentAfter.workerTasks?.[0]).toMatchObject({
      status: 'completed',
      summary: 'Background worker finished reconnaissance.',
      executionMode: 'background',
    });
    expect(scheduleParent).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({ content: expect.stringContaining('/workspace/surface/login.txt') }),
    );
    expect(scheduleParent).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({ content: expect.stringContaining('Shared-state discoveries merged: endpoint /login') }),
    );
    expect(processMessage).not.toHaveBeenCalledWith(parent.id, expect.any(String), undefined);
    expect(parentAfter.memory.discoveredFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'endpoint:path:/login',
        }),
      ]),
    );
  });

  it('links a spawned worker to its plan step and reopens a blocked linked step when the worker completes', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });
    await store.setAsync(parent.id, {
      ...parent,
      plan: [
        {
          id: 'step-admin',
          title: 'Assess the admin surface',
          status: 'blocked',
          blockedReason: 'Waiting for delegated worker output.',
        },
      ],
    }, 'test.parent.plan_link');

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      if (sessionId === parent.id) {
        return;
      }
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Admin surface mapped with a reachable login and dashboard.',
        findings: ['Mapped /admin/login and /admin/dashboard'],
        evidenceRefs: ['https://target.test/admin/login'],
        touchedTargets: ['/admin/login', '/admin/dashboard'],
        confidence: 0.84,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.plan_link_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the admin surface and return the highest-value routes.',
      reason: 'Need independent admin-surface mapping before synthesis.',
      planStepId: 'step-admin',
    });

    await vi.waitFor(() => {
      const parentAfter = store.get(parent.id)!;
      expect(parentAfter.workerTasks?.[0]).toMatchObject({
        taskId: result.task.taskId,
        planStepId: 'step-admin',
        status: 'completed',
      });
      expect(parentAfter.plan[0]).toMatchObject({
        id: 'step-admin',
        status: 'running',
        blockedReason: undefined,
      });
      expect(parentAfter.currentPlanStepId).toBe('step-admin');
    });
  });

  it('does not guess a linked plan step when multiple plan steps are already running', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
    });
    await store.setAsync(parent.id, {
      ...parent,
      currentPlanStepId: 'step-b',
      plan: [
        { id: 'step-a', title: 'Map app surface', status: 'running' },
        { id: 'step-b', title: 'Map admin surface', status: 'running' },
      ],
    }, 'test.parent.plan_link_ambiguous');

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon completed without an explicit plan linkage.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.5,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.plan_link_ambiguous_completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map a bounded surface slice.',
      reason: 'Need a bounded recon worker.',
      executionMode: 'blocking',
    });

    expect(result.task.planStepId).toBeUndefined();
    const parentAfter = store.get(parent.id)!;
    expect(parentAfter.workerTasks?.[0]?.planStepId).toBeUndefined();
  });

  it('starts the first reactive follow-up wave at index 1 instead of counting settled workers', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
      workerTasks: [
        {
          taskId: 'open-1',
          parentSessionId: 'parent',
          workerSessionId: 'child-open-1',
          workerType: 'recon_worker',
          waveIndex: 0,
          status: 'completed',
          reason: 'opening wave host 1',
          task: 'scan host 1',
          expectedArtifactType: 'surface-map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now() - 3000,
        },
        {
          taskId: 'open-2',
          parentSessionId: 'parent',
          workerSessionId: 'child-open-2',
          workerType: 'recon_worker',
          waveIndex: 0,
          status: 'running',
          reason: 'opening wave host 2',
          task: 'scan host 2',
          expectedArtifactType: 'surface-map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now() - 3000,
        },
        {
          taskId: 'open-3',
          parentSessionId: 'parent',
          workerSessionId: 'child-open-3',
          workerType: 'recon_worker',
          waveIndex: 0,
          status: 'failed',
          reason: 'opening wave host 3',
          task: 'scan host 3',
          expectedArtifactType: 'surface-map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now() - 3000,
        },
      ] as any,
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Reactive validator completed.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.75,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.reactive_wave_completed');
    });

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'validator_worker',
      task: 'Validate the exposed admin panel discovered in the opening wave.',
      reason: 'Need a reactive confirmation worker.',
      executionMode: 'blocking',
      dependencyMode: 'dependency',
    });

    expect(result.task.waveIndex).toBe(1);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.wave.spawned',
        payload: expect.objectContaining({
          waveIndex: 1,
          openingWave: false,
          priorSettledWorkers: 2,
          priorRunningWorkers: 1,
        }),
      }),
    );
  });

  it('keeps additional spawns in the same reactive wave on the same index', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
      workerTasks: [
        {
          taskId: 'open-1',
          parentSessionId: 'parent',
          workerSessionId: 'child-open-1',
          workerType: 'recon_worker',
          waveIndex: 0,
          status: 'completed',
          reason: 'opening wave',
          task: 'scan host 1',
          expectedArtifactType: 'surface-map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now() - 3000,
        },
        {
          taskId: 'reactive-1',
          parentSessionId: 'parent',
          workerSessionId: 'child-reactive-1',
          workerType: 'validator_worker',
          waveIndex: 1,
          status: 'running',
          reason: 'reactive validation',
          task: 'validate host 1',
          expectedArtifactType: 'finding-validation',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now() - 2000,
        },
      ] as any,
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Second reactive branch completed.',
        findings: [],
        evidenceRefs: [],
        touchedTargets: [],
        confidence: 0.7,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.same_wave_completed');
    });

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the auth surface on the second host while the first reactive validator is still running.',
      reason: 'Need another branch in the same reactive wave.',
      executionMode: 'background',
      dependencyMode: 'sidecar',
    });

    expect(result.task.waveIndex).toBe(1);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.wave.spawned',
        payload: expect.objectContaining({
          waveIndex: 1,
          openingWave: false,
          priorSettledWorkers: 1,
          priorRunningWorkers: 1,
        }),
      }),
    );
  });

  it('marks a background worker failed and durably schedules its parent', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker'],
      },
      flags: {
        securityops: { runId: 'run-3' },
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      if (sessionId === parent.id) {
        return;
      }
      throw new Error('worker crashed during recon');
    });

    const scheduleParent = vi
      .spyOn(store, 'recordInternalContinuationInputAsync')
      .mockResolvedValue(true);
    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the public login surface.',
      reason: 'Need independent reconnaissance before planning follow-up validation.',
    });

    await vi.waitFor(() => {
      const parentAfter = store.get(parent.id)!;
      expect(parentAfter.workerTasks?.[0]).toMatchObject({
        taskId: result.task.taskId,
        status: 'failed',
        executionMode: 'background',
      });
      expect(parentAfter.workerTasks?.[0].lastError).toContain('worker crashed during recon');
    });

    await vi.waitFor(() => {
      expect(scheduleParent).toHaveBeenCalledWith(
        parent.id,
        expect.objectContaining({ content: expect.stringContaining('A background worker task changed state.') }),
      );
    });
    expect(processMessage).not.toHaveBeenCalledWith(parent.id, expect.any(String), undefined);

    const childAfter = store.get(result.sessionId)!;
    expect(childAfter.blockedReason).toBe('worker_failed');
    expect(childAfter.stateMachine?.isProcessing()).toBe(false);
  });

  it('cancels an active worker task and marks the parent record cancelled', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-1',
        workerType: 'validator_worker',
        expectedArtifactType: 'validation_result',
      },
    });

    child.stateMachine?.startProcessing('validator', 0, 'test');
    await store.setAsync(child.id, child, 'test.worker.started');
    const latestParent = store.get(parent.id)!;
    await store.setAsync(parent.id, {
      ...latestParent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-1',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'validator_worker',
          status: 'running',
          reason: 'Confirm the exploit path.',
          task: 'Reproduce the vulnerability',
          expectedArtifactType: 'validation_result',
          executionMode: 'blocking',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
      ],
    }, 'test.parent.worker_task');

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());

    const result = await service.stopWorker({
      parentSessionId: parent.id,
      taskId: 'task-1',
      reason: 'Parent found enough evidence already.',
    });

    const parentAfter = store.get(parent.id)!;
    const childAfter = store.get(child.id)!;

    expect(result.task.status).toBe('cancelled');
    expect(result.task.lastStatusReason).toBe('Parent found enough evidence already.');
    expect(parentAfter.workerTasks?.[0]).toMatchObject({
      taskId: 'task-1',
      status: 'cancelled',
      lastStatusReason: 'Parent found enough evidence already.',
    });
    expect(childAfter.blockedReason).toBe('worker_cancelled');
    expect(childAfter.stateMachine?.isProcessing()).toBe(false);
  });

  it('does not cancel a worker task that already completed', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-complete',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
    });

    child.completed = true;
    child.flags = {
      ...(child.flags ?? {}),
      session: { completed: true },
    };
    child.workerResult = {
      taskId: 'task-complete',
      workerType: 'recon_worker',
      summary: 'Completed recon branch.',
      findings: [],
      evidenceRefs: ['/workspace/.artifacts/recon.txt'],
      touchedTargets: ['https://target.test'],
      confidence: 0.8,
    };
    await store.setAsync(child.id, child, 'test.child.completed_worker_task');

    const latestParent = store.get(parent.id)!;
    await store.setAsync(parent.id, {
      ...latestParent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-complete',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          status: 'completed',
          reason: 'Map target surface.',
          task: 'Map target surface',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          continuationMode: 'spawn',
          createdAt: Date.now() - 10_000,
          completedAt: Date.now() - 1_000,
          summary: 'Completed recon branch.',
          artifact: {
            taskId: 'task-complete',
            workerType: 'recon_worker',
            summary: 'Completed recon branch.',
            findings: [],
            evidenceRefs: ['/workspace/.artifacts/recon.txt'],
            touchedTargets: ['https://target.test'],
            confidence: 0.8,
          },
        },
      ],
    }, 'test.parent.completed_worker_task');

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);

    const result = await service.stopWorker({
      parentSessionId: parent.id,
      taskId: 'task-complete',
      reason: 'Cleanup after completed worker sync.',
    });

    const parentAfter = store.get(parent.id)!;
    const childAfter = store.get(child.id)!;

    expect(result.task.status).toBe('completed');
    expect(parentAfter.workerTasks?.[0]).toMatchObject({
      taskId: 'task-complete',
      status: 'completed',
      summary: 'Completed recon branch.',
    });
    expect(childAfter.completed).toBe(true);
    expect(childAfter.blockedReason).toBeUndefined();
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.cancelled',
      }),
    );
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      child.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.session.cancelled',
      }),
    );
  });

  it('refuses to continue a worker while the parent executor is paused', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });
    parent.blockedReason = 'user_paused';
    await store.setAsync(parent.id, parent, 'test.parent.blocked');

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-2',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
      },
    });

    const latestParent = store.get(parent.id)!;
    await store.setAsync(parent.id, {
      ...latestParent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-2',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          status: 'running',
          reason: 'Need more recon detail.',
          task: 'Map the surface',
          expectedArtifactType: 'surface_map',
          executionMode: 'blocking',
          continuationMode: 'continue',
          createdAt: Date.now(),
        },
      ],
    }, 'test.parent.paused_worker');

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn() } as any,
      orchestrator: { processMessage: vi.fn() } as any,
    });

    await expect(
      service.continueWorker({
        parentSessionId: parent.id,
        taskId: 'task-2',
      }),
    ).rejects.toThrow(/parent session .* is blocked/i);
  });

  it('continues a blocking worker across turns until it submits a result', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'web_search', 'shell_run', 'submit_worker_result', 'spawn_worker', 'continue_worker', 'stop_worker', 'wait_for_worker'],
      },
    });

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string, prompt: string) => {
      const child = store.get(sessionId)!;
      child.turn = (child.turn ?? 0) + 1;
      if ((child.turn ?? 0) === 1) {
        child.summary = 'Initial surface map captured core entrypoints but not enough to hand off yet.';
        await store.setAsync(child.id, child, 'test.worker.partial_turn');
        return;
      }

      expect(prompt).toContain('continue');
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Recon worker completed the core surface map.',
        findings: ['Mapped app, api, and auth entrypoints'],
        evidenceRefs: ['https://target.test/', 'https://api.target.test/openapi.json'],
        touchedTargets: ['/', '/api', '/auth/login'],
        confidence: 0.88,
      };
      child.completed = true;
      child.flags = {
        ...(child.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(child.id, child, 'test.worker.completed_second_turn');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the exposed app, api, and auth surface. Stop after the primary map is complete.',
      reason: 'Need an initial surface map before choosing the first validation path.',
      executionMode: 'blocking',
    });

    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(result.task.status).toBe('completed');
    expect(result.task.summary).toBe('Recon worker completed the core surface map.');
    expect(result.artifact?.findings).toEqual(['Mapped app, api, and auth entrypoints']);
  });

  it('yields a worker loop after a no-op turn instead of spinning', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'submit_worker_result', 'spawn_worker'],
      },
    });
    const processMessage = vi.fn().mockResolvedValue(undefined);
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the exposed surface and return a compact handoff.',
      reason: 'Exercise no-progress loop handling.',
      executionMode: 'blocking',
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(result.task.status).toBe('running');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.loop_yielded',
        payload: expect.objectContaining({
          reason: 'worker_turn_made_no_observable_progress',
          childTurnBefore: 0,
          childTurnAfter: 0,
        }),
      }),
    );
  });

  it('keeps transient provider retry delay under the worker loop owner', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'submit_worker_result', 'spawn_worker'],
      },
    });
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      if (processMessage.mock.calls.length === 1) {
        child.flags = {
          ...(child.flags ?? {}),
          error_retry: {
            retryCount: 1,
            lastCode: 'network.connection_failed',
            retryAfterMs: 1,
          },
        };
        await store.setAsync(child.id, child, 'test.worker.retry_scheduled');
        return;
      }

      child.turn = (child.turn ?? 0) + 1;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Worker completed after the owned provider retry.',
        findings: [],
        evidenceRefs: ['https://target.test/'],
        touchedTargets: ['/'],
        confidence: 0.8,
      };
      child.completed = true;
      child.flags = { ...(child.flags ?? {}), error_retry: undefined, session: { completed: true } };
      await store.setAsync(child.id, child, 'test.worker.retry_completed');
    });
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the public surface and return a compact handoff.',
      reason: 'Exercise worker-owned provider retry.',
      executionMode: 'blocking',
    });

    expect(result.task.status).toBe('completed');
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.retry_wait_started',
        payload: expect.objectContaining({ retryDelayMs: 1, retryCount: 1 }),
      }),
    );
  });

  it('shares one active loop when the same background worker is continued concurrently', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      toolPolicy: {
        allow: ['file_read', 'submit_worker_result', 'spawn_worker', 'continue_worker'],
      },
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const processMessage = vi.fn(async (sessionId: string) => {
      await turnGate;
      const child = store.get(sessionId)!;
      child.turn = (child.turn ?? 0) + 1;
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Concurrent continuation reused the active worker loop.',
        findings: [],
        evidenceRefs: ['https://target.test/'],
        touchedTargets: ['/'],
        confidence: 0.8,
      };
      child.completed = true;
      child.flags = { ...(child.flags ?? {}), session: { completed: true } };
      await store.setAsync(child.id, child, 'test.worker.concurrent_completed');
    });
    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn().mockResolvedValue(undefined) } as any,
      orchestrator: { processMessage } as any,
    });

    const spawned = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the public surface and return a compact handoff.',
      reason: 'Exercise concurrent continuation ownership.',
      executionMode: 'background',
    });
    await service.continueWorker({
      parentSessionId: parent.id,
      taskId: spawned.task.taskId,
      instruction: 'Continue the same bounded mission.',
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    releaseTurn();
    const settled = await service.waitForWorker({
      parentSessionId: parent.id,
      taskId: spawned.task.taskId,
      timeoutMs: 2_000,
    });

    expect(settled.task.status).toBe('completed');
    expect(
      processMessage.mock.calls.filter(([sessionId]) => sessionId === spawned.sessionId),
    ).toHaveLength(1);
  });

  it('waits for a background worker result without marking the task failed', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-wait',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'dependency',
      },
    });

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-wait',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          status: 'running',
          reason: 'Need the recon map before validation.',
          task: 'Map the surface and return a compact handoff.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          dependencyMode: 'dependency',
          continuationMode: 'spawn',
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
      ],
    }, 'test.parent.wait_worker');

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn() } as any,
      orchestrator: { processMessage: vi.fn() } as any,
    });

    setTimeout(async () => {
      const liveChild = store.get(child.id)!;
      liveChild.workerResult = {
        taskId: 'task-wait',
        workerType: 'recon_worker',
        summary: 'Background recon produced the requested surface map.',
        findings: ['Mapped login and signup flows'],
        evidenceRefs: ['https://target.test/login'],
        touchedTargets: ['/login', '/signup'],
        confidence: 0.8,
      };
      liveChild.completed = true;
      liveChild.flags = {
        ...(liveChild.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(liveChild.id, liveChild, 'test.worker.wait_completed');
      await (service as any).syncWorkerState(parent.id, 'task-wait');
    }, 50);

    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      taskId: 'task-wait',
      timeoutMs: 2_000,
    });

    expect(result.task.status).toBe('completed');
    expect(result.task.summary).toBe('Background recon produced the requested surface map.');
    expect(result.artifact?.touchedTargets).toEqual(['/login', '/signup']);
  });

  it('waits for any active worker event when taskId is omitted', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-any',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-any',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          status: 'running',
          reason: 'Map the public surface in parallel.',
          task: 'Map the public surface and return a compact handoff.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
      ],
    }, 'test.parent.any_wait');

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn() } as any,
      orchestrator: { processMessage: vi.fn() } as any,
    });

    setTimeout(async () => {
      const liveChild = store.get(child.id)!;
      liveChild.workerResult = {
        taskId: 'task-any',
        workerType: 'recon_worker',
        summary: 'Background recon completed with the requested map.',
        findings: ['Mapped / and /login'],
        evidenceRefs: ['https://target.test/'],
        touchedTargets: ['/', '/login'],
        confidence: 0.77,
      };
      liveChild.completed = true;
      liveChild.flags = {
        ...(liveChild.flags ?? {}),
        session: { completed: true },
      };
      await store.setAsync(liveChild.id, liveChild, 'test.worker.any_wait_completed');
      await (service as any).syncWorkerState(parent.id, 'task-any');
    }, 50);

    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      timeoutMs: 2_000,
    });

    expect(result.task.taskId).toBe('task-any');
    expect(result.task.status).toBe('completed');
    expect(result.task.summary).toBe('Background recon completed with the requested map.');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.tasks.wait_finished',
        payload: expect.objectContaining({
          waitMode: 'any',
          observedTaskId: 'task-any',
        }),
      }),
    );
  });

  it('wait_for_worker syncs a child-submitted result before reading stale parent status', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });
    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-stale-parent',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });
    await store.setAsync(child.id, {
      ...child,
      workerResult: {
        taskId: 'task-stale-parent',
        workerType: 'recon_worker',
        summary: 'Child already submitted a terminal result.',
        findings: ['Mapped /login'],
        evidenceRefs: ['/workspace/.artifacts/scans/task-stale-parent/httpx.jsonl'],
        touchedTargets: ['/login'],
        confidence: 0.8,
      },
      completed: true,
      flags: { session: { completed: true } },
    } as any, 'test.child.stale_worker_submitted');

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [{
        taskId: 'task-stale-parent',
        parentSessionId: parent.id,
        workerSessionId: child.id,
        workerType: 'recon_worker',
        status: 'running',
        reason: 'Parent has not observed the worker result yet.',
        task: 'Map login.',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
        continuationMode: 'spawn',
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      }],
    }, 'test.parent.stale_worker_status');

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      taskId: 'task-stale-parent',
      timeoutMs: 1_000,
    });

    expect(result.task.status).toBe('completed');
    expect(result.task.summary).toBe('Child already submitted a terminal result.');
    expect(result.artifact?.touchedTargets).toEqual(['/login']);
  });

  it('wait_for_worker without taskId returns a worker made terminal by pre-wait sync', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });
    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-any-stale-parent',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });
    await store.setAsync(child.id, {
      ...child,
      workerResult: {
        taskId: 'task-any-stale-parent',
        workerType: 'recon_worker',
        summary: 'Any-wait worker already submitted.',
        findings: ['Mapped /signup'],
        evidenceRefs: ['/workspace/.artifacts/scans/task-any-stale-parent/httpx.jsonl'],
        touchedTargets: ['/signup'],
      },
      completed: true,
      flags: { session: { completed: true } },
    } as any, 'test.child.any_stale_worker_submitted');
    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [{
        taskId: 'task-any-stale-parent',
        parentSessionId: parent.id,
        workerSessionId: child.id,
        workerType: 'recon_worker',
        status: 'running',
        reason: 'Parent has not observed the worker result yet.',
        task: 'Map signup.',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
        continuationMode: 'spawn',
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      }],
    }, 'test.parent.any_stale_worker_status');

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      timeoutMs: 1_000,
    });

    expect(result.task.taskId).toBe('task-any-stale-parent');
    expect(result.task.status).toBe('completed');
    expect(result.artifact?.summary).toBe('Any-wait worker already submitted.');
  });

  it('stop_worker syncs first and does not downgrade a submitted worker result to cancelled', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });
    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-stop-after-submit',
        workerType: 'validator_worker',
        expectedArtifactType: 'validation_result',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });
    await store.setAsync(child.id, {
      ...child,
      workerResult: {
        taskId: 'task-stop-after-submit',
        workerType: 'validator_worker',
        summary: 'Validation result was already submitted.',
        findings: ['Confirmed no issue'],
        evidenceRefs: ['/workspace/.artifacts/scans/task-stop-after-submit/validation.json'],
        touchedTargets: ['/api/me'],
        confidence: 0.7,
      },
      completed: true,
      flags: { session: { completed: true } },
    } as any, 'test.child.stop_after_submit');
    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [{
        taskId: 'task-stop-after-submit',
        parentSessionId: parent.id,
        workerSessionId: child.id,
        workerType: 'validator_worker',
        status: 'running',
        reason: 'Parent is cleaning up live-looking workers.',
        task: 'Validate /api/me.',
        expectedArtifactType: 'validation_result',
        executionMode: 'background',
        dependencyMode: 'sidecar',
        continuationMode: 'spawn',
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      }],
    }, 'test.parent.stop_after_submit');

    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);

    const result = await service.stopWorker({
      parentSessionId: parent.id,
      taskId: 'task-stop-after-submit',
      reason: 'Clean up before handoff.',
    });

    expect(result.task.status).toBe('completed');
    expect(result.artifact?.summary).toBe('Validation result was already submitted.');
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({ event: 'worker.task.cancelled' }),
    );
  });

  it('waits for any worker event even when the opening wave still leaves uncovered plan steps', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-wave-1',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      plan: [
        { id: 'task-1', title: 'Map app surface', status: 'running' },
        { id: 'task-2', title: 'Map admin surface', status: 'pending' },
      ],
      workerTasks: [
        {
          taskId: 'task-wave-1',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          waveIndex: 0,
          planStepId: 'task-1',
          status: 'running',
          reason: 'Map the app surface in parallel.',
          task: 'Map the app surface and return a compact handoff.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
      ],
    }, 'test.parent.any_wait');

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn() } as any,
      orchestrator: { processMessage: vi.fn() } as any,
    });

    setTimeout(async () => {
      await store.setAsync(child.id, {
        ...child,
        workerResult: {
          taskId: 'task-wave-1',
          workerType: 'recon_worker',
          summary: 'App surface mapped.',
          findings: ['Mapped app routes'],
          evidenceRefs: ['/workspace/.artifacts/scans/task-wave-1/httpx.jsonl'],
          touchedTargets: ['app.example.com'],
        },
      }, 'test.child.wave.completed');
      const parentSession = store.get(parent.id);
      if (parentSession) {
        await store.setAsync(parent.id, {
          ...parentSession,
          workerTasks: (parentSession.workerTasks ?? []).map((task) =>
            task.taskId === 'task-wave-1'
              ? {
                  ...task,
                  status: 'completed',
                  summary: 'App surface mapped.',
                  completedAt: Date.now(),
                  lastUpdatedAt: Date.now(),
                }
              : task,
          ),
        }, 'test.parent.any_wait.completed');
      }
    }, 25);

    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      timeoutMs: 2_000,
    });

    expect(result.task.taskId).toBe('task-wave-1');
    expect(result.task.status).toBe('completed');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.tasks.wait_finished',
        payload: expect.objectContaining({
          waitMode: 'any',
          observedTaskId: 'task-wave-1',
        }),
      }),
    );
  });

  it('waits on running background sidecars and records completion without suppression', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const child = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-sidecar',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-sidecar',
          parentSessionId: parent.id,
          workerSessionId: child.id,
          workerType: 'recon_worker',
          waveIndex: 0,
          status: 'running',
          reason: 'Map the public surface in parallel.',
          task: 'Map the public surface and return a compact handoff.',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
      ],
    }, 'test.parent.sidecar_wait');

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);
    service.bindRuntime({
      agentEngine: { initializeSession: vi.fn() } as any,
      orchestrator: { processMessage: vi.fn() } as any,
    });

    setTimeout(async () => {
      await store.setAsync(child.id, {
        ...child,
        workerResult: {
          taskId: 'task-sidecar',
          workerType: 'recon_worker',
          summary: 'Parallel recon branch completed.',
          findings: ['Mapped public surface'],
          evidenceRefs: ['/workspace/.artifacts/scans/task-sidecar/httpx.jsonl'],
          touchedTargets: ['app.example.com'],
        },
      }, 'test.child.sidecar.completed');
      const parentSession = store.get(parent.id);
      if (parentSession) {
        await store.setAsync(parent.id, {
          ...parentSession,
          workerTasks: (parentSession.workerTasks ?? []).map((task) =>
            task.taskId === 'task-sidecar'
              ? {
                  ...task,
                  status: 'completed',
                  summary: 'Parallel recon branch completed.',
                  completedAt: Date.now(),
                  lastUpdatedAt: Date.now(),
                }
              : task,
          ),
        }, 'test.parent.sidecar_wait.completed');
      }
    }, 25);

    const result = await service.waitForWorker({
      parentSessionId: parent.id,
      taskId: 'task-sidecar',
      timeoutMs: 2_000,
    });

    expect(result.task.status).toBe('completed');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.wait_finished',
        payload: expect.objectContaining({
          taskId: 'task-sidecar',
        }),
      }),
    );
  });

  it('allows stop_worker during wrap-up even when other live sidecars are still running', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
    });

    const childA = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-a',
        workerType: 'recon_worker',
        expectedArtifactType: 'surface_map',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });
    const childB = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      coordination: {
        role: 'worker',
        parentSessionId: parent.id,
        parentTaskId: 'task-b',
        workerType: 'validator_worker',
        expectedArtifactType: 'validation_result',
        executionMode: 'background',
        dependencyMode: 'sidecar',
      },
    });

    await store.setAsync(parent.id, {
      ...parent,
      coordination: { role: 'direct' },
      workerTasks: [
        {
          taskId: 'task-a',
          parentSessionId: parent.id,
          workerSessionId: childA.id,
          workerType: 'recon_worker',
          status: 'running',
          reason: 'Parallel recon branch A.',
          task: 'Map host A',
          expectedArtifactType: 'surface_map',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
        {
          taskId: 'task-b',
          parentSessionId: parent.id,
          workerSessionId: childB.id,
          workerType: 'validator_worker',
          status: 'running',
          reason: 'Parallel validation branch B.',
          task: 'Validate host B',
          expectedArtifactType: 'validation_result',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          continuationMode: 'spawn',
          createdAt: Date.now(),
        },
      ],
    }, 'test.parent.stop_denied');

    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDelegationService(store, new ToolPolicyChecker(), traceRecorder as any);

    const result = await service.stopWorker({
      parentSessionId: parent.id,
      taskId: 'task-a',
      reason: 'All tasks look terminal; stop remaining workers before report.',
    });

    expect(result.task.status).toBe('cancelled');
    expect(traceRecorder.write).toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.cancelled',
      }),
    );
    expect(traceRecorder.write).not.toHaveBeenCalledWith(
      parent.id,
      expect.any(Number),
      expect.objectContaining({
        event: 'worker.task.stop_denied',
      }),
    );
  });
});
