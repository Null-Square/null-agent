import { describe, expect, it, vi } from 'vitest';
import { validateSession, validateSessions } from './validators';

describe('validateSession', () => {
  it('coerces numeric strings and preserves usage fields', () => {
    const session = validateSession({
      id: 'sess-1',
      createdAt: '123',
      updatedAt: '456',
      executionTarget: 'scope_runner',
      runnerId: 'runner-1',
      runnerName: 'Private Runner',
      usage: {
        promptTokens: '10',
        totalTokens: '20',
      },
    });

    expect(session.createdAt).toBe(123);
    expect(session.updatedAt).toBe(456);
    expect(session.executionTarget).toBe('scope_runner');
    expect(session.runnerName).toBe('Private Runner');
    expect(session.usage?.promptTokens).toBe(10);
    expect(session.usage?.totalTokens).toBe(20);
  });

  it('accepts record-shaped session metadata under the frontend zod runtime', () => {
    const session = validateSession({
      id: 'sess-1',
      blocked_meta: { reason: 'operator_cancelled' },
      liveToolStreams: {
        shell_run: {
          name: 'shell_run',
          chunks: ['ok'],
          status: 'completed',
          lastUpdated: 123,
        },
      },
    });

    expect(session.blocked_meta).toEqual({ reason: 'operator_cancelled' });
    expect(session.liveToolStreams?.shell_run?.status).toBe('completed');
  });

  it('accepts enumeration worker payloads and remains tolerant of unknown worker types', () => {
    const session = validateSession({
      id: 'sess-enumeration',
      workerTasks: [{
        taskId: 'task-1',
        parentSessionId: 'sess-enumeration',
        workerSessionId: 'worker-1',
        workerType: 'enumeration_worker',
        status: 'completed',
        reason: 'bounded hunt',
        task: 'enumerate one endpoint',
        expectedArtifactType: 'enumeration_result/v1',
        executionMode: 'background',
        continuationMode: 'spawn',
        targetRequestsUsed: 0,
        createdAt: 1,
        artifact: {
          taskId: 'task-1',
          workerType: 'enumeration_worker',
          summary: 'No lead after bounded coverage.',
          enumeration: {
            schemaVersion: 1,
            missionFingerprint: 'a'.repeat(64),
            resultHash: 'b'.repeat(64),
            status: 'completed',
            targetRef: 'https://app.example.com',
            surfaceRefs: ['/api/users'],
            skills: [{ slug: 'idor', versionHash: 'c'.repeat(64), role: 'primary' }],
            leads: [],
            negativeResults: [],
            attempts: [],
            coverage: {
              requested: {},
              attempted: {},
              counts: { attempts: 0, requests: 0, leads: 0, negativeResults: 0 },
              uncovered: [],
            },
            blockers: [],
            artifacts: [],
            recommendedValidationMissions: [],
          },
        },
      }, {
        taskId: 'task-future',
        parentSessionId: 'sess-enumeration',
        workerSessionId: 'worker-future',
        workerType: 'future_worker_v2',
        status: 'running',
        reason: 'forward-compatible fixture',
        task: 'future work',
        expectedArtifactType: 'future/v2',
        executionMode: 'background',
        continuationMode: 'spawn',
        createdAt: 2,
      }],
    });

    expect(session.workerTasks?.[0]?.workerType).toBe('enumeration_worker');
    expect(session.workerTasks?.[0]?.artifact?.enumeration?.resultHash).toBe('b'.repeat(64));
    expect(session.workerTasks?.[1]?.workerType).toBe('future_worker_v2');
  });
});

describe('validateSessions', () => {
  it('returns only valid sessions when mixed input is provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = validateSessions([{ id: 'sess-1' }, { foo: 'bar' }]);

    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe('sess-1');

    warnSpy.mockRestore();
  });
});
