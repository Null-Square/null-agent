import { describe, expect, it } from 'vitest';
import {
  resolvePhaseState,
  TERMINAL_LEAD_STATUSES,
} from '@/domains/security-ops/runs/phaseStateResolver';
import { tools as securityOpsTools } from '@/domains/agent-brain/adapters/tools/builtins/securityops';

/**
 * D9 — at the end of validation Turn 1 in production run r1 the lead queue was resolved and
 * the turn reported `plan 0/4`, after 69 requested tools and more than 2.28M input tokens.
 * Turn 2 then spent a 127-second call, a 101-second call, a rejected outcome submission and
 * another long call rediscovering a state that is a pure function of records already held.
 *
 * These cases are that function. No clock, no I/O, no model call.
 */
const lead = (id: string, status: string, blockerCode?: string) => ({ id, status, blockerCode });
const step = (id: string, status = 'pending', leadIds?: string[]) => ({ id, status, leadIds });

describe('phase state resolver', () => {
  it('reproduces the r1 disagreement and settles it', () => {
    // The exact shape: a settled queue and four plan steps nobody advanced.
    const state = resolvePhaseState({
      leads: [
        lead('lead-graphql', 'false_positive'),
        lead('lead-api', 'validated'),
        lead('lead-idor', 'blocked', 'credential_required'),
        lead('lead-login', 'false_positive'),
        lead('lead-cors', 'superseded'),
      ],
      planSteps: [step('task-3'), step('task-4'), step('task-5'), step('task-6')],
    });

    expect(state.allLeadsTerminal).toBe(true);
    // The first version of this resolver completed all four steps here, on the reasoning that
    // a settled queue implies settled tasks. It does not, and none of these steps names a
    // lead, so the honest answer is that nothing records what closed them.
    expect(state.planStepTransitions).toEqual([]);
    expect(state.unmappedPlanStepIds).toEqual(['task-3', 'task-4', 'task-5', 'task-6']);
    expect(state.remainingPlanStepIds).toEqual([]);
    expect(state.status).toBe('needs_operator_input');
    expect(state.reason).toContain('credential_required');
    expect(state.reason).toContain('name no lead');
  });

  it('will not read a settled queue as a settled plan', () => {
    // The production adapter supplies no lead references at all, so this was the only branch
    // that ever ran: every plan step completed on no evidence whatsoever.
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated'), lead('lead-2', 'false_positive')],
      planSteps: [step('task-1'), step('task-2')],
    });

    expect(state.planStepTransitions).toEqual([]);
    expect(state.unmappedPlanStepIds).toEqual(['task-1', 'task-2']);
    expect(state.status).toBe('needs_reconciliation');
    expect(state.reason).toContain('rather than assuming the settled queue did');
  });

  it('still reads a step that names its leads', () => {
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated')],
      planSteps: [step('task-1', 'pending', ['lead-1'])],
    });

    expect(state.unmappedPlanStepIds).toEqual([]);
    expect(state.status).toBe('completed');
  });

  it('stays in progress while any lead is open', () => {
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated'), lead('lead-2', 'open')],
      planSteps: [step('task-1')],
    });

    expect(state.status).toBe('in_progress');
    expect(state.openLeadIds).toEqual(['lead-2']);
    expect(state.planStepTransitions).toEqual([]);
  });

  it('completes when every lead settled, nothing is blocked, and the steps say which leads', () => {
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated'), lead('lead-2', 'false_positive')],
      planSteps: [step('task-1', 'pending', ['lead-1', 'lead-2']), step('task-2', 'completed')],
    });

    expect(state.status).toBe('completed');
    expect(state.planStepTransitions).toEqual([
      { stepId: 'task-1', from: 'pending', to: 'completed', because: expect.any(String) },
    ]);
  });

  it('separates a blocker the operator can clear from one they cannot', () => {
    const operator = resolvePhaseState({
      leads: [lead('lead-1', 'blocked', 'credential_required')],
      planSteps: [],
    });
    const structural = resolvePhaseState({
      leads: [lead('lead-1', 'blocked', 'waf_blocked')],
      planSteps: [],
    });

    expect(operator.status).toBe('needs_operator_input');
    expect(operator.operatorResolvableBlockers).toEqual(['credential_required']);
    expect(structural.status).toBe('blocked');
    expect(structural.unresolvableBlockers).toEqual(['waf_blocked']);
  });

  it('follows the leads a plan step names rather than the queue as a whole', () => {
    const state = resolvePhaseState({
      leads: [
        lead('lead-a', 'validated'),
        lead('lead-b', 'blocked', 'credential_required'),
        lead('lead-c', 'open'),
      ],
      planSteps: [
        step('task-a', 'pending', ['lead-a']),
        step('task-b', 'pending', ['lead-b']),
        step('task-c', 'pending', ['lead-c']),
      ],
    });

    expect(state.planStepTransitions).toEqual([
      { stepId: 'task-a', from: 'pending', to: 'completed', because: expect.any(String) },
      { stepId: 'task-b', from: 'pending', to: 'blocked', because: expect.any(String) },
    ]);
    // task-c names an open lead, so it is genuinely still outstanding.
    expect(state.remainingPlanStepIds).toEqual(['task-c']);
    expect(state.status).toBe('in_progress');
  });

  it('does not imply anything for a plan with no leads behind it at all', () => {
    // A phase that never produced leads must not have its plan silently completed.
    const state = resolvePhaseState({ leads: [], planSteps: [step('task-1')] });

    expect(state.planStepTransitions).toEqual([]);
    expect(state.remainingPlanStepIds).toEqual(['task-1']);
    expect(state.status).toBe('in_progress');
  });

  it('lets a gate failure override a queue that otherwise looks finished', () => {
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated')],
      planSteps: [],
      gateFailureCodes: ['missing_replay_evidence'],
    });

    expect(state.status).toBe('blocked');
    expect(state.reason).toContain('missing_replay_evidence');
  });

  it('ignores an optional plan step when deciding whether work remains', () => {
    const state = resolvePhaseState({
      leads: [lead('lead-1', 'validated')],
      planSteps: [{ id: 'task-optional', status: 'pending', mandatory: false, leadIds: ['lead-missing'] }],
    });

    expect(state.remainingPlanStepIds).toEqual([]);
    expect(state.status).toBe('completed');
  });

  it('is a pure function of its inputs', () => {
    const inputs = {
      leads: [lead('lead-1', 'blocked', 'rate_limited'), lead('lead-2', 'validated')],
      planSteps: [step('task-1')],
    };

    expect(resolvePhaseState(inputs)).toEqual(resolvePhaseState(inputs));
  });

  it('reports every blocked lead once, sorted, without duplicates', () => {
    const state = resolvePhaseState({
      leads: [
        lead('lead-1', 'blocked', 'credential_required'),
        lead('lead-2', 'blocked', 'credential_required'),
        lead('lead-3', 'deferred', 'auth_required'),
      ],
      planSteps: [],
    });

    expect(state.operatorResolvableBlockers).toEqual(['auth_required', 'credential_required']);
    expect(state.blockedLeadIds).toEqual(['lead-1', 'lead-2', 'lead-3']);
  });
});

/**
 * The resolver decides a phase is settled by comparing lead statuses against a set written
 * here. That set is a copy of the vocabulary `submit_validation_lead_outcome` accepts, and a
 * copy is exactly how the discovery counter came to hold five tool names that never existed.
 * If the tool learns a sixth terminal outcome, this test fails instead of the resolver
 * quietly reading that outcome as open work and holding a finished phase open forever.
 */
describe('terminal lead statuses match the tool that writes them', () => {
  const leadOutcomeTool = securityOpsTools.find(
    (tool) => tool.meta.name === 'submit_validation_lead_outcome',
  );

  it('finds the tool that closes a lead', () => {
    expect(leadOutcomeTool).toBeDefined();
  });

  it('treats exactly the outcomes that tool accepts as terminal', () => {
    const schema = leadOutcomeTool?.meta.schema as {
      properties?: { outcome?: { enum?: string[] } };
    } | undefined;
    const declared = schema?.properties?.outcome?.enum ?? [];

    expect(declared.length).toBeGreaterThan(0);
    expect([...TERMINAL_LEAD_STATUSES].sort()).toEqual([...declared].sort());
  });
});
