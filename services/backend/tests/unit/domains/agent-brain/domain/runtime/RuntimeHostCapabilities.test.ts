import { describe, expect, it } from 'vitest';

import {
  assertRuntimeHostCapabilitiesCompatible,
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  createTestRuntimeHostCapabilities,
  resolveRuntimeHostCapabilities,
  RUNTIME_HOST_LIFECYCLES,
  RuntimeHostCapabilityRegistrationError,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

describe('RuntimeHostCapabilities', () => {
  it.each([
    ['organization', createOrganizationRuntimeHostCapabilities],
    ['research_lab', createResearchLabRuntimeHostCapabilities],
  ] as const)('resolves the reviewed %s declaration with durable owners', (hostKind, factory) => {
    const capabilities = factory();

    expect(capabilities.hostKind).toBe(hostKind);
    for (const lifecycle of RUNTIME_HOST_LIFECYCLES) {
      expect(capabilities[lifecycle]).toMatchObject({
        durability: 'durable',
        schemaVersion: lifecycle === 'modelRequests'
          ? 3
          : lifecycle === 'toolExecutions'
            ? 2
            : lifecycle === 'providerAttempts'
              || lifecycle === 'traceEvents'
              || lifecycle === 'artifacts'
              ? 2
              : 1,
      });
      expect(capabilities[lifecycle].owner.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it('allows a test host to declare its behavior explicitly as ephemeral', () => {
    const capabilities = createTestRuntimeHostCapabilities({ ownerPrefix: 'unit-fixture' });
    expect(capabilities.hostKind).toBe('test');
    expect(capabilities.toolExecutions).toEqual({
      owner: 'unit-fixture.toolExecutions',
      durability: 'ephemeral',
      schemaVersion: 1,
    });
  });

  it('rejects a production Research Lab host with ephemeral tool state', () => {
    const valid = createResearchLabRuntimeHostCapabilities();
    const unsupported = {
      ...valid,
      toolExecutions: {
        ...valid.toolExecutions,
        owner: 'negative-control.memory',
        durability: 'ephemeral' as const,
      },
    };

    expect(() => resolveRuntimeHostCapabilities(unsupported)).toThrow(
      RuntimeHostCapabilityRegistrationError,
    );
    expect(() => resolveRuntimeHostCapabilities(unsupported)).toThrow(
      /host=research_lab lifecycle=toolExecutions durability=ephemeral required=durable/u,
    );
  });

  it('rejects an adapter whose owner set differs from the constructed runtime', () => {
    const runtime = createResearchLabRuntimeHostCapabilities();
    const adapter = {
      ...runtime,
      artifacts: { ...runtime.artifacts, owner: 'different-artifact-owner' },
    };

    expect(() => assertRuntimeHostCapabilitiesCompatible(runtime, adapter)).toThrow(
      /lifecycle=artifacts/u,
    );
  });
});
