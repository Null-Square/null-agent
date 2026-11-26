import {
    parseAttemptKey,
    type SessionState,
    type PlanItem,
    type ToolDefinition,
} from '../types';
import {
    getWorkerTemplate,
    normalizeWorkerType,
    shouldRequireReportForSession,
} from '../workers/workerContracts';
import { selectStartingPlanTask } from '../workers/planTaskSelection';
import {
    createPromptSection,
    renderPromptSections,
    type PromptSection,
} from './promptSections';
import { renderMissionEnvelope } from '../workers/missionEnvelope';
import { getPromptSectionRegistry } from './PromptSectionRegistry';

const promptSectionRegistry = getPromptSectionRegistry();
const WORKSPACE_MODEL_RECITATION_FLAG = 'workspaceProjectionModelRecitation';
const WORKSPACE_PROJECTION_WARNING_FLAG = 'workspaceProjectionWarning';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const hasWorkerSpawningAvailable = (sessionState: SessionState): boolean =>
    sessionState.coordination?.role !== 'worker' &&
    sessionState.agentType === 'executor' &&
    sessionState.flags?.workerSpawningAvailable === true;

const stripGenericNextActions = (value: string): string =>
    value
        .replace(/(?:^|\n)#{1,6}\s+Next Actions\s*\n[\s\S]*?(?=\n#{1,6}\s|$)/giu, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const isReportingRecipient = (sessionState: SessionState): boolean =>
    ['reporting', 'review_reporting'].includes(getActiveSecurityOpsPhaseKey(sessionState) ?? '');

const isFocusedVerificationRecipient = (sessionState: SessionState): boolean => {
    const securityops = isRecord(sessionState.flags?.securityops) ? sessionState.flags.securityops : undefined;
    return securityops?.runTrigger === 'exposure_verification'
        || typeof securityops?.findingDispositionVerificationId === 'string';
};

const isPentestPhaseExecutor = (sessionState: SessionState): boolean => {
    const securityops = isRecord(sessionState.flags?.securityops) ? sessionState.flags.securityops : undefined;
    const workflow = typeof securityops?.workflowDiscipline === 'string'
        ? securityops.workflowDiscipline.trim().toLowerCase()
        : 'pentest';
    return sessionState.agentType === 'executor'
        && sessionState.coordination?.role !== 'worker'
        && Boolean(getActiveSecurityOpsPhaseKey(sessionState))
        && !isReportingRecipient(sessionState)
        && !isFocusedVerificationRecipient(sessionState)
        && workflow === 'pentest';
};

const formatWorkspaceModelRecitation = (sessionState: SessionState): string => {
    if (!isPentestPhaseExecutor(sessionState)) {
        return '';
    }
    const value = sessionState.flags?.[WORKSPACE_MODEL_RECITATION_FLAG];
    return typeof value === 'string' ? stripGenericNextActions(value) : '';
};

const formatWorkspaceProjectionWarning = (sessionState: SessionState): string => {
    const value = sessionState.flags?.[WORKSPACE_PROJECTION_WARNING_FLAG];
    return typeof value === 'string' ? value.trim() : '';
};

const getAttemptPriority = (result: string): number => {
    const normalized = result.trim().toLowerCase();
    if (normalized === 'blocked') return 0;
    if (normalized === 'failed') return 1;
    return 2;
};

const compactReason = (value: string): string =>
    value.length <= 80 ? value : `${value.slice(0, 77).trimEnd()}...`;

const formatFactPreview = (value: unknown): string => {
    if (typeof value === 'string') {
        return compactReason(value);
    }
    if (isRecord(value)) {
        const candidate =
            typeof value.url === 'string'
                ? value.url
                : typeof value.path === 'string'
                    ? value.path
                    : typeof value.host === 'string'
                        ? value.host
                        : '';
        if (candidate) {
            return compactReason(candidate);
        }
    }

    try {
        return compactReason(JSON.stringify(value));
    } catch {
        return compactReason(String(value));
    }
};

const formatToolDescription = (value: string | undefined): string => {
    const lines = (value || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return '';
    }

    const [firstLine, ...rest] = lines;
    if (rest.length === 0) {
        return firstLine;
    }

    return `${firstLine}\n${rest.map((line) => `  ${line}`).join('\n')}`;
};

const formatCompactMemory = (sessionState: SessionState): string => {
    const memory = sessionState.memory;
    if (!memory) {
        return 'stats: none';
    }

    const facts =
        Array.isArray(memory.discoveredFacts)
            ? memory.discoveredFacts.filter(
                (fact) => typeof fact.confidence === 'number' && fact.confidence >= 0.7,
            ).length
            : 0;
    const attempts =
        memory.attemptedTechniques && typeof memory.attemptedTechniques === 'object'
            ? Object.keys(memory.attemptedTechniques).length
            : 0;
    const failures = Array.isArray(memory.failedApproaches) ? memory.failedApproaches.length : 0;
    const endpoints = Array.isArray(memory.testedEndpoints) ? memory.testedEndpoints.length : 0;

    if (facts === 0 && attempts === 0 && failures === 0 && endpoints === 0) {
        return 'stats: none';
    }

    const summary = `stats: facts=${facts}, attempts=${attempts}, failures=${failures}, endpoints=${endpoints}`;
    const avoidRetryMap = new Map<
        string,
        {
            endpoint: string;
            technique: string;
            result: 'blocked' | 'failed';
            count: number;
            reason: string;
            lastAt: number;
        }
    >();

    if (memory.attemptedTechniques && typeof memory.attemptedTechniques === 'object') {
        for (const [key, rawAttempt] of Object.entries(memory.attemptedTechniques)) {
            if (!rawAttempt || typeof rawAttempt !== 'object') continue;
            const parsed = parseAttemptKey(key);
            if (!parsed) continue;
            const normalizedResult = typeof (rawAttempt as { result?: unknown }).result === 'string'
                ? (rawAttempt as { result: string }).result.trim().toLowerCase()
                : '';
            if (normalizedResult !== 'blocked' && normalizedResult !== 'failed') continue;
            const result: 'blocked' | 'failed' = normalizedResult === 'blocked' ? 'blocked' : 'failed';
            const rawCount = typeof (rawAttempt as { count?: unknown }).count === 'number'
                ? (rawAttempt as { count: number }).count
                : 1;
            const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1;
            const lastAt = typeof (rawAttempt as { lastAttemptAt?: unknown }).lastAttemptAt === 'number'
                ? (rawAttempt as { lastAttemptAt: number }).lastAttemptAt
                : 0;
            avoidRetryMap.set(key, {
                endpoint: parsed.endpoint,
                technique: parsed.technique,
                result,
                count,
                reason: '',
                lastAt,
            });
        }
    }

    if (Array.isArray(memory.failedApproaches)) {
        for (const failure of memory.failedApproaches) {
            if (!failure || typeof failure !== 'object') continue;
            const endpoint = typeof (failure as { endpoint?: unknown }).endpoint === 'string'
                ? (failure as { endpoint: string }).endpoint.trim()
                : '';
            const technique = typeof (failure as { technique?: unknown }).technique === 'string'
                ? (failure as { technique: string }).technique.trim()
                : '';
            if (!endpoint || !technique) continue;
            const key = `${endpoint}:${technique}`;
            const lastAt = typeof (failure as { failedAt?: unknown }).failedAt === 'number'
                ? (failure as { failedAt: number }).failedAt
                : 0;
            const reason = typeof (failure as { reason?: unknown }).reason === 'string'
                ? (failure as { reason: string }).reason.trim()
                : '';
            const existing = avoidRetryMap.get(key);
            if (!existing) {
                avoidRetryMap.set(key, {
                    endpoint,
                    technique,
                    result: 'failed',
                    count: 1,
                    reason,
                    lastAt,
                });
                continue;
            }
            existing.result = existing.result === 'blocked' ? 'blocked' : 'failed';
            existing.reason = reason || existing.reason;
            existing.lastAt = Math.max(existing.lastAt, lastAt);
        }
    }

    const avoidRetries = Array.from(avoidRetryMap.values())
        .sort((left, right) => {
            const byPriority = getAttemptPriority(left.result) - getAttemptPriority(right.result);
            if (byPriority !== 0) return byPriority;
            if (right.count !== left.count) return right.count - left.count;
            return right.lastAt - left.lastAt;
        })
        .slice(0, 5)
        .map((entry) => {
            const reasonPart = entry.reason ? ` reason=${compactReason(entry.reason)}` : '';
            return `- ${entry.result} ${entry.technique} @ ${entry.endpoint} x${entry.count}${reasonPart}`;
        });

    const recentFacts = Array.isArray(memory.discoveredFacts)
        ? memory.discoveredFacts
            .slice()
            .sort((left, right) => (right.discoveredAt ?? 0) - (left.discoveredAt ?? 0))
            .slice(0, 3)
            .map((fact) => `- ${fact.category} ${formatFactPreview(fact.value)}`)
        : [];

    const sections = [summary];
    if (recentFacts.length > 0) {
        sections.push(`recent_facts:\n${recentFacts.join('\n')}`);
    }
    if (avoidRetries.length > 0) {
        sections.push(`avoid_retries:\n${avoidRetries.join('\n')}`);
    }

    return sections.join('\n');
};

const formatWorkerTaskSummary = (sessionState: SessionState): string => {
    const tasks = Array.isArray(sessionState.workerTasks) ? sessionState.workerTasks : [];
    if (tasks.length === 0) {
        return '';
    }

    return tasks
        .slice()
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .map((task) => {
            const canonicalWorkerType = normalizeWorkerType(task.workerType) ?? task.workerType;
            const mode = typeof task.executionMode === 'string' ? `/${task.executionMode}` : '';
            const dependencyMode = typeof task.dependencyMode === 'string' ? `/${task.dependencyMode}` : '';
            const planStep = typeof task.planStepId === 'string' && task.planStepId.trim().length > 0
                ? ` planStep=${task.planStepId.trim()}`
                : '';
            const summary = typeof task.summary === 'string' && task.summary.trim().length > 0
                ? ` => ${task.summary.trim()}`
                : '';
            const handoffManifest = typeof task.artifact?.parentReadableManifestPath === 'string' &&
                task.artifact.parentReadableManifestPath.trim().length > 0
                ? ` handoff_manifest=${task.artifact.parentReadableManifestPath.trim()}`
                : '';
            const handoffEvidence = Array.isArray(task.artifact?.parentReadableEvidenceRefs) &&
                task.artifact.parentReadableEvidenceRefs.length > 0
                ? ` handoff_evidence=${task.artifact.parentReadableEvidenceRefs.slice(0, 3).join(',')}`
                : '';
            const mission = task.mission ? ` mission="${compactReason(task.mission.question)}"` : '';
            const statusReason = typeof task.lastStatusReason === 'string' && task.lastStatusReason.trim().length > 0
                ? ` (${compactReason(task.lastStatusReason.trim())})`
                : '';
            return `- ${task.taskId} [${task.status}${mode}${dependencyMode}] ${canonicalWorkerType}:${planStep ? `${planStep}` : ''} ${task.reason}${mission}${summary}${statusReason}${handoffManifest}${handoffEvidence}`;
        })
        .join('\n');
};

const formatWorkerCoverageSnapshot = (sessionState: SessionState): string => {
    if (formatWorkspaceModelRecitation(sessionState)) {
        return '';
    }
    if (!hasWorkerSpawningAvailable(sessionState)) {
        return '';
    }

    const tasks = Array.isArray(sessionState.workerTasks) ? sessionState.workerTasks : [];
    if (tasks.length === 0) {
        return 'No worker tasks yet. Stay direct until a bounded specialist would materially improve coverage, confidence, or speed.';
    }

    const counts = {
        running: tasks.filter((task) => task.status === 'running').length,
        blocked: tasks.filter((task) => task.status === 'blocked').length,
        awaiting: tasks.filter((task) => task.status === 'awaiting_input' || task.status === 'awaiting_approval').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
        failed: tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled').length,
        dependency: tasks.filter((task) => task.dependencyMode === 'dependency').length,
        sidecar: tasks.filter((task) => (task.dependencyMode ?? 'sidecar') === 'sidecar').length,
    };

    const latest = tasks
        .slice()
        .sort((left, right) => (right.lastUpdatedAt ?? right.createdAt ?? 0) - (left.lastUpdatedAt ?? left.createdAt ?? 0))
        .slice(0, 3)
        .map((task) => {
            const canonicalWorkerType = normalizeWorkerType(task.workerType) ?? task.workerType;
            const summary = typeof task.summary === 'string' && task.summary.trim().length > 0
                ? compactReason(task.summary.trim())
                : typeof task.lastStatusReason === 'string' && task.lastStatusReason.trim().length > 0
                    ? compactReason(task.lastStatusReason.trim())
                    : 'no summary yet';
            const mission = task.mission ? ` mission=${compactReason(task.mission.question)}` : '';
            return `- ${canonicalWorkerType} ${task.taskId}: ${task.status}${mission} -> ${summary}`;
        });

    return [
        `- total=${tasks.length}, running=${counts.running}, blocked=${counts.blocked}, awaiting=${counts.awaiting}, completed=${counts.completed}, failed_or_cancelled=${counts.failed}, dependency=${counts.dependency}, sidecar=${counts.sidecar}`,
        latest.length > 0 ? 'Latest worker outcomes:' : '',
        ...latest,
        '- Use this snapshot to decide whether the next move should be direct work, a follow-up worker instruction, a blocking wait, or wrap-up.',
        '- Avoid duplicating a running dependency worker. Either do non-overlapping work or wait for the dependency when it gates the path.',
    ]
        .filter(Boolean)
        .join('\n');
};

const formatCoordinationSection = (sessionState: SessionState): string => {
    const coordination = sessionState.coordination;
    if (coordination?.role === 'worker') {
        const activeCoordination = coordination;
        const workerType = activeCoordination.workerType
            ? getWorkerTemplate(activeCoordination.workerType)
            : undefined;
        const writeScope = Array.isArray(activeCoordination.writeScope) && activeCoordination.writeScope.length > 0
            ? activeCoordination.writeScope.join(', ')
            : 'none';
        return [
            `- You are a bounded worker session for parent session ${activeCoordination.parentSessionId ?? 'unknown'}.`,
            workerType ? `- Worker type: ${workerType.label}.` : '- Worker type: specialized worker.',
            activeCoordination.expectedArtifactType
                ? `- Expected artifact: ${activeCoordination.expectedArtifactType}.`
                : '- Expected artifact: structured worker result.',
            `- Allowed write scope: ${writeScope}.`,
            '- Do not delegate further.',
            workerType?.workerType === 'validator_worker'
                ? '- If you independently confirm a real issue and report_finding is available, file it before submit_worker_result. Otherwise return your work through submit_worker_result.'
                : '- Return your work through submit_worker_result. Do not try to finalize the whole run from this session.',
        ].join('\n');
    }

    const securityops = isRecord(sessionState.flags?.securityops) ? sessionState.flags.securityops : undefined;
    const activePhaseKey = typeof securityops?.activePhaseKey === 'string'
        ? securityops.activePhaseKey.trim().toLowerCase()
        : '';

    if (hasWorkerSpawningAvailable(sessionState)) {
        const parentOwnership =
            activePhaseKey && activePhaseKey !== 'reporting'
                ? '- Keep synthesis and phase handoff in the parent session. Do not take final reporting responsibilities outside the reporting phase.'
                : '- Keep synthesis, approvals, strategic notes, and final reporting in the parent session.';
        return [
            '- You are the root execution session for this run.',
            '- Decide directly whether the next step is best handled here or by a bounded worker.',
            parentOwnership,
            '- Use workers only when they materially improve coverage, confidence, or speed over direct work.',
            '- Make every worker instruction self-contained: exact target, concrete hypothesis, expected artifact, and done condition.',
            '- Validator workers may file report_finding only for issues they independently confirm with durable evidence.',
        ].join('\n');
    }

    if (sessionState.agentType === 'executor') {
        const executorOwnership =
            activePhaseKey && activePhaseKey !== 'reporting'
                ? '- Own this active phase only: canonical writes, evidence, blockers, checkpoints, and phase handoff.'
                : '- Own discovery, validation, strategic notes, findings, and final reporting in this session.';
        return [
            '- You are the primary execution agent for this run.',
            '- Work directly with the available hands-on tools unless an approval, user-action, or safety boundary blocks you.',
            executorOwnership,
        ].join('\n');
    }

    return '';
};

const formatDelegationPlaybook = (sessionState: SessionState): string => {
    if (!hasWorkerSpawningAvailable(sessionState)) {
        return '';
    }

    return [
        '- Workers do not see the user conversation. Every worker instruction must be self-contained with the exact target, concrete hypothesis, expected artifact type, and explicit done condition.',
        '- Prefer direct work for trivial reads, one-off commands, or reasoning that depends on your current session context.',
        '- Prefer executionMode="background" for independent parallel work. Use executionMode="blocking" only when the worker result gates the next decision.',
        '- Use dependencyMode="dependency" when the worker result gates your next move. Use dependencyMode="sidecar" for parallel branches.',
        '- wait_for_worker is a plain state tool. Use it when an active worker gates the path or when you want to yield for the next worker update.',
        '- Use continue_worker when the same worker context is still useful: corrections, refined payloads, or narrower follow-up on the same path.',
        '- Spawn a fresh worker when the next step needs different specialization or fresh context.',
        '- In SecurityOps runs, every spawn_worker call must carry the current graph-lite mission envelope so the worker has the same question, required evidence, expected artifact, and stop condition.',
        '- For mission.assignedSkills, call list_relevant_skills for the exact worker task before choosing a methodology beyond the planner-assigned set. The runtime rejects non-phase-compatible slugs and the worker receives only the selected methodology.',
        '- If the worker needs to save PoC scripts or local evidence, provide a narrow writeScope. Without writeScope, write-capable tools are withheld.',
        '- When a worker returns, read the artifact or manifest and synthesize the next instruction yourself. Do not hand interpretation to another worker.',
        '- The spawn_worker tool description is the source of truth for worker-role selection and arguments.',
    ].join('\n');
};

const formatDelegationActivationGuidance = (sessionState: SessionState): string => {
    if (!hasWorkerSpawningAvailable(sessionState)) {
        return '';
    }

    const guidance = sessionState.flags?.delegationActivationGuidance;
    return typeof guidance === 'string' ? guidance : '';
};

const formatActivePhaseGuidance = (sessionState: SessionState): string | null => {
    const securityops = isRecord(sessionState.flags?.securityops) ? sessionState.flags.securityops : undefined;
    const activePhaseKey = typeof securityops?.activePhaseKey === 'string'
        ? securityops.activePhaseKey.trim().toLowerCase()
        : '';
    if (!activePhaseKey) {
        return null;
    }
    const checkpointAllowed = activePhaseKey === 'recon' || activePhaseKey === 'enumeration';
    const canRecordApproachNote =
        sessionState.toolPolicy?.allow?.includes('report_note') === true;
    return [
        `Active run phase: ${activePhaseKey}`,
        typeof securityops?.activePhaseId === 'string' ? `phaseId: ${securityops.activePhaseId}` : '',
        typeof securityops?.phaseOrdinal === 'number' ? `ordinal: ${securityops.phaseOrdinal}` : '',
        typeof sessionState.promptProfile === 'string' ? `promptProfile: ${sessionState.promptProfile}` : '',
        '- Follow the phase-specific Markdown prompt profile for responsibilities, exclusions, and exit behavior.',
        checkpointAllowed ? '- Use submit_phase_checkpoint only for restart-safe partial inventory before this phase is finished.' : '',
        checkpointAllowed
            ? '- In query_inventory, every versionAcquisition item is a bounded attack-surface objective. Try only its recommendedMethod, record the result with report_note(tech.fingerprint) or report_service using that exact versionReadMethod even when the version remains absent, and stop when status is exhausted. Never infer a version.'
            : '',
        '- Use submit_phase_handoff to close the active phase.',
        canRecordApproachNote
            ? '- Record dead ends with approach.tried or approach.blocker instead of looping.'
            : '- Capture blockers and unresolved questions in submit_phase_handoff instead of looping.',
    ].filter(Boolean).join('\n');
};

const getActiveSecurityOpsPhaseKey = (sessionState: SessionState): string | undefined => {
    const securityops = isRecord(sessionState.flags?.securityops) ? sessionState.flags.securityops : undefined;
    const value = securityops?.activePhaseKey;
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim().toLowerCase()
        : undefined;
};

const formatSecurityWorkflow = (sessionState: SessionState): string => {
    if (sessionState.agentType !== 'executor') {
        return '';
    }

    if (sessionState.coordination?.role === 'worker') {
        return '';
    }

    const phaseGuidance = formatActivePhaseGuidance(sessionState);
    if (phaseGuidance) {
        return phaseGuidance;
    }

    const lines = [
        '- Use report_finding to record candidate findings with evidence. report_finding is record-only and does not make a finding reportable.',
        '- Use promote_finding only after durable evidence satisfies the reportable gate.',
        '- Record meaningful pivots with report_note, approach.tried, or approach.blocker. First-class phase movement is owned by submit_phase_handoff in active phase sessions.',
        '- If shell_run returns a running jobId, use wait_for_shell_job before treating that scan output as evidence; unfinished scans make scan.coverage blocked, not completed.',
        '- Leave shell stderr visible; avoid 2>&1 unless a command specifically requires merged streams.',
        '- For deterministic discovery work, prefer one phase-sized shell_run that writes all planned artifacts, then one wait_for_shell_job, then the related ingest_scan_artifact calls together when they do not depend on each other.',
        '- For supported scanner artifacts, prefer writing them under /workspace/.artifacts/... and call ingest_scan_artifact after the scan completes. Use it for subfinder, naabu, httpx, nuclei, sqlmap, dalfox, semgrep, trivy, gitleaks, trufflehog, nmap, ffuf, katana, and openapi before manual inventory/finding fan-out, and do not duplicate rows already ingested from that artifact.',
        '- In query_inventory, every versionAcquisition item is a bounded attack-surface objective. Try only its recommendedMethod, record that exact versionReadMethod even when no version is found, stop when status is exhausted, and never infer a version.',
        '- Record dead ends and blockers with approach.tried or approach.blocker instead of looping on the same failing path.',
    ];
    if (hasWorkerSpawningAvailable(sessionState)) {
        lines.push(
            '- Use validator workers for independent confirmation when delegation is the cleaner path.',
            '- If a worker returned evidence refs, read those shared /workspace artifacts before rerunning the same path.',
        );
    }

    return lines.join('\n');
};

const formatToolCatalog = (tools: ToolDefinition[]): string =>
    tools
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => `- ${tool.name}: ${formatToolDescription(tool.description)}`)
        .join('\n');

