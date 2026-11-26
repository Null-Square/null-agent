import type { RunPhaseRow, RunRow, RunnerRow, RunTrigger, RunWorkflowDiscipline } from '@/db/schema';
import type { AgentApiServices } from '@/app/services/agent/types';
import { MemoryManager } from '@/domains/agent-brain/domain/helpers/MemoryManager';
import type { Message, MessageSource } from '@/domains/agent-brain/domain/types';
import { createTimelineEntry } from '@/domains/agent-brain/application/orchestration/utils/timelineEntries';
import type { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { logger } from '@/shared/logger';
import { AppError, ERROR_CODES, toAppError } from '@/shared/errors';
import * as fs from 'fs/promises';
import * as path from 'path';

import { resolvePolicyForRunnerType, type RunService } from './RunService';
import { normalizeExecutionTarget, type ExecutionTarget } from './executionTargets';
import {
  normalizePhaseKey,
  phaseProfileRegistry,
  type RunPhaseKey,
} from './PhaseProfileRegistry';
import {
  CODE_REVIEW_PLANNER_KICKOFF_PROMPT,
  COMPLIANCE_PLANNER_KICKOFF_PROMPT,
  EXPOSURE_VERIFICATION_KICKOFF_PROMPT,
  PLANNER_KICKOFF_PROMPT,
  normalizeSkillSlug,
  runtimeSkillLoader,
  uniqueSkillSlugs,
  type PhaseCheckpointPayload,
  type PhaseHandoffPayload,
} from './StartRunPromptHelpers';

type RunStartRunnerSummary = Pick<RunnerRow, 'id' | 'name' | 'type' | 'status'>;

export const resolvePlannerKickoffPrompt = (
  workflowDiscipline: unknown,
  trigger?: RunTrigger,
): string => {
  if (trigger === 'exposure_verification') {
    return EXPOSURE_VERIFICATION_KICKOFF_PROMPT;
  }
  switch (workflowDiscipline) {
    case undefined:
    case 'pentest':
      return PLANNER_KICKOFF_PROMPT;
    case 'compliance':
      return COMPLIANCE_PLANNER_KICKOFF_PROMPT;
    case 'code_review':
      return CODE_REVIEW_PLANNER_KICKOFF_PROMPT;
    default:
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'Unknown workflow discipline cannot fall back to the Pentest planner',
      );
  }
};

export type StartPlannerRunReplayResult = {
  run: RunRow;
  sessionId: string | null;
  policySlug: string;
  warnings: [];
  runner: RunStartRunnerSummary | null;
  runnerName: string | null;
  idempotentReplay: true;
};

export type StartRunRuntimeServiceDeps = {
  runService: RunService;
  runnerService: RunnerService;
  agentServices: Pick<AgentApiServices, 'sessionStore' | 'orchestrator'>;
};

export class StartRunRuntimeService {
  constructor(private readonly deps: StartRunRuntimeServiceDeps) {}

  async kickoffPlanner(
    runId: string,
    sessionId: string,
    options: {
      workflowDiscipline?: RunWorkflowDiscipline;
      trigger?: RunTrigger;
    },
  ): Promise<void> {
    await this.scheduleKickoff(
      runId,
      sessionId,
      resolvePlannerKickoffPrompt(options.workflowDiscipline, options.trigger),
      'planner_kickoff',
    );
  }

  async kickoffExecutor(runId: string, sessionId: string, kickoffPrompt: string): Promise<void> {
    await this.scheduleKickoff(runId, sessionId, kickoffPrompt, 'executor_kickoff');
  }

  private async scheduleKickoff(
    runId: string,
    sessionId: string,
    prompt: string,
    source: Extract<MessageSource, 'planner_kickoff' | 'executor_kickoff'>,
  ): Promise<void> {
    const session =
      (await this.deps.agentServices.sessionStore.getOrHydrate?.(sessionId)) ??
      this.deps.agentServices.sessionStore.get?.(sessionId);

    const message: Message = {
      id: `run-kickoff:${runId}:${sessionId}`,
      role: 'user',
      content: prompt,
      // The stable session creation time makes concurrent repair attempts the
      // same idempotent journal command, not conflicting copies.
      timestamp: session?.createdAt ?? 0,
      metadata: {
        visibility: 'internal',
        source,
      },
    };
    const scheduled = await this.deps.agentServices.sessionStore
      .recordInternalContinuationInputAsync?.(sessionId, message) ?? false;
    if (scheduled) return;

    // Focused tests and intentionally embedded runtimes can omit the journal.
    // Product runtimes always take the durable branch above.
    await this.deps.agentServices.orchestrator.processMessage(
      sessionId,
      prompt,
      undefined,
      undefined,
      message.metadata,
    );
  }

