import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  buildToolTracePairingExpectations,
  reconcileTraceIntegrity,
  SessionTraceRecorder,
  TimelineService,
  TraceArtifactIntegrityError,
  type TraceIntegrityResult,
  type TimelineEvent,
} from '../../../../src/domains/agent-brain/infrastructure/telemetry';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E6_ASSEMBLED_SCENARIO_ID =
  'harness-artifact-trace-survives-delayed-terminal-close';

type ObjectStore = Map<string, Buffer>;

export type TraceArtifactIntegrityEvidenceBundle = {
  schema: 'behavior-lab-trace-artifact-integrity-evidence/v1';
  scenarioId: typeof E6_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  corrected: {
    closeWaitedForFlush: boolean;
    acceptedOrdinals: number[];
    acceptedHighWater: number;
    persistedHighWater: number;
    inlineHeader: {
      requestId?: string;
      toolCallId?: string;
      name?: string;
      status?: string;
      outcome?: string;
      artifactRef?: string;
      artifactSha256?: string;
    };
    strictMarker: string | null;
    pairing: { starts: number; finishes: number; unmatched: number };
    integrity: TraceIntegrityResult;
  };
  negativeControls: {
    corruptArtifact: { strictFailed: boolean; errorCode?: string; integrity: TraceIntegrityResult };
    rejectedWrite: { reason?: string; integrity: TraceIntegrityResult };
    crashBeforeFlush: {
      acceptedHighWater: number;
      recoveredEvents: number;
      integrity: TraceIntegrityResult;
    };
  };
  assertions: VerificationAssertion[];
  verdict: {
    correctedFixturePassed: boolean;
    negativeControlDetected: boolean;
    namedMismatches: string[];
  };
};

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
): VerificationAssertion => ({
  id,
  passed,
  expected,
  actual,
  authoritativeSource: 'SessionTraceRecorder+TimelineService+trace-integrity/v1',
  detail,
});

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const traceClient = (store: ObjectStore, uploadBuffer: (key: string, content: Buffer) => Promise<void>) => ({
  ensureBucket: async () => undefined,
  uploadBuffer,
  getObjectBuffer: async (key: string): Promise<Buffer> => {
    const content = store.get(key);
    if (!content) throw new Error(`missing object ${key}`);
    return Buffer.from(content);
  },
});

const countPairs = (events: TimelineEvent[]): { starts: number; finishes: number; unmatched: number } => {
  const starts = events.filter((event) => event.event === 'tool.start').length;
  const finishes = events.filter((event) => event.event === 'tool.finish').length;
  const expectations = buildToolTracePairingExpectations(events);
  return {
    starts,
    finishes,
    unmatched: expectations.filter((expectation) => !expectation.present || expectation.valid === false).length,
  };
};