const isResumablePlanStep = (item: PlanItem): boolean =>
    item.status === 'blocked' &&
    typeof item.blockedReason === 'string' &&
    item.blockedReason.includes('for resume');

const formatPlanMissionLines = (item: PlanItem): string[] => {
    if (!item.mission) {
        return [];
    }
    return renderMissionEnvelope(item.mission).map((line) => `  - ${line}`);
};

const formatPlanSection = (sessionState: SessionState): string =>
    getActiveSecurityOpsPhaseKey(sessionState) || sessionState.coordination?.role === 'worker'
        ? ''
        : sessionState.plan && sessionState.plan.length > 0
        ? (sessionState.plan as PlanItem[])
            .map((item: PlanItem) => {
                const details: string[] = [];
                if (typeof item.blockedReason === 'string' && item.blockedReason.trim().length > 0) {
                    details.push(`reason: ${item.blockedReason.trim()}`);
                }
                if (typeof item.checkpointId === 'string' && item.checkpointId.trim().length > 0) {
                    details.push(`checkpoint: ${item.checkpointId.trim()}`);
                }
                return [
                    `- [${item.status}] ${item.id}: ${item.title}${details.length > 0 ? ` (${details.join('; ')})` : ''}`,
                    ...formatPlanMissionLines(item),
                ].join('\n');
            })
            .join('\n')
        : 'No current plan';

