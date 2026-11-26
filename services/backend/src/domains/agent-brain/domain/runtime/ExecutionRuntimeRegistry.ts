import type { ModelConfig } from '../../ports/ModelConfigPort';
import { deterministicHash64 } from '../deterministicHash';
import type {
  ExecutionAccountingMode,
  ExecutionAccountingPolicy,
  ExecutionAuthMode,
  ExecutionBackendId,
  ModelExecutionResolverPort,
  ModelUnavailableReason,
} from '../../ports/modelExecution';

export const PLATFORM_API_ROUTE_ID = 'platform-api';

export type ExecutionControlValue = string | number | boolean;

/** Atomic, untrusted choice of a registered execution route. Absent, a session runs on Platform API. */
export interface ExecutionSelection {
  routeId: string;
  catalogueRevision: string;
  modelId: string;
  controls: Readonly<Record<string, ExecutionControlValue>>;
}

export interface ExecutionSelectionSubject {
  userId?: string;
  organizationId?: string | null;
}

export type ExecutionSelectionDefaultResolver = (
  subject: ExecutionSelectionSubject,
) => Promise<ExecutionSelection | undefined> | ExecutionSelection | undefined;

export interface ExecutionControlCapability {
  id: string;
  displayName: string;
  kind: 'enum' | 'boolean';
  required?: boolean;
  defaultValue?: ExecutionControlValue;
  options?: ReadonlyArray<{ id: string; displayName: string }>;
}

export interface ExecutionModelCapability {
  id: string;
  displayName: string;
  providerIdentity: string;
  /** Optional canonical platform model name when the runtime advertises a different alias. */
  pricingModelName?: string;
  isDefault?: boolean;
  retirementAt?: string;
  controls: ReadonlyArray<ExecutionControlCapability>;
}

export interface ExecutionRouteCapabilities {
  routeId: string;
  displayName: string;
  providerIdentity: string;
  executionBackend: string;
  authMode: string;
  accountingMode: string;
  catalogueRevision: string;
  models: ReadonlyArray<ExecutionModelCapability>;
}

export type RegisteredExecutionCapabilityResult =
  { routeId: string; capabilities: ExecutionRouteCapabilities } | { routeId: string; unavailableReason: string };

/** Immutable execution provenance pinned to a session at admission. */
export interface SessionExecutionProfileV1 {
  version: 1;
  routeId: string;
  catalogueRevision: string;
  providerIdentity: string;
  executionBackend: ExecutionBackendId;
  authMode: ExecutionAuthMode;
  accountingMode: ExecutionAccountingMode;
  consumesPlatformCredits: boolean;
  requiresPlatformCreditAdmission: boolean;
  requestedModel: string;
  effectiveModel: string;
  pricingModelId: string;
  controls: Readonly<Record<string, ExecutionControlValue>>;
  faultDomain: string;
}

export interface BoundExecutionSelection {
  resolver: ModelExecutionResolverPort;
  profile: Omit<SessionExecutionProfileV1, 'pricingModelId'>;
  /** Adapter-owned mapping from runtime model id to the platform pricing catalogue. */
  pricingModelName?: string;
}

/** Registered only at composition time, before the catalogue is observed. */
export interface ExecutionAdapterRegistration {
  readonly routeId: string;
  readCapabilities(): Promise<ExecutionRouteCapabilities>;
  bind(selection: ExecutionSelection): Promise<BoundExecutionSelection>;
  resolverFor(profile: SessionExecutionProfileV1): Promise<ModelExecutionResolverPort>;
  dispose?(): Promise<void>;
}

export class ExecutionRuntimeRegistrationError extends Error {
  readonly code = 'execution_runtime_registration_rejected';

  constructor(reason: string) {
    super(`Execution runtime registration rejected: ${reason}`);
    this.name = 'ExecutionRuntimeRegistrationError';
  }
}

export class ExecutionSelectionError extends Error {
  readonly code = 'execution_selection_rejected';

  constructor(reason: string) {
    super(`Execution selection rejected: ${reason}`);
    this.name = 'ExecutionSelectionError';
  }
}

