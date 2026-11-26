import { describe, expect, it } from 'vitest';

import type {
  EnumerationMissionV1,
  EnumerationWorkerResultV1,
  WorkerTaskRecord,
} from '@/domains/agent-brain/domain/types';
import {
  buildEnumerationAttemptReservation,
  computeEnumerationMissionFingerprint,
  computeEnumerationResultHash,
  EnumerationMissionV1Schema,
  isEnumerationArtifactPathForTask,
  isEnumerationLeadValidatorEligible,
  normalizeEnumerationResultInputV1,
  parseEnumerationResultV1,
  resolveEnumerationContinuationAdmission,
  resolveEnumerationInfrastructureRetryAdmission,
} from '@/domains/agent-brain/domain/workers/enumerationContracts';
import { sha256Hex } from '@/domains/agent-brain/domain/workers/sha256';

const hash = (character: string): string => character.repeat(64);

const buildMission = (): EnumerationMissionV1 => {
  const mission: EnumerationMissionV1 = {
    schemaVersion: 1,
    kind: 'enumeration_hunt_v1',
    phaseAttemptId: 'phase-attempt-1',
    targetRef: 'https://app.example.com',
    surface: { kind: 'endpoint_set', refs: ['/api/users/{id}'] },
    techniqueIds: ['T-IDOR'],
    primarySkill: { slug: 'idor', versionHash: hash('a') },
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
    missionFingerprint: hash('0'),
  };
  mission.missionFingerprint = computeEnumerationMissionFingerprint('run-1', mission);
  return mission;
};

const buildTask = (mission: EnumerationMissionV1): WorkerTaskRecord => ({
  taskId: '00000000-0000-4000-8000-000000000001',
  parentSessionId: 'parent',
  workerSessionId: 'worker',
  workerType: 'enumeration_worker',
  status: 'running',
  reason: 'bounded hunt',
  task: 'enumerate one endpoint',
  expectedArtifactType: 'enumeration_result/v1',
  executionMode: 'background',
  continuationMode: 'spawn',
  mission: {
    phase: 'enumeration',
    question: 'Does object authorization drift?',
    whyReadyNow: 'Endpoint and baseline are known.',
    requiredEvidence: ['request comparison'],
    expectedArtifact: 'enumeration_result/v1',
    stopCondition: 'Technique exhausted.',
    assignedSkills: ['idor'],
    enumeration: mission,
  },
  budget: mission.budgets,
  targetRequestsUsed: 0,
  createdAt: 1,
});

const buildResult = (mission: EnumerationMissionV1): EnumerationWorkerResultV1 => {
  const result = {
    schemaVersion: 1 as const,
    missionFingerprint: mission.missionFingerprint,
    resultHash: hash('0'),
    status: 'completed' as const,
    targetRef: mission.targetRef,
    surfaceRefs: [...mission.surface.refs],
    skills: [{ ...mission.primarySkill, role: 'primary' as const }],
    leads: [],
    negativeResults: [],
    attempts: [],
    coverage: {
      requested: {
        surfaceRefs: [...mission.surface.refs],
        techniqueIds: [...mission.techniqueIds],
        personaClasses: [],
      },
      attempted: { surfaceRefs: [], techniqueIds: [], personaClasses: [] },
      counts: { attempts: 0, requests: 0, leads: 0, negativeResults: 0 },
      uncovered: [{ kind: 'surface' as const, ref: mission.surface.refs[0], reason: 'bounded stop' }],
    },
    blockers: [],
    artifacts: [],
    recommendedValidationMissions: [],
  };
  result.resultHash = computeEnumerationResultHash(result);
  return result;
};

