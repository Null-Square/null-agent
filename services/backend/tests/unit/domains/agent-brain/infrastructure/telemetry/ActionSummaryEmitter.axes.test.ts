import { describe, expect, it } from 'vitest';
import { ActionSummaryEmitter } from '@/domains/agent-brain/infrastructure/telemetry/ActionSummaryEmitter';

/**
 * D2 — the emitter used to record any HTTP response of 400 or worse as a tool failure.
 * In production run r1 that made 46 of 63 recorded failures ordinary security evidence:
 * 26 x 404, 12 x 401, 3 x 400. Only 17 were genuine execution failures.
 *
 * A request that executes and receives an error-class response is a successful probe. The
 * two facts now live on two axes.
 */
const httpResult = (overrides: Record<string, unknown>) => ({
  ok: overrides.ok as boolean | undefined ?? true,
  data: {
    method: 'POST',
    url: 'https://api.example.com/api/auth/login',
    ...overrides,
  },
});

const summarize = (result: unknown) => ActionSummaryEmitter.summarize({
  toolName: 'http_payload',
  toolCallId: 'call-1',
  args: {},
  result: result as never,
  durationMs: 12,
}).summary;

describe('action summary execution and observation axes', () => {
  describe('an error-class response is evidence, not a tool failure', () => {
    const cases: Array<[number, string, string]> = [
      [401, '401_auth_enforced', 'auth enforcement confirmed'],
      [403, '403_forbidden', 'authorization enforced'],
      [404, '404_absent', 'exposure hypothesis falsified'],
      [429, '429_rate_limited', 'rate limiting confirmed'],
      [400, '4xx_client_error', 'the target rejected the input'],
    ];

    for (const [statusCode, observation, why] of cases) {
      it(`${statusCode} is a successful execution — ${why}`, () => {
        const summary = summarize(httpResult({ status_code: statusCode, ok: false }));

        expect(summary.execution).toBe('succeeded');
        expect(summary.observation).toBe(observation);
        expect(summary.outcome).not.toBe('failure');
        expect(summary.statusCode).toBe(statusCode);
      });
    }
  });

  it('records a 200 as a positive observation', () => {
    const summary = summarize(httpResult({ status_code: 200 }));

    expect(summary.execution).toBe('succeeded');
    expect(summary.observation).toBe('2xx_positive');
    expect(summary.outcome).toBe('success');
  });

  it('records a 500 as a server error the tool still successfully observed', () => {
    // The r1 CORS probe made the target return 500. That is a product defect worth seeing,
    // and it is still not a failure of the tool that found it.
    const summary = summarize(httpResult({ status_code: 500, ok: false }));

    expect(summary.execution).toBe('succeeded');
    expect(summary.observation).toBe('5xx_server_error');
  });

  it('records a transport failure with no status line as a real failure', () => {
    const summary = summarize({
      ok: false,
      message: 'Connection refused',
      data: { method: 'GET', url: 'https://api.example.com/' },
    });

    expect(summary.execution).toBe('transport_failed');
    expect(summary.observation).toBe('no_response');
    expect(summary.outcome).toBe('failure');
  });

  it('records a timeout on the execution axis', () => {
    const summary = summarize(httpResult({ status_code: undefined, ok: false, timedOut: true }));

    expect(summary.execution).toBe('timeout');
    expect(summary.observation).toBe('no_response');
    expect(summary.outcome).toBe('timeout');
  });

  it('records a policy block as blocked, not as a target response', () => {
    const summary = summarize({
      ok: false,
      message: 'Target is outside the policy allowlist',
      data: { method: 'GET', url: 'https://out-of-scope.example.com/', forbidden: true },
    });

    expect(summary.execution).toBe('policy_blocked');
    expect(summary.outcome).toBe('blocked');
  });

  it('gives a non-HTTP tool no target observation to misread', () => {
    const summary = ActionSummaryEmitter.summarize({
      toolName: 'shell_run',
      toolCallId: 'call-2',
      args: { command: 'nmap -sV example.com' },
      result: { ok: true, data: { command: 'nmap -sV example.com', code: 0 } } as never,
      durationMs: 40,
    }).summary;

    expect(summary.execution).toBe('succeeded');
    expect(summary.observation).toBe('not_applicable');
  });

  it('marks a skipped tool as skipped on both axes', () => {
    const summary = ActionSummaryEmitter.summarize({
      toolName: 'http_payload',
      toolCallId: 'call-3',
      args: {},
      result: { ok: true, data: {} } as never,
      durationMs: 0,
      skipped: true,
      skipReason: 'Blocked by guard',
    }).summary;

    expect(summary.execution).toBe('skipped');
    expect(summary.observation).toBe('not_applicable');
    expect(summary.outcome).toBe('skipped');
  });

  it('reproduces the production failure inflation and shows it is gone', () => {
    // The exact status distribution behind r1's 63 failure-classed actions.
    const observed = [
      ...Array.from({ length: 26 }, () => 404),
      ...Array.from({ length: 12 }, () => 401),
      ...Array.from({ length: 3 }, () => 400),
      ...Array.from({ length: 3 }, () => 500),
      ...Array.from({ length: 2 }, () => 502),
    ];

    const executionFailures = observed
      .map((statusCode) => summarize(httpResult({ status_code: statusCode, ok: false })))
      .filter((summary) => summary.execution !== 'succeeded');

    expect(executionFailures).toHaveLength(0);
  });
});
