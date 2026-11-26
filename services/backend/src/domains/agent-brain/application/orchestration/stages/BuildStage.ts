/**
 * BuildStage - Build LLM prompt with context, history, and tools
 * @module agent-brain/application/orchestration/stages/BuildStage
 */

import type OpenAI from 'openai';
import { logger } from '@/shared/logger';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { joinFsPath, readTextFile } from '../../../adapters/workspace/WorkspaceFsAdapter';
import { MessageValidator } from '../../services/MessageValidator';
import type { ContextBlocks, Message } from '../../../domain/types';
import type { PromptBuild } from '../../../ports';
import type {
  BuildStage,
  BuildPromptArgs,
  BuildPromptResult,
} from './types';
import { sanitizeForLLM } from './helpers/MessageSanitizer';
import { trimHistoryHeadTail } from './helpers/HistoryTrimmer';
import { estimateContentTokens, estimateTextTokens, estimateTokens, safeStringify } from './helpers/messageUtils';
import { microcompactToolResults } from './helpers/ToolResultMicrocompactor';
import {
  describePrefixDivergence,
  diffPrefixSections,
  digestPrefixSections,
  type PrefixSectionDigest,
} from '../services/prefixDivergence';
import { TOOL_RESULT_POLICY_VERSION } from '../tool-results/ToolResultPolicy';
import {
  buildCompactionInstruction,
  extractCompactionCategoryCounts,
  getCompactionPolicy,
  normalizeCompactionSummary,
  summarizeCompactionCounts,
  type RunCompactionProfile,
} from './helpers/CompactionSummary';
import { ToolPolicyChecker } from '../../tools/ToolPolicyChecker';
import {
  evaluateDelegationActivation,
  parseAssignedSkillsFromExtraContext,
  renderDelegationActivationGuidance,
} from '../../../domain/workers/delegationActivation';
import {
  getWorkerTemplate,
  resolveOpeningWaveConcurrency,
  resolveRootReportingReserveToolCalls,
  resolveWorkerMaxToolCalls,
} from '../../../domain/workers/workerContracts';
import { getEnumerationWorkerAdmissionState } from '@/domains/security-ops/runs/enumerationCapability';
import { EnumerationWorkerSkillResolver } from '@/domains/security-ops/skills/EnumerationWorkerSkillResolver';
import {
  buildContextMeasurement,
  toContextMeasurementSnapshot,
  type ContextMeasurement,
} from '../../../domain/context';
import {
  createHistoryTransformationId,
  HISTORY_TRANSFORMATION_SCHEMA_VERSION,
  type HistoryTransformationRecord,
} from '../../../ports/HistoryTransformationPort';
import { sha256Hex } from '../../../domain/workers/sha256';

const pipelineLogger = logger.child({ scope: 'OrchestratorPipeline' });
const SYSTEM_PROMPT_RESERVE = 4_000;
const HISTORY_RATIO = 0.7;
/** Mirrors `buildContextMeasurement`'s soft threshold, so the two authorities can be ordered. */
const CONTEXT_SOFT_RATIO = 0.7;
/**
 * How far the trimmer's cap sits above compaction's soft threshold. Small on purpose: enough
 * that compaction is always reached first, not so much that the trimmer stops protecting the
 * provider limit.
 */
const TRIM_HEADROOM_OVER_COMPACTION = 1.05;
const HEAD_SOFT_CAP_TOKENS = 16_000;
const PROMPT_EFFECTIVE_WINDOW_RATIO = 0.9;
const MIN_EXECUTION_SPACE_FLOOR_TOKENS = 2_000;
const MIN_EXECUTION_SPACE_RATIO = 0.05;
const MAX_COMPACTION_FAILURES = 3;
const DELEGATION_ACTIVATION_GUIDANCE_FLAG = 'delegationActivationGuidance';
const WORKER_SPAWNING_AVAILABLE_FLAG = 'workerSpawningAvailable';
const WORKSPACE_MODEL_RECITATION_FLAG = 'workspaceProjectionModelRecitation';
const WORKSPACE_PROJECTION_WARNING_FLAG = 'workspaceProjectionWarning';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveRunCompactionProfile = (
  session: BuildPromptArgs['session'],
): RunCompactionProfile => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : {};
  if (securityops.runTrigger === 'exposure_verification') return 'exposure_verification';
  if (typeof securityops.findingDispositionVerificationId === 'string') return 'finding_disposition';
  if (securityops.workflowDiscipline === 'compliance') return 'compliance';
  if (securityops.workflowDiscipline === 'code_review') return 'code_review';
  return 'pentest';
};

const estimateMessagesTokens = (messages: Message[]): number =>
  messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

const estimateToolResultTokens = (messages: Message[]): number =>
  messages.reduce((sum, msg) => sum + (msg.role === 'tool' ? estimateTokens(msg) : 0), 0);

const readJsonRecord = (content: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const buildToolNameByCallId = (messages: Message[]): Map<string, string> => {
  const toolNameByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (typeof call.id === 'string' && typeof call.function?.name === 'string') {
        toolNameByCallId.set(call.id, call.function.name);
      }
    }
  }
  return toolNameByCallId;
};

const estimateToolResultTokensByTool = (messages: Message[]): Record<string, number> => {
  const toolNameByCallId = buildToolNameByCallId(messages);
  const totals: Record<string, number> = {};
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const toolName =
      message.toolName ??
      (message.toolCallId ? toolNameByCallId.get(message.toolCallId) : undefined) ??
      (message.tool_call_id ? toolNameByCallId.get(message.tool_call_id) : undefined) ??
      'unknown';
    totals[toolName] = (totals[toolName] ?? 0) + estimateTokens(message);
  }
  return totals;
};

const estimatePersistedToolResultStats = (
  messages: Message[],
): { count: number; savedTokens: number } => {
  let count = 0;
  let savedTokens = 0;
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const payload = readJsonRecord(message.content);
    if (payload?.status !== 'tool_result_persisted') continue;
    count += 1;
    const policy = isRecord(payload.policy) ? payload.policy : undefined;
    const saved = typeof policy?.savedApproxTokens === 'number' ? policy.savedApproxTokens : 0;
    savedTokens += Number.isFinite(saved) ? saved : 0;
  }
  return { count, savedTokens };
};

const estimateToolSchemaTokens = (tools: unknown[]): number =>
  estimateContentTokens(safeStringify(tools));

const loadWorkspaceModelRecitation = async (session: BuildPromptArgs['session']): Promise<string | null> => {
  if (!session.workspaceDir) {
    return null;
  }
  const flags = isRecord(session.flags) ? session.flags : undefined;
  const securityops = isRecord(flags?.securityops) ? flags.securityops : undefined;
  if (!securityops?.runId) {
    return null;
  }

  const modelPath = joinFsPath(session.workspaceDir, 'journal', 'model.md');
  try {
    const content = await readTextFile(modelPath);
    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length <= 12_000
      ? trimmed
      : `${trimmed.slice(0, 12_000)}\n\n[truncated: read /workspace/journal/model.md for the full projected model]`;
  } catch {
    return null;
  }
};