const formatScratchTodosSection = (sessionState: SessionState): string => {
    const todos = sessionState.scratchTodos ?? [];
    if (todos.length === 0) {
        return '';
    }
    return [
        'These are executor working notes. They do not count toward approved-plan completion. Use plan_set_step_status to update approved mission state.',
        ...todos.map((todo) => {
            const details = typeof todo.notes === 'string' && todo.notes.trim().length > 0
                ? ` (${todo.notes.trim()})`
                : '';
            return `- [${todo.status}] ${todo.id}: ${todo.content}${details}`;
        }),
    ].join('\n');
};

const formatPlanHint = (sessionState: SessionState): string => {
    if (!sessionState.plan || sessionState.plan.length === 0) {
        return '';
    }

    if (sessionState.coordination?.role === 'worker' || isReportingRecipient(sessionState)) {
        return '';
    }

    const activePhaseKey = getActiveSecurityOpsPhaseKey(sessionState);

    const hints = [
        `- Use the plan step IDs exactly as given: ${sessionState.plan
            .map((item) => item.id)
            .join(', ')}. Do not invent new IDs or use titles.`,
    ];
    const startingStep = selectStartingPlanTask({ plan: sessionState.plan });
    if (startingStep?.stepId) {
        hints.push(
            activePhaseKey
                ? `- Start with ${startingStep.stepId}. Its complete mission contract is in TARGET CONTEXT; do not widen or repeat it.`
                : `- Start with ${startingStep.stepId}: ${startingStep.title}. Do not jump ahead unless it becomes completed or blocked.`,
        );
        if (!activePhaseKey && startingStep.mission) {
            hints.push(`- Current mission question: ${startingStep.mission.question}`);
            hints.push(`- Current mission expected artifact: ${startingStep.mission.expectedArtifact}`);
            hints.push(`- Current mission stop condition: ${startingStep.mission.stopCondition}`);
            const assignedSkills = Array.isArray(startingStep.mission.assignedSkills)
                ? startingStep.mission.assignedSkills.filter((skill) => typeof skill === 'string' && skill.trim().length > 0)
                : [];
            if (assignedSkills.length > 0) {
                hints.push(`- Current mission skills: ${assignedSkills.join(', ')}`);
                for (const skill of assignedSkills) {
                    hints.push(`- Current mission methodology path: /workspace/.skills/${skill}/methodology.md`);
                }
                hints.push('- Read methodology only for the current mission skills you are about to use.');
            }
        }
    }
    const resumableStep = sessionState.plan.find((item) => isResumablePlanStep(item));
    if (resumableStep) {
        const checkpointHint =
            typeof resumableStep.checkpointId === 'string' && resumableStep.checkpointId.trim().length > 0
                ? ` Latest checkpoint: ${resumableStep.checkpointId.trim()}.`
                : '';
        hints.push(`- Resume from blocked step ${resumableStep.id} before starting later steps.${checkpointHint}`);
    }

    return hints.join('\n');
};

