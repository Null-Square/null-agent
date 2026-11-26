import { describe, expect, it } from 'vitest';
import {
  classifyLeadFeasibility,
  NO_EXECUTION_CAPABILITIES,
  partitionLeadsByFeasibility,
  type RunExecutionCapabilities,
} from '@/domains/security-ops/runs/leadFeasibility';

/**
 * D14 — production run r1 had no replan in 3.1 and one in 3.2. It fired on two new routes and
 * three new high-priority leads, then spent roughly 414k input tokens, 28k output tokens, 21
 * tools and several minutes introducing validation tasks 3 through 6 — all four of which
 * transitioned to blocked together at closeout, because their prerequisites (credentials,
 * evaluator-owned accounts) did not exist in that run.
 *
 * A lead that needs an absent capability is still real and still belongs on the validation
 * queue. It is not a reason to restructure the active plan.
 */
const fullyEquipped: RunExecutionCapabilities = {
  hasCredentials: true,
  hasEvaluatorAccounts: true,
  hasPrivateRunner: true,
};

describe('lead feasibility against a run\'s actual capabilities', () => {
  it('holds back the r1 tenant IDOR lead when the run has no credentials', () => {
    const result = classifyLeadFeasibility(
      { id: 'lead-idor', riskFamily: 'idor', priority: 'high' },
      NO_EXECUTION_CAPABILITIES,
    );

    expect(result.actionable).toBe(false);
    expect(result.missingCapabilities).toEqual(['credentials', 'evaluator_accounts']);
  });

  it('lets the same lead through once the run is equipped', () => {
    expect(classifyLeadFeasibility(
      { id: 'lead-idor', riskFamily: 'idor' },
      fullyEquipped,
    )).toEqual({ actionable: true, missingCapabilities: [] });
  });

  it('keeps an authorization lead actionable when synthetic identities are provisionable', () => {
    expect(classifyLeadFeasibility(
      { id: 'lead-idor', riskFamily: 'idor' },
      {
        hasCredentials: false,
        hasEvaluatorAccounts: false,
        hasPrivateRunner: false,
        credentialAvailability: 'provisionable',
        evaluatorAccountAvailability: 'provisionable',
        privateRunnerAvailability: 'blocked',
      },
    )).toEqual({
      actionable: true,
      missingCapabilities: [],
      provisionableCapabilities: ['credentials', 'evaluator_accounts'],
    });
  });

  it('reads a stated prerequisite, not only the risk family', () => {
    const result = classifyLeadFeasibility(
      {
        id: 'lead-1',
        riskFamily: 'injection',
        requiredPrerequisites: ['A valid session cookie for the target application'],
      },
      NO_EXECUTION_CAPABILITIES,
    );

    expect(result.missingCapabilities).toEqual(['credentials']);
  });

  it('recognises a lead that needs the internal network', () => {
    const result = classifyLeadFeasibility(
      { id: 'lead-2', riskFamily: 'ssrf', requiredPrerequisites: ['Access to the internal network'] },
      NO_EXECUTION_CAPABILITIES,
    );

    expect(result.missingCapabilities).toEqual(['private_runner']);
  });

  it('calls an unauthenticated lead actionable with no capabilities at all', () => {
    // CORS on a public origin needs nothing. This is what a replan may legitimately answer.
    expect(classifyLeadFeasibility(
      { id: 'lead-cors', riskFamily: 'cors', priority: 'high' },
      NO_EXECUTION_CAPABILITIES,
    )).toEqual({ actionable: true, missingCapabilities: [] });
  });

  it('does not guess: a lead with no stated prerequisite and a neutral family is actionable', () => {
    // Guessing would push real work off the plan, which is the opposite defect.
    expect(classifyLeadFeasibility({ id: 'lead-3' }, NO_EXECUTION_CAPABILITIES).actionable).toBe(true);
  });

  it('partitions the r1 lead set the way the replan trigger should have read it', () => {
    const leads = [
      { id: 'lead-idor', riskFamily: 'idor', priority: 'high' },
      { id: 'lead-login', riskFamily: 'auth', priority: 'high', requiredPrerequisites: ['valid credentials'] },
      { id: 'lead-graphql', riskFamily: 'graphql', priority: 'high' },
    ];

    const partition = partitionLeadsByFeasibility(leads, NO_EXECUTION_CAPABILITIES);

    // One actionable lead is below the threshold of three that forced the r1 replan.
    expect(partition.actionable.map((lead) => lead.id)).toEqual(['lead-graphql']);
    expect(partition.needsCapability.map((lead) => lead.id)).toEqual(['lead-idor', 'lead-login']);
    expect(partition.needsCapability[0]?.missingCapabilities).toContain('credentials');
  });

  it('keeps every lead when the run can do everything', () => {
    const leads = [
      { id: 'lead-idor', riskFamily: 'idor' },
      { id: 'lead-ssrf', riskFamily: 'ssrf', requiredPrerequisites: ['internal network'] },
    ];

    const partition = partitionLeadsByFeasibility(leads, fullyEquipped);

    expect(partition.actionable).toHaveLength(2);
    expect(partition.needsCapability).toEqual([]);
  });

  it('is case and whitespace insensitive about stated prerequisites', () => {
    expect(classifyLeadFeasibility(
      { id: 'lead-4', requiredPrerequisites: ['  A Second Account On The Tenant  '] },
      NO_EXECUTION_CAPABILITIES,
    ).missingCapabilities).toEqual(['evaluator_accounts']);
  });
});
