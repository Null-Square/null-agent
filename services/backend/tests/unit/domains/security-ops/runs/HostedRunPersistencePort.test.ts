import { describe, expect, it, vi } from 'vitest';

import {
  getHostedRunPersistencePort,
  getHostedRunRuntimeCapabilities,
  registerHostedRunPersistencePort,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import {
  createResearchLabRuntimeHostCapabilities,
  RuntimeHostCapabilityRegistrationError,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { InMemoryUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';

describe('HostedRunPersistencePort capability registration', () => {
  const lifecycle = () => ({
    claim: vi.fn(),
    markStarted: vi.fn(),
    block: vi.fn(),
    markOutcomeUnknown: vi.fn(),
  });
  const modelRequests = () => ({
    append: vi.fn(),
    findByRequestId: vi.fn(),
    findBySession: vi.fn(),
  });
  const historyTransformations = () => ({
    prepare: vi.fn(),
    persistReplacement: vi.fn(),
    activate: vi.fn(),
    findById: vi.fn(),
    findActiveBySession: vi.fn(),
    findBySession: vi.fn(),
  });

  it('publishes one validated capability set with the active port', () => {
    const port = {
      kind: 'research_lab',
      runId: 'capability-run',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: lifecycle(),
      modelRequestLifecycle: modelRequests(),
      providerAttemptLifecycle: new InMemoryUsageStore(),
      historyTransformationLifecycle: historyTransformations(),
    } as any;
    const unregister = registerHostedRunPersistencePort(
      port,
      createResearchLabRuntimeHostCapabilities(),
    );

    try {
      expect(getHostedRunPersistencePort('capability-run')).toBe(port);
      expect(getHostedRunRuntimeCapabilities({
        runId: 'capability-run',
        runHost: 'research_lab',
      })).toEqual(port.runtimeHostCapabilities);
    } finally {
      unregister();
    }
    expect(getHostedRunPersistencePort('capability-run')).toBeNull();
  });

  it('rejects ephemeral tool ownership before provider or tool dispatch', () => {
    const providerDispatch = vi.fn();
    const toolDispatch = vi.fn();
    const valid = createResearchLabRuntimeHostCapabilities();
    const port = {
      kind: 'research_lab',
      runId: 'ephemeral-tool-run',
      runtimeHostCapabilities: {
        ...valid,
        toolExecutions: {
          owner: 'in-memory-tool-map',
          durability: 'ephemeral',
          schemaVersion: 1,
        },
      },
    } as any;

    expect(() => registerHostedRunPersistencePort(port)).toThrow(
      RuntimeHostCapabilityRegistrationError,
    );
    expect(getHostedRunPersistencePort('ephemeral-tool-run')).toBeNull();
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(toolDispatch).not.toHaveBeenCalled();
  });

  it('rejects an undeclared production adapter', () => {
    expect(() => registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'undeclared-run',
    } as any)).toThrow(/hostKind=invalid/u);
  });

  it('rejects a v2 host without the durable lifecycle adapter', () => {
    expect(() => registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'missing-v2-tool-lifecycle',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
    } as any)).toThrow(/adapter=missing_v2_contract/u);
  });

  it('rejects a v2 host without the atomic model-request adapter', () => {
    expect(() => registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'missing-v2-model-request-lifecycle',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: lifecycle(),
    } as any)).toThrow(/lifecycle=modelRequests.*adapter=missing_v2_contract/u);
  });

  it('rejects a contextual-request host without transactional history', () => {
    expect(() => registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'missing-history-transformation-lifecycle',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: lifecycle(),
      modelRequestLifecycle: modelRequests(),
    } as any)).toThrow(/adapter=missing_history_transaction_contract/u);
  });

  it('rejects a v2 host without the durable provider-attempt adapter', () => {
    expect(() => registerHostedRunPersistencePort({
      kind: 'research_lab',
      runId: 'missing-v2-provider-attempt-lifecycle',
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
      toolExecutionLifecycle: lifecycle(),
      modelRequestLifecycle: modelRequests(),
      historyTransformationLifecycle: historyTransformations(),
    } as any)).toThrow(/lifecycle=providerAttempts.*adapter=missing_v2_contract/u);
  });
});
