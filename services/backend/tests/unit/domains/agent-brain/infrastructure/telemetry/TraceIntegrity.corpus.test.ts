import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import { buildToolTracePairingExpectations } from '@/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';

/**
 * E6 corpus regression gate.
 *
 * The 3.1 production run that motivated E6 projected 312 tool starts against only 297
 * inline finishes. The 15 "missing" finishes were never missing: `redactPayload` had
 * replaced every oversized payload with `{ artifact, truncated }`, discarding the
 * correlation key along with the detail. A reader that paired on payload contents
 * therefore invented 15 orphans.
 *
 * This corpus reproduces that exact shape — 312 calls, 297 inline finishes, 15 spilled —
 * and proves that identity-based pairing over the reserved envelope header reaches
 * 312/312/0 without hydrating a single artifact. The negative control pairs the way the
 * pre-E6 reader did and must still observe 297.
 */
const TOTAL_TOOL_CALLS = 312;
const INLINE_FINISHES = 297;
const SPILLED_FINISHES = TOTAL_TOOL_CALLS - INLINE_FINISHES;

const seed = { workspace: '/tmp/ws', tools: ['neutral_marker'], model: 'corpus-fixture' };

type TraceRecord = {
  event?: unknown;
  toolCallId?: unknown;
  artifactRef?: unknown;
  payload?: { toolCallId?: unknown } | unknown;
};

describe('E6 trace pairing corpus', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-corpus-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const writeCorpus = async (): Promise<TraceRecord[]> => {
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 512,
      compressOverBytes: 1_000_000,
    });
    await recorder.init('corpus-session', seed);

    for (let index = 0; index < TOTAL_TOOL_CALLS; index += 1) {
      const toolCallId = `corpus-call-${index}`;
      const spills = index >= INLINE_FINISHES;
      const start = await recorder.write('corpus-session', index + 1, {
        event: 'tool.start',
        payload: { requestId: `corpus-request-${index}`, toolCallId, name: 'neutral_marker', status: 'started' },
      });
      expect(start.accepted).toBe(true);
      const finish = await recorder.write('corpus-session', index + 1, {
        event: 'tool.finish',
        payload: {
          requestId: `corpus-request-${index}`,
          toolCallId,
          name: 'neutral_marker',
          status: 'completed',
          outcome: 'success',
          // Only the tail exceeds the inline limit, so the corpus mixes both shapes.
          detail: spills ? 'x'.repeat(4_096) : 'ok',
        },
      });
      expect(finish.accepted).toBe(true);
    }
    await recorder.close('corpus-session', { terminal: 'session.done', status: 'completed' });

    return fs.readFileSync(path.join(rootDir, 'corpus-session', 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TraceRecord);
  };

  it('re-pairs 312 starts with 312 finishes and zero unmatched without hydrating artifacts', async () => {
    const records = await writeCorpus();

    const starts = records.filter((record) => record.event === 'tool.start');
    const finishes = records.filter((record) => record.event === 'tool.finish');
    expect(starts).toHaveLength(TOTAL_TOOL_CALLS);
    expect(finishes).toHaveLength(TOTAL_TOOL_CALLS);

    // The corpus must actually exercise offload, or it proves nothing about spill.
    const offloaded = finishes.filter((record) => typeof record.artifactRef === 'string');
    expect(offloaded).toHaveLength(SPILLED_FINISHES);

    const expectations = buildToolTracePairingExpectations(
      records.map((record) => ({
        event: String(record.event ?? ''),
        toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
      })),
    );

    expect(expectations).toHaveLength(TOTAL_TOOL_CALLS);
    expect(expectations.filter((expectation) => !expectation.present || expectation.valid === false)).toHaveLength(0);
  });

  it('negative control: pairing on payload contents reproduces the original 297 finishes', async () => {
    const records = await writeCorpus();

    // Exactly what the pre-E6 reader did: read the correlation key out of the payload,
    // which spill replaces with `{ artifact, truncated }`.
    const legacyExpectations = buildToolTracePairingExpectations(
      records.map((record) => {
        const payload = record.payload as { toolCallId?: unknown } | undefined;
        return {
          event: String(record.event ?? ''),
          toolCallId: typeof payload?.toolCallId === 'string' ? payload.toolCallId : undefined,
        };
      }),
    );

    const legacyFinishes = legacyExpectations.filter((expectation) => expectation.present).length;
    expect(legacyFinishes).toBe(INLINE_FINISHES);
    expect(legacyExpectations.filter((expectation) => !expectation.present)).toHaveLength(SPILLED_FINISHES);
  });
});
