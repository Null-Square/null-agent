/**
 * Tool truth — the Layer 1 defects production run r1 exposed.
 *
 * An agent reasons from what tools tell it. Four defects made tools lie, and none of them was
 * visible to any component test because each component was internally correct:
 *
 * - **D1** `http_payload` and a direct shell curl returned materially different content for
 *   the same URL, and nothing recorded enough about either exchange to explain it.
 * - **D2** every HTTP response of 400 or worse was recorded as a tool failure, which made 46
 *   of r1's 63 recorded failures ordinary security evidence.
 * - **D3** `max_body_bytes` bounded `body_preview` and nothing else, so a large body reached
 *   the conversation in full before being truncated.
 * - **D4** the shell network guard read `Windows NT 10.0` inside a User-Agent as the private
 *   network `10.0.0.0/8` and rejected an ordinary enumeration command.
 *
 * Each leg drives the shipping implementation, not a copy of its rule, and each carries a
 * negative control so a passing assertion cannot be an absence of evidence.
 */

import { z } from 'zod';

import { executeHttpRequest } from '../../../../src/domains/agent-brain/adapters/tools/runtime/httpRequestExecutor';
import { ActionSummaryEmitter } from '../../../../src/domains/agent-brain/infrastructure/telemetry/ActionSummaryEmitter';
import { computeRunTraceStats } from '../../../../src/domains/security-ops/runs/RunTraceService';
import { findCloudBlockedNetworkTargetsInCommand } from '../../../../src/domains/security-ops/scopes/networkTargetPolicy';
import type { ToolContext } from '../../../../src/domains/agent-brain/application/tools';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const TOOL_TRUTH_SCENARIO_ID = 'harness-tool-truth-execution-observation-and-route';

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
  authoritativeSource = 'shipping tool implementations driven directly',
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

// ---------------------------------------------------------------------------
// Leg A — the shell network guard (D4)
// ---------------------------------------------------------------------------

/** The exact command shape r1 rejected, plus the forms a guard must never confuse with a host. */
const NON_TARGET_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['user_agent', 'curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" https://app.example.com'],
  ['version_string', 'echo grafana version 10.0 detected'],
  ['flag_value', 'curl --max-time 10.0 https://app.example.com'],
  ['archive_name', 'tar -xzf build-2.0.tar.gz'],
  ['quoted_payload', `curl -d '{"client":"agent","v":"10.0"}' https://app.example.com`],
  ['decimal_in_prose', 'echo processed 2130706433 bytes'],
];

/** Destinations the guard must keep blocking, so a pass is never an absence of enforcement. */
const REAL_TARGET_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['private_url', 'curl http://10.0.0.1/admin'],
  ['cloud_metadata', 'curl http://169.254.169.254/latest/meta-data/'],
  ['loopback_shorthand', 'nc 127.1 8080'],
  ['hex_loopback', 'curl 0x7f000001'],
  ['private_cidr', 'nmap -sV 192.168.0.0/16'],
  ['loopback_in_quoted_callback', `curl -d '{"cb":"http://127.0.0.1/x"}' https://app.example.com`],
];

export type NetworkGuardEvidence = {
  falsePositives: string[];
  missedTargets: string[];
  nonTargetCommandsChecked: number;
  realTargetCommandsChecked: number;
};

const measureNetworkGuard = (): NetworkGuardEvidence => {
  const falsePositives: string[] = [];
  const missedTargets: string[] = [];

  for (const [name, command] of NON_TARGET_COMMANDS) {
    if (findCloudBlockedNetworkTargetsInCommand(command).length > 0) {
      falsePositives.push(name);
    }
  }
  for (const [name, command] of REAL_TARGET_COMMANDS) {
    if (findCloudBlockedNetworkTargetsInCommand(command).length === 0) {
      missedTargets.push(name);
    }
  }

  return {
    falsePositives,
    missedTargets,
    nonTargetCommandsChecked: NON_TARGET_COMMANDS.length,
    realTargetCommandsChecked: REAL_TARGET_COMMANDS.length,
  };
};

// ---------------------------------------------------------------------------
// Leg B — execution against observation (D2), and the counters that read them (D21)
// ---------------------------------------------------------------------------

/** The exact status distribution behind r1's 63 failure-classed actions. */
const R1_STATUS_DISTRIBUTION: ReadonlyArray<readonly [number, number]> = [
  [404, 26], [401, 12], [400, 3], [500, 3], [502, 2],
];

