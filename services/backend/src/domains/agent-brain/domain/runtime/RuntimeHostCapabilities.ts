export const RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const RUNTIME_HOST_LIFECYCLES = [
  'modelRequests',
  'providerAttempts',
  'toolExecutions',
  'traceEvents',
  'artifacts',
  'restartRecovery',
  'terminalState',
] as const;

export type RuntimeHostLifecycle = typeof RUNTIME_HOST_LIFECYCLES[number];
export type RuntimeHostKind = 'organization' | 'research_lab' | 'test';
export type PersistenceDurability = 'durable' | 'ephemeral' | 'unsupported';

export type PersistenceCapability = {
  owner: string;
  durability: PersistenceDurability;
  schemaVersion: number;
};

export type RuntimeHostCapabilities = {
  hostKind: RuntimeHostKind;
  modelRequests: PersistenceCapability;
  providerAttempts: PersistenceCapability;
  toolExecutions: PersistenceCapability;
  traceEvents: PersistenceCapability;
  artifacts: PersistenceCapability;
  restartRecovery: PersistenceCapability;
  terminalState: PersistenceCapability;
};

export class RuntimeHostCapabilityRegistrationError extends Error {
  readonly code = 'runtime_host_capability_registration_rejected';

  constructor(public readonly issues: string[]) {
    super(`Runtime host capability registration rejected: ${issues.join('; ')}`);
    this.name = 'RuntimeHostCapabilityRegistrationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRuntimeHostKind = (value: unknown): value is RuntimeHostKind =>
  value === 'organization' || value === 'research_lab' || value === 'test';

const isDurability = (value: unknown): value is PersistenceDurability =>
  value === 'durable' || value === 'ephemeral' || value === 'unsupported';

const validateCapability = (
  hostKind: RuntimeHostKind,
  lifecycle: RuntimeHostLifecycle,
  value: unknown,
): { capability?: PersistenceCapability; issues: string[] } => {
  if (!isRecord(value)) {
    return { issues: [`host=${hostKind} lifecycle=${lifecycle} declaration=missing`] };
  }
  const issues: string[] = [];
  const owner = typeof value.owner === 'string' ? value.owner.trim() : '';
  if (!owner) issues.push(`host=${hostKind} lifecycle=${lifecycle} owner=missing`);
  if (!isDurability(value.durability)) {
    issues.push(`host=${hostKind} lifecycle=${lifecycle} durability=invalid`);
  }
  if (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
    issues.push(`host=${hostKind} lifecycle=${lifecycle} schemaVersion=invalid`);
  }
  if (hostKind !== 'test' && value.durability !== 'durable') {
    issues.push(
      `host=${hostKind} lifecycle=${lifecycle} durability=${String(value.durability)} required=durable`,
    );
  }
  if (issues.length > 0) return { issues };
  return {
    capability: {
      owner,
      durability: value.durability as PersistenceDurability,
      schemaVersion: Number(value.schemaVersion),
    },
    issues,
  };
};

/**
 * Registration authority for host declarations. Production hosts fail closed unless every
 * required lifecycle has a durable, versioned owner. The frozen result is the value passed
 * through runtime construction.
 */
export const resolveRuntimeHostCapabilities = (
  input: RuntimeHostCapabilities,
): RuntimeHostCapabilities => {
  const raw = input as unknown;
  if (!isRecord(raw) || !isRuntimeHostKind(raw.hostKind)) {
    throw new RuntimeHostCapabilityRegistrationError(['hostKind=invalid']);
  }

  const hostKind = raw.hostKind;
  const issues: string[] = [];
  const resolved = {} as Record<RuntimeHostLifecycle, PersistenceCapability>;
  for (const lifecycle of RUNTIME_HOST_LIFECYCLES) {
    const validation = validateCapability(hostKind, lifecycle, raw[lifecycle]);
    issues.push(...validation.issues);
    if (validation.capability) resolved[lifecycle] = validation.capability;
  }
  if (issues.length > 0) throw new RuntimeHostCapabilityRegistrationError(issues);

  const capabilities: RuntimeHostCapabilities = {
    hostKind,
    modelRequests: resolved.modelRequests,
    providerAttempts: resolved.providerAttempts,
    toolExecutions: resolved.toolExecutions,
    traceEvents: resolved.traceEvents,
    artifacts: resolved.artifacts,
    restartRecovery: resolved.restartRecovery,
    terminalState: resolved.terminalState,
  };
  for (const lifecycle of RUNTIME_HOST_LIFECYCLES) {
    Object.freeze(capabilities[lifecycle]);
  }
  return Object.freeze(capabilities);
};

export const createOrganizationRuntimeHostCapabilities = (): RuntimeHostCapabilities =>
  resolveRuntimeHostCapabilities({
    hostKind: 'organization',
    modelRequests: {
      owner: 'ModelRequestAdapter',
      durability: 'durable',
      schemaVersion: 3,
    },
    providerAttempts: {
      owner: 'UsageRecordRepository.usage_records',
      durability: 'durable',
      schemaVersion: 2,
    },
    toolExecutions: {
      owner: 'ToolExecutionAdapter',
      durability: 'durable',
      schemaVersion: 2,
    },
    traceEvents: {
      owner: 'SessionTraceRecorder+TraceIndexRepository',
      durability: 'durable',
      schemaVersion: 2,
    },
    artifacts: {
      owner: 'ArtifactService+ArtifactRepository+S3StorageService',
      durability: 'durable',
      schemaVersion: 2,
    },
    restartRecovery: {
      owner: 'SystemRecoveryWorker',
      durability: 'durable',
      schemaVersion: RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION,
    },
    terminalState: {
      owner: 'StartRunService+RunRepository',
      durability: 'durable',
      schemaVersion: RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION,
    },
  });

export const createResearchLabRuntimeHostCapabilities = (): RuntimeHostCapabilities =>
  resolveRuntimeHostCapabilities({
    hostKind: 'research_lab',
    modelRequests: {
      owner: 'FileModelRequestLifecycleAdapter.model-requests.json',
      durability: 'durable',
      schemaVersion: 3,
    },
    providerAttempts: {
      owner: 'FileProviderAttemptLifecycleAdapter.provider-attempts.json',
      durability: 'durable',
      schemaVersion: 2,
    },
    toolExecutions: {
      owner: 'FileToolExecutionLifecycleAdapter.tool-executions.json',
      durability: 'durable',
      schemaVersion: 2,
    },
    traceEvents: {
      owner: 'SessionTraceRecorder+TraceIndexRepository',
      durability: 'durable',
      schemaVersion: 2,
    },
    artifacts: {
      owner: 'FileHostedRunPersistence.run-artifacts+ArtifactService',
      durability: 'durable',
      schemaVersion: 2,
    },
    restartRecovery: {
      owner: 'FileHostedRunPersistence.run.json+phases.json',
      durability: 'durable',
      schemaVersion: RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION,
    },
    terminalState: {
      owner: 'FileHostedRunPersistence.run.json',
      durability: 'durable',
      schemaVersion: RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION,
    },
  });

export const createTestRuntimeHostCapabilities = (options: {
  ownerPrefix: string;
  durability?: 'durable' | 'ephemeral';
  schemaVersion?: number;
}): RuntimeHostCapabilities => {
  const durability = options.durability ?? 'ephemeral';
  const schemaVersion = options.schemaVersion ?? RUNTIME_HOST_CAPABILITY_SCHEMA_VERSION;
  const capability = (lifecycle: RuntimeHostLifecycle): PersistenceCapability => ({
    owner: `${options.ownerPrefix}.${lifecycle}`,
    durability,
    schemaVersion,
  });
  return resolveRuntimeHostCapabilities({
    hostKind: 'test',
    modelRequests: capability('modelRequests'),
    providerAttempts: capability('providerAttempts'),
    toolExecutions: capability('toolExecutions'),
    traceEvents: capability('traceEvents'),
    artifacts: capability('artifacts'),
    restartRecovery: capability('restartRecovery'),
    terminalState: capability('terminalState'),
  });
};

export const assertRuntimeHostCapabilitiesCompatible = (
  runtime: RuntimeHostCapabilities,
  adapter: RuntimeHostCapabilities,
): void => {
  const resolvedRuntime = resolveRuntimeHostCapabilities(runtime);
  const resolvedAdapter = resolveRuntimeHostCapabilities(adapter);
  const issues: string[] = [];
  if (resolvedRuntime.hostKind !== resolvedAdapter.hostKind) {
    issues.push(
      `runtimeHost=${resolvedRuntime.hostKind} adapterHost=${resolvedAdapter.hostKind}`,
    );
  }
  for (const lifecycle of RUNTIME_HOST_LIFECYCLES) {
    const expected = resolvedRuntime[lifecycle];
    const actual = resolvedAdapter[lifecycle];
    if (
      expected.owner !== actual.owner
      || expected.durability !== actual.durability
      || expected.schemaVersion !== actual.schemaVersion
    ) {
      issues.push(
        `lifecycle=${lifecycle} runtime=${expected.owner}/${expected.durability}/v${expected.schemaVersion} adapter=${actual.owner}/${actual.durability}/v${actual.schemaVersion}`,
      );
    }
  }
  if (issues.length > 0) throw new RuntimeHostCapabilityRegistrationError(issues);
};
