import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TimelineEvent } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import { RunTraceService } from '@/domains/security-ops/runs/RunTraceService';
import { reconcileTraceIntegrity } from '@/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';

const event = (overrides: Partial<TimelineEvent> & { id: string; sessionId: string; event: string; ts: string }): TimelineEvent => ({
  id: overrides.id,
  sessionId: overrides.sessionId,
  turn: overrides.turn ?? 1,
  ts: overrides.ts,
  event: overrides.event,
  severity: overrides.severity ?? 'info',
  payload: overrides.payload,
  note: overrides.note,
  links: overrides.links,
  runId: overrides.runId,
  agentRole: overrides.agentRole,
  phaseId: overrides.phaseId,
  workerTaskId: overrides.workerTaskId,
});

describe('RunTraceService', () => {
  let traceRoot: string;

  beforeEach(async () => {
    traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'run-trace-service-'));
  });

  afterEach(async () => {
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it('merges run sessions, hides debug by default, and computes run trace stats', async () => {
    const plannerEvents = [
      event({
        id: 'e1',
        sessionId: 'planner-session',
        event: 'model.call.finish',
        ts: '2026-05-05T10:00:00.000Z',
        payload: { tokens: { total: 100 }, status: 'completed' },
      }),
      event({
        id: 'e2',
        sessionId: 'planner-session',
        event: 'model.call.messages',
        ts: '2026-05-05T10:00:01.000Z',
        severity: 'debug',
      }),
    ];
    const executorEvents = [
      event({
        id: 'e3',
        sessionId: 'executor-session',
        event: 'tool.finish',
        ts: '2026-05-05T10:01:00.000Z',
        payload: { toolName: 'http_payload', outcome: 'success', success: true },
      }),
      event({
        id: 'e4',
        sessionId: 'executor-session',
        event: 'discovery',
        ts: '2026-05-05T10:02:00.000Z',
        payload: { category: 'endpoint', key: 'api', summary: 'Found API', confidence: 0.8 },
      }),
      event({
        id: 'e5',
        sessionId: 'worker-session',
        event: 'tool.finish',
        ts: '2026-05-05T10:03:00.000Z',
        payload: { toolName: 'shell_run', outcome: 'failure', success: false },
        links: { artifact: 'artifacts/e5.json' },
      }),
    ];
    const timelineService = {
      getAllEvents: vi.fn(async (sessionId: string) => {
        if (sessionId === 'planner-session') return plannerEvents;
        if (sessionId === 'executor-session') return executorEvents.filter((entry) => entry.sessionId === 'executor-session');
        if (sessionId === 'worker-session') return executorEvents.filter((entry) => entry.sessionId === 'worker-session');
        return [];
      }),
    };
    const service = new RunTraceService({
      timelineService,
      sessionResolver: { listIdsByRunId: vi.fn().mockResolvedValue(['worker-session']) },
      phaseSource: {
        listByRunId: vi.fn().mockResolvedValue([
          {
            id: 'phase-1',
            phaseKey: 'validation',
            ordinal: 1,
            sessionId: 'executor-session',
          },
        ]),
      },
      traceRoot,
    });

    const trace = await service.getTraceForRun({
      id: 'run-1',
      plannerSessionId: 'planner-session',
      executorSessionId: 'executor-session',
      sessionId: 'executor-session',
    });

    expect(trace.sessionIds).toEqual(['planner-session', 'executor-session', 'worker-session']);
    expect(trace.events.map((entry) => entry.id)).toEqual(['e1', 'e3', 'e4', 'e5']);
    expect(trace.events.find((entry) => entry.id === 'e1')).toEqual(expect.objectContaining({
      runId: 'run-1',
      agentRole: 'planner',
    }));
    expect(trace.events.find((entry) => entry.id === 'e3')).toEqual(expect.objectContaining({
      runId: 'run-1',
      phaseId: 'phase-1',
      agentRole: 'executor',
    }));
    expect(trace.stats).toEqual(expect.objectContaining({
      events: 4,
      sessions: 3,
      toolCalls: 2,
      modelCalls: 1,
      discoveries: 1,
      linkedArtifacts: 1,
      totalTokens: 100,
      failures: 1,
    }));
    expect(trace.integrity).toMatchObject({
      status: 'degraded',
      sessions: [
        { sessionId: 'planner-session', status: 'degraded' },
        { sessionId: 'executor-session', status: 'degraded' },
        { sessionId: 'worker-session', status: 'degraded' },
      ],
    });

    const debugTrace = await service.getTraceForRun(
      {
        id: 'run-1',
        plannerSessionId: 'planner-session',
        executorSessionId: 'executor-session',
        sessionId: 'executor-session',
      },
      { includeDebug: true },
    );
    expect(debugTrace.events.map((entry) => entry.id)).toContain('e2');
  });

  it('exposes a stored complete integrity receipt instead of reconstructing legacy certainty', async () => {
    const integrity = reconcileTraceIntegrity({
      sessionId: 'session-1',
      acceptedHighWater: 4,
      persistedHighWater: 4,
      terminalReceipt: true,
    });
    const service = new RunTraceService({
      timelineService: {
        getAllEvents: vi.fn().mockResolvedValue([
          event({
            id: 'event-1',
            sessionId: 'session-1',
            event: 'session.cleanup',
            ts: '2026-05-05T10:00:00.000Z',
          }),
        ]),
      },
      integritySource: {
        find: vi.fn().mockResolvedValue({
          acceptedHighWater: 4,
          persistedHighWater: 4,
          integrityStatus: 'complete',
          integrityDetails: integrity,
        }),
      },
      traceRoot,
    });

    const trace = await service.getTraceSnapshotForRun({ id: 'run-1', sessionId: 'session-1' });
    expect(trace.integrity).toEqual({ status: 'complete', sessions: [integrity] });
  });

  it('builds the full forensic bundle with every trace rendering and proof domain', async () => {
    await fs.mkdir(path.join(traceRoot, 'session-1', 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(traceRoot, 'session-1', 'trace.ndjson'), '{"event":"session.init"}\n');
    await fs.writeFile(path.join(traceRoot, 'session-1', 'trace.md'), '# Session\n');
    await fs.writeFile(path.join(traceRoot, 'session-1', 'artifacts', 'finding.json'), '{"ok":true}\n');

    const events = [
      event({
        id: 'finding-1',
        sessionId: 'session-1',
        event: 'discovery',
        ts: '2026-05-05T10:00:00.000Z',
        payload: { category: 'credential', key: 'cred-1', summary: 'Found credentials', confidence: 0.9 },
        links: { evidence: 'artifacts/finding.json' },
      }),
    ];
    const performanceBundleSource = {
      getRunBundleEntries: vi.fn().mockResolvedValue([
        { path: 'performance/run-performance.json', content: 'performance-summary' },
        { path: 'performance/run-performance.md', content: '# Performance\n' },
      ]),
    };
    const complianceBundleSource = {
      getRunBundleEntries: vi.fn().mockResolvedValue([
        { path: 'compliance/control-checks.json', content: '{"checks":[]}' },
        { path: 'compliance/evidence-manifest.json', content: '{"items":[]}' },
        { path: 'compliance/drift.json', content: '{"status":"clean"}' },
      ]),
    };
    const service = new RunTraceService({
      timelineService: { getAllEvents: vi.fn().mockResolvedValue(events) },
      reportFindingsSource: {
        listReportFindings: vi.fn().mockResolvedValue([
          {
            id: 'db-finding-1',
            title: 'Stored credential exposure',
            severity: 'high',
            state: 'confirmed',
            summary: 'Database-backed report finding.',
            businessImpact: 'Credentials can be reused to access internal systems.',
            technicalAnalysis: 'A stored artifact contained plaintext credentials in a reachable path.',
            pocDescription: 'Open the referenced artifact and confirm the credential material is present.',
            assumptions: 'The attacker can reach the exposed artifact path.',
            remediation: 'Remove the stored credentials, rotate affected secrets, and prevent future publication.',
            fixEffort: 'low',
            cweIds: ['CWE-522'],
            owaspCategory: 'A05:2021-Security Misconfiguration',
            cvssScore: 6.5,
            cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
            dedupeKey: 'dedupe-1',
            assetKind: 'domain',
            assetValue: 'app.example.com',
            lastSeenAt: '2026-05-05T10:00:00.000Z',
          },
        ]),
      },
      closeoutArtifactSource: {
        listCloseoutArtifacts: vi.fn().mockResolvedValue([
          { path: 'closeout/session-1/summary.md', content: '# Summary\n' },
          { path: 'closeout/session-1/report.md', content: '# Report\n' },
        ]),
      },
      performanceBundleSource,
      complianceBundleSource,
      traceRoot,
    });

    const bundle = await service.getBundleEntries({
      id: 'run-2',
      sessionId: 'session-1',
      workflowDiscipline: 'pentest',
    }, { mode: 'forensic' });
    const paths = bundle.map((entry) => entry.path).sort();

    expect(paths).toEqual(expect.arrayContaining([
      'run_summary.json',
      'run_summary.md',
      'trace.ndjson',
      'trace.md',
      'trace-findings.csv',
      'report-findings.csv',
      'performance/run-performance.json',
      'performance/run-performance.md',
      'compliance/control-checks.json',
      'compliance/evidence-manifest.json',
      'compliance/drift.json',
      'sessions/session-1/trace.ndjson',
      'sessions/session-1/trace.md',
      'artifacts/session-1/artifacts/finding.json',
      'closeout/session-1/summary.md',
      'closeout/session-1/report.md',
    ]));
    expect(String(bundle.find((entry) => entry.path === 'trace-findings.csv')?.content)).toContain('Found credentials');
    const reportFindingsCsv = String(bundle.find((entry) => entry.path === 'report-findings.csv')?.content);
    expect(reportFindingsCsv).toContain('Stored credential exposure');
    expect(reportFindingsCsv).toContain('businessImpact');
    expect(reportFindingsCsv).toContain('Remove the stored credentials');
    expect(reportFindingsCsv).toContain('missingReportFields');
    expect(String(bundle.find((entry) => entry.path === 'trace.md')?.content)).toContain('discovery');
    expect(performanceBundleSource.getRunBundleEntries).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-2' }),
      expect.objectContaining({ runId: 'run-2' }),
    );
    expect(complianceBundleSource.getRunBundleEntries).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-2' }),
      ['session-1'],
      expect.arrayContaining([
        expect.objectContaining({ path: 'closeout/session-1/report.md' }),
      ]),
      expect.objectContaining({ runId: 'run-2' }),
    );
  });

  it.each([
    { workflowDiscipline: 'pentest' as const, includesCompliance: false },
    { workflowDiscipline: 'code_review' as const, includesCompliance: false },
    { workflowDiscipline: 'compliance' as const, includesCompliance: true },
  ])(
    'builds a focused $workflowDiscipline review bundle from workflow and agent evidence',
    async ({ workflowDiscipline, includesCompliance }) => {
      await fs.mkdir(path.join(traceRoot, 'session-1', 'artifacts'), { recursive: true });
      await fs.writeFile(path.join(traceRoot, 'session-1', 'trace.ndjson'), '{"event":"session.init"}\n');
      await fs.writeFile(path.join(traceRoot, 'session-1', 'trace.md'), '# Session\n');
      await fs.writeFile(path.join(traceRoot, 'session-1', 'artifacts', 'proof.json'), '{"ok":true}\n');

      const events = [
        event({
          id: 'init-1',
          sessionId: 'session-1',
          event: 'session.init',
          ts: '2026-05-05T10:00:00.000Z',
          agentRole: 'planner',
          payload: { agentType: 'planner' },
        }),
        event({
          id: 'finding-1',
          sessionId: 'session-1',
          event: 'finding',
          ts: '2026-05-05T10:01:00.000Z',
          agentRole: 'worker',
          payload: {
            agentType: 'executor',
            workerType: 'validation_worker',
            summary: 'Proof found',
          },
          links: { evidence: 'artifacts/proof.json' },
        }),
      ];
      const complianceBundleSource = {
        getRunBundleEntries: vi.fn().mockResolvedValue([
          { path: 'compliance/control-checks.json', content: '{"checks":[]}' },
        ]),
      };
      const service = new RunTraceService({
        timelineService: { getAllEvents: vi.fn().mockResolvedValue(events) },
        reportFindingsSource: {
          listReportFindings: vi.fn().mockResolvedValue([]),
        },
        closeoutArtifactSource: {
          listCloseoutArtifacts: vi.fn().mockResolvedValue([
            { path: 'closeout/session-1/summary.md', content: '# Summary\n' },
            { path: 'closeout/session-1/report.md', content: '# Report\n' },
            {
              path: 'closeout/session-1/.artifacts/report/compliance-context.json',
              content: '{"controls":[]}',
            },
          ]),
        },
        performanceBundleSource: {
          getRunBundleEntries: vi.fn().mockResolvedValue([
            { path: 'performance/run-performance.json', content: '{"status":"complete"}' },
            { path: 'performance/run-performance.md', content: '# Performance\n' },
            { path: 'performance/sessions/session-1.json', content: '{"sessionId":"session-1"}' },
          ]),
        },
        complianceBundleSource,
        traceRoot,
      });

      const bundle = await service.getBundleEntries({
        id: `run-${workflowDiscipline}`,
        sessionId: 'session-1',
        status: 'completed',
        workflowDiscipline,
      }, { mode: 'review' });
      const paths = bundle.map((entry) => entry.path);

      expect(paths).toEqual(expect.arrayContaining([
        'review/README.md',
        'review/index.json',
        'review/summary.json',
        'trace.ndjson',
        'trace-findings.csv',
        'report-findings.csv',
        'run-phase-replans.json',
        'performance/run-performance.json',
        'closeout/session-1/summary.md',
        'closeout/session-1/report.md',
        'artifacts/session-1/artifacts/proof.json',
      ]));
      for (const omittedPath of [
        'run_summary.json',
        'run_summary.md',
        'trace.md',
        'sessions/session-1/trace.ndjson',
        'sessions/session-1/trace.md',
        'performance/run-performance.md',
        'performance/sessions/session-1.json',
      ]) {
        expect(paths).not.toContain(omittedPath);
      }

      const reviewIndex = JSON.parse(String(
        bundle.find((entry) => entry.path === 'review/index.json')?.content,
      ));
      expect(reviewIndex).toMatchObject({
        bundleMode: 'review',
        workflowDiscipline,
        selectionBasis: {
          workflowDiscipline,
          agentRoles: ['planner', 'worker'],
          agentTypes: ['planner', 'executor'],
          workerTypes: ['validation_worker'],
        },
        fullForensicBundleAvailable: true,
      });
      expect(reviewIndex.supportingFiles).toContain('trace.ndjson');

      if (includesCompliance) {
        expect(paths).toContain('compliance/control-checks.json');
        expect(paths).toContain('closeout/session-1/.artifacts/report/compliance-context.json');
        expect(complianceBundleSource.getRunBundleEntries).toHaveBeenCalledOnce();
      } else {
        expect(paths.some((entryPath) => entryPath.startsWith('compliance/'))).toBe(false);
        expect(paths).not.toContain('closeout/session-1/.artifacts/report/compliance-context.json');
        expect(complianceBundleSource.getRunBundleEntries).not.toHaveBeenCalled();
      }
    },
  );

  it('falls back to the forensic bundle when a legacy run has no trusted workflow discipline', async () => {
    const complianceBundleSource = {
      getRunBundleEntries: vi.fn().mockResolvedValue([
        { path: 'compliance/control-checks.json', content: '{"checks":[]}' },
      ]),
    };
    const service = new RunTraceService({
      timelineService: { getAllEvents: vi.fn().mockResolvedValue([]) },
      complianceBundleSource,
      traceRoot,
    });

    const bundle = await service.getBundleEntries({
      id: 'legacy-run',
      sessionId: 'session-1',
    }, { mode: 'review' });
    const paths = bundle.map((entry) => entry.path);

    expect(paths).toContain('run_summary.json');
    expect(paths).toContain('trace.md');
    expect(paths).toContain('compliance/control-checks.json');
    expect(paths).not.toContain('review/index.json');
  });

  it('falls back to DB tool and run events when canonical trace files are empty', async () => {
    const service = new RunTraceService({
      timelineService: { getAllEvents: vi.fn().mockResolvedValue([]) },
      dbFallbackSource: {
        listToolExecutionRecords: vi.fn().mockResolvedValue([
          {
            id: 'tool-row-1',
            sessionId: 'executor-session',
            turnId: 'turn-3',
            toolCallId: 'call-1',
            toolName: 'submit_phase_handoff',
            args: { status: 'completed' },
            result: { success: true },
            status: 'completed',
            startedAt: '2026-05-05T10:00:00.000Z',
            completedAt: '2026-05-05T10:00:01.000Z',
            durationMs: 1000,
            error: null,
          },
        ]),
        listRunEvents: vi.fn().mockResolvedValue([
          {
            id: 'run-event-1',
            runId: 'run-db-fallback',
            type: 'completed',
            note: null,
            createdAt: '2026-05-05T10:00:02.000Z',
          },
        ]),
        listRunPhaseReplans: vi.fn().mockResolvedValue([
          {
            id: 'replan-1',
            runId: 'run-db-fallback',
            phaseId: 'phase-1',
            status: 'open',
            requestedPhaseStatus: 'completed',
            handoffRef: '.artifacts/phase-handoffs/phase-1.json',
            reason: 'Discovery changed the remaining validation plan.',
            dispatchAttempts: 1,
            lastDispatchAt: '2026-05-05T10:00:03.000Z',
            lastDispatchError: null,
            requestedAt: '2026-05-05T10:00:02.500Z',
            appliedAt: null,
            closedAt: null,
            createdAt: '2026-05-05T10:00:02.500Z',
            updatedAt: '2026-05-05T10:00:03.000Z',
          },
        ]),
      },
      phaseSource: {
        listByRunId: vi.fn().mockResolvedValue([
          {
            id: 'phase-1',
            phaseKey: 'reporting',
            ordinal: 1,
            sessionId: 'executor-session',
          },
        ]),
      },
      traceRoot,
    });

    const trace = await service.getTraceForRun({
      id: 'run-db-fallback',
      sessionId: 'executor-session',
      executorSessionId: 'executor-session',
    });

    expect(trace.stats.events).toBe(2);
    expect(trace.stats.toolCalls).toBe(1);
    expect(trace.events.map((entry) => entry.id)).toEqual([
      'db-tool:tool-row-1',
      'db-run-event:run-event-1',
    ]);
    expect(trace.events[0]).toEqual(expect.objectContaining({
      event: 'tool.finish',
      phaseId: 'phase-1',
      payload: expect.objectContaining({
        source: 'db.tool_execution_records',
        fallback: true,
        toolName: 'submit_phase_handoff',
      }),
    }));

    const bundle = await service.getBundleEntries({
      id: 'run-db-fallback',
      sessionId: 'executor-session',
      executorSessionId: 'executor-session',
    });
    expect(String(bundle.find((entry) => entry.path === 'trace.ndjson')?.content)).toContain('db.tool_execution_records');
    expect(String(bundle.find((entry) => entry.path === 'sessions/executor-session/trace.ndjson')?.content)).toContain(
      'db.tool_execution_records',
    );
    expect(String(bundle.find((entry) => entry.path === 'run-phase-replans.json')?.content)).toContain(
      'Discovery changed the remaining validation plan',
    );
  });
});