export type OutcomeAxisEvidence = {
  probesClassified: number;
  probesCalledExecutionFailures: number;
  observationsSeen: string[];
  runSummaryFailures: number;
  runSummaryDiscoveries: number;
  transportFailuresStillCounted: number;
};

const summarizeHttp = (statusCode: number) => ActionSummaryEmitter.summarize({
  toolName: 'http_payload',
  toolCallId: `probe-${statusCode}`,
  args: {},
  result: {
    ok: false,
    data: { method: 'GET', url: 'https://api.example.com/probe', status_code: statusCode },
  } as never,
  durationMs: 8,
}).summary;

const measureOutcomeAxes = (): OutcomeAxisEvidence => {
  const summaries = R1_STATUS_DISTRIBUTION.flatMap(([statusCode, count]) =>
    Array.from({ length: count }, () => summarizeHttp(statusCode)));

  const transportFailure = ActionSummaryEmitter.summarize({
    toolName: 'http_payload',
    toolCallId: 'probe-dead',
    args: {},
    result: { ok: false, message: 'Connection refused', data: { method: 'GET', url: 'https://dead.example.com/' } } as never,
    durationMs: 3,
  }).summary;

  // Feed the same shapes through the counter an operator actually reads.
  const at = (index: number): string => new Date(1_700_000_000_000 + index * 1_000).toISOString();
  const events = [
    ...summaries.map((summary, index) => ({
      event: 'action.summary',
      severity: 'info',
      payload: { ...summary },
      ts: at(index),
      sessionId: 'session-1',
    })),
    {
      event: 'action.summary',
      severity: 'info',
      payload: { ...transportFailure },
      ts: at(summaries.length),
      sessionId: 'session-1',
    },
    {
      event: 'tool.finish',
      severity: 'info',
      payload: { toolName: 'report_finding', progressKind: 'canonical', success: true },
      ts: at(summaries.length + 1),
      sessionId: 'session-1',
    },
    {
      event: 'tool.finish',
      severity: 'info',
      payload: { toolName: 'report_asset', progressKind: 'canonical', success: true },
      ts: at(summaries.length + 2),
      sessionId: 'session-1',
    },
  ];
  const stats = computeRunTraceStats(events as never, 1);

  return {
    probesClassified: summaries.length,
    probesCalledExecutionFailures: summaries.filter((s) => s.execution !== 'succeeded').length,
    observationsSeen: [...new Set(summaries.map((s) => s.observation))].sort(),
    runSummaryFailures: stats.failures,
    runSummaryDiscoveries: stats.discoveries,
    transportFailuresStillCounted: transportFailure.execution === 'transport_failed' ? 1 : 0,
  };
};

// ---------------------------------------------------------------------------
// Leg C — the HTTP executor's stream budget and route record (D3, D1)
// ---------------------------------------------------------------------------

const SENTINEL_PLACEHOLDER = '<<<CURL_WRITES_ITS_ROUTE_RECORD_HERE>>>';

/**
 * The separator carries a per-invocation nonce so a response body cannot forge the route
 * record. A fixture cannot know it in advance, so it reads it back out of the command the
 * executor built — which is what curl itself does with `-w`.
 */
const readRouteSentinel = (cmd: string): string => {
  const match = /__NS_ROUTE_PROVENANCE__[0-9a-f]{32}:/.exec(cmd);
  return match ? `\n${match[0]}` : '\n__NS_ROUTE_PROVENANCE__';
};

const curlOutput = (body: string, route: Record<string, string>): string => {
  const record = JSON.stringify({
    remote_ip: '203.0.113.10',
    remote_port: '443',
    final_url: 'https://app.example.com/main.js',
    redirect_count: '0',
    redirect_url: '',
    http_version: '2',
    scheme: 'https',
    ssl_verify_result: '0',
    ...route,
  });
  return `HTTP/2 200\r\ncontent-type: application/javascript\r\n\r\n${body}${SENTINEL_PLACEHOLDER}${record}`;
};

type ExchangeProbe = {
  streamedBytes: number;
  provenanceBytes: number;
  previewBytes: number;
  bodySize: number;
  route: Record<string, unknown>;
  streamCarriedTheRouteRecord: boolean;
};

