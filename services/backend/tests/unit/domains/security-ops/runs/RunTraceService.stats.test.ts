import { describe, expect, it } from 'vitest';
import {
  computeRunTraceStats,
  LEGACY_CANONICAL_DISCOVERY_TOOLS,
  WORKFLOW_CANONICAL_TOOLS,
} from '@/domains/security-ops/runs/RunTraceService';
import { tools as securityOpsTools } from '@/domains/agent-brain/adapters/tools/builtins/securityops';

/**
 * D21 — run r1's summary reported `discoveries: 0` and `failures: 86` for a run that mapped
 * hosts and services, wrote canonical inventory, identified technologies, generated
 * validation leads, filed two findings and falsified several hypotheses.
 *
 * Both counters were wrong for separate reasons. `discoveries` counted the event names
 * `discovery` and `finding`, which nothing in the codebase writes. `failures` counted the
 * single-axis outcome, which D2 set to `failure` for every HTTP response of 400 or worse.
 */
type Event = {
  event: string;
  severity: string;
  payload?: Record<string, unknown>;
  ts: string;
  sessionId: string;
};

const at = (index: number): string => new Date(1_700_000_000_000 + index * 1_000).toISOString();

const event = (index: number, event: string, payload: Record<string, unknown> = {}, severity = 'info'): Event => ({
  event,
  severity,
  payload,
  ts: at(index),
  sessionId: 'session-1',
});

const statsOf = (events: Event[]) => computeRunTraceStats(events as never, 1);

