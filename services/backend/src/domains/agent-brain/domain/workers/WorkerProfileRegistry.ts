import type {
  SessionState,
  WorkerDependencyMode,
  WorkerTaskBudget,
  WorkerType,
} from '../types';
import { BUILTIN_WORKER_PROFILES } from './builtinWorkerProfiles';

export type WorkerProfile = {
  workerType: WorkerType;
  label: string;
  executionMode: Exclude<SessionState['executionMode'], undefined>;
  allowedTools: string[];
  defaultBudget: WorkerTaskBudget;
  maxBudget: WorkerTaskBudget;
  defaultArtifactType: string;
  systemGuidance: string[];
  useCases: string[];
  continueWhen: string;
  spawnFreshWhen: string;
  preferredDependencyMode: WorkerDependencyMode;
};

const normalizeAllowedTools = (allowedTools: string[]): string[] =>
  Array.from(
    new Set(
      allowedTools
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

const cloneProfile = (profile: WorkerProfile): WorkerProfile => ({
  ...profile,
  allowedTools: normalizeAllowedTools(profile.allowedTools),
  defaultBudget: { ...profile.defaultBudget },
  maxBudget: { ...profile.maxBudget },
  systemGuidance: [...profile.systemGuidance],
  useCases: [...profile.useCases],
});

type RegistrationOptions = {
  priority?: number;
  source?: string;
};

type RegisteredWorkerProfile = {
  profile: WorkerProfile;
  priority: number;
  source?: string;
};

export type WorkerProfileRegistryEntry = {
  profile: WorkerProfile;
  priority: number;
  source?: string;
};

export class WorkerProfileRegistry {
  private readonly profiles = new Map<WorkerType, RegisteredWorkerProfile>();

  register(profile: WorkerProfile, options: RegistrationOptions = {}): void {
    const priority = Number.isFinite(options.priority) ? Number(options.priority) : 0;
    const existing = this.profiles.get(profile.workerType);
    if (existing && existing.priority > priority) {
      return;
    }

    this.profiles.set(profile.workerType, {
      profile: cloneProfile(profile),
      priority,
      source: options.source,
    });
  }

  registerMany(profiles: WorkerProfile[], options: RegistrationOptions = {}): void {
    for (const profile of profiles) {
      this.register(profile, options);
    }
  }

  get(workerType: WorkerType): WorkerProfile | undefined {
    const profile = this.profiles.get(workerType)?.profile;
    return profile ? cloneProfile(profile) : undefined;
  }

  list(): WorkerProfile[] {
    return Array.from(this.profiles.values()).map((entry) => cloneProfile(entry.profile));
  }

  listEntries(): WorkerProfileRegistryEntry[] {
    return Array.from(this.profiles.values())
      .map((entry) => ({
        profile: cloneProfile(entry.profile),
        priority: entry.priority,
        source: entry.source,
      }))
      .sort((left, right) =>
        left.priority - right.priority ||
        left.profile.workerType.localeCompare(right.profile.workerType),
      );
  }

  getEntry(workerType: WorkerType): WorkerProfileRegistryEntry | undefined {
    const entry = this.profiles.get(workerType);
    if (!entry) {
      return undefined;
    }
    return {
      profile: cloneProfile(entry.profile),
      priority: entry.priority,
      source: entry.source,
    };
  }

  has(workerType: WorkerType): boolean {
    return this.profiles.has(workerType);
  }
}

const BUILTIN_WORKER_PROFILE_SOURCE = 'nullai-core-worker-profiles';
const BUILTIN_WORKER_PROFILE_PRIORITY = 10;

const workerProfileRegistryInstance = new WorkerProfileRegistry();
workerProfileRegistryInstance.registerMany(BUILTIN_WORKER_PROFILES, {
  priority: BUILTIN_WORKER_PROFILE_PRIORITY,
  source: BUILTIN_WORKER_PROFILE_SOURCE,
});

export const getWorkerProfileRegistry = (): WorkerProfileRegistry => workerProfileRegistryInstance;