const runExchange = async (input: {
  body: string;
  maxBodyBytes: number;
  route?: Record<string, string>;
}): Promise<ExchangeProbe> => {
  const stdout = curlOutput(input.body, input.route ?? {});
  let streamedBytes = 0;
  let provenanceBytes = 0;
  let streamCarriedTheRouteRecord = false;

  const ctx = {
    sessionId: 'session-1',
    workspaceDir: '',
    sandbox: {
      exec: async (execInput: { cmd?: string; onStdout?: (chunk: string) => void }) => {
        const resolved = stdout
          .split(SENTINEL_PLACEHOLDER)
          .join(readRouteSentinel(execInput.cmd ?? ''));
        for (let offset = 0; offset < resolved.length; offset += 65_536) {
          execInput.onStdout?.(resolved.slice(offset, offset + 65_536));
        }
        return {
          stdout: resolved,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          artifacts: [],
        };
      },
    },
    sessionStore: { get: () => ({ id: 'session-1', turn: 1, flags: {} }) },
    streamBroker: {
      emit: (_sessionId: string, event: { data?: { chunk?: string } }) => {
        const chunk = event.data?.chunk;
        if (typeof chunk !== 'string') return;
        streamedBytes += Buffer.byteLength(chunk, 'utf8');
        if (chunk.includes('__NS_ROUTE_PROVENANCE__')) streamCarriedTheRouteRecord = true;
      },
    },
    trace: undefined,
    approvals: { require: async () => undefined },
    guards: { pathGuard: { ensureInsideWorkspace: () => undefined }, cmdGuard: { validate: () => undefined } },
    policies: { requireApproval: false, maxStdoutBytes: 65_536, timeoutMs: 30_000 },
    flags: {},
    planRuntime: {
      appendProvenanceSnippet: (_sessionId: string, chunk: string) => {
        provenanceBytes += Buffer.byteLength(chunk, 'utf8');
      },
    },
    abortSignal: new AbortController().signal,
    config: { trace: { stdoutChunkSize: 65_536 } },
  } as unknown as ToolContext;

  const result = await executeHttpRequest(
    { url: 'https://app.example.com/main.js', method: 'GET', max_body_bytes: input.maxBodyBytes } as never,
    ctx,
    { toolName: 'http_payload' } as never,
  );
  const data = (result as { data: Record<string, unknown> }).data;

  return {
    streamedBytes,
    provenanceBytes,
    previewBytes: Buffer.byteLength(String(data.body_preview ?? ''), 'utf8'),
    bodySize: Number(data.body_size ?? 0),
    route: (data.route_provenance ?? {}) as Record<string, unknown>,
    streamCarriedTheRouteRecord,
  };
};

export type ExchangeEvidence = {
  largeBody: {
    bodySize: number;
    maxBodyBytes: number;
    previewBytes: number;
    streamedBytes: number;
    provenanceBytes: number;
    streamedShareOfBody: number;
  };
  smallBody: { streamedBytes: number; bodySize: number };
  disagreement: {
    firstResolvedIp: unknown;
    secondResolvedIp: unknown;
    firstFinalUrl: unknown;
    secondFinalUrl: unknown;
    distinguishable: boolean;
  };
  routeRecordLeakedIntoStream: boolean;
};