describe('run trace statistics', () => {
  it('does not count an error-class HTTP response as a failure', () => {
    const events = [
      event(0, 'action.summary', { execution: 'succeeded', observation: '401_auth_enforced', statusCode: 401 }),
      event(1, 'action.summary', { execution: 'succeeded', observation: '404_absent', statusCode: 404 }),
      event(2, 'action.summary', { execution: 'succeeded', observation: '5xx_server_error', statusCode: 500 }),
    ];

    expect(statsOf(events).failures).toBe(0);
  });

  it('counts a real execution failure', () => {
    const events = [
      event(0, 'action.summary', { execution: 'transport_failed', observation: 'no_response' }),
      event(1, 'action.summary', { execution: 'timeout', observation: 'no_response' }),
      event(2, 'action.summary', { execution: 'policy_blocked', observation: 'not_applicable' }),
      event(3, 'action.summary', { execution: 'skipped', observation: 'not_applicable' }),
    ];

    // Three genuine failures. A skipped tool is not one.
    expect(statsOf(events).failures).toBe(3);
  });

  it('reproduces the r1 status distribution and reports no failures for it', () => {
    const statuses = [
      ...Array.from({ length: 26 }, () => 404),
      ...Array.from({ length: 12 }, () => 401),
      ...Array.from({ length: 3 }, () => 400),
      ...Array.from({ length: 3 }, () => 500),
      ...Array.from({ length: 2 }, () => 502),
    ];
    const events = statuses.map((statusCode, index) =>
      event(index, 'action.summary', { execution: 'succeeded', statusCode }));

    expect(statsOf(events).failures).toBe(0);
    expect(statsOf(events).actions).toBe(46);
  });

  it('still reads the legacy single-axis fields on events written before the split', () => {
    const events = [
      event(0, 'tool.finish', { outcome: 'failure' }),
      event(1, 'tool.finish', { success: false }),
      event(2, 'shell_job.failed', {}, 'error'),
    ];

    expect(statsOf(events).failures).toBe(3);
  });

  it('counts a canonical record written by a tool as a discovery', () => {
    const events = [
      // Tools that exist. An earlier version of this test named three that did not, and
      // agreed with a counter that named the same three.
      event(0, 'tool.finish', { toolName: 'report_finding', success: true }),
      event(1, 'tool.finish', { toolName: 'report_asset', success: true }),
      event(2, 'tool.finish', { toolName: 'submit_validation_lead_outcome', success: true }),
      event(3, 'tool.finish', { toolName: 'query_notes', success: true }),
    ];

    // A read tool is not a discovery; the three writes are.
    expect(statsOf(events).discoveries).toBe(3);
  });

  it('does not count a canonical write that failed', () => {
    const events = [
      event(0, 'tool.finish', { toolName: 'report_finding', success: false }),
    ];

    expect(statsOf(events).discoveries).toBe(0);
  });

  it('still counts an emitted discovery event', () => {
    const events = [
      event(0, 'discovery', { category: 'endpoint', key: '/api/admin' }),
      event(1, 'finding.reported', { id: 'f-1' }),
    ];

    expect(statsOf(events).discoveries).toBe(2);
  });

  it('never counts one tool.finish as both a discovery and a second discovery event', () => {
    const events = [
      event(0, 'tool.finish', { toolName: 'report_finding', success: true }),
    ];

    expect(statsOf(events).discoveries).toBe(1);
    expect(statsOf(events).toolCalls).toBe(1);
  });

  /**
   * The count reads what the tool declared about itself. A list of tool names maintained in
   * the counter goes stale the moment a canonical tool is added or renamed, and the staleness
   * is invisible — the number simply reads low.
   */
  describe('what counts is what the tool declared', () => {
    it('counts a canonical write it has never heard of by name', () => {
      const events = [
        event(0, 'tool.finish', { toolName: 'a_tool_added_next_year', progressKind: 'canonical', success: true }),
      ];

      expect(statsOf(events).discoveries).toBe(1);
    });

    it('does not count a non-canonical tool even when its name looks like a write', () => {
      const events = [
        event(0, 'tool.finish', { toolName: 'report_finding', progressKind: 'ephemeral', success: true }),
        event(1, 'tool.finish', { toolName: 'query_findings', progressKind: 'ephemeral', success: true }),
      ];

      expect(statsOf(events).discoveries).toBe(0);
    });

    it('still reads a trace recorded before the declaration was on the event', () => {
      const events = [
        event(0, 'tool.finish', { toolName: 'report_asset', success: true }),
        event(1, 'tool.finish', { toolName: 'http_payload', success: true }),
      ];

      expect(statsOf(events).discoveries).toBe(1);
    });

    it('does not count a declared canonical call that failed', () => {
      const events = [
        event(0, 'tool.finish', { toolName: 'report_asset', progressKind: 'canonical', success: false }),
      ];

      expect(statsOf(events).discoveries).toBe(0);
    });

    it('does not count workflow bookkeeping as knowledge about the target', () => {
      // r1 handed off six times. Six handoffs are not six discoveries.
      const events = [
        event(0, 'tool.finish', { toolName: 'submit_phase_handoff', progressKind: 'canonical', success: true }),
        event(1, 'tool.finish', { toolName: 'submit_phase_checkpoint', progressKind: 'canonical', success: true }),
        event(2, 'tool.finish', { toolName: 'report_asset', progressKind: 'canonical', success: true }),
      ];

      expect(statsOf(events).discoveries).toBe(1);
    });
  });

  /**
   * Both name lists are read against tools that exist. The first version of this counter
   * held five tool names that were never real — `upsert_asset`, `record_endpoint` and
   * friends — so it would have kept reading low against a list nobody could see was wrong.
   */
  describe('the name lists name real tools', () => {
    const declaredCanonical = new Set(
      securityOpsTools
        .filter((tool) => tool.meta.progressKind === 'canonical')
        .map((tool) => tool.meta.name),
    );

    it('has at least one canonical tool to read', () => {
      expect(declaredCanonical.size).toBeGreaterThan(0);
    });

    it('lists only tools that exist and declare themselves canonical', () => {
      const unknown = [...LEGACY_CANONICAL_DISCOVERY_TOOLS].filter((name) => !declaredCanonical.has(name));

      expect(unknown).toEqual([]);
    });

    it('excludes only workflow tools that exist and declare themselves canonical', () => {
      // These live outside the securityops module, so they are checked by shape rather than
      // by membership: an excluded name that no longer exists is a silent over-count.
      expect([...WORKFLOW_CANONICAL_TOOLS].every((name) => name.startsWith('submit_phase_'))).toBe(true);
      expect(WORKFLOW_CANONICAL_TOOLS.size).toBeGreaterThan(0);
    });
  });
});
