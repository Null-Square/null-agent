import { describe, expect, it, vi } from 'vitest';

import type { ToolAccessPolicy } from '@/domains/agent-brain/domain/types';
import {
  PhaseSessionFactory,
  buildPhaseSessionParams,
  type CreatePhaseSessionInput,
} from '@/domains/security-ops/runs/PhaseSessionFactory';

const input = (): CreatePhaseSessionInput => ({
  phaseKey: 'reporting',
  userId: 'user-1',
  organizationId: 'org-1',
  modelId: 'model-1',
  profileKey: 'sandbox-default',
  promptProfile: 'phase-reporting',
  extraContext: 'canonical reporting context',
  executionMode: 'evidence',
  flags: {
    securityops: {
      runId: 'run-1',
      activePhaseKey: 'reporting',
    },
  },
  scopeId: 'scope-1',
  planSeed: [{ id: 'report', title: 'Write the report', status: 'pending' }],
  toolPolicy: { allow: ['prepare_report_context'] } as ToolAccessPolicy,
});

describe('PhaseSessionFactory', () => {
  it('normalizes identical phase inputs to identical production session parameters', () => {
    const first = buildPhaseSessionParams(input());
    const second = buildPhaseSessionParams(input());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: 'automated',
      agentType: 'executor',
      promptProfile: 'phase-reporting',
      executionMode: 'evidence',
      extraContext: 'canonical reporting context',
    });
    expect(first).not.toHaveProperty('phaseKey');
  });

  it('passes the canonical parameters to the injected production session creator', async () => {
    const result = {
      session: { id: 'session-1' },
      model: { id: 'model-1' },
    };
    const createSession = vi.fn().mockResolvedValue(result);
    const factory = new PhaseSessionFactory({ createSession } as never);

    await expect(factory.create(input())).resolves.toBe(result);
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith(buildPhaseSessionParams(input()));
  });
});