const runScenario = async (): Promise<AssembledScenarioResult<TraceArtifactIntegrityEvidenceBundle>> => {
  const store: ObjectStore = new Map();
  let releaseTrace!: () => void;
  const delayedTrace = new Promise<void>((resolve) => {
    releaseTrace = resolve;
  });
  let traceUploadStarted = false;
  const uploadBuffer = async (key: string, content: Buffer): Promise<void> => {
    if (key === 'e6-session/trace.ndjson') {
      traceUploadStarted = true;
      await delayedTrace;
    }
    store.set(key, Buffer.from(content));
  };
  const client = traceClient(store, uploadBuffer);
  const recorder = new SessionTraceRecorder(
    {
      rootDir: path.join(os.tmpdir(), 'null-ai-e6-assembled'),
      keepLocalCopy: false,
      inlineLimit: 320,
      compressOverBytes: 100_000,
      s3FlushIntervalMs: 60_000,
      s3FlushMaxEvents: 100,
    },
    { client: client as never, bucket: 'behavior-traces' },
  );
  await recorder.init('e6-session', { workspace: '/workspace', tools: ['neutral_marker'], model: 'behavior' });
  const startReceipt = await recorder.write('e6-session', 1, {
    event: 'tool.start',
    payload: {
      requestId: 'request-e6',
      toolCallId: 'tool-call-e6',
      name: 'neutral_marker',
      status: 'started',
    },
  });
  const finishReceipt = await recorder.write('e6-session', 1, {
    event: 'tool.finish',
    payload: {
      requestId: 'request-e6',
      toolCallId: 'tool-call-e6',
      name: 'neutral_marker',
      status: 'completed',
      outcome: 'success',
      marker: 'artifact-backed-terminal-marker',
      detail: 'proof:'.repeat(800),
    },
  });

  let closeResolved = false;
  const close = recorder.close('e6-session', {
    terminal: 'session.done',
    status: 'completed',
    turns: 1,
  }).then(() => {
    closeResolved = true;
  });
  while (!traceUploadStarted) await Promise.resolve();
  const closeWaitedForFlush = !closeResolved && !store.has('e6-session/index.json');
  releaseTrace();
  await close;

  const timeline = new TimelineService({ s3Client: client as never });
  const inlineEvents = await timeline.getAllEvents('e6-session', 'inline');
  const strictEvents = await timeline.getAllEvents('e6-session', 'strict');
  const inlineFinish = inlineEvents.find((event) => event.event === 'tool.finish');
  const strictFinish = strictEvents.find((event) => event.event === 'tool.finish');
  const index = JSON.parse(store.get('e6-session/index.json')!.toString('utf8')) as {
    acceptedHighWater: number;
    persistedHighWater: number;
  };
  const pairing = countPairs(strictEvents);
  const artifactRef = inlineFinish?.artifactRef ?? 'missing';
  const correctedIntegrity = reconcileTraceIntegrity({
    sessionId: 'e6-session',
    acceptedHighWater: index.acceptedHighWater,
    persistedHighWater: index.persistedHighWater,
    terminalReceipt: true,
    expectations: [
      { surface: 'model_requests', id: 'request-e6', present: true },
      { surface: 'tool_executions', id: 'tool-call-e6', present: true },
      { surface: 'messages', id: 'message-receipt-e6', present: true },
      { surface: 'artifacts', id: artifactRef, present: true, valid: true },
      ...buildToolTracePairingExpectations(strictEvents),
    ],
  });

  const originalArtifact = Buffer.from(store.get(`e6-session/${artifactRef}`)!);
  store.set(`e6-session/${artifactRef}`, Buffer.concat([originalArtifact, Buffer.from('corrupt')]));
  let strictFailed = false;
  let strictErrorCode: string | undefined;
  try {
    await timeline.getAllEvents('e6-session', 'strict');
  } catch (error) {
    strictFailed = error instanceof TraceArtifactIntegrityError;
    strictErrorCode = error instanceof TraceArtifactIntegrityError ? error.code : undefined;
  }
  const corruptIntegrity = reconcileTraceIntegrity({
    sessionId: 'e6-session',
    acceptedHighWater: index.acceptedHighWater,
    persistedHighWater: index.persistedHighWater,
    terminalReceipt: true,
    expectations: [{ surface: 'artifacts', id: artifactRef, present: true, valid: false }],
  });

  const rejected = await recorder.write('e6-session', 2, { event: 'tool.finish' });
  const rejectedIntegrity = reconcileTraceIntegrity({
    sessionId: 'e6-session',
    acceptedHighWater: index.acceptedHighWater,
    persistedHighWater: index.persistedHighWater,
    terminalReceipt: true,
    rejectedWrites: rejected.accepted ? [] : [{ reason: rejected.reason, event: 'tool.finish', required: true }],
  });

  const crashStore: ObjectStore = new Map();
  const crashClient = traceClient(crashStore, async (key, content) => {
    crashStore.set(key, Buffer.from(content));
  });
  const crashRecorder = new SessionTraceRecorder(
    {
      rootDir: path.join(os.tmpdir(), 'null-ai-e6-crash'),
      keepLocalCopy: false,
      s3FlushIntervalMs: 60_000,
      s3FlushMaxEvents: 100,
    },
    { client: crashClient as never, bucket: 'behavior-traces' },
  );
  await crashRecorder.init('e6-crash', { workspace: '/workspace', tools: [], model: 'behavior' });
  const crashWrite = await crashRecorder.write('e6-crash', 1, {
    event: 'tool.start',
    payload: { toolCallId: 'crash-call', name: 'neutral_marker' },
  });
  const coldTimeline = new TimelineService({
    traceRoot: path.join(os.tmpdir(), 'null-ai-e6-crash-cold'),
    s3Client: crashClient as never,
  });
  const recoveredEvents = await coldTimeline.getAllEvents('e6-crash', 'inline');
  const crashAcceptedHighWater = crashWrite.accepted ? crashWrite.acceptedOrdinal : 0;
  const crashIntegrity = reconcileTraceIntegrity({
    sessionId: 'e6-crash',
    acceptedHighWater: crashAcceptedHighWater,
    persistedHighWater: 0,
    terminalReceipt: false,
  });

  const marker = strictFinish?.payload && typeof strictFinish.payload === 'object'
    ? (strictFinish.payload as Record<string, unknown>).marker
    : undefined;
  const corrected = {
    closeWaitedForFlush,
    acceptedOrdinals: [startReceipt, finishReceipt]
      .filter((receipt) => receipt.accepted)
      .map((receipt) => receipt.accepted ? receipt.acceptedOrdinal : 0),
    acceptedHighWater: index.acceptedHighWater,
    persistedHighWater: index.persistedHighWater,
    inlineHeader: {
      requestId: inlineFinish?.requestId,
      toolCallId: inlineFinish?.toolCallId,
      name: inlineFinish?.name,
      status: inlineFinish?.status,
      outcome: inlineFinish?.outcome,
      artifactRef: inlineFinish?.artifactRef,
      artifactSha256: inlineFinish?.artifactSha256,
    },
    strictMarker: typeof marker === 'string' ? marker : null,
    pairing,
    integrity: correctedIntegrity,
  };
  const negativeControls = {
    corruptArtifact: { strictFailed, errorCode: strictErrorCode, integrity: corruptIntegrity },
    rejectedWrite: {
      reason: rejected.accepted ? undefined : rejected.reason,
      integrity: rejectedIntegrity,
    },
    crashBeforeFlush: {
      acceptedHighWater: crashAcceptedHighWater,
      recoveredEvents: recoveredEvents.length,
      integrity: crashIntegrity,
    },
  };
  const assertions = [
    assertion(
      'close.drains_accepted_trace_and_artifact_writes',
      closeWaitedForFlush && index.acceptedHighWater === index.persistedHighWater,
      { waited: true, highWaterMatched: true },
      { closeWaitedForFlush, ...index },
      'Terminal close must not publish its receipt before the accepted trace tail is durable.',
    ),
    assertion(
      'artifact.inline_header_and_strict_marker',
      inlineFinish?.requestId === 'request-e6'
        && inlineFinish.toolCallId === 'tool-call-e6'
        && inlineFinish.name === 'neutral_marker'
        && inlineFinish.status === 'completed'
        && inlineFinish.outcome === 'success'
        && Boolean(inlineFinish.artifactRef)
        && /^[a-f0-9]{64}$/u.test(inlineFinish.artifactSha256 ?? '')
        && marker === 'artifact-backed-terminal-marker',
      true,
      corrected.inlineHeader,
      'Identity and outcome remain inline while strict hydration proves artifact detail and digest.',
    ),
    assertion(
      'integrity.complete_and_tool_pairing_exact',
      correctedIntegrity.status === 'complete'
        && pairing.starts === 1
        && pairing.finishes === 1
        && pairing.unmatched === 0,
      { integrity: 'complete', starts: 1, finishes: 1, unmatched: 0 },
      { integrity: correctedIntegrity.status, ...pairing },
      'Generic reconciliation joins E4, E3, messages, traces, and artifacts without adjacency assumptions.',
    ),
    assertion(
      'negative.corrupt_artifact_fails_strict',
      strictFailed && corruptIntegrity.status === 'failed',
      { strictFailed: true, integrity: 'failed' },
      { strictFailed, integrity: corruptIntegrity.status },
      'A byte change must fail the stored artifact digest instead of yielding hydrated evidence.',
    ),
    assertion(
      'negative.rejected_write_is_degraded',
      !rejected.accepted
        && rejected.reason === 'closed'
        && rejectedIntegrity.status === 'degraded'
        && rejectedIntegrity.issues.some((issue) => issue.code === 'write_rejected_closed'),
      { reason: 'closed', integrity: 'degraded' },
      negativeControls.rejectedWrite,
      'A required rejected write is typed and names the degraded trace surface.',
    ),
    assertion(
      'negative.crash_before_flush_is_not_complete',
      crashAcceptedHighWater > 0
        && recoveredEvents.length === 0
        && crashIntegrity.status === 'degraded',
      { recoveredEvents: 0, integrity: 'degraded' },
      negativeControls.crashBeforeFlush,
      'A contiguous or empty recovered file cannot claim completeness without the accepted high-water receipt.',
    ),
  ];
  const negativeControlDetected = assertions.slice(3).every((entry) => entry.passed);
  const evidence: TraceArtifactIntegrityEvidenceBundle = {
    schema: 'behavior-lab-trace-artifact-integrity-evidence/v1',
    scenarioId: E6_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    corrected,
    negativeControls,
    assertions,
    verdict: {
      correctedFixturePassed: assertions.slice(0, 3).every((entry) => entry.passed),
      negativeControlDetected,
      namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
    },
  };
  const passed = assertions.every((entry) => entry.passed);
  return {
    id: E6_ASSEMBLED_SCENARIO_ID,
    title: 'Harness artifact trace survives delayed terminal close',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? { error: `failed=${evidence.verdict.namedMismatches.join(',')}` } : {}),
  };
};

