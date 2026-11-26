/**
 * Product-neutral host contract for the shared NullSquare agent engine.
 *
 * The organizational product and Research Lab own different persistence and
 * scope adapters, but they must launch and observe the same engine. This file
 * intentionally contains no Research Lab execution loop.
 */
import { getWorkerProfileRegistry } from '@/domains/agent-brain/domain/workers/WorkerProfileRegistry';
import {
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import {
  SkillLoader,
  type SkillSourceMode,
} from '@/domains/security-ops/skills/SkillLoader';

export type AgentRunHostKind = 'organization' | 'research_lab';
export type AgentRunProfile =
  | 'repository_research'
  | 'pentest'
  | 'compliance'
  | 'code_review';
export type AgentRunProfileAvailability =
  | 'unavailable'
  | 'preview'
  | 'supported'
  | 'default';
export type AgentRunEngineIntegration =
  | 'transitional_executor'
  | 'shared_pipeline';

/**
 * Which question a host must answer before it may run metered work.
 *
 * `target_ownership` asks "have you proven you own this target?" — the right
 * question when an agent acts against a live third-party host, and the only
 * model that existed before. It resolves through `scope_targets`.
 *
 * `pinned_source_review` covers read-only review of public source at a fixed
 * commit. There is no live target, so no ownership can exist to prove, and
 * demanding a verified `scope_targets` row would force a host to write a
 * verification it does not hold. It carries its own conditions instead — see
 * `evaluatePinnedSourceReview`.
 *
 * Hosts that say nothing get `target_ownership`. A new host cannot opt out of
 * authorization by omission.
 */
export type RunAuthorizationModel = 'target_ownership' | 'pinned_source_review';

/**
 * Which figure a run's USD budget is measured against.
 *
 * `platform` is the customer-facing price: provider cost plus overhead, grossed
 * up by margin. It is what a paying organization is billed, and stays the
 * default so product behaviour is unchanged.
 *
 * `native` is the provider cost alone. Internal labs spend against real API
 * cost — a margin charged to ourselves only obscures what a run actually costs,
 * and makes an internal budget mean something different from the invoice it is
 * meant to approximate.
 */
export type RunCostBasis = 'platform' | 'native';

export type AgentRunHostContext = {
  host: AgentRunHostKind;
  workspaceId: string;
  /** Defaults to `target_ownership` when absent. */
  authorizationModel?: RunAuthorizationModel;
  /** Defaults to `platform` when absent, so billed products are unchanged. */
  costBasis?: RunCostBasis;
  objective: string;
  modelName: string;
  runProfile: AgentRunProfile;
  sourceMode: SkillSourceMode;
  repository?: {
    url: string;
    ref: string;
    commit: string;
    localPath: string;
    /**
     * Provider-style `owner/name`. Required by the Code Review profile so the
     * hosted run can build the same typed immutable context the organization
     * product builds from a connected repository.
     */
    fullName?: string;
    defaultBranch?: string;
    visibility?: 'private' | 'public' | 'internal' | 'unknown';
  };
  findingIds?: string[];
  frameworkIds?: string[];
  budget: {
    maxWallSeconds: number;
    maxModelRequests?: number;
    maxUsd?: number;
  };
};

export type AgentRunHandle = {
  runId: string;
  integration: 'shared_pipeline';
};

export type AgentRunEvent = {
  type: string;
  at: string;
  runId: string;
  phaseKey?: RunPhaseKey;
  sessionId?: string;
  workerTaskId?: string;
  data?: Record<string, unknown>;
};

export type AgentRunEventSink = (event: AgentRunEvent) => Promise<void> | void;

/**
 * This is the boundary that the current DB-coupled StartRunService must
 * implement after its organization-specific persistence dependencies become
 * ports. Product hosts depend on this contract, never on a copied run service.
 */
export interface AgentRunHost {
  start(context: AgentRunHostContext, events: AgentRunEventSink): Promise<AgentRunHandle>;
  pause(runId: string, reason?: string): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
  recover(context: AgentRunHostContext, events: AgentRunEventSink): Promise<AgentRunHandle>;
}

export type AgentRunHostCapabilities = {
  schemaVersion: 1;
  engine: 'nullsquare-shared-agent-engine';
  hostBoundary: {
    launchAvailable: boolean;
    blocker?: string;
  };
  profiles: Array<{
    key: AgentRunProfile;
    label: string;
    availability: AgentRunProfileAvailability;
    selectable: boolean;
    reason: string;
  }>;
  phases: Array<{
    key: RunPhaseKey;
    promptProfile: string;
    toolProfile: string;
    allowedTools: string[];
    workerSpawning: boolean;
    allowedWorkerTypes: string[];
    handoffSchema: string;
  }>;
  workers: Array<{
    type: string;
    label: string;
    executionMode: string;
    allowedTools: string[];
    defaultArtifactType: string;
  }>;
  skills: {
    catalogVersion: string;
    activeCount: number;
    whiteboxCount: number;
    byPhase: Partial<Record<RunPhaseKey, number>>;
  };
  legacy: {
    integration: 'transitional_executor';
    available: true;
    description: string;
  };
};

const PROFILE_CAPABILITIES: AgentRunHostCapabilities['profiles'] = [
  {
    key: 'repository_research',
    label: 'Repository Research (legacy)',
    availability: 'preview',
    selectable: true,
    reason: 'Transitional Pentest-shaped route over recon/enumeration/validation/reporting. Retained for existing projects; new projects should use Code Review.',
  },
  {
    key: 'pentest',
    label: 'Pentest',
    availability: 'unavailable',
    selectable: false,
    reason: 'The shared pentest pipeline has not passed repository-context acceptance.',
  },
  {
    key: 'compliance',
    label: 'Compliance',
    availability: 'unavailable',
    selectable: false,
    reason: 'The shared compliance pipeline has not passed repository-context acceptance.',
  },
  {
    key: 'code_review',
    label: 'Code Review',
    availability: 'preview',
    selectable: true,
    reason: 'Runs the standalone Code Review discipline, phase graph, prompts, skills, proof contract, and revision-compatible repository memory against a pinned local clone through the hosted persistence port.',
  },
];

/**
 * Capability discovery is projected directly from the canonical phase, worker,
 * and skill registries. The Lab can display the real engine surface without
 * maintaining a second catalog.
 */
export const getAgentRunHostCapabilities = async (): Promise<AgentRunHostCapabilities> => {
  const skillLoader = new SkillLoader();
  const [skills, manifest] = await Promise.all([
    skillLoader.loadSkillCatalog(),
    skillLoader.getCatalogManifest(),
  ]);
  const byPhase: Partial<Record<RunPhaseKey, number>> = {};
  for (const skill of skills) {
    const phases = skill.compatiblePhases.length > 0
      ? skill.compatiblePhases
      : [skill.phase];
    for (const phase of phases) {
      if (!phaseProfileRegistry.list().some((profile) => profile.phaseKey === phase)) {
        continue;
      }
      const phaseKey = phase as RunPhaseKey;
      byPhase[phaseKey] = (byPhase[phaseKey] ?? 0) + 1;
    }
  }

  return {
    schemaVersion: 1,
    engine: 'nullsquare-shared-agent-engine',
    hostBoundary: {
      launchAvailable: true,
    },
    profiles: PROFILE_CAPABILITIES.map((profile) => ({ ...profile })),
    phases: phaseProfileRegistry.list().map((profile) => ({
      key: profile.phaseKey,
      promptProfile: profile.promptProfile,
      toolProfile: profile.toolProfile,
      allowedTools: [
        ...(phaseProfileRegistry.buildToolPolicy(profile.phaseKey, {
          whiteboxEnabled: true,
          connectedRepoCount: 1,
        }).allow ?? []),
      ],
      workerSpawning: profile.workerSpawning.allowed,
      allowedWorkerTypes: [...profile.workerSpawning.allowedWorkerTypes],
      handoffSchema: profile.handoffSchema,
    })),
    workers: getWorkerProfileRegistry().list().map((profile) => ({
      type: profile.workerType,
      label: profile.label,
      executionMode: profile.executionMode,
      allowedTools: [...profile.allowedTools],
      defaultArtifactType: profile.defaultArtifactType,
    })),
    skills: {
      catalogVersion: manifest.catalogVersion,
      activeCount: skills.length,
      whiteboxCount: skills.filter((skill) => skill.sourceModes.includes('whitebox')).length,
      byPhase,
    },
    legacy: {
      integration: 'transitional_executor',
      available: true,
      description: 'Legacy direct executor retained only for existing jobs; new project runs use the shared pipeline.',
    },
  };
};