export const apiUnavailableReason = (model: ModelConfig | null | undefined): ModelUnavailableReason | null => {
  if (!model) return { code: 'unknown_model', detail: 'Model not found in database' };
  if (model.isActive === false) {
    return {
      code: 'inactive',
      detail: `Model ${model.modelName} is not active`,
    };
  }
  const apiKey = typeof model.apiKey === 'string' ? model.apiKey.trim() : '';
  if (!apiKey && !model.runsOnOwnServer) {
    return {
      code: 'missing_api_key',
      detail: `Selected model ${model.modelName} is missing apiKey in database`,
    };
  }
  return null;
};

export const API_ACCOUNTING: ExecutionAccountingPolicy = {
  accountingMode: 'platform',
  consumesPlatformCredits: true,
  requiresPlatformCreditAdmission: true,
};

const registrations = new Map<string, ExecutionAdapterRegistration>();
let catalogueObserved = false;
let defaultSelectionResolver: ExecutionSelectionDefaultResolver | null = null;
let defaultSelectionResolverObserved = false;

/**
 * Optional composition-owned policy for session starts that have no request-scoped selection.
 * Production registers nothing and therefore remains byte-for-byte equivalent to Platform API.
 */
export const registerExecutionSelectionDefaultResolver = (
  resolver: ExecutionSelectionDefaultResolver,
): void => {
  if (defaultSelectionResolver === resolver) return;
  if (defaultSelectionResolver) {
    throw new ExecutionRuntimeRegistrationError('an execution selection default resolver is already registered');
  }
  if (defaultSelectionResolverObserved) {
    throw new ExecutionRuntimeRegistrationError(
      'the execution selection default has already been read; registration is composition-time only',
    );
  }
  defaultSelectionResolver = resolver;
};

export const resolveExecutionSelectionDefault = async (
  subject: ExecutionSelectionSubject,
): Promise<ExecutionSelection | undefined> => {
  defaultSelectionResolverObserved = true;
  if (!defaultSelectionResolver || !subject.userId || !subject.organizationId) return undefined;
  return defaultSelectionResolver(subject);
};

export const registerExecutionAdapter = (registration: ExecutionAdapterRegistration): void => {
  if (!registration.routeId || registration.routeId === PLATFORM_API_ROUTE_ID) {
    throw new ExecutionRuntimeRegistrationError(
      registration.routeId === PLATFORM_API_ROUTE_ID
        ? `"${PLATFORM_API_ROUTE_ID}" is reserved for the built-in API route`
        : 'routeId is required',
    );
  }
  const existing = registrations.get(registration.routeId);
  if (existing === registration) return;
  if (existing) {
    throw new ExecutionRuntimeRegistrationError(`route "${registration.routeId}" is already registered`);
  }
  if (catalogueObserved) {
    throw new ExecutionRuntimeRegistrationError(
      'the adapter catalogue has already been observed; registrations are composition-time only',
    );
  }
  registrations.set(registration.routeId, registration);
};

export const listRegisteredExecutionCapabilities = async (): Promise<ExecutionRouteCapabilities[]> => {
  catalogueObserved = true;
  return Promise.all([...registrations.values()].map((registration) => registration.readCapabilities()));
};

/**
 * Discovery is best effort per route: one unavailable external runtime must not hide the routes
 * that are healthy.
 */
export const inspectRegisteredExecutionCapabilities = async (): Promise<RegisteredExecutionCapabilityResult[]> => {
  catalogueObserved = true;
  return Promise.all(
    [...registrations.values()].map(async (registration) => {
      try {
        return {
          routeId: registration.routeId,
          capabilities: await registration.readCapabilities(),
        } satisfies RegisteredExecutionCapabilityResult;
      } catch (error) {
        return {
          routeId: registration.routeId,
          unavailableReason: error instanceof Error ? error.message : 'Capability discovery failed',
        } satisfies RegisteredExecutionCapabilityResult;
      }
    }),
  );
};

const registrationFor = (routeId: string): ExecutionAdapterRegistration => {
  catalogueObserved = true;
  const registration = registrations.get(routeId);
  if (!registration) throw new ExecutionSelectionError(`route "${routeId}" is not registered`);
  return registration;
};

export const bindExecutionSelection = async (selection: ExecutionSelection): Promise<BoundExecutionSelection> =>
  registrationFor(selection.routeId).bind(selection);