const formatRunCompletion = (sessionState: SessionState): string => {
    if (sessionState.agentType !== 'executor' || sessionState.coordination?.role === 'worker') {
        return '';
    }

    const securityops = isRecord(sessionState.flags?.securityops)
        ? sessionState.flags.securityops
        : undefined;
    if (!securityops || typeof securityops.runId !== 'string') {
        return '';
    }

    const activePhaseKey = getActiveSecurityOpsPhaseKey(sessionState);
    if (activePhaseKey && activePhaseKey !== 'reporting') {
        return '';
    }

    const stored = isRecord(securityops.runCompletion) ? securityops.runCompletion : undefined;
    const finalized = stored?.state === 'completed' || typeof securityops.finalizedAt === 'string';
    const incompletePlanSteps = (sessionState.plan ?? []).filter((step) => step.status !== 'completed');
    const candidateCount =
        typeof securityops.candidateFindingCount === 'number' ? securityops.candidateFindingCount : 0;
    const reportableCount =
        typeof securityops.reportableFindingCount === 'number' ? securityops.reportableFindingCount : 0;
    const validatingCount =
        typeof securityops.validatingFindingCount === 'number' ? securityops.validatingFindingCount : 0;
    const storedReasons = Array.isArray(stored?.reasons)
        ? stored.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
        : [];
    const reasons = storedReasons.length > 0
        ? storedReasons
        : [
            incompletePlanSteps.length > 0 ? `${incompletePlanSteps.length} plan step(s) are not completed` : '',
            candidateCount > 0 ? `${candidateCount} candidate finding(s) still need promote_finding or interim closeout` : '',
            validatingCount > 0 ? `${validatingCount} finding(s) under validator review — wait for submit_validation_outcome or use interim closeout` : '',
        ].filter(Boolean);
    const ready = !finalized && incompletePlanSteps.length === 0 && candidateCount === 0 && validatingCount === 0;
    const state = finalized
        ? 'completed'
        : typeof stored?.state === 'string'
            ? stored.state
            : ready
                ? 'ready_for_finalization'
                : 'not_ready';

    return [
        `RunCompletion.state = ${state}`,
        `reportable_findings = ${reportableCount}`,
        `candidate_findings = ${candidateCount}`,
        reasons.length > 0 ? 'reasons:' : '',
        ...reasons.map((reason) => `- ${reason}`),
        '- You may stop only after authored summary.md/report.md exist and finalize_run_artifacts returns success.',
        '- Use mode="final" only when RunCompletion is ready. Use mode="interim" for blocked or partial closeout.',
    ].filter(Boolean).join('\n');
};

