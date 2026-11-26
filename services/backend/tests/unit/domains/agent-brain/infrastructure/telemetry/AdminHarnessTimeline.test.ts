import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

import {
  classifyTraceEvent,
  computeAdminHarnessStats,
  type AdminHarnessCategory,
} from '@/domains/agent-brain/infrastructure/telemetry/AdminHarnessTimeline';
import type { TimelineEvent } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';

const srcRoot = path.resolve(process.cwd(), 'src');

const eventOf = (
  event: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id: `event-${event}`,
  sessionId: 'session-1',
  runId: 'run-1',
  agentType: 'securityops',
  agentRole: 'executor',
  turn: 1,
  ts: '2026-06-07T00:00:00.000Z',
  event,
  severity: 'info',
  payload,
  ...overrides,
});

describe('AdminHarnessTimeline classifier', () => {
  it('classifies harness gates with why, subject, and blocked outcome', () => {
    const classified = classifyTraceEvent(eventOf('submit_plan.gate_blocked', {
      gateCode: 'skill_phase_mismatch',
      taskId: 'task-3',
      skillSlug: 'subdomain-takeover',
      phaseKey: 'enumeration',
      reason: 'Skill is not compatible with enumeration.',
      correctionHint: 'Move this skill to validation.',
    }));

    expect(classified).toMatchObject({
      category: 'harness_gate',
      outcome: 'blocked',
      title: 'Plan rejected by harness gate',
      why: 'Skill is not compatible with enumeration.',
      subject: 'task-3',
      nextAction: 'Move this skill to validation.',
    });
    expect(classified.flags.isGate).toBe(true);
  });

  it('classifies workspace projection failures with actionable context', () => {
    const classified = classifyTraceEvent(eventOf('workspace_projection.failed', {
      reason: 'run_start',
      phaseKey: 'planning',
      errorCode: 'resource.quota_exceeded',
      errorMessage: 'No space left on device',
      written: 0,
    }, { severity: 'error' }));

    expect(classified.category).toBe('workspace_projection');
    expect(classified.outcome).toBe('failed');
    expect(classified.why).toBe('run_start');
    expect(classified.payloadPreview).toMatchObject({
      reason: 'run_start',
      phaseKey: 'planning',
      errorCode: 'resource.quota_exceeded',
      errorMessage: 'No space left on device',
    });
  });

  it('classifies ENOSPC tool failures as storage pressure', () => {
    const classified = classifyTraceEvent(eventOf('tool.finish', {
      toolName: 'shell_run',
      outcome: 'error',
      outcomeReason: 'Failed to write managed shell job file: cat: write error: No space left on device',
    }, { severity: 'error' }));

    expect(classified).toMatchObject({
      category: 'scanner_sandbox_storage',
      subcategory: 'storage',
      outcome: 'failed',
      title: 'Workspace storage pressure',
      subject: 'shell_run',
      nextAction: 'Inspect workspace storage, cleanup, and scanner output volume.',
    });
  });

  it('treats action.summary outcome failure as a failed tool action', () => {
    const classified = classifyTraceEvent(eventOf('action.summary', {
      tool: 'shell_run',
      action: 'ffuf ...',
      outcome: 'failure',
      outcomeReason: 'command exited non-zero',
    }));

    expect(classified).toMatchObject({
      category: 'tool_action',
      outcome: 'failed',
      subject: 'shell_run',
    });
  });

  it('extracts artifact links and session links', () => {
    const classified = classifyTraceEvent(eventOf('worker.spawned', {
      workerSessionId: 'worker-session-1',
      stdoutPath: '.artifacts/shell-jobs/job/stdout.log',
    }, {
      links: {
        prompt: 'messages/model-call.json',
      },
    }));

    expect(classified.sessionLinks).toContainEqual(expect.objectContaining({
      sessionId: 'worker-session-1',
      role: 'worker',
    }));
    expect(classified.artifactLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'prompt', kind: 'prompt' }),
      expect.objectContaining({ label: 'stdoutPath', kind: 'stdout' }),
    ]));
  });

  it.each([
    ['lifecycle', eventOf('session.status_changed', { from: 'running', to: 'system_paused', reason: 'manual_pause' })],
    ['model_context', eventOf('model.call.finish', { model: 'deepseek-v4-pro', finishReason: 'stop' })],
    ['tool_action', eventOf('tool.finish', { toolName: 'query_inventory', status: 'success' })],
    ['harness_gate', eventOf('submit_plan.gate_blocked', { gateCode: 'skill_phase_mismatch', reason: 'wrong phase' })],
    ['workspace_projection', eventOf('workspace_projection.projected', { reason: 'run_start', written: 32 })],
    ['skill_worker', eventOf('assigned_skills.injected', { skillSlug: 'idor', phaseKey: 'validation' })],
    ['scanner_sandbox_storage', eventOf('scanner.budget_exceeded', { scannerFamily: 'ffuf', status: 'blocked' })],
    ['securityops_outcome', eventOf('validation.lead', { leadId: 'lead-1', outcome: 'open' })],
    ['recovery_repair', eventOf('turn.error.retry_scheduled', { reason: 'transient provider error', attempt: 1 })],
    ['noise', eventOf('tool.stdout', { toolName: 'shell_run', bytes: 1024 })],
  ] as const)('classifies %s events into the intended category', (expectedCategory, event) => {
    const classified = classifyTraceEvent(event);

    expect(classified.category).toBe(expectedCategory);
    expect(classified.title.length).toBeGreaterThan(0);
  });

  it('computes usage and cost rollups from usage.recorded events', () => {
    const events = [
      eventOf('usage.recorded', {
        promptTokens: 100,
        cachedPromptTokens: 40,
        completionTokens: 25,
        totalTokens: 125,
        nativeCost: 0.01,
        platformPrice: 0.02,
      }, { turn: 1, agentRole: 'planner' }),
      eventOf('usage.recorded', {
        promptTokens: 50,
        cachedPromptTokens: 10,
        completionTokens: 10,
        totalTokens: 60,
        nativeCost: 0.005,
        platformPrice: 0.01,
      }, { turn: 2, agentRole: 'worker', workerTaskId: 'worker-1' }),
    ];
    const classified = events.map((event) => classifyTraceEvent(event));
    const stats = computeAdminHarnessStats(events, classified);

    expect(stats.usage.promptTokens).toBe(150);
    expect(stats.usage.cachedTokens).toBe(50);
    expect(stats.usage.totalTokens).toBe(185);
    expect(stats.usage.chargedCostUsd).toBeCloseTo(0.03);
    expect(stats.usage.cachedTokenPercent).toBeCloseTo(33.333, 2);
    expect(stats.usage.byTurn).toHaveLength(2);
    expect(stats.usage.byRole.map((role) => role.role).sort()).toEqual(['planner', 'worker']);
    expect(stats.usage.byWorker[0]).toMatchObject({
      sessionId: 'session-1',
      workerTaskId: 'worker-1',
      totalTokens: 60,
    });
  });

  it('falls back to model.call.finish token payloads when usage.recorded is absent', () => {
    const events = [
      eventOf('model.call.start', {
        model: 'deepseek-v4-pro',
      }, { turn: 1, agentRole: 'phase:enumeration' }),
      eventOf('model.call.finish', {
        tokens: {
          input: 120,
          output: 30,
          cached: 40,
          total: 150,
        },
      }, { turn: 1, agentRole: 'phase:enumeration' }),
    ];
    const classified = events.map((event) => classifyTraceEvent(event));
    const stats = computeAdminHarnessStats(events, classified);

    expect(stats.usage.promptTokens).toBe(120);
    expect(stats.usage.completionTokens).toBe(30);
    expect(stats.usage.cachedTokens).toBe(40);
    expect(stats.usage.totalTokens).toBe(150);
    expect(stats.usage.modelCallCount).toBe(1);
    expect(stats.usage.byRole[0]).toMatchObject({
      role: 'phase:enumeration',
      totalTokens: 150,
    });
    expect(stats.modelCalls).toBe(1);
  });

  it('does not double-count model.call.finish tokens when usage.recorded exists', () => {
    const events = [
      eventOf('usage.recorded', {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
      }),
      eventOf('model.call.finish', {
        tokens: {
          input: 100,
          output: 10,
          total: 110,
        },
      }),
    ];
    const classified = events.map((event) => classifyTraceEvent(event));
    const stats = computeAdminHarnessStats(events, classified);

    expect(stats.usage.totalTokens).toBe(110);
    expect(stats.usage.modelCallCount).toBe(1);
  });

  it('counts completed model and tool calls instead of every trace event', () => {
    const events = [
      eventOf('model.call.start'),
      eventOf('model.call.finish'),
      eventOf('tool.start', { toolName: 'shell_run' }),
      eventOf('tool.stdout', { toolName: 'shell_run' }),
      eventOf('tool.finish', { toolName: 'shell_run' }),
    ];
    const classified = events.map((event) => classifyTraceEvent(event));
    const stats = computeAdminHarnessStats(events, classified);

    expect(stats.modelCalls).toBe(1);
    expect(stats.toolCalls).toBe(1);
  });

  it('provides safe fallback classification for emitted event literals', async () => {
    const files = await listTsFiles(srcRoot);
    const eventNames = new Set<string>();
    const literalPattern = /event:\s*'([^']+)'/gu;

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      for (const match of content.matchAll(literalPattern)) {
        eventNames.add(match[1]);
      }
    }

    expect(eventNames.size).toBeGreaterThan(50);

    const allowedCategories: AdminHarnessCategory[] = [
      'lifecycle',
      'model_context',
      'tool_action',
      'harness_gate',
      'workspace_projection',
      'skill_worker',
      'scanner_sandbox_storage',
      'securityops_outcome',
      'recovery_repair',
      'noise',
    ];

    for (const eventName of eventNames) {
      const classified = classifyTraceEvent(eventOf(eventName));
      expect(classified.event).toBe(eventName);
      expect(classified.title.length).toBeGreaterThan(0);
      expect(allowedCategories).toContain(classified.category);
    }
  });
});

async function listTsFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return listTsFiles(fullPath);
    }
    if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) return [fullPath];
    return [];
  }));
  return nested.flat();
}