const getCompactionFailureState = (
  flags: Record<string, unknown> | undefined,
): { consecutive: number; disabled: boolean } => {
  const raw = isRecord(flags?.compaction_failures) ? flags.compaction_failures : {};
  return {
    consecutive:
      typeof raw.consecutive === 'number' && Number.isFinite(raw.consecutive)
        ? Math.max(0, Math.floor(raw.consecutive))
        : 0,
    disabled: raw.disabled === true,
  };
};

function adjustStartForToolBoundary(messages: Message[], startIndex: number): number {
  let adjusted = Math.max(0, Math.min(startIndex, messages.length));
  while (adjusted > 0 && adjusted < messages.length && messages[adjusted]?.role === 'tool') {
    adjusted--;
  }
  return adjusted;
}

class InjectedHistoryTransformationFault extends Error {
  readonly cause: unknown;

  constructor(
    readonly point: 'after_prepare' | 'after_replacement_persisted_before_activation' | 'after_activation',
    readonly transactionId: string,
    cause: unknown,
  ) {
    super(`history_transformation_fault:${point}:${transactionId}`);
    this.name = 'InjectedHistoryTransformationFault';
    this.cause = cause;
  }
}

const messageIndexAfterId = (messages: Message[], messageId: string | undefined): number | undefined => {
  if (!messageId) return undefined;
  const index = messages.findIndex((message) => message.id === messageId);
  return index >= 0 ? index + 1 : undefined;
};

const historyInputDigest = (messages: Message[]): string => `sha256:${sha256Hex(JSON.stringify(
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId ?? message.tool_call_id,
    toolCalls: message.tool_calls,
  })),
))}`;

/** D17 - the section digests the previous turn recorded, if any. */
const readPreviousSectionDigests = (
  session: { flags?: Record<string, unknown> },
): PrefixSectionDigest[] | undefined => {
  const cacheControl = session.flags?.cache_control;
  if (typeof cacheControl !== 'object' || cacheControl === null) return undefined;
  const digests = (cacheControl as { sectionDigests?: unknown }).sectionDigests;
  if (!Array.isArray(digests)) return undefined;
  return digests.filter((entry): entry is PrefixSectionDigest =>
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as PrefixSectionDigest).key === 'string'
    && typeof (entry as PrefixSectionDigest).digest === 'string');
};

export class DefaultBuildStage implements BuildStage {
  constructor(private readonly validator: MessageValidator = new MessageValidator()) {}