const measureExchanges = async (): Promise<ExchangeEvidence> => {
  const maxBodyBytes = 2_048;
  const large = await runExchange({ body: 'x'.repeat(500_000), maxBodyBytes });
  const small = await runExchange({ body: 'console.log(1)', maxBodyBytes });

  // The r1 shape: the same URL answered by two different network paths, both HTTP 200.
  const viaCdn = await runExchange({
    body: 'export const app = 1;',
    maxBodyBytes,
    route: { remote_ip: '198.51.100.7' },
  });
  const viaBucket = await runExchange({
    body: '<ListBucketResult><Name>staging-builds</Name></ListBucketResult>',
    maxBodyBytes,
    route: { remote_ip: '203.0.113.99', final_url: 'https://s3.example.com/staging-builds' },
  });

  return {
    largeBody: {
      bodySize: large.bodySize,
      maxBodyBytes,
      previewBytes: large.previewBytes,
      streamedBytes: large.streamedBytes,
      provenanceBytes: large.provenanceBytes,
      streamedShareOfBody: Number((large.streamedBytes / Math.max(1, large.bodySize)).toFixed(4)),
    },
    smallBody: { streamedBytes: small.streamedBytes, bodySize: small.bodySize },
    disagreement: {
      firstResolvedIp: viaCdn.route.resolved_ip,
      secondResolvedIp: viaBucket.route.resolved_ip,
      firstFinalUrl: viaCdn.route.final_url,
      secondFinalUrl: viaBucket.route.final_url,
      distinguishable: viaCdn.route.resolved_ip !== viaBucket.route.resolved_ip
        && viaCdn.route.final_url !== viaBucket.route.final_url,
    },
    routeRecordLeakedIntoStream: large.streamCarriedTheRouteRecord
      || small.streamCarriedTheRouteRecord,
  };
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const toolTruthEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-assembled-evidence/v1'),
  scenario: z.literal(TOOL_TRUTH_SCENARIO_ID),
  networkGuard: z.object({
    falsePositives: z.array(z.string()),
    missedTargets: z.array(z.string()),
    nonTargetCommandsChecked: z.number(),
    realTargetCommandsChecked: z.number(),
  }),
  outcomeAxes: z.object({
    probesClassified: z.number(),
    probesCalledExecutionFailures: z.number(),
    observationsSeen: z.array(z.string()),
    runSummaryFailures: z.number(),
    runSummaryDiscoveries: z.number(),
    transportFailuresStillCounted: z.number(),
  }),
  exchanges: z.object({
    largeBody: z.object({
      bodySize: z.number(),
      maxBodyBytes: z.number(),
      previewBytes: z.number(),
      streamedBytes: z.number(),
      provenanceBytes: z.number(),
      streamedShareOfBody: z.number(),
    }),
    smallBody: z.object({ streamedBytes: z.number(), bodySize: z.number() }),
    disagreement: z.object({
      firstResolvedIp: z.unknown(),
      secondResolvedIp: z.unknown(),
      firstFinalUrl: z.unknown(),
      secondFinalUrl: z.unknown(),
      distinguishable: z.boolean(),
    }),
    routeRecordLeakedIntoStream: z.boolean(),
  }),
  assertions: z.array(z.object({
    id: z.string(),
    passed: z.boolean(),
    expected: z.unknown(),
    actual: z.unknown(),
    authoritativeSource: z.string(),
    detail: z.string(),
  })),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string()),
  }),
});

export type ToolTruthEvidence = z.infer<typeof toolTruthEvidenceSchema>;