const formatExecutionTurnContract = (sessionState: SessionState): string =>
    sessionState.agentType === 'executor' && sessionState.coordination?.role !== 'worker'
        ? [
            '- When starting a new task, pivoting to a different approach, or hitting a blocker, write 1-2 sentences explaining what you are doing and why before the first tool call of that phase.',
            '- Prefer concise narration at task transitions; do not narrate before every individual tool call.',
            '- If worker tasks already exist, read their latest state before opening a new branch so you converge on the highest-value next move.',
        ].join('\n')
        : '';

const formatAutomationContract = (sessionState: SessionState): string => {
    if (sessionState.mode !== 'automated') {
        return '';
    }

    if (sessionState.coordination?.role === 'worker') {
        return [
            '- You are running in automated worker mode.',
            '- Keep working until the delegated task is complete, decisively blocked, or informative enough to hand back.',
            '- Finish with submit_worker_result. Do not try to finalize the overall run from this session.',
        ].join('\n');
    }

    const requiresReport = shouldRequireReportForSession(sessionState);
    const securityops = isRecord(sessionState.flags?.securityops)
        ? sessionState.flags.securityops
        : undefined;
    const isSecurityOpsRun = sessionState.agentType === 'executor' && typeof securityops?.runId === 'string';
    const activePhaseKey = getActiveSecurityOpsPhaseKey(sessionState);
    const canRecordBlockerNote =
        sessionState.toolPolicy?.allow?.includes('report_note') === true;
    const hardExecutorRule = isSecurityOpsRun
        ? [
            '- Every output MUST contain at least one tool call. A reply without a tool call halts your work.',
            '- If you have nothing to do, call submit_phase_checkpoint where available or submit_phase_handoff with a blocker reason.',
            '- If you need to think, that thinking belongs inside the next tool call arguments or reasoning, not as a standalone narration turn.',
        ]
        : [
            '- You are running in fully automated mode. There is no human present to read intermediate messages.',
            '- If useful work remains and you can proceed, keep the turn moving with a tool call.',
            '- Do not end a turn with empty output. If you cannot proceed, record the blocker and stop cleanly.',
        ];
    return [
        ...hardExecutorRule,
        isSecurityOpsRun && activePhaseKey && activePhaseKey !== 'reporting'
            ? '- Finish this phase with submit_phase_handoff. Do not prepare final report artifacts outside the reporting phase.'
            : isSecurityOpsRun
            ? '- Finish the session by preparing report context, writing summary.md/report.md, then calling finalize_run_artifacts after RunCompletion is ready, or with mode="interim" when blocked.'
            : requiresReport
            ? '- Finish the session with report.md in the workspace root.'
            : '- Finish planning with submit_plan when the plan is ready.',
        canRecordBlockerNote
            ? '- If you are blocked by a missing prerequisite, call report_note with ntype="approach.blocker" to record it, then stop. Do not loop on a blocked path.'
            : '- If a required prerequisite is missing and no available tool can record it, stop cleanly instead of looping or inventing context.',
        '- Do not repeat the same failing tool call with identical arguments. Change the approach, change the inputs, or stop cleanly.',
    ].join('\n');
};