export const executionResolverForProfile = async (
  profile: SessionExecutionProfileV1 | undefined,
  apiResolver: ModelExecutionResolverPort,
): Promise<ModelExecutionResolverPort> => {
  if (!profile || profile.routeId === PLATFORM_API_ROUTE_ID) return apiResolver;
  return registrationFor(profile.routeId).resolverFor(profile);
};

export const readSessionExecutionProfile = (
  flags: Record<string, unknown> | null | undefined,
): SessionExecutionProfileV1 | undefined => {
  const value = flags?.execution_profile;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionSelectionError('persisted session execution profile is malformed');
  }
  const profile = value as Partial<SessionExecutionProfileV1>;
  const controlsAreValid =
    profile.controls &&
    typeof profile.controls === 'object' &&
    !Array.isArray(profile.controls) &&
    Object.entries(profile.controls).every(
      ([key, control]) =>
        key.trim().length > 0 &&
        (typeof control === 'string' ||
          typeof control === 'boolean' ||
          (typeof control === 'number' && Number.isFinite(control))),
    );
  if (
    profile.version !== 1 ||
    typeof profile.routeId !== 'string' || !profile.routeId.trim() ||
    typeof profile.catalogueRevision !== 'string' || !profile.catalogueRevision.trim() ||
    typeof profile.providerIdentity !== 'string' || !profile.providerIdentity.trim() ||
    typeof profile.executionBackend !== 'string' || !profile.executionBackend.trim() ||
    typeof profile.authMode !== 'string' || !profile.authMode.trim() ||
    typeof profile.accountingMode !== 'string' || !profile.accountingMode.trim() ||
    typeof profile.consumesPlatformCredits !== 'boolean' ||
    typeof profile.requiresPlatformCreditAdmission !== 'boolean' ||
    typeof profile.requestedModel !== 'string' || !profile.requestedModel.trim() ||
    typeof profile.effectiveModel !== 'string' || !profile.effectiveModel.trim() ||
    typeof profile.pricingModelId !== 'string' || !profile.pricingModelId.trim() ||
    !controlsAreValid ||
    typeof profile.faultDomain !== 'string' || !profile.faultDomain.trim()
  ) {
    throw new ExecutionSelectionError('persisted session execution profile is malformed or unsupported');
  }
  return Object.freeze({
    ...(profile as SessionExecutionProfileV1),
    controls: Object.freeze({ ...profile.controls }),
  });
};

export const executionProfileFingerprint = (input: Omit<ExecutionRouteCapabilities, 'catalogueRevision'>): string =>
  deterministicHash64(JSON.stringify(input));

// Process-wide runtime seam, read by OrchestratorAdapter and ModelRuntime: one resolver registered
// here answers every session in the process. Per-session routing uses the adapter catalogue above;
// absence always means Platform API.
let legacyRegistered: ModelExecutionResolverPort | null = null;
let legacyObserved = false;

export const registerExecutionRuntime = (resolver: ModelExecutionResolverPort): void => {
  if (legacyRegistered === resolver) return;
  if (legacyRegistered) {
    throw new ExecutionRuntimeRegistrationError(
      `already registered as "${legacyRegistered.backend}"; a process runs on one runtime`,
    );
  }
  if (legacyObserved) {
    throw new ExecutionRuntimeRegistrationError(
      'the runtime has already been read by this process; registering now would change execution',
    );
  }
  legacyRegistered = resolver;
};

export const registeredExecutionRuntime = (): ModelExecutionResolverPort | null => {
  legacyObserved = true;
  return legacyRegistered;
};

export const executionUnavailableReason = (model: ModelConfig | null | undefined): ModelUnavailableReason | null => {
  const runtime = registeredExecutionRuntime();
  return runtime ? runtime.unavailableReason(model) : apiUnavailableReason(model);
};

export const executionAccountingPolicy = (): ExecutionAccountingPolicy =>
  registeredExecutionRuntime()?.accountingPolicy() ?? API_ACCOUNTING;

export const executionEffectiveModelName = (): string | null =>
  registeredExecutionRuntime()?.effectiveModelName?.() ?? null;

export const __resetExecutionRuntimeForTests = (): void => {
  legacyRegistered = null;
  legacyObserved = false;
  registrations.clear();
  catalogueObserved = false;
  defaultSelectionResolver = null;
  defaultSelectionResolverObserved = false;
};