const run = async (): Promise<AssembledScenarioResult<ToolTruthEvidence>> => {
  const networkGuard = measureNetworkGuard();
  const outcomeAxes = measureOutcomeAxes();
  const exchanges = await measureExchanges();

  const assertions: VerificationAssertion[] = [
    assertion(
      'guard.does_not_read_prose_as_a_network_target',
      networkGuard.falsePositives.length === 0,
      { falsePositives: [] },
      { falsePositives: networkGuard.falsePositives, checked: networkGuard.nonTargetCommandsChecked },
      'Run r1 rejected an ordinary enumeration command because a User-Agent contained '
        + '"Windows NT 10.0", which the legacy inet_aton two-part form expands to 10.0.0.0.',
    ),
    assertion(
      'guard.negative_control_still_blocks_a_real_private_destination',
      networkGuard.missedTargets.length === 0,
      { missedTargets: [] },
      { missedTargets: networkGuard.missedTargets, checked: networkGuard.realTargetCommandsChecked },
      'Loosening the guard must not be measurable as an absence of enforcement.',
    ),
    assertion(
      'outcome.an_error_class_response_is_not_a_tool_failure',
      outcomeAxes.probesCalledExecutionFailures === 0,
      { executionFailures: 0, probes: outcomeAxes.probesClassified },
      {
        executionFailures: outcomeAxes.probesCalledExecutionFailures,
        probes: outcomeAxes.probesClassified,
      },
      'Replays the exact status distribution behind r1\'s 63 failure-classed actions: '
        + '26 x 404, 12 x 401, 3 x 400, 3 x 500, 2 x 502.',
    ),
    assertion(
      'outcome.observation_axis_distinguishes_what_the_target_said',
      outcomeAxes.observationsSeen.includes('401_auth_enforced')
        && outcomeAxes.observationsSeen.includes('404_absent')
        && outcomeAxes.observationsSeen.includes('5xx_server_error'),
      { includes: ['401_auth_enforced', '404_absent', '5xx_server_error'] },
      { observationsSeen: outcomeAxes.observationsSeen },
      'Collapsing the axes lost the distinction between enforced auth, an absent route and a '
        + 'server error. All three are evidence and none is a tool failure.',
    ),
    assertion(
      'outcome.negative_control_a_transport_failure_is_still_a_failure',
      outcomeAxes.transportFailuresStillCounted === 1 && outcomeAxes.runSummaryFailures === 1,
      { transportFailures: 1, runSummaryFailures: 1 },
      {
        transportFailures: outcomeAxes.transportFailuresStillCounted,
        runSummaryFailures: outcomeAxes.runSummaryFailures,
      },
      'A request that never reached the target is a real failure and must survive the split.',
    ),
    assertion(
      'summary.counts_a_canonical_write_as_a_discovery',
      outcomeAxes.runSummaryDiscoveries === 2,
      { discoveries: 2 },
      { discoveries: outcomeAxes.runSummaryDiscoveries },
      'r1 reported discoveries: 0 because the counter read event names nothing writes.',
    ),
    assertion(
      'stream.max_body_bytes_bounds_what_the_model_sees',
      exchanges.largeBody.streamedBytes
        <= exchanges.largeBody.maxBodyBytes + 8_192 + 512,
      { streamedAtMost: exchanges.largeBody.maxBodyBytes + 8_192 + 512 },
      {
        bodySize: exchanges.largeBody.bodySize,
        streamedBytes: exchanges.largeBody.streamedBytes,
        streamedShareOfBody: exchanges.largeBody.streamedShareOfBody,
      },
      'A 500 KB body used to reach the conversation in full and then show a 2 KB preview.',
    ),
    assertion(
      'stream.the_provenance_buffer_is_bounded_too',
      exchanges.largeBody.provenanceBytes
        <= exchanges.largeBody.maxBodyBytes + 8_192 + 512,
      { provenanceAtMost: exchanges.largeBody.maxBodyBytes + 8_192 + 512 },
      { provenanceBytes: exchanges.largeBody.provenanceBytes },
      'Provenance snippets are a second model-visible surface and leaked the same bytes.',
    ),
    assertion(
      'stream.negative_control_a_small_response_still_arrives_whole',
      exchanges.smallBody.streamedBytes > exchanges.smallBody.bodySize,
      'a small body is streamed in full',
      exchanges.smallBody,
      'A cap that silences small responses would be a worse defect than the one it replaced.',
    ),
    assertion(
      'route.a_same_url_disagreement_is_explainable',
      exchanges.disagreement.distinguishable,
      { distinguishable: true },
      exchanges.disagreement,
      'Two tools returned different content for one URL in r1 and nothing recorded which '
        + 'network path either took. Both answers were HTTP 200.',
    ),
    assertion(
      'route.the_record_never_enters_the_response_or_the_stream',
      exchanges.routeRecordLeakedIntoStream === false,
      { leaked: false },
      { leaked: exchanges.routeRecordLeakedIntoStream },
      'Diagnostic plumbing must not become response content the agent reasons about.',
    ),
  ];

  const namedMismatches = assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
  const negativeControlDetected = networkGuard.missedTargets.length === 0
    && outcomeAxes.transportFailuresStillCounted === 1
    && exchanges.smallBody.streamedBytes > exchanges.smallBody.bodySize;

  const evidence = {
    schema: 'behavior-lab-assembled-evidence/v1',
    scenario: TOOL_TRUTH_SCENARIO_ID,
    networkGuard,
    outcomeAxes,
    exchanges,
    assertions,
    verdict: {
      correctedFixturePassed: namedMismatches.length === 0,
      negativeControlDetected,
      namedMismatches,
    },
  } as const;

  const parsed = toolTruthEvidenceSchema.safeParse(evidence);
  const passed = namedMismatches.length === 0 && negativeControlDetected && parsed.success;

  return {
    id: TOOL_TRUTH_SCENARIO_ID,
    title: 'Tools report what they did and what the target said, as two separate facts',
    mode: 'assembled-runtime',
    passed,
    evidence: evidence as unknown as ToolTruthEvidence,
    ...(parsed.success ? {} : { error: parsed.error.message }),
  };
};

export const toolTruthScenario: AssembledBehaviorScenario<ToolTruthEvidence> = {
  id: TOOL_TRUTH_SCENARIO_ID,
  title: 'Tools report what they did and what the target said, as two separate facts',
  why:
    'Production run r1 recorded 46 successful security probes as tool failures, streamed '
    + 'hundreds of KB past a 2 KB cap, rejected a command because a User-Agent looked like a '
    + 'private address, and could not explain why two tools disagreed about one URL. Every '
    + 'component involved was internally correct, so only an assembled scenario catches it.',
  run,
};