  async recordExecutionEnvironmentTimeline(
    sessionId: string,
    executionTarget: ExecutionTarget,
    runnerName: string | null,
  ): Promise<void> {
    const normalizedTarget = normalizeExecutionTarget(executionTarget);
    const title =
      normalizedTarget === 'scope_runner'
        ? 'Execution pinned to private runner'
        : 'Execution pinned to cloud';
    const detail =
      normalizedTarget === 'scope_runner'
        ? `Network-originating activity for this run executes from ${runnerName ?? 'the pinned private runner'} inside the organization network. Authorization still follows the scope targets and Rules of Engagement.`
        : 'Network-originating activity for this run executes from the cloud-managed environment.';

    await this.deps.agentServices.sessionStore.recordTimelineEntryAsync(
      sessionId,
      createTimelineEntry({
        sessionId,
        kind: 'context',
        status: 'success',
        title,
        detail,
        source: 'securityops',
        importance: 'high',
        replaceKey: 'execution-environment',
        metadata: {
          executionTarget: normalizedTarget,
          ...(runnerName ? { runnerName } : {}),
        },
      }),
    );
  }

  async buildReplayResult(run: RunRow, policySlug: string): Promise<StartPlannerRunReplayResult> {
    const runner = run.runnerId
      ? await this.deps.runnerService
          .getRunner(run.organizationId, run.runnerId)
          .then((detail) => ({
            id: detail.id,
            name: detail.name,
            type: detail.type,
            status: detail.status,
          }))
          .catch(() => null)
      : null;

    return {
      run,
      sessionId: run.sessionId,
      policySlug,
      warnings: [],
      runner,
      runnerName: runner?.name ?? null,
      idempotentReplay: true,
    };
  }

  async resolvePolicySlugForRunner(orgId: string, runnerId: string | null | undefined): Promise<string> {
    if (!runnerId) {
      return resolvePolicyForRunnerType(null);
    }

    const runnerType = await this.deps.runnerService
      .getRunner(orgId, runnerId)
      .then((runner) => runner.type)
      .catch(() => null);

    return resolvePolicyForRunnerType(runnerType);
  }

  async seedExecutorMemoryFromStrategicNotes(
    sessionId: string,
    orgId: string,
    scopeId: string,
  ): Promise<void> {
    try {
      const notes = await this.deps.runService.getStrategicNotesForMemorySeed(orgId, scopeId);
      if (notes.length === 0) {
        return;
      }

      const seededMemory = MemoryManager.seedFromNotes(notes);
      const stats = MemoryManager.getStats(seededMemory);
      if (stats.attemptsCount === 0 && stats.failuresCount === 0 && stats.endpointsCount === 0) {
        return;
      }

      await this.deps.agentServices.sessionStore.setMemoryAsync(
        sessionId,
        seededMemory as unknown as Record<string, unknown>,
      );
      logger.info(
        { sessionId, orgId, scopeId, attempts: stats.attemptsCount, failures: stats.failuresCount },
        '[runs] Seeded executor memory from strategic notes',
      );
    } catch (error) {
      const err = toAppError(error);
      logger.warn(
        { err, sessionId, orgId, scopeId },
        '[runs] Failed to seed executor memory from strategic notes',
      );
    }
  }

  async readPhaseHandoffPayload(
    workspaceDir: string | null | undefined,
    handoffRef: string | null | undefined,
  ): Promise<PhaseHandoffPayload | null> {
    return this.readPhaseArtifactPayload<PhaseHandoffPayload>(
      workspaceDir,
      handoffRef,
      '.artifacts/phase-handoffs/',
    );
  }

  async readPhaseCheckpointPayload(
    workspaceDir: string | null | undefined,
    checkpointRef: string | null | undefined,
  ): Promise<PhaseCheckpointPayload | null> {
    return this.readPhaseArtifactPayload<PhaseCheckpointPayload>(
      workspaceDir,
      checkpointRef,
      '.artifacts/phase-checkpoints/',
    );
  }