const readTestingPostureFromSession = (sessionState?: SessionState): string | undefined => {
    if (!sessionState) {
        return undefined;
    }
    const securityops = isRecord(sessionState.flags?.securityops)
        ? sessionState.flags.securityops
        : undefined;
    const flagValue = typeof securityops?.testingPosture === 'string'
        ? securityops.testingPosture
        : typeof securityops?.testingMode === 'string'
            ? securityops.testingMode
            : undefined;
    if (flagValue?.trim()) {
        return flagValue.trim().toLowerCase();
    }
    const match = sessionState.extraContext?.match(/Testing Posture:\s*([A-Za-z-]+)/i);
    return match?.[1]?.trim().toLowerCase();
};

const formatTestingModePolicy = (sessionState?: SessionState): string => {
    if (sessionState && isReportingRecipient(sessionState)) {
        return '';
    }
    const posture = readTestingPostureFromSession(sessionState);
    if (!posture) {
        return '';
    }
    // The black-box line and the white-box "Target Map" line are adapted from Strix's system prompt
    // (https://github.com/usestrix/strix, Apache-2.0, Copyright 2025 OmniSecure Inc.); changed by
    // NullSquare, Inc. See NOTICE.
    if (posture === 'black-box' || posture === 'blackbox') {
        return [
            'Testing Mode: BLACK-BOX',
            'Focus on external reconnaissance and discovery. Test without source code knowledge. Use every available tool and technique. Do not stop until the authorized surface has been exhausted or a blocker is recorded.',
        ].join('\n');
    }
    if (posture === 'white-box' || posture === 'whitebox') {
        return [
            'Testing Mode: WHITE-BOX',
            'This remains a Pentest. Use source only for bounded route, control, and sink corroboration tied to a concrete runtime hypothesis, then validate dynamically. Do not perform repository-wide review, claim Code Review coverage, or turn static candidates into findings without the Pentest proof floor.',
        ].join('\n');
    }
    if (posture === 'multi-target' || posture === 'multitarget' || posture === 'gray-box' || posture === 'graybox') {
        return [
            `Testing Mode: ${posture.startsWith('gray') ? 'GRAY-BOX / MULTI-TARGET' : 'MULTI-TARGET'}`,
            'Build an internal Target Map at the start. Identify relationships across assets. Use bounded source context only to focus dynamic Pentest hypotheses; route repository-wide analysis to the standalone Code Review workflow.',
        ].join('\n');
    }
    return '';
};