export const traceArtifactIntegrityEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-trace-artifact-integrity-evidence/v1'),
  scenarioId: z.literal(E6_ASSEMBLED_SCENARIO_ID),
  corrected: z.object({
    closeWaitedForFlush: z.boolean(),
    acceptedHighWater: z.number().int().nonnegative(),
    persistedHighWater: z.number().int().nonnegative(),
    strictMarker: z.string().nullable(),
    pairing: z.object({ starts: z.number(), finishes: z.number(), unmatched: z.number() }),
    integrity: z.object({ status: z.enum(['complete', 'degraded', 'failed']) }).passthrough(),
  }).passthrough(),
  negativeControls: z.object({
    corruptArtifact: z.object({ strictFailed: z.boolean() }).passthrough(),
    rejectedWrite: z.object({ integrity: z.object({ status: z.literal('degraded') }).passthrough() }).passthrough(),
    crashBeforeFlush: z.object({ integrity: z.object({ status: z.literal('degraded') }).passthrough() }).passthrough(),
  }),
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()),
}).passthrough();

export const traceArtifactIntegrityScenario:
AssembledBehaviorScenario<TraceArtifactIntegrityEvidenceBundle> = {
  id: E6_ASSEMBLED_SCENARIO_ID,
  title: 'Harness artifact trace survives delayed terminal close',
  why: 'Delays the real trace flush after acceptance, verifies artifact-safe correlation and strict hydration, and rejects corruption, rejected writes, and crash-lost tails.',
  run: runScenario,
};
