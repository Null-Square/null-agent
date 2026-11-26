import type { SessionStore } from '../../core/SessionStore';
import { ToolPolicyChecker } from '../../tools/ToolPolicyChecker';
import type {
  MissionEnvelope,
  SessionState,
  ToolAccessPolicy,
  WorkerTaskRecord,
  WorkerType,
} from '../../../domain/types';
import { WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS } from '../../../domain/workers/workerContracts';
import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';
import {
  WORKER_PARENT_BLOCK_REASONS,
  WORKER_TOOL_SELF_DENY,
  chooseNarrowerNetwork,
  filterPatternsForTools,
  getActivePhaseKey,
  intersectHosts,
  unique,
} from './WorkerDelegationShared';

export class WorkerPolicyResolver {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly policyChecker: ToolPolicyChecker = new ToolPolicyChecker(),
  ) {}

  buildWorkerPolicy(parentPolicy: ToolAccessPolicy | undefined, allowedTools: string[]): ToolAccessPolicy {
    const deny = unique([...(parentPolicy?.deny ?? []), ...WORKER_TOOL_SELF_DENY]);
    const ask = filterPatternsForTools(parentPolicy?.ask, allowedTools, this.policyChecker);
    const allowlistHosts = intersectHosts(parentPolicy?.allowlist_hosts, undefined);
    const network = chooseNarrowerNetwork(parentPolicy?.network, undefined);

    return {
      allow: unique(allowedTools),
      ...(deny.length > 0 ? { deny } : {}),
      ...(ask ? { ask } : {}),
      ...(Array.isArray(parentPolicy?.rules) && parentPolicy.rules.length > 0 ? { rules: [...parentPolicy.rules] } : {}),
      ...(allowlistHosts ? { allowlist_hosts: allowlistHosts } : {}),
      ...(network ? { network } : {}),
    };
  }

  getAllowedWorkerTools(parentPolicy: ToolAccessPolicy | undefined, candidateTools: string[]): string[] {
    if (!parentPolicy) {
      return unique(candidateTools);
    }
    return unique(candidateTools.filter((tool) => this.policyChecker.isToolAllowedByPolicy(parentPolicy, tool)));
  }

  resolveLinkedPlanStepId(parentSession: SessionState, requestedPlanStepId?: string): string | undefined {
    if (typeof requestedPlanStepId === 'string' && requestedPlanStepId.trim().length > 0) {
      return requestedPlanStepId.trim();
    }

    const runningPlanSteps = parentSession.plan.filter((candidate) => candidate.status === 'running');
    if (runningPlanSteps.length === 1) {
      return runningPlanSteps[0].id;
    }

    if (
      runningPlanSteps.length === 0 &&
      typeof parentSession.currentPlanStepId === 'string' &&
      parentSession.currentPlanStepId.trim().length > 0
    ) {
      return parentSession.currentPlanStepId.trim();
    }
    return undefined;
  }

  assertPhaseWorkerAllowed(
    parentSession: SessionState,
    workerType: WorkerType,
    mission: MissionEnvelope | undefined,
  ): void {
    const activePhaseKey = getActivePhaseKey(parentSession.flags);
    if (!activePhaseKey) {
      return;
    }

    if (mission?.phase && mission.phase !== activePhaseKey) {
      throw new Error(
        `Worker mission phase "${mission.phase}" does not match active phase "${activePhaseKey}".`,
      );
    }

    const profile = phaseProfileRegistry.get(activePhaseKey);
    if (!profile.workerSpawning.allowed) {
      throw new Error(`Phase "${activePhaseKey}" does not allow worker delegation.`);
    }

    if (!profile.workerSpawning.allowedWorkerTypes.includes(workerType)) {
      throw new Error(
        `Worker type "${workerType}" is not allowed in phase "${activePhaseKey}". Allowed worker types: ${profile.workerSpawning.allowedWorkerTypes.join(', ') || 'none'}.`,
      );
    }
  }

  assertWorkerCanRunTurn(parentSessionId: string, task: WorkerTaskRecord, childSession: SessionState): void {
    const parentSession = this.requireSession(parentSessionId);
    const parentBlockedReason = typeof parentSession.blockedReason === 'string' ? parentSession.blockedReason : undefined;

    if (parentSession.pendingApproval || parentBlockedReason === 'awaiting_approval') {
      throw new Error(`Parent session ${parentSessionId} is awaiting approval; worker ${task.taskId} cannot continue.`);
    }
    if (parentBlockedReason && WORKER_PARENT_BLOCK_REASONS.has(parentBlockedReason)) {
      throw new Error(`Parent session ${parentSessionId} is blocked (${parentBlockedReason}); worker ${task.taskId} cannot continue.`);
    }

    if (childSession.pendingApproval || childSession.blockedReason === 'awaiting_approval') {
      throw new Error(`Worker ${task.taskId} is awaiting approval and cannot continue until that approval is resolved.`);
    }
    if (childSession.blockedReason && childSession.blockedReason !== 'deadlock') {
      throw new Error(`Worker ${task.taskId} is blocked (${childSession.blockedReason}) and cannot continue.`);
    }
  }

  isWorkerSkillRequiredToolSatisfied(workerToolPolicy: ToolAccessPolicy, tool: string): boolean {
    if (this.policyChecker.isToolAllowedByPolicy(workerToolPolicy, tool)) {
      return true;
    }

    // Canonical write tools are intentionally withheld from scoped workers because
    // they cannot be constrained by workspace path. A worker still satisfies those
    // methodology requirements by returning a structured handoff for the parent to
    // file through submit_worker_result.
    if (
      WORKER_WRITE_SCOPE_NO_PATH_WRITE_TOOLS.has(tool) &&
      this.policyChecker.isToolAllowedByPolicy(workerToolPolicy, 'submit_worker_result')
    ) {
      return true;
    }

    // wait_for_shell_job is the companion to shell_run. Some legacy parent
    // policies only allow shell_run; do not block skill assignment when the worker
    // can still execute bounded foreground shell work.
    if (
      tool === 'wait_for_shell_job' &&
      this.policyChecker.isToolAllowedByPolicy(workerToolPolicy, 'shell_run')
    ) {
      return true;
    }

    return false;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    return session;
  }
}