describe('enumeration worker contracts', () => {
  it('uses the standard SHA-256 digest in the pure domain implementation', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts the locked mission limits and rejects unknown fields', () => {
    const mission = buildMission();
    expect(EnumerationMissionV1Schema.parse(mission)).toEqual(mission);
    expect(() => EnumerationMissionV1Schema.parse({ ...mission, unknown: true })).toThrow();
    expect(() => EnumerationMissionV1Schema.parse({
      ...mission,
      supportingSkills: [1, 2, 3].map((index) => ({
        slug: `tool-${index}`,
        versionHash: hash(String(index)),
      })),
    })).toThrow();
    expect(isEnumerationArtifactPathForTask(
      'task-1',
      '/workspace/.artifacts/workers/enumeration/task-1/evidence.json',
    )).toBe(true);
    expect(isEnumerationArtifactPathForTask(
      'task-1',
      '/workspace/.artifacts/workers/enumeration/task-1/../secret.txt',
    )).toBe(false);
  });

  it('round-trips a reconciled result and detects foreign coverage or meter drift', () => {
    const mission = buildMission();
    const task = buildTask(mission);
    const result = buildResult(mission);
    expect(parseEnumerationResultV1(result, task)).toEqual(result);

    const foreign = {
      ...result,
      surfaceRefs: ['/admin'],
      resultHash: hash('f'),
    };
    expect(() => parseEnumerationResultV1(foreign, task)).toThrow(/surfaceRefs/u);

    expect(() => parseEnumerationResultV1(result, { ...task, targetRequestsUsed: 1 }))
      .toThrow(/server meter/u);
  });

  it('normalizes worker draft bookkeeping from authoritative server task state', () => {
    const mission = buildMission();
    const serverAttempt = {
      ...buildEnumerationAttemptReservation(
        mission,
        'http_payload',
        { url: 'https://app.example.com/api/users/7', method: 'GET' },
        1,
        1_000,
      ),
      completedAt: 2_000,
      status: 'completed' as const,
    };
    const task = {
      ...buildTask(mission),
      targetRequestsUsed: 1,
      enumerationAttempts: [serverAttempt],
    };
    const draft = {
      ...buildResult(mission),
      resultHash: 'model-cannot-precompute-this',
      skills: [{ slug: 'wrong-shape' }],
      attempts: [{
        fingerprint: hash('f'),
        surfaceRef: mission.surface.refs[0],
        techniqueId: 'T-IDOR',
        evidenceRefs: ['/workspace/.artifacts/tool-results/http_payload.json'],
      }],
      negativeResults: [{
        localId: 'neg-1',
        surfaceRef: mission.surface.refs[0],
        techniqueId: 'T-IDOR',
        controlOrBaseline: 'baseline response',
        attemptFingerprints: [hash('e')],
        evidenceRefs: [],
        conclusion: 'The baseline did not show drift.',
        confidence: 0.6,
      }],
      coverage: {
        requested: { surfaceRefs: ['/wrong'], techniqueIds: ['T-WRONG'] },
        attempted: { surfaceRefs: ['/wrong'], techniqueIds: ['T-WRONG'] },
        counts: { attempts: 99, requests: 99, leads: 99, negativeResults: 99 },
        uncovered: [],
      },
      artifacts: [{
        id: 'outside-tool-result',
        path: '/workspace/.artifacts/tool-results/http_payload.json',
        sha256: hash('1'),
        bytes: 12,
        contentType: 'application/json',
        purpose: 'tool output',
        sensitivity: 'internal' as const,
      }],
    };

    const normalized = normalizeEnumerationResultInputV1(draft, task);

    expect(normalized.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalized.skills).toEqual([{ ...mission.primarySkill, role: 'primary' }]);
    expect(normalized.attempts).toEqual([
      expect.objectContaining({
        fingerprint: serverAttempt.fingerprintsByTechnique['T-IDOR'],
        requestCount: 1,
        surfaceRef: mission.surface.refs[0],
      }),
    ]);
    expect(normalized.negativeResults[0].attemptFingerprints).toEqual([
      serverAttempt.fingerprintsByTechnique['T-IDOR'],
    ]);
    expect(normalized.coverage.counts).toEqual({
      attempts: 1,
      requests: 1,
      leads: 0,
      negativeResults: 1,
    });
    expect(normalized.artifacts).toEqual([]);
    expect(parseEnumerationResultV1(normalized, task)).toEqual(normalized);
  });

  it('treats durable evidenced leads as validation eligible even when validation must still test prerequisites', () => {
    const mission = buildMission();
    const lead: EnumerationWorkerResultV1['leads'][number] = {
      localId: 'lead-1',
      riskFamily: 'idor',
      techniqueId: 'T-IDOR',
      targetRef: mission.targetRef,
      surfaceRef: mission.surface.refs[0],
      hypothesis: 'The endpoint may expose another user record.',
      observation: 'A bounded baseline request reached the target endpoint and showed object-id input.',
      validationGoal: 'Replay with two authorized personas and compare access.',
      requiredControls: ['same-user baseline'],
      prerequisites: ['validation phase must perform bounded HTTP replay'],
      evidenceRefs: ['/workspace/.artifacts/workers/enumeration/task-1/baseline.json'],
      evidenceState: 'durable',
      confidence: 0.7,
      priority: 'high',
      authContextClass: 'anonymous',
      attemptFingerprints: [],
    };

    expect(isEnumerationLeadValidatorEligible(lead)).toBe(true);
    expect(isEnumerationLeadValidatorEligible({ ...lead, evidenceState: 'needs_evidence' })).toBe(false);
    expect(isEnumerationLeadValidatorEligible({ ...lead, evidenceRefs: [] })).toBe(false);
  });

  it('rejects secret-bearing result content before persistence', () => {
    const mission = buildMission();
    const result = buildResult(mission);
    const secretBearing = {
      ...result,
      blockers: [{
        code: 'policy_denied',
        message: 'Authorization: Bearer abcdefghijklmnop',
      }],
      resultHash: hash('e'),
    };
    expect(() => parseEnumerationResultV1(secretBearing, buildTask(mission))).toThrow(/secret/u);
  });

  it('issues deterministic per-technique attempt fingerprints and reconciles them to the server meter', () => {
    const mission = buildMission();
    const serverAttempt = {
      ...buildEnumerationAttemptReservation(
        mission,
        'http_payload',
        { url: 'https://app.example.com/api/users/7', method: 'GET' },
        1,
        1_000,
      ),
      completedAt: 2_000,
      status: 'completed' as const,
    };
    expect(serverAttempt.fingerprintsByTechnique['T-IDOR']).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildEnumerationAttemptReservation(
      mission,
      'http_payload',
      { url: 'https://app.example.com/api/users/7', method: 'GET' },
      1,
      3_000,
    ).reservationFingerprint).toBe(serverAttempt.reservationFingerprint);

    const base = buildResult(mission);
    const withAttempt = {
      ...base,
      attempts: [{
        fingerprint: serverAttempt.fingerprintsByTechnique['T-IDOR']!,
        toolClass: serverAttempt.toolClass,
        actionClass: serverAttempt.actionClass,
        surfaceRef: serverAttempt.surfaceRef,
        techniqueId: 'T-IDOR',
        personaClass: serverAttempt.personaClass,
        startedAt: new Date(serverAttempt.reservedAt).toISOString(),
        endedAt: new Date(serverAttempt.completedAt).toISOString(),
        status: 'completed' as const,
        requestCount: 1,
        evidenceRefs: [],
      }],
      coverage: {
        ...base.coverage,
        attempted: {
          surfaceRefs: [...mission.surface.refs],
          techniqueIds: [...mission.techniqueIds],
          personaClasses: ['anonymous'],
        },
        counts: { ...base.coverage.counts, attempts: 1, requests: 1 },
      },
    };
    const result = {
      ...withAttempt,
      resultHash: computeEnumerationResultHash(withAttempt),
    };
    const task = {
      ...buildTask(mission),
      targetRequestsUsed: 1,
      enumerationAttempts: [serverAttempt],
    };
    expect(parseEnumerationResultV1(result, task)).toEqual(result);
    expect(() => parseEnumerationResultV1({
      ...result,
      attempts: [{ ...result.attempts[0], fingerprint: hash('f') }],
      resultHash: computeEnumerationResultHash({
        ...result,
        attempts: [{ ...result.attempts[0], fingerprint: hash('f') }],
      }),
    }, task)).toThrow(/server attempt reservations/u);
  });

  it('recalculates continuation request and immutable deadline headroom, with no credit state', () => {
    const task = {
      budget: { maxTargetRequests: 40 },
      targetRequestsUsed: 7,
      deadlineAt: 10_000,
    };
    expect(resolveEnumerationContinuationAdmission(task, 4_000)).toEqual({
      allowed: true,
      remainingTargetRequests: 33,
      remainingWallMs: 6_000,
    });
    expect(resolveEnumerationContinuationAdmission(
      { ...task, targetRequestsUsed: 40 },
      4_000,
    ).reason).toBe('request_budget_exhausted');
    expect(resolveEnumerationContinuationAdmission(task, 10_000).reason)
      .toBe('deadline_exhausted');
  });

  it('allows one infrastructure retry only before requests, artifacts, or deadline exhaustion', () => {
    const task = {
      budget: { maxTargetRequests: 40 },
      targetRequestsUsed: 0,
      retryIndex: 0,
      deadlineAt: 10_000,
    };
    expect(resolveEnumerationInfrastructureRetryAdmission(task, 4_000).allowed).toBe(true);
    expect(resolveEnumerationInfrastructureRetryAdmission(
      { ...task, targetRequestsUsed: 1 },
      4_000,
    ).reason).toBe('target_request_already_issued');
    expect(resolveEnumerationInfrastructureRetryAdmission(
      { ...task, retryIndex: 1 },
      4_000,
    ).reason).toBe('retry_limit_reached');
    expect(resolveEnumerationInfrastructureRetryAdmission(
      {
        ...task,
        artifact: {
          taskId: 'task',
          workerType: 'enumeration_worker',
          summary: 'partial',
          findings: [],
          evidenceRefs: [],
          touchedTargets: [],
          confidence: 0,
        },
      },
      4_000,
    ).reason).toBe('artifact_already_produced');
    expect(resolveEnumerationInfrastructureRetryAdmission(task, 10_000).reason)
      .toBe('deadline_exhausted');
  });
});