const formatMandatoryOutputs = (sessionState: SessionState): string => {
    const isPlanner = sessionState.agentType === 'planner';
    const isWorker = sessionState.coordination?.role === 'worker';
    const artifacts = sessionState.flags ? sessionState.flags['artifacts'] : undefined;
    const hasSummary = Boolean(isRecord(artifacts) && artifacts['hasSummary']);
    const hasReport = Boolean(isRecord(artifacts) && artifacts['hasReport']);
    const securityops = isRecord(sessionState.flags?.securityops)
        ? sessionState.flags.securityops
        : undefined;

    if (isPlanner) {
        if (securityops?.runTrigger === 'exposure_verification') {
            return '- submit_exposure_verification: required to record the bound CVE verdict and end this verification run. Do not call submit_plan.';
        }
        return '- submit_plan: call submit_plan with { plan, skillSlugs? } when planning is complete.';
    }

    if (isWorker) {
        return '- submit_worker_result: call submit_worker_result with a structured artifact when the delegated task is complete.';
    }

    if (sessionState.agentType === 'executor' && typeof securityops?.runId === 'string') {
        const activePhaseKey = getActiveSecurityOpsPhaseKey(sessionState);
        if (activePhaseKey && activePhaseKey !== 'reporting') {
            const checkpointAllowed = activePhaseKey === 'recon' || activePhaseKey === 'enumeration';
            return [
                checkpointAllowed
                    ? '- submit_phase_checkpoint: optional, for restart-safe partial inventory before this phase is finished.'
                    : '',
                '- submit_phase_handoff: required to close the active phase before any next phase can start.',
            ].filter(Boolean).join('\n');
        }
        return [
            '- prepare_report_context: call this at reporting closeout to create .artifacts/report/brief.md and context.json.',
            '- summary.md/report.md: author both files manually from canonical state and the report context before stopping.',
            '- submit_phase_handoff: call this after summary.md/report.md are authored and before finalize_run_artifacts.',
            '- finalize_run_artifacts: call this after authored summary.md/report.md exist; it validates and publishes the files.',
        ].join('\n');
    }

    return [
        hasSummary
            ? '- summary.md: maintain and keep it updated as you work.'
            : '- summary.md: create if missing and keep it updated as you work.',
        hasReport
            ? '- report.md: maintain a thorough report in the workspace root.'
            : '- report.md: produce a thorough report in the workspace root when the task completes.',
    ].join('\n');
};

let builtInPromptSectionsRegistered = false;

