import { describe, expect, it } from 'vitest';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';
import type { SessionState, StreamEvent } from '@/domains/agent-brain/domain/types';
import {
  buildToolTimelineReplaceKey,
  mapStreamEventToTimelineEntries,
} from '@/domains/agent-brain/application/orchestration/utils/timelineEntries';

const createSession = (overrides: Partial<SessionState> = {}): SessionState =>
  ({
    id: 'session-1',
    status: 'running',
    mode: 'interactive',
    turn: 0,
    history: [],
    plan: [],
    memory: createEmptyMemory(),
    checkpoints: [],
    artifacts: [],
    flags: {},
    toolPolicy: {},
    createdAt: Date.now(),
    lastActive: Date.now(),
    timeline: [],
    ...overrides,
  } as SessionState);

describe('timelineEntries', () => {
  it('maps tool lifecycle events with a shared replaceKey', () => {
    const toolStarted = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'tool_started',
        data: {
          name: 'shell',
          args: { command: 'npm test' },
          toolCallId: 'call-1',
        },
      } satisfies StreamEvent,
    });
    const toolResult = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'tool_result',
        data: {
          name: 'shell',
          result: { ok: true, message: 'done' },
          toolCallId: 'call-1',
        },
      } satisfies StreamEvent,
    });

    expect(toolStarted).toHaveLength(1);
    expect(toolStarted[0]).toMatchObject({
      kind: 'tool',
      status: 'running',
      title: 'Running shell',
      detail: 'npm test',
      replaceKey: 'tool:call-1',
    });

    expect(toolResult).toHaveLength(1);
    expect(toolResult[0]).toMatchObject({
      kind: 'tool',
      status: 'success',
      title: 'Completed shell',
      replaceKey: 'tool:call-1',
    });
  });

  it('suppresses duplicate plan-ready entries when the session already has one', () => {
    const entries = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      session: createSession({
        timeline: [
          {
            id: 'plan-ready-1',
            sessionId: 'session-1',
            ts: Date.now(),
            kind: 'plan_ready',
            status: 'success',
            title: 'Plan ready',
            source: 'system',
            importance: 'medium',
          },
        ],
      }),
      event: {
        type: 'plan_update',
        data: [{ id: 'step-1', title: 'Scan', status: 'pending' }],
      } satisfies StreamEvent,
    });

    expect(entries).toEqual([]);
  });

  it('maps manual pause status transitions into timeline cards', () => {
    const entries = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'session.status',
        data: {
          id: 'session-1',
          status: 'paused',
          previousStatus: 'running',
          version: 2,
          updatedAt: Date.now(),
          pause_reason: 'manual',
          interaction_type: 'none',
          blocked_reason: 'user_paused',
          reason: 'Operator paused the session',
        },
      } satisfies StreamEvent,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'session_status',
      status: 'pending',
      title: 'Session paused',
      detail: 'Operator paused the session',
    });
  });

  it('keeps gate request and resolution as separate timeline entries while deduping each phase', () => {
    const approvalRequested = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'approval_needed',
        data: { actionId: 'approval-1', tool: 'browser_action' },
      } satisfies StreamEvent,
    });
    const approvalResolved = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'approval_granted',
        data: { actionId: 'approval-1' },
      } satisfies StreamEvent,
    });

    expect(approvalRequested[0]?.replaceKey).toBe('approval:approval-1:requested');
    expect(approvalResolved[0]?.replaceKey).toBe('approval:approval-1:resolved');
  });

  it('dedupes repeated warnings by warning code', () => {
    const entries = mapStreamEventToTimelineEntries({
      sessionId: 'session-1',
      event: {
        type: 'warning',
        data: {
          code: 'summary_missing',
          message: 'summary.md is required. Create or update it now.',
        },
      } satisfies StreamEvent,
    });

    expect(entries[0]).toMatchObject({
      kind: 'warning',
      replaceKey: 'warning:summary_missing',
    });
  });

  it('builds a stable tool replace key from toolCallId or tool name', () => {
    expect(buildToolTimelineReplaceKey('call-9', 'shell')).toBe('tool:call-9');
    expect(buildToolTimelineReplaceKey(undefined, 'shell')).toBe('tool:shell');
    expect(buildToolTimelineReplaceKey(undefined, undefined)).toBeUndefined();
  });
});
