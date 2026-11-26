import { describe, expect, it } from 'vitest';
import {
  evaluateDelegationActivation,
  parseAssignedSkillsFromExtraContext,
} from '@/domains/agent-brain/domain/workers/delegationActivation';

describe('delegationActivation', () => {
  const structuredEnumerationMission = (fingerprint: string, surfaceRef: string) => ({
    phase: 'enumeration',
    question: `Enumerate ${surfaceRef}`,
    whyReadyNow: 'The endpoint and baseline are known.',
    requiredEvidence: ['bounded request comparison'],
    expectedArtifact: 'enumeration_result/v1',
    stopCondition: 'Technique exhausted.',
    assignedSkills: ['idor'],
    enumeration: {
      schemaVersion: 1,
      kind: 'enumeration_hunt_v1',
      phaseAttemptId: 'phase-1',
      targetRef: 'https://app.example.com',
      surface: { kind: 'endpoint_set', refs: [surfaceRef] },
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
      missionFingerprint: fingerprint.repeat(64),
    },
  });

  it('parses assigned skills without leaking methodology keys into the slug list', () => {
    const extraContext = [
      '=== ASSIGNED METHODOLOGIES ===',
      '- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md',
      '=== PRIOR RUN CONTEXT ===',
      'none',
    ].join('\n');

    expect(parseAssignedSkillsFromExtraContext(extraContext)).toEqual({
      detected: true,
      slugs: ['broad-surface-scan'],
      versions: {},
      blockLength: expect.any(Number),
    });
  });

  it('does not expose assigned skill content hashes to the model', () => {
    const extraContext = [
      '=== ASSIGNED METHODOLOGIES ===',
      '- cors: /workspace/.skills/cors/methodology.md',
    ].join('\n');

    expect(parseAssignedSkillsFromExtraContext(extraContext)).toMatchObject({
      slugs: ['cors'],
      versions: {},
    });
  });

  it('fans out the opening wave across independent discovery branches with background/sidecar defaults', () => {
    const hint = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '=== ASSIGNED METHODOLOGIES ===\n- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md\n',
        plan: [
          { id: 'task-1', title: 'Broad Surface Scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Broad Surface Scan on api.example.com', status: 'pending' },
          { id: 'task-3', title: 'Analysis and Vulnerability Assessment Planning', status: 'pending' },
        ],
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
    } as any);

    expect(hint.shouldPrompt).toBe(true);
    expect(hint.confidence).toBe('strong');
    expect(hint.openingWave).toBe(true);
    expect(hint.recommendations.length).toBeGreaterThanOrEqual(2);
    for (const recommendation of hint.recommendations) {
      expect(recommendation.workerType).toBe('recon_worker');
      expect(recommendation.executionMode).toBe('background');
      expect(recommendation.dependencyMode).toBe('sidecar');
      expect(recommendation.independenceKey).toBeDefined();
    }
    expect(new Set(hint.recommendations.map((r) => r.independenceKey)).size).toBe(
      hint.recommendations.length,
    );
    expect(hint.reasons.join('\n')).toContain('fan out in parallel');
  });

  it('recommends enumeration workers only from multiple eligible structured missions', () => {
    const plan = [
      {
        id: 'enum-1',
        title: 'Authorization question A',
        status: 'pending',
        mission: structuredEnumerationMission('a', '/api/users/{id}'),
      },
      {
        id: 'enum-2',
        title: 'Authorization question B',
        status: 'pending',
        mission: structuredEnumerationMission('b', '/api/orders/{id}'),
      },
    ];
    const enabled = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan,
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
      enumerationWorkerEnabled: true,
      enumerationAutoEligiblePlanStepIds: ['enum-1', 'enum-2'],
    } as any);
    expect(enabled.openingWave).toBe(true);
    expect(enabled.recommendations.map((recommendation) => recommendation.workerType))
      .toEqual(['enumeration_worker', 'enumeration_worker']);
    expect(enabled.recommendations.every((recommendation) =>
      recommendation.mission?.enumeration?.kind === 'enumeration_hunt_v1'
    )).toBe(true);

    const disabled = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan,
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
      enumerationWorkerEnabled: false,
      enumerationAutoEligiblePlanStepIds: ['enum-1', 'enum-2'],
    } as any);
    expect(disabled.recommendations.some((recommendation) =>
      recommendation.workerType === 'enumeration_worker'
    )).toBe(false);
  });

  it('dedupes opening-wave recommendations by independence key when plan steps target the same host', () => {
    const hint = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan: [
          { id: 'task-1', title: 'Broad surface scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Content discovery on app.example.com', status: 'pending' },
          { id: 'task-3', title: 'Broad surface scan on api.example.com', status: 'pending' },
        ],
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
    } as any);

    expect(hint.recommendations.length).toBe(2);
    const keys = hint.recommendations.map((r) => r.independenceKey).sort();
    expect(keys).toEqual(['host:api.example.com', 'host:app.example.com']);
  });

  it('honors the maxConcurrency cap when truncating opening-wave recommendations', () => {
    const hint = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan: [
          { id: 'task-1', title: 'Broad surface scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Broad surface scan on api.example.com', status: 'pending' },
          { id: 'task-3', title: 'Broad surface scan on admin.example.com', status: 'pending' },
        ],
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
      maxConcurrency: 2,
    } as any);

    expect(hint.openingWave).toBe(true);
    expect(hint.recommendations.length).toBe(2);
    expect(hint.maxConcurrency).toBe(2);
  });

  it('suppresses background discovery recommendations when the budget cap is zero', () => {
    const hint = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan: [
          { id: 'task-1', title: 'Broad surface scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Broad surface scan on api.example.com', status: 'pending' },
        ],
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
      maxConcurrency: 0,
    } as any);

    expect(hint.maxConcurrency).toBe(0);
    expect(hint.openingWave).toBe(false);
    expect(hint.shouldPrompt).toBe(false);
    expect(hint.recommendations).toHaveLength(0);
  });

  it('falls back to a single background recon when only one discovery step is pending', () => {
    const hint = evaluateDelegationActivation({
      session: {
        agentType: 'executor',
        extraContext: '',
        plan: [
          { id: 'task-1', title: 'Broad surface scan on app.example.com', status: 'pending' },
          { id: 'task-2', title: 'Package evidence and write report', status: 'pending' },
        ],
        workerTasks: [],
        coordination: { role: 'direct' },
        executionMode: 'discovery',
      },
    } as any);

    expect(hint.openingWave).toBe(false);
    expect(hint.recommendations.length).toBe(1);
    expect(hint.recommendations[0].workerType).toBe('recon_worker');
    expect(hint.recommendations[0].executionMode).toBe('background');
    expect(hint.recommendations[0].dependencyMode).toBe('sidecar');
  });

  it('does not force recon delegation when the first plan task is targeted validation', () => {
    const hint = evaluateDelegationActivation({
      agentType: 'executor',
      extraContext: '=== ASSIGNED METHODOLOGIES ===\n- broad-surface-scan: /workspace/.skills/broad-surface-scan/methodology.md\n',
      plan: [
        { id: 'task-1', title: 'Validate CVE-2025-1234 auth bypass on api.example.com', status: 'pending' },
        { id: 'task-2', title: 'Package evidence and remediation notes', status: 'pending' },
      ],
      workerTasks: [],
      coordination: { role: 'direct' },
      executionMode: 'validation',
    } as any);

    expect(hint.shouldPrompt).toBe(true);
    expect(hint.recommendedWorkerType).toBe('validator_worker');
    expect(hint.recommendations.some((recommendation) => recommendation.workerType === 'recon_worker')).toBe(false);
    expect(hint.reasons).toContain(
      'current plan step is targeted validation: Validate CVE-2025-1234 auth bypass on api.example.com',
    );
  });

  it('suggests evidence delegation only when evidence-mode work has completed worker artifacts', () => {
    const hint = evaluateDelegationActivation({
      agentType: 'executor',
      extraContext: '',
      plan: [],
      workerTasks: [
        {
          taskId: 'task-1',
          workerType: 'recon_worker',
          status: 'completed',
        },
      ],
      coordination: { role: 'direct' },
      executionMode: 'evidence',
    } as any);

    expect(hint.shouldPrompt).toBe(true);
    expect(hint.recommendedWorkerType).toBe('evidence_worker');
    expect(hint.recommendedExecutionMode).toBe('background');
    expect(hint.recommendedDependencyMode).toBe('sidecar');
    expect(hint.reasons).toContain('completed worker artifacts exist during evidence-mode work');
  });
});