const ensureBuiltInPromptSections = (): void => {
    if (builtInPromptSectionsRegistered) {
        return;
    }
    builtInPromptSectionsRegistered = true;

    promptSectionRegistry.registerStatic(({ basePrompt }) =>
        createPromptSection({
            key: 'role_prompt',
            kind: 'static',
            order: 10,
            content: basePrompt,
        }),
    );

    promptSectionRegistry.registerStatic(({ tools }) =>
        createPromptSection({
            key: 'tool_catalog',
            kind: 'static',
            order: 20,
            content: [
                'You have access to the following tools to help you complete tasks:',
                formatToolCatalog(tools) || '- No tools are available in this session.',
            ].join('\n'),
        }),
    );

    promptSectionRegistry.registerSoft(({ softContext }) =>
        createPromptSection({
            key: 'soft_context',
            kind: 'soft',
            order: 10,
            content: softContext || '',
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'target_context',
            kind: 'dynamic',
            order: 10,
            title: 'TARGET CONTEXT',
            content: sessionState.extraContext || '',
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'session_memory',
            kind: 'dynamic',
            order: 16,
            title: 'SESSION MEMORY (MUTABLE)',
            content: isReportingRecipient(sessionState) ? '' : formatCompactMemory(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'execution_mode',
            kind: 'dynamic',
            order: 15,
            title: 'EXECUTION MODE',
            content: sessionState.executionMode ? `- ${sessionState.executionMode}` : '',
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'coordination_contract',
            kind: 'dynamic',
            order: 18,
            title: 'COORDINATION CONTRACT',
            content: formatCoordinationSection(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'security_workflow',
            kind: 'dynamic',
            order: 19,
            title: 'SECURITY WORKFLOW',
            content: formatSecurityWorkflow(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'mandatory_outputs',
            kind: 'dynamic',
            order: 20,
            title: 'MANDATORY OUTPUTS',
            content: formatMandatoryOutputs(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'run_completion',
            kind: 'dynamic',
            order: 21,
            title: 'RUN COMPLETION',
            content: formatRunCompletion(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'workspace_projection_warning',
            kind: 'dynamic',
            order: 21.4,
            title: 'WORKSPACE PROJECTION WARNING',
            content: formatWorkspaceProjectionWarning(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'workspace_engagement_model',
            kind: 'dynamic',
            order: 21.5,
            title: 'WORKSPACE ENGAGEMENT MODEL',
            content: formatWorkspaceModelRecitation(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'delegation_playbook',
            kind: 'dynamic',
            order: 22,
            title: 'DELEGATION PLAYBOOK',
            content: formatDelegationPlaybook(sessionState),
        }),
    );

    promptSectionRegistry.registerStatic(({ sessionState }) =>
        createPromptSection({
            key: 'testing_mode_policy',
            kind: 'static',
            order: 15,
            title: 'TESTING MODE POLICY',
            content: formatTestingModePolicy(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'delegation_activation_guidance',
            kind: 'dynamic',
            order: 23,
            title: 'DELEGATION ACTIVATION GUIDANCE',
            content: formatDelegationActivationGuidance(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'execution_turn_contract',
            kind: 'dynamic',
            order: 25,
            title: 'EXECUTION TURN CONTRACT',
            content: formatExecutionTurnContract(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'automation_contract',
            kind: 'dynamic',
            order: 30,
            title: 'AUTOMATION CONTRACT',
            content: formatAutomationContract(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'plan_hint',
            kind: 'dynamic',
            order: 40,
            title: 'PLAN HINT',
            content: formatPlanHint(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'approved_plan',
            kind: 'dynamic',
            order: 50,
            title: 'APPROVED PLAN (PLANNER-OWNED)',
            content: formatPlanSection(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'working_todos',
            kind: 'dynamic',
            order: 51,
            title: 'WORKING TODOS (EXECUTOR SCRATCH)',
            content: formatScratchTodosSection(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'worker_tasks',
            kind: 'dynamic',
            order: 55,
            title: 'WORKER TASKS (MUTABLE)',
            content: formatWorkerTaskSummary(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'worker_coverage_snapshot',
            kind: 'dynamic',
            order: 56,
            title: 'WORKER COVERAGE SNAPSHOT',
            content: formatWorkerCoverageSnapshot(sessionState),
        }),
    );

    promptSectionRegistry.registerDynamic(({ sessionState }) =>
        createPromptSection({
            key: 'workspace_directory',
            kind: 'dynamic',
            order: 70,
            content: `Workspace directory: ${sessionState.workspaceDir || '/workspace'}`,
        }),
    );
};

export class SystemPromptBuilder {
    static buildStaticSections(
        basePrompt: string,
        tools: ToolDefinition[],
        sessionState?: SessionState,
    ): PromptSection[] {
        ensureBuiltInPromptSections();
        return promptSectionRegistry.buildStatic({ basePrompt, tools, sessionState });
    }

    static buildSoftSections(softContext?: string): PromptSection[] {
        ensureBuiltInPromptSections();
        return promptSectionRegistry.buildSoft({ softContext });
    }

    static buildDynamicSections(
        sessionState: SessionState,
    ): PromptSection[] {
        ensureBuiltInPromptSections();
        return promptSectionRegistry.buildDynamic({ sessionState });
    }

    static buildStatic(
        basePrompt: string,
        tools: ToolDefinition[],
        sessionState?: SessionState,
    ): string {
        return renderPromptSections(this.buildStaticSections(basePrompt, tools, sessionState));
    }

    static buildDynamic(
        sessionState: SessionState,
    ): string {
        return renderPromptSections(this.buildDynamicSections(sessionState));
    }
}