  async reconcileRecommendedSkillsForPhase(
    phase: Pick<RunPhaseRow, 'id' | 'runId' | 'phaseKey' | 'assignedSkillSlugs'>,
    handoffPayload: PhaseHandoffPayload | null,
  ): Promise<string[]> {
    const baseSkills = uniqueSkillSlugs(phase.assignedSkillSlugs ?? []);
    const recommendedRaw = Array.isArray(handoffPayload?.recommendedNextSkills)
      ? handoffPayload.recommendedNextSkills
      : [];
    const recommended = uniqueSkillSlugs(
      recommendedRaw.filter((value): value is string => typeof value === 'string'),
    );
    if (recommended.length === 0) {
      return baseSkills;
    }

    const recommendedPhase = normalizePhaseKey(handoffPayload?.recommendedNextPhase);
    if (recommendedPhase && recommendedPhase !== phase.phaseKey) {
      await this.recordRecommendedSkillReconciliation(phase, {
        accepted: [],
        rejected: recommended,
        injected: [],
        replanned: false,
        reason: `recommendedNextPhase ${recommendedPhase} did not match phase ${phase.phaseKey}`,
      });
      return baseSkills;
    }

    const catalog = await runtimeSkillLoader.loadSkillCatalog();
    const catalogBySlug = new Map(catalog.map((skill) => [normalizeSkillSlug(skill.slug), skill]));
    const compatible = recommended.filter((slug) => {
      const skill = catalogBySlug.get(slug);
      return skill ? phaseProfileRegistry.validateSkillAssignment(phase.phaseKey as RunPhaseKey, skill) === null : false;
    });
    const rejected = recommended.filter((slug) => !compatible.includes(slug));
    const merged = uniqueSkillSlugs([...baseSkills, ...compatible]);
    const injected = compatible.filter((slug) => !baseSkills.includes(slug));
    if (merged.length !== baseSkills.length || merged.some((slug, index) => slug !== baseSkills[index])) {
      await this.deps.runService.updatePhaseAssignedSkills(phase.id, merged).catch((error) => {
        logger.warn(
          { err: error, phaseId: phase.id, phaseKey: phase.phaseKey, recommended },
          '[runs] Failed to persist reconciled phase skill slugs',
        );
      });
    }
    await this.recordRecommendedSkillReconciliation(phase, {
      accepted: compatible,
      rejected,
      injected,
      replanned: false,
    });

    return merged;
  }

  async buildPriorPhaseArtifactManifest(
    workspaceDir: string | null | undefined,
    phaseKey: string | null | undefined,
  ): Promise<string[]> {
    if (!workspaceDir || !phaseKey) {
      return [];
    }

    const root = path.resolve(workspaceDir, '.artifacts', 'phases', phaseKey);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      return [];
    }

    const supportedPattern =
      /\.(?:json|jsonl|ya?ml|txt|md|html|har|png|jpe?g|webp|log|xml)$/iu;
    const entries: Array<{ relativePath: string; size: number; kind: string }> = [];
    const walk = async (current: string): Promise<void> => {
      const children = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        const absolute = path.join(current, child.name);
        if (child.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!child.isFile() || !supportedPattern.test(child.name)) {
          continue;
        }
        const childStat = await fs.stat(absolute).catch(() => null);
        if (!childStat?.isFile()) {
          continue;
        }
        const relative = path.relative(workspaceDir, absolute).replace(/\\/g, '/');
        const lower = child.name.toLowerCase();
        const kind =
          lower.includes('openapi') || lower.includes('swagger') || lower.includes('catalogue')
            ? 'api-catalogue'
            : lower.includes('ffuf')
              ? 'ffuf'
              : lower.includes('nuclei')
                ? 'nuclei'
                : lower.includes('katana')
                  ? 'katana'
                  : lower.includes('httpx')
                    ? 'httpx'
                    : lower.includes('naabu')
                      ? 'naabu'
                      : 'artifact';
        entries.push({
          relativePath: `/workspace/${relative}`,
          size: childStat.size,
          kind,
        });
      }
    };

    await walk(root);
    return entries
      .sort((left, right) => {
        const priority = (kind: string): number =>
          kind === 'api-catalogue' ? 0 : kind === 'ffuf' ? 1 : kind === 'httpx' ? 2 : 3;
        return priority(left.kind) - priority(right.kind) || left.relativePath.localeCompare(right.relativePath);
      })
      .slice(0, 30)
      .map((entry) => `- ${entry.relativePath}\n  type: ${entry.kind}, size: ${entry.size}`);
  }

  private async recordRecommendedSkillReconciliation(
    phase: Pick<RunPhaseRow, 'id' | 'runId' | 'phaseKey'>,
    event: {
      accepted: string[];
      rejected: string[];
      injected: string[];
      replanned: boolean;
      reason?: string;
    },
  ): Promise<void> {
    await this.deps.runService.recordPhaseHandoffReconciliation({
      runId: phase.runId,
      phaseId: phase.id,
      phaseKey: phase.phaseKey,
      ...event,
    }).catch((error) => {
      logger.warn(
        { err: error, runId: phase.runId, phaseId: phase.id, phaseKey: phase.phaseKey },
        '[runs] Failed to record phase handoff skill reconciliation',
      );
    });
  }

  private async readPhaseArtifactPayload<T extends object>(
    workspaceDir: string | null | undefined,
    artifactRef: string | null | undefined,
    expectedRoot: '.artifacts/phase-handoffs/' | '.artifacts/phase-checkpoints/',
  ): Promise<T | null> {
    if (!workspaceDir || !artifactRef) {
      return null;
    }

    const normalizedRef = artifactRef.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedRef.startsWith(expectedRoot)) {
      return null;
    }

    try {
      const raw = await fs.readFile(path.resolve(workspaceDir, normalizedRef), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as T
        : null;
    } catch {
      return null;
    }
  }
}