  async run(args: BuildPromptArgs): Promise<BuildPromptResult> {
    const log = pipelineLogger.child({ sessionId: args.session.id });

    const contextEnvelope: ContextBlocks = await args.contextProvider.getContext({
      sessionId: args.session.id,
      turn: args.turnNumber,
      extraContext: args.session.extraContext,
      taskBlocks: args.session.task ? args.session.softContextBlocks : undefined,
    });

    if (args.traceRecorder && args.session.agentType === 'executor') {
      const alreadyLogged = Boolean(args.session.flags?.assignedSkillsTraceLogged);
      if (!alreadyLogged) {
        const assignedSkills = parseAssignedSkillsFromExtraContext(args.session.extraContext);
        const count = assignedSkills.slugs.length;
        const note = assignedSkills.detected
          ? `assigned skills injected count=${count}`
          : 'assigned skills block missing';

        await args.traceRecorder.write(args.session.id, args.turnNumber, {
          event: 'assigned_skills.injected',
          severity: 'info',
          payload: {
            detected: assignedSkills.detected,
            count,
            slugs: assignedSkills.slugs,
            versions: assignedSkills.versions,
            blockLength: assignedSkills.blockLength,
          },
          note,
        });
        if (assignedSkills.slugs.length > 0) {
          await args.traceRecorder.write(args.session.id, args.turnNumber, {
            event: 'skill.preloaded',
            severity: 'info',
            payload: {
              source: 'assigned_skills',
              slugs: assignedSkills.slugs,
              skills: assignedSkills.slugs.map((slug) => ({
                slug,
                versionHash: assignedSkills.versions[slug],
              })),
              count: assignedSkills.slugs.length,
              telemetryOnly: true,
            },
            note: `preloaded assigned skills: ${assignedSkills.slugs.join(', ')}`,
          });
        }

        args.session.flags = args.session.flags ?? {};
        args.session.flags.assignedSkillsTraceLogged = true;
      }
    }
    const policyChecker = new ToolPolicyChecker();
    const toolSchemas = args.toolsRegistry.getToolSchemas();
    const filteredToolSchemas = toolSchemas.filter((tool) =>
      policyChecker.isToolAllowedByPolicy(args.session.toolPolicy, tool.name),
    );
    const promptToolSchemas = filteredToolSchemas;
    const toolDefinitions: OpenAI.Chat.ChatCompletionFunctionTool[] = promptToolSchemas.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as OpenAI.Chat.ChatCompletionFunctionTool['function']['parameters'],
      },
    }));

    args.session.flags = args.session.flags ?? {};
    delete args.session.flags[DELEGATION_ACTIVATION_GUIDANCE_FLAG];
    delete args.session.flags[WORKER_SPAWNING_AVAILABLE_FLAG];
    const spawnWorkerAvailable = promptToolSchemas.some((tool) => tool.name === 'spawn_worker');
    if (spawnWorkerAvailable) {
      args.session.flags[WORKER_SPAWNING_AVAILABLE_FLAG] = true;
    }
    const shouldEvaluateDelegationActivation =
      args.session.agentType === 'executor' &&
      args.session.coordination?.role !== 'worker' &&
      spawnWorkerAvailable;
    let delegationActivationTrace:
      | {
          confidence: string;
          reasons: string[];
          recommendations: Array<Record<string, unknown>>;
          openingWave: boolean;
          maxConcurrency?: number;
        }
      | undefined;

    if (shouldEvaluateDelegationActivation) {
      const effectiveMaxToolCalls = resolveWorkerMaxToolCalls(args.session, args.maxToolCalls);
      const reservedToolCalls = resolveRootReportingReserveToolCalls(args.session, effectiveMaxToolCalls);
      const securityops = isRecord(args.session.flags?.securityops)
        ? args.session.flags.securityops
        : undefined;
      const enumerationWorkerEnabled =
        securityops?.activePhaseKey === 'enumeration' &&
        getEnumerationWorkerAdmissionState(args.session.flags).allowed;
      const enumerationAutoEligiblePlanStepIds: string[] = [];
      if (enumerationWorkerEnabled) {
        const resolver = new EnumerationWorkerSkillResolver();
        const executableTools = getWorkerTemplate('enumeration_worker').allowedTools;
        for (const step of args.session.plan ?? []) {
          const mission = step.mission?.enumeration;
          if (
            (step.status !== 'pending' && step.status !== 'running') ||
            step.mission?.phase !== 'enumeration' ||
            !mission
          ) {
            continue;
          }
          try {
            const resolved = await resolver.resolve({
              mission,
              executableTools,
              runtimeSourceMode:
                typeof securityops?.enumerationSourceMode === 'string'
                  ? securityops.enumerationSourceMode
                  : undefined,
              runImpactTolerance:
                typeof securityops?.enumerationImpactTolerance === 'string'
                  ? securityops.enumerationImpactTolerance
                  : undefined,
              catalogAdmission:
                typeof securityops?.enumerationEvaluationCandidateCatalogDigest === 'string'
                  ? {
                      kind: 'evaluation_candidate',
                      expectedCatalogDigest: securityops.enumerationEvaluationCandidateCatalogDigest,
                    }
                  : undefined,
            });
            if (
              [resolved.primary, ...resolved.supporting].every(
                (skill) => skill.riskTier === 'low' || skill.riskTier === 'standard',
              )
            ) {
              enumerationAutoEligiblePlanStepIds.push(step.id);
            }
          } catch {
            // Automatic activation is fail-closed; spawn_worker returns the
            // detailed admission reason for an explicit operator-selected task.
          }
        }
      }
      const provisionalHint = evaluateDelegationActivation({
        session: args.session,
        enumerationWorkerEnabled,
        enumerationAutoEligiblePlanStepIds,
      });
      const maxConcurrency = resolveOpeningWaveConcurrency(args.session, {
        maxToolCalls: effectiveMaxToolCalls,
        usedToolCalls: 0,
        reservedToolCalls,
      }, undefined, provisionalHint.recommendations.map((recommendation) => recommendation.workerType));
      const hint = evaluateDelegationActivation({
        session: args.session,
        maxConcurrency,
        enumerationWorkerEnabled,
        enumerationAutoEligiblePlanStepIds,
      });
      const guidance = renderDelegationActivationGuidance(hint);

      if (guidance) {
        args.session.flags[DELEGATION_ACTIVATION_GUIDANCE_FLAG] = guidance;
        delegationActivationTrace = {
          confidence: hint.confidence,
          reasons: hint.reasons,
          recommendations: hint.recommendations.map((recommendation) => ({
            workerType: recommendation.workerType,
            confidence: recommendation.confidence,
            executionMode: recommendation.executionMode,
            dependencyMode: recommendation.dependencyMode,
            suggestedTarget: recommendation.suggestedTarget,
            independenceKey: recommendation.independenceKey,
            planStepId: recommendation.planStepId,
            missionFingerprint: recommendation.mission?.enumeration?.missionFingerprint,
          })),
          openingWave: hint.openingWave,
          ...(typeof hint.maxConcurrency === 'number' ? { maxConcurrency: hint.maxConcurrency } : {}),
        };
      }
    }

    const workspaceProjectionFlushWarning = await (async (): Promise<string | null> => {
      try {
        const result = await args.toolsRegistry.flushWorkspaceProjection?.({
          sessionId: args.session.id,
          turnNumber: args.turnNumber,
          reason: 'pre_prompt_dirty_recovery',
        });
        return result?.warning ?? null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Projection refresh failed before prompt recitation: ${message}. Use canonical query tools if projected files look stale.`;
      }
    })();

    const workspaceModelRecitation = await loadWorkspaceModelRecitation(args.session);
    if (workspaceModelRecitation) {
      args.session.flags[WORKSPACE_MODEL_RECITATION_FLAG] = workspaceModelRecitation;
    } else {
      delete args.session.flags[WORKSPACE_MODEL_RECITATION_FLAG];
    }
    if (workspaceProjectionFlushWarning) {
      args.session.flags[WORKSPACE_PROJECTION_WARNING_FLAG] = workspaceProjectionFlushWarning;
    } else {
      delete args.session.flags[WORKSPACE_PROJECTION_WARNING_FLAG];
    }
    let promptBuild!: PromptBuild;
    try {
      promptBuild = args.promptBuilder.build({
        session: args.session,
        agentType: args.session.agentType ?? 'chat',
        promptProfile: args.session.promptProfile,
        softContext: contextEnvelope.soft || '',
        tools: promptToolSchemas,
      });
    } finally {
      delete args.session.flags[DELEGATION_ACTIVATION_GUIDANCE_FLAG];
      delete args.session.flags[WORKER_SPAWNING_AVAILABLE_FLAG];
      delete args.session.flags[WORKSPACE_MODEL_RECITATION_FLAG];
      delete args.session.flags[WORKSPACE_PROJECTION_WARNING_FLAG];
    }

    const previousSectionDigests = readPreviousSectionDigests(args.session);
    const currentPrefixSections = [
      ...promptBuild.sections.static,
      ...promptBuild.sections.dynamic,
    ];
    const cacheDecision = args.cacheCoordinator.build({
      session: args.session,
      cacheablePrefix: promptBuild.cacheablePrefix,
      providerSupportsCache: args.provider.supportsCacheControl(),
      prefixSections: currentPrefixSections,
    });
    opsMetrics.recordCacheIntent(cacheDecision.cacheIntent?.action ?? 'none');

    if (args.traceRecorder && delegationActivationTrace) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'delegation.guidance_injected',
        severity: 'info',
        payload: {
          ...delegationActivationTrace,
          dynamicSection: 'delegation_activation_guidance',
          recommendationCount: delegationActivationTrace.recommendations.length,
        },
        note:
          `delegation guidance injected confidence=${delegationActivationTrace.confidence} ` +
          `recommendations=${delegationActivationTrace.recommendations.length}`,
      });
    }

    if (args.traceRecorder && workspaceModelRecitation) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'workspace_projection.model_recited',
        severity: 'info',
        payload: {
          path: 'journal/model.md',
          chars: workspaceModelRecitation.length,
          approxTokens: estimateTextTokens(workspaceModelRecitation),
        },
        note: 'workspace projection live model recited',
      });
    }

    if (args.traceRecorder && workspaceProjectionFlushWarning) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'workspace_projection.prompt_warning',
        severity: 'warn',
        payload: {
          warning: workspaceProjectionFlushWarning,
        },
        note: 'workspace projection warning injected into prompt',
      });
    }

    if (args.traceRecorder) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'system.prompt.full',
        severity: 'debug',
        payload: {
          static: promptBuild.staticPrompt,
          dynamic: promptBuild.dynamicPrompt,
          soft: promptBuild.softContext,
          staticSections: promptBuild.sections.static.map((section) => section.key),
          softSections: promptBuild.sections.soft.map((section) => section.key),
          dynamicSections: promptBuild.sections.dynamic.map((section) => section.key),
          dynamicBoundary: promptBuild.dynamicBoundary,
          promptProfile: promptBuild.promptProfile,
          cacheAction: cacheDecision.cacheIntent?.action ?? 'none',
          cachePrefixHash: cacheDecision.cacheIntent?.prefixHash ?? cacheDecision.prefixHash,
          prefixLengthApproxTokens: cacheDecision.approxPrefixTokens,
        },
        note: 'System prompt (static+dynamic) logged for traceability',
      });
    }

    const pendingCacheResume = isRecord(args.session.flags?.cache_resume_pending)
      ? args.session.flags.cache_resume_pending
      : undefined;
    if (pendingCacheResume) {
      if (args.traceRecorder) {
        const previousPrefixHash =
          typeof pendingCacheResume.previousPrefixHash === 'string'
            ? pendingCacheResume.previousPrefixHash
            : undefined;
        const previousCreatedAt =
          typeof pendingCacheResume.previousCreatedAt === 'number'
            ? pendingCacheResume.previousCreatedAt
            : undefined;
        const ttlRemainingMs =
          previousCreatedAt !== undefined
            ? Math.max(0, 5 * 60 * 1000 - (Date.now() - previousCreatedAt))
            : undefined;
        const prefixStable = previousPrefixHash === cacheDecision.prefixHash;
        // D17 - all four resumes in run r1 reported prefixStable=false and nothing said what
        // moved. Name the sections, so the next one is answerable.
        const divergence = diffPrefixSections(
          previousSectionDigests,
          digestPrefixSections(currentPrefixSections),
        );
        await args.traceRecorder.write(args.session.id, args.turnNumber, {
          event: 'cache.resume',
          severity: 'info',
          payload: {
            reason:
              typeof pendingCacheResume.reason === 'string'
                ? pendingCacheResume.reason
                : 'unknown',
            prevHash: previousPrefixHash,
            previousPrefixHash,
            prefixHash: cacheDecision.prefixHash,
            currentHash: cacheDecision.prefixHash,
            prefixStable,
            divergedSections: divergence.changed,
            addedSections: divergence.added,
            removedSections: divergence.removed,
            sectionOrderStable: divergence.orderStable,
            divergenceSummary: describePrefixDivergence(divergence),
            ttlRemainingMs,
            decision: prefixStable && cacheDecision.cacheIntent?.action === 'hit' ? 'reused' : 'rebuilt',
            cacheAction: cacheDecision.cacheIntent?.action ?? 'none',
            prefixLengthApproxTokens: cacheDecision.approxPrefixTokens,
          },
          note: `cache resume prefixStable=${prefixStable} action=${cacheDecision.cacheIntent?.action ?? 'none'}`
            + (prefixStable ? '' : ` (${describePrefixDivergence(divergence)})`),
        });
      }
      delete args.session.flags?.cache_resume_pending;
    }

    const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] = args.provider.buildSystemMessages({
      staticPrompt: promptBuild.staticPrompt,
      dynamicPrompt: promptBuild.dynamicPrompt,
      softContext: promptBuild.softContext || '',
      cacheIntent: cacheDecision.cacheIntent,
      providerName: args.provider.name,
    });
    // ============================================================================
    // EPHEMERAL NUDGE: Inject guard feedback (e.g., "you used wrong tool format")
    // Consumed once and cleared to avoid polluting future turns
    // ============================================================================
    const ephemeralNudge = args.session.flags?.ephemeralNudge;
    if (ephemeralNudge && typeof ephemeralNudge === 'string') {
      systemMessages.push({
        role: 'system',
        content: ephemeralNudge,
      });
      // Clear the nudge so it's not repeated
      if (args.session.flags) {
        delete args.session.flags.ephemeralNudge;
      }
    }

    // ============================================================================
    // DYNAMIC CONTEXT BUDGET (wired from model config, not hardcoded)
    // ============================================================================
    const providerContextWindow = typeof args.provider.getCapabilities === 'function'
      ? args.provider.getCapabilities().contextWindow
      : undefined;
    const modelContextWindow = args.session.modelContextWindow ?? providerContextWindow ?? 100000;
    const capacitySource = args.session.modelContextWindow
      ? 'model_config' as const
      : 'provider_capability_fallback' as const;
    const modelMaxOutput = args.session.modelMaxOutputTokens ?? 8192;
    const effectiveContextWindow = Math.max(2_000, Math.floor(modelContextWindow * PROMPT_EFFECTIVE_WINDOW_RATIO));
    const maxOutputReserve = Math.max(modelMaxOutput, 1_000);
    const availablePromptTokens = Math.max(2_000, effectiveContextWindow - maxOutputReserve);
    const staticPromptTokens = estimateTextTokens(promptBuild.staticPrompt);
    const softContextTokens = estimateTextTokens(promptBuild.softContext || '');
    const dynamicPromptTokens = estimateTextTokens(promptBuild.dynamicPrompt);
    const systemTokens = staticPromptTokens + softContextTokens + dynamicPromptTokens;
    const toolSchemaTokens = estimateToolSchemaTokens(toolDefinitions);
    const promptOverheadTokens = systemTokens + toolSchemaTokens;
    const minimumExecutionSpaceTokens = Math.max(
      MIN_EXECUTION_SPACE_FLOOR_TOKENS,
      Math.floor(availablePromptTokens * MIN_EXECUTION_SPACE_RATIO),
    );
    const fixedPromptLimit = availablePromptTokens - minimumExecutionSpaceTokens;
    if (promptOverheadTokens > fixedPromptLimit) {
      await args.traceRecorder?.write(args.session.id, args.turnNumber, {
        event: 'context.fixed_prompt_rejected',
        severity: 'error',
        payload: {
          promptOverheadTokens,
          fixedPromptLimit,
          contextWindow: modelContextWindow,
          maxOutputReserve,
          minimumExecutionSpace: minimumExecutionSpaceTokens,
        },
        note: `fixed prompt rejected: ${promptOverheadTokens}/${fixedPromptLimit} tokens`,
      });
      throw new Error(
        `Agent context is too large for the selected model before execution begins ` +
        `(${promptOverheadTokens} fixed tokens; limit ${fixedPromptLimit}). Reduce scope metadata or choose a model with a larger context window.`,
      );
    }
    const availableForHistory = Math.max(
      minimumExecutionSpaceTokens,
      Math.min(
        modelContextWindow - modelMaxOutput - SYSTEM_PROMPT_RESERVE,
        availablePromptTokens - promptOverheadTokens,
      ),
    );
    // D18 - order the two authorities. The trimmer used to cap history on the model window
    // while compaction triggered on the routed soft threshold, and on four of five seeded
    // routes the cap was crossed first: `trimHistoryHeadTail` dropped a range with no summary
    // standing in for it, and the summariser never saw what it would have preserved.
    //
    // The trimmer's cap is therefore lifted above compaction's soft threshold, and still
    // clamped to what the window can actually hold. Ordered: compaction first, irreversible
    // dropping only when compaction could not bring the prompt down.
    const compactionSoftPromptTokens = Math.floor(modelContextWindow * CONTEXT_SOFT_RATIO);
    const compactionSoftHistoryTokens = Math.max(
      0,
      compactionSoftPromptTokens - promptOverheadTokens,
    );
    const MAX_HISTORY_TOKENS = Math.min(
      availableForHistory,
      Math.max(
        2_000,
        Math.floor(availableForHistory * HISTORY_RATIO),
        Math.ceil(compactionSoftHistoryTokens * TRIM_HEADROOM_OVER_COMPACTION),
      ),
    );
    const HEAD_TOKENS = Math.min(HEAD_SOFT_CAP_TOKENS, Math.floor(MAX_HISTORY_TOKENS * 0.1));
    
    const rawMessages = Array.isArray(args.session.messages) ? args.session.messages : [];

    // Sanitize history using extracted helper
    const sanitized = sanitizeForLLM(rawMessages);
    const preMicroHistoryTokens = estimateMessagesTokens(sanitized);
    const microcompaction = microcompactToolResults(sanitized);
    const promptMessages = microcompaction.messages;
    const totalEstimatedTokens = estimateMessagesTokens(promptMessages);
    const toolResultTokens = estimateToolResultTokens(promptMessages);
    const toolResultTokensByTool = estimateToolResultTokensByTool(promptMessages);
    const persistedToolResults = estimatePersistedToolResultStats(promptMessages);
    const currentUserTokens =
      promptMessages.length > 0 && promptMessages[promptMessages.length - 1]?.role === 'user'
        ? estimateTokens(promptMessages[promptMessages.length - 1])
        : 0;
    const costAwarePromptBudget = Math.max(promptOverheadTokens + MAX_HISTORY_TOKENS, 2_000);
    const totalPromptEstimateBeforeTrim = promptOverheadTokens + totalEstimatedTokens;
    const historyPressure = totalEstimatedTokens / MAX_HISTORY_TOKENS;
    const totalPromptPressure = totalPromptEstimateBeforeTrim / costAwarePromptBudget;
    const percentUsed = Math.max(historyPressure, totalPromptPressure);
    const reducerProfile = resolveRunCompactionProfile(args.session);
    const createReducerMeasurement = (
      messages: Message[],
      reason: string,
      suffix: string,
    ): ContextMeasurement => {
      const seed = JSON.stringify([
        args.session.id,
        args.turnNumber,
        args.provider.name,
        args.modelName,
        modelContextWindow,
        messages.map((message) => message.id),
        suffix,
      ]);
      return buildContextMeasurement({
        measurementId: `context:reducer:${sha256Hex(seed)}`,
        requestId: `reducer:${args.session.id}:${args.turnNumber}`,
        sessionId: args.session.id,
        runId: args.runId,
        stepId: args.stepId,
        turn: args.turnNumber,
        callOrdinal: 0,
        provider: args.provider.name,
        model: args.modelName,
        routedCapacity: modelContextWindow,
        capacitySource,
        reducerProfile,
        reducerReason: reason,
        envelope: {
          messages: [...systemMessages, ...args.convertMessages(messages)],
          tools: toolDefinitions,
          max_tokens: modelMaxOutput,
        },
      });
    };
    let preReductionMeasurement = createReducerMeasurement(
      promptMessages,
      args.compactionReason ?? 'request_measurement',
      'unprojected',
    );

    if (args.traceRecorder && microcompaction.stats.compactedResults > 0) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'tool_result_compacted',
        severity: 'info',
        payload: {
          ...microcompaction.stats,
          // The reduce set is a set; the trace records only what a reader needs.
          decision: {
            ...microcompaction.stats.decision,
            reduceIndices: [...microcompaction.stats.decision.reduceIndices],
          },
        },
        note: `compacted ${microcompaction.stats.compactedResults} old tool result(s), saved ~${microcompaction.stats.savedTokens} tokens`,
      });
    }
    
    // ============================================================================
    // AUTO-COMPACTION: Summarize older messages at 70% threshold
    // ============================================================================
    const PRESERVE_TAIL_RATIO = 0.3;
    
    const durableActive = await args.historyTransformationPort?.findActiveBySession(args.session.id);
    const durableHistory = args.historyTransformationPort
      ? await args.historyTransformationPort.findBySession(args.session.id)
      : [];
    const promptMessageIds = promptMessages.map((message) => message.id);
    const recoverablePending = [...durableHistory].reverse().find((record) => {
      if (record.status !== 'prepared' && record.status !== 'replacement_persisted') return false;
      if (record.inputHistoryVersion !== (durableActive?.outputHistoryVersion ?? 0)) return false;
      const start = promptMessageIds.indexOf(record.inputStartMessageId);
      if (start < 0) return false;
      return record.inputMessageIds.every((messageId, offset) => promptMessageIds[start + offset] === messageId);
    });
    const effectiveCompactionReason = args.compactionReason
      ?? (recoverablePending?.reason === 'provider_context_overflow'
        ? 'provider_context_overflow'
        : undefined);
    if (durableActive?.replacementSummary) {
      const activeStart = messageIndexAfterId(promptMessages, durableActive.inputEndMessageId) ?? 0;
      const projectedActiveMessages: Message[] = [
        {
          id: durableActive.replacementMessageId ?? `compaction-summary:${durableActive.transactionId}`,
          role: 'assistant',
          content: `[CONVERSATION CONTEXT SUMMARY - Earlier messages have been summarized]\n\n${durableActive.replacementSummary}`,
          timestamp: Date.now(),
        },
        ...promptMessages.slice(activeStart),
      ];
      preReductionMeasurement = createReducerMeasurement(
        projectedActiveMessages,
        effectiveCompactionReason ?? 'request_measurement',
        durableActive.transactionId,
      );
    }
    const activeSummary = durableActive?.replacementSummary ?? args.session.compactionSummary;
    const activeCutoffAfterIndex = messageIndexAfterId(
      promptMessages,
      durableActive?.inputEndMessageId,
    );
    const hasExistingSummary = Boolean(activeSummary);
    const compactionPolicy = getCompactionPolicy(hasExistingSummary);
    const turnsPassedSinceCompaction = args.turnNumber - (
      durableActive?.turn ?? args.session.compactionCutoffTurn ?? 0
    );
    const failureState = getCompactionFailureState(args.session.flags as Record<string, unknown> | undefined);
    const providerOverflowRecovery = effectiveCompactionReason === 'provider_context_overflow';
    const measurementReachedSoftThreshold =
      preReductionMeasurement.counts.totalWithReservedOutputTokens
      >= preReductionMeasurement.thresholds.softTokens;
    const shouldCompact = (recoverablePending || providerOverflowRecovery || !failureState.disabled) &&
                          (recoverablePending || providerOverflowRecovery || measurementReachedSoftThreshold) &&
                          promptMessages.length >= (recoverablePending ? 1 : providerOverflowRecovery ? 2 : 6) &&
                          (recoverablePending || providerOverflowRecovery || turnsPassedSinceCompaction >= compactionPolicy.cooldownTurns);

    if (failureState.disabled && args.traceRecorder) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'context.compaction_disabled',
        severity: 'warn',
        payload: {
          reason: 'consecutive_failures',
          consecutiveFailures: failureState.consecutive,
          percentUsed: Math.round(percentUsed * 100),
        },
        note: `auto-compaction disabled after ${failureState.consecutive} consecutive failures`,
      });
    }
    
    let compactionResult:
      | {
          summary: string;
          messagesSummarized: number;
          categoryCounts: ReturnType<typeof extractCompactionCategoryCounts>;
        }
      | null = null;
    let authoritativeTransformation: HistoryTransformationRecord | undefined = durableActive;
    
    if (shouldCompact) {
      try {
        log.info({
          percentUsed: Math.round(percentUsed * 100),
          totalMessages: promptMessages.length,
          historyPressure: Math.round(historyPressure * 100),
          totalPromptPressure: Math.round(totalPromptPressure * 100),
        },
          'Auto-compaction triggered');
        
        const preserveCount = providerOverflowRecovery
          ? Math.max(1, Math.ceil(promptMessages.length * PRESERVE_TAIL_RATIO))
          : Math.max(3, Math.ceil(promptMessages.length * PRESERVE_TAIL_RATIO));
        const pendingSplitIndex = recoverablePending
          ? messageIndexAfterId(promptMessages, recoverablePending.inputEndMessageId)
          : undefined;
        const splitIndex = pendingSplitIndex
          ?? adjustStartForToolBoundary(promptMessages, promptMessages.length - preserveCount);
        
        const alreadyCompactedCount = Math.max(0, args.session.compactionMessageCutoff ?? 0);
        const summarizeStart = durableActive
          ? Math.min(activeCutoffAfterIndex ?? 0, splitIndex)
          : hasExistingSummary
            ? Math.min(alreadyCompactedCount, splitIndex)
            : 0;
        const toSummarize = promptMessages.slice(summarizeStart, splitIndex);
        
        if (toSummarize.length >= (providerOverflowRecovery ? 1 : compactionPolicy.minMessages)) {
          
          const previousSummary = activeSummary;
          const compactionInstruction = buildCompactionInstruction(reducerProfile, previousSummary);
          if (!args.executeModelCall) {
            throw new Error('ModelRuntime is unavailable for context compaction');
          }
          const reason = effectiveCompactionReason ?? 'soft_threshold';
          const inputMessageIds = toSummarize.map((message) => message.id);
          const configurationDigest = `sha256:${sha256Hex(JSON.stringify({
            schemaVersion: HISTORY_TRANSFORMATION_SCHEMA_VERSION,
            reducerProfile,
            reason,
            countingMethod: preReductionMeasurement.countingMethod,
            routeFingerprint: preReductionMeasurement.routeFingerprint,
            softThreshold: preReductionMeasurement.thresholds.softTokens,
            hardThreshold: preReductionMeasurement.thresholds.hardTokens,
            preserveTailRatio: PRESERVE_TAIL_RATIO,
            promptVersion: 'run_compaction_prompt_v1',
          }))}`;
          const inputHistoryVersion = durableActive?.outputHistoryVersion
            ?? Math.max(0, args.session.compactionVersion ?? 0);
          const transactionId = createHistoryTransformationId({
            sessionId: args.session.id,
            inputHistoryVersion,
            inputMessageIds,
            reducerProfile,
            reason,
            configurationDigest,
          });
          const replacementMessageId = `compaction-summary:${transactionId.slice('history:'.length)}`;
          const runFault = async (
            point: 'after_prepare' | 'after_replacement_persisted_before_activation' | 'after_activation',
          ): Promise<void> => {
            if (!args.historyTransformationFault) return;
            try {
              await args.historyTransformationFault(point, transactionId);
            } catch (fault) {
              throw new InjectedHistoryTransformationFault(point, transactionId, fault);
            }
          };

          let normalizedSummary: string | undefined;
          if (args.historyTransformationPort) {
            let transaction = await args.historyTransformationPort.prepare({
              transactionId,
              schemaVersion: HISTORY_TRANSFORMATION_SCHEMA_VERSION,
              sessionId: args.session.id,
              runId: args.runId,
              stepId: args.stepId,
              turn: args.turnNumber,
              reducerProfile,
              reason,
              intent: 'Replace the stable input message range with a durable compaction summary.',
              inputHistoryVersion,
              outputHistoryVersion: inputHistoryVersion + 1,
              inputMessageIds,
              inputStartMessageId: inputMessageIds[0]!,
              inputEndMessageId: inputMessageIds[inputMessageIds.length - 1]!,
              inputDigest: historyInputDigest(toSummarize),
              configurationDigest,
              beforeMeasurement: toContextMeasurementSnapshot(preReductionMeasurement),
              triggerRequestId: args.triggerRequestId ?? recoverablePending?.triggerRequestId,
              createdAt: preReductionMeasurement.createdAt,
            });
            await runFault('after_prepare');

            if (transaction.status === 'prepared') {
              // E12 Slice C: replay the warm ancestor prefix exactly, then append the
              // directive as the only new message. Tools ride along even though the
              // summarizer must not call one — dropping them would shorten the token
              // sequence and break alignment with the cached request.
              const compactionMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
                ...systemMessages,
                ...args.convertMessages(toSummarize),
                { role: 'user', content: compactionInstruction },
              ];
              const completionResponse = await args.executeModelCall({
                sessionId: args.session.id,
                turnNumber: args.turnNumber,
                routeReason: 'context_compaction',
                cacheMode: { kind: 'reuse_ancestor' },
                messages: compactionMessages,
                tools: toolDefinitions,
                maxTokens: 1000,
                temperature: 0.3,
                signal: args.abortSignal ?? new AbortController().signal,
              });
              if (completionResponse.toolCalls && completionResponse.toolCalls.length > 0) {
                throw new Error(
                  'Context compaction returned a tool call; the summarizer must only produce checkpoint text',
                );
              }
              if (!completionResponse.content || completionResponse.content.length <= 50) {
                throw new Error('Context compaction returned an empty replacement');
              }
              normalizedSummary = normalizeCompactionSummary(completionResponse.content);
              const afterMessages: Message[] = [
                {
                  id: replacementMessageId,
                  role: 'assistant',
                  content: `[CONVERSATION CONTEXT SUMMARY - Earlier messages have been summarized]\n\n${normalizedSummary}`,
                  timestamp: Date.now(),
                },
                ...promptMessages.slice(splitIndex),
              ];
              const afterMeasurement = buildContextMeasurement({
                measurementId: `context:${transactionId}:after`,
                requestId: `transformation:${transactionId}`,
                sessionId: args.session.id,
                runId: args.runId,
                stepId: args.stepId,
                turn: args.turnNumber,
                callOrdinal: 0,
                provider: args.provider.name,
                model: args.modelName,
                routedCapacity: modelContextWindow,
                capacitySource,
                reducerProfile,
                reducerReason: reason,
                transformationId: transactionId,
                envelope: {
                  messages: [...systemMessages, ...args.convertMessages(afterMessages)],
                  tools: toolDefinitions,
                  max_tokens: modelMaxOutput,
                },
              });
              transaction = await args.historyTransformationPort.persistReplacement(transactionId, {
                replacementSummary: normalizedSummary,
                replacementMessageId,
                afterMeasurement: toContextMeasurementSnapshot(afterMeasurement),
              });
            } else {
              normalizedSummary = transaction.replacementSummary;
            }

            await runFault('after_replacement_persisted_before_activation');
            transaction = await args.historyTransformationPort.activate(transactionId);
            authoritativeTransformation = transaction;
            normalizedSummary = transaction.replacementSummary;
            await runFault('after_activation');
          } else {
            // E12 Slice C: the resume path replays the same exact ancestor prefix.
            const resumeMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
              ...systemMessages,
              ...args.convertMessages(toSummarize),
              { role: 'user', content: compactionInstruction },
            ];
            const completionResponse = await args.executeModelCall({
              sessionId: args.session.id,
              turnNumber: args.turnNumber,
              routeReason: 'context_compaction',
              cacheMode: { kind: 'reuse_ancestor' },
              messages: resumeMessages,
              tools: toolDefinitions,
              maxTokens: 1000,
              temperature: 0.3,
              signal: args.abortSignal ?? new AbortController().signal,
            });
            normalizedSummary = completionResponse.content && completionResponse.content.length > 50
              ? normalizeCompactionSummary(completionResponse.content)
              : undefined;
          }

          if (normalizedSummary) {
            const categoryCounts = extractCompactionCategoryCounts(normalizedSummary);
            compactionResult = {
              summary: normalizedSummary,
              messagesSummarized: toSummarize.length,
              categoryCounts,
            };
            
            // These fields remain a compatibility projection. The activated durable
            // transaction is authoritative whenever the transactional port is present.
            args.session.compactionSummary = normalizedSummary;
            args.session.compactionCutoffTurn = args.turnNumber;
            args.session.compactionMessageCutoff = splitIndex;
            args.session.compactionVersion = authoritativeTransformation?.outputHistoryVersion
              ?? (args.session.compactionVersion ?? 0) + 1;
            args.session.flags = args.session.flags ?? {};
            delete args.session.flags.compaction_failures;
            
            log.info({ 
              messagesSummarized: toSummarize.length, 
              summaryLength: normalizedSummary.length,
              categoryCounts,
              compactionVersion: args.session.compactionVersion,
            }, 'Auto-compaction completed successfully');
            
            if (args.traceRecorder) {
              await args.traceRecorder.write(args.session.id, args.turnNumber, {
                event: 'context.compacted',
                severity: 'info',
                payload: {
                  beforeTokens: totalEstimatedTokens,
                  messagesSummarized: toSummarize.length,
                  summaryLength: normalizedSummary.length,
                  ...categoryCounts,
                  compactionVersion: args.session.compactionVersion,
                },
                note: `Compacted ${toSummarize.length} messages; ${summarizeCompactionCounts(categoryCounts)}`,
              });
            }
          }
        }
      } catch (compactionError) {
        if (compactionError instanceof InjectedHistoryTransformationFault) {
          throw compactionError;
        }
        const mappedError = args.provider.mapError(compactionError, {
          model: args.modelName,
          provider: args.provider.name,
        });
        args.session.flags = args.session.flags ?? {};
        const nextFailures = failureState.consecutive + 1;
        args.session.flags.compaction_failures = {
          consecutive: nextFailures,
          disabled: nextFailures >= MAX_COMPACTION_FAILURES,
          lastError: mappedError.message,
          lastFailedAt: new Date().toISOString(),
        };
        if (args.traceRecorder) {
          await args.traceRecorder.write(args.session.id, args.turnNumber, {
            event: nextFailures >= MAX_COMPACTION_FAILURES
              ? 'context.compaction_disabled'
              : 'context.compaction_failed',
            severity: nextFailures >= MAX_COMPACTION_FAILURES ? 'warn' : 'info',
            payload: {
              consecutiveFailures: nextFailures,
              maxFailures: MAX_COMPACTION_FAILURES,
              disabled: nextFailures >= MAX_COMPACTION_FAILURES,
              message: mappedError.message,
            },
            note:
              nextFailures >= MAX_COMPACTION_FAILURES
                ? 'auto-compaction disabled after repeated failures'
                : `auto-compaction failed (${nextFailures}/${MAX_COMPACTION_FAILURES})`,
          });
        }
        log.warn({ err: mappedError }, 'Auto-compaction failed, continuing without');
      }
    }
    
    let effectiveMessages = promptMessages;
    const projectedSummary = authoritativeTransformation?.replacementSummary
      ?? args.session.compactionSummary;
    if (projectedSummary) {
      const summaryMessage: typeof promptMessages[0] = {
        id: authoritativeTransformation?.replacementMessageId ?? 'compaction-summary',
        role: 'assistant' as const,
        content: `[CONVERSATION CONTEXT SUMMARY - Earlier messages have been summarized]\n\n${projectedSummary}`,
        timestamp: Date.now(),
      };
      const tailCount = Math.max(3, Math.ceil(promptMessages.length * PRESERVE_TAIL_RATIO));
      const durableStart = messageIndexAfterId(
        promptMessages,
        authoritativeTransformation?.inputEndMessageId,
      );
      const preferredStart = durableStart
        ?? (typeof args.session.compactionMessageCutoff === 'number'
          ? args.session.compactionMessageCutoff
          : promptMessages.length - tailCount);
      const tailStart = adjustStartForToolBoundary(promptMessages, preferredStart);
      effectiveMessages = [summaryMessage, ...promptMessages.slice(tailStart)];
    }
    
    // Trim history using extracted helper
    const { trimmed, usedTokens, dropped } = trimHistoryHeadTail(effectiveMessages, {
      maxTokens: MAX_HISTORY_TOKENS,
      headTokens: HEAD_TOKENS,
      logger: log,
    });

    const latest = trimmed[trimmed.length - 1];
    if (!latest || latest.role !== 'user') {
      log.warn('Latest message is not a user message before prompt build; history may be stale.');
    }

    if (args.traceRecorder) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'history.trim',
        severity: dropped > 0 ? 'info' : 'debug',
        payload: {
          // E12: a reducer that ran and changed nothing must not read as a mutation.
          // Consumers attribute cache divergence from `changed`, never from the event name.
          evaluated: true,
          changed: dropped > 0 || microcompaction.stats.compactedResults > 0,
          changedBy: [
            ...(dropped > 0 ? ['history_trim'] : []),
            ...(microcompaction.stats.compactedResults > 0 ? ['tool_result_microcompaction'] : []),
          ],
          totalMessages: rawMessages.length,
          dedupedMessages: sanitized.length,
          promptMessages: promptMessages.length,
          microcompactedToolResults: microcompaction.stats.compactedResults,
          keptMessages: trimmed.length,
          droppedMessages: dropped,
          tokenBudget: MAX_HISTORY_TOKENS,
          headTokens: HEAD_TOKENS,
          usedTokens,
        },
        note: `history kept=${trimmed.length} dropped=${dropped} tokens=${usedTokens}/${MAX_HISTORY_TOKENS}`,
      });
    }

    const contextOverflow = dropped > 0 
      ? {
          droppedMessages: dropped,
          keptMessages: trimmed.length,
          usedTokens,
          tokenBudget: MAX_HISTORY_TOKENS,
          percentUsed: Math.round((usedTokens / MAX_HISTORY_TOKENS) * 100),
        }
      : undefined;

    const historyMessages = args.convertMessages(trimmed);

    try {
    this.validator.assertValid(historyMessages as typeof trimmed, {
      sessionId: args.session.id,
      turnNumber: args.turnNumber,
    });
    } catch (validationError) {
      log.warn(
        { err: validationError, sessionId: args.session.id, turnNumber: args.turnNumber },
        '[Pipeline] Message validation failed, attempting repair',
      );
      throw validationError;
    }

    // D18 - order the thresholds. The trimmer runs before this point, so assessing compaction
    // against the *trimmed* history let head-tail dropping pre-empt the summariser on four of
    // five seeded routes: the trimmer discarded a range, the prompt fell back under the
    // threshold, and compaction never saw the range it would have preserved. What the trimmer
    // drops is gone with no summary standing in for it.
    //
    // Compaction is therefore assessed against the history as it stood *before* trimming.
    // Irreversible dropping stays available as the last resort it was meant to be.
    const historyTokensForPressure = Math.max(usedTokens, totalEstimatedTokens);
    const estimatedTotalTokens = historyTokensForPressure + promptOverheadTokens;
    const autoCompactThreshold = Math.floor(costAwarePromptBudget * compactionPolicy.threshold);
    const contextBudget = {
      turn: args.turnNumber,
      contextWindow: modelContextWindow,
      effectiveWindow: effectiveContextWindow,
      maxOutputReserve,
      systemTokens,
      staticPromptTokens,
      softContextTokens,
      dynamicPromptTokens,
      toolSchemaTokens,
      historyTokens: usedTokens,
      historyTokensBeforeTrim: totalEstimatedTokens,
      historyTokensBeforeMicrocompaction: preMicroHistoryTokens,
      toolResultTokens,
      toolResultTokensByTool,
      toolResultCompactionsByTool: microcompaction.stats.compactedTools,
      toolResultsPersistedToDisk: persistedToolResults.count,
      toolResultPersistedSavedTokens: persistedToolResults.savedTokens,
      aggregateBudgetEnforcements: microcompaction.stats.aggregateBudgetEnforcements,
      aggregateBudgetOverageTokensBefore: microcompaction.stats.aggregateBudgetOverageTokensBefore,
      aggregateBudgetOverageTokensAfter: microcompaction.stats.aggregateBudgetOverageTokensAfter,
      toolResultPolicyVersion: TOOL_RESULT_POLICY_VERSION,
      currentUserTokens,
      totalPromptEstimate: estimatedTotalTokens,
      totalPromptEstimateBeforeTrim,
      promptOverheadTokens,
      maxHistoryTokens: MAX_HISTORY_TOKENS,
      costAwarePromptBudget,
      autoCompactThreshold,
      historyPressure: Math.round(historyPressure * 100),
      totalPromptPressure: Math.round(totalPromptPressure * 100),
      microcompactedToolResults: microcompaction.stats.compactedResults,
      microcompactionSavedTokens: microcompaction.stats.savedTokens,
    };
    args.session.flags = args.session.flags ?? {};
    args.session.flags.context_budget_last = contextBudget;

    if (args.traceRecorder) {
      await args.traceRecorder.write(args.session.id, args.turnNumber, {
        event: 'context.budget',
        severity: estimatedTotalTokens >= autoCompactThreshold ? 'info' : 'debug',
        payload: contextBudget,
        note:
          `prompt=${estimatedTotalTokens}/${costAwarePromptBudget} ` +
          `history=${usedTokens}/${MAX_HISTORY_TOKENS} ` +
          `tools=${toolSchemaTokens}+${toolResultTokens}`,
      });
    }

    const contextEstimate = {
      estimatedTokens: estimatedTotalTokens,
      contextWindow: modelContextWindow,
      maxHistoryTokens: MAX_HISTORY_TOKENS,
      percentUsed: Math.round((estimatedTotalTokens / modelContextWindow) * 100),
      budget: {
        effectiveWindow: effectiveContextWindow,
        maxOutputReserve,
        systemTokens,
        staticPromptTokens,
        softContextTokens,
        dynamicPromptTokens,
        toolSchemaTokens,
        historyTokens: usedTokens,
        toolResultTokens,
        toolResultTokensByTool,
        toolResultsPersistedToDisk: persistedToolResults.count,
        toolResultPersistedSavedTokens: persistedToolResults.savedTokens,
        aggregateBudgetEnforcements: microcompaction.stats.aggregateBudgetEnforcements,
        aggregateBudgetOverageTokensBefore: microcompaction.stats.aggregateBudgetOverageTokensBefore,
        aggregateBudgetOverageTokensAfter: microcompaction.stats.aggregateBudgetOverageTokensAfter,
        toolResultPolicyVersion: TOOL_RESULT_POLICY_VERSION,
        currentUserTokens,
        totalPromptEstimate: estimatedTotalTokens,
        promptOverheadTokens,
        autoCompactThreshold,
        microcompactedToolResults: microcompaction.stats.compactedResults,
        microcompactionSavedTokens: microcompaction.stats.savedTokens,
      },
    };

    const returnCompactionResult = compactionResult ? {
      beforeTokens: totalEstimatedTokens,
      afterTokens: usedTokens,
      messagesSummarized: compactionResult.messagesSummarized,
      ...compactionResult.categoryCounts,
      compactionVersion: args.session.compactionVersion ?? 1,
    } : undefined;
    const activatedCompaction = compactionResult
      && authoritativeTransformation?.replacementSummary
      ? {
          transactionId: authoritativeTransformation.transactionId,
          throughMessageId: authoritativeTransformation.inputEndMessageId,
          summaryMessage: {
            id: authoritativeTransformation.replacementMessageId
              ?? `compaction-summary:${authoritativeTransformation.transactionId}`,
            role: 'assistant' as const,
            content: `[CONVERSATION CONTEXT SUMMARY - Earlier messages have been summarized]\n\n${authoritativeTransformation.replacementSummary}`,
            // Journal payloads must remain byte-for-byte stable on an acknowledgement-lost retry.
            timestamp: 0,
          },
        }
      : undefined;

    return {
      contextEnvelope,
      systemMessages,
      historyMessages,
      toolDefinitions,
      contextMeasurementHints: {
        capacitySource,
        reducerProfile,
        reducerReason: compactionResult
          ? (args.compactionReason ?? 'soft_threshold_compaction')
          : 'request_measurement',
        transformationId: authoritativeTransformation?.transactionId,
      },
      transformationRefs: [
        ...(authoritativeTransformation ? [authoritativeTransformation.transactionId] : []),
        // E12: a tool-result reduction rewrites the prefix. Declaring it is what separates
        // an intended reset from an unexplained divergence in the cache lineage.
        ...(microcompaction.stats.decision.changed
          ? [`tool_result_reduction:gen-${microcompaction.stats.decision.generation}`]
          : []),
      ],
      activatedCompaction,
      contextOverflow,
      contextEstimate,
      compactionResult: returnCompactionResult,
    };
  }
}
