import type { AppContext } from '../createAppContext';
import { createModelConfigPort } from '@/app/adapters/portFactories';
import { createAgentRepositories } from '@/app/services/agent/agentRepositories';
import type { AgentApiServices } from '@/app/services/agent/types';
import { db } from '@/db/client';
import type { CodeReviewContext } from '@/db/schema';
import type { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import type { SubscriptionPort } from '@/domains/agent-brain/ports';
import { CodeReviewFindingService } from '@/domains/security-ops/code-review/CodeReviewFindingService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import { RunService } from '@/domains/security-ops/runs/RunService';
import { securityOpsRunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
import {
  CODE_REVIEW_PLANNER_TOOL_POLICY,
  StartRunService,
  type StartPlannerRunResult,
} from '@/domains/security-ops/runs/StartRunService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { WorkspaceProjectionService } from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';
import { schedulingClassForPlan } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';

export type StandaloneCodeReviewStartInput = {
  orgId: string;
  userId: string;
  scopeId: string;
  goal: string;
  title?: string | null;
  modelId: string;
  codeReviewContext: CodeReviewContext;
  manifestFiles: Array<{ path: string; blobSha: string; size?: number | null }>;
  repositoryBrief?: string | null;
  securityOpsFlags?: Record<string, unknown>;
  autoApproveOnPlanning: boolean;
};

/**
 * Narrow trusted-sidecar façade over the organization-owned standalone Code
 * Review runtime. Persistence, phase orchestration, prompts, tools, and finding
 * semantics stay in the backend; sidecars receive no lower-level services.
 */
export class StandaloneCodeReviewRunRuntime {
  private readonly runService: RunService;
  private readonly phaseRepository = new RunPhaseRepository(db);
  private readonly findingService = new CodeReviewFindingService(db);
  private readonly startRunService: StartRunService;
  private readonly sessionRepository: SessionRepository;
  private readonly services: AgentApiServices;
  private readonly app: AppContext;
  private readonly subscriptionPort: SubscriptionPort;

  constructor(
    app: AppContext,
    subscriptionPort: SubscriptionPort,
  ) {
    const repositories = createAgentRepositories();
    this.app = app;
    this.subscriptionPort = subscriptionPort;
    this.services = app.agentServices;
    this.sessionRepository = repositories.sessionRepository;
    const scopeService = new ScopeService(db);
    this.runService = new RunService(
      db,
      new OrganizationService(db),
      scopeService,
      {
        sessionStatusPort: repositories.sessionRepository,
        skillContextService: securityOpsRunSkillContextService,
      },
    );
    const sessionService = new SessionService(
      app.agentServices.sessionStore,
      app.agentServices.sandboxProfileRegistry,
      app.agentServices.ports,
      app.agentServices.agentEngine,
      subscriptionPort,
      app.agentServices.policyResolver,
      createModelConfigPort(),
      app.agentServices.traceRecorder,
      repositories.sessionRepository,
      app.agentServices.policyFacade,
    );
    this.startRunService = new StartRunService({
      runService: this.runService,
      scopeService,
      runnerService: new RunnerService(db),
      sessionService,
      agentServices: app.agentServices,
      sessionRepository: repositories.sessionRepository,
      scopeAccessMaterialService: new ScopeAccessMaterialService(db),
      workspaceProjectionService: new WorkspaceProjectionService(db),
    });
  }

  async startRepositoryReview(input: StandaloneCodeReviewStartInput): Promise<StartPlannerRunResult> {
    const subscription = await this.subscriptionPort.resolveOrganizationSubscription({
      organizationId: input.orgId,
      userId: input.userId,
    });
    return this.startRunService.startPlannerRun({
      orgId: input.orgId,
      userId: input.userId,
      scopeId: input.scopeId,
      goal: input.goal,
      title: input.title,
      modelId: input.modelId,
      executionTarget: 'cloud',
      trigger: 'manual',
      toolPolicy: CODE_REVIEW_PLANNER_TOOL_POLICY,
      idempotency: 'disabled',
      securityOpsFlags: input.securityOpsFlags,
      workflowDiscipline: 'code_review',
      codeReviewOperation: 'repository_review',
      codeReviewContext: input.codeReviewContext,
      codeReviewManifestFiles: input.manifestFiles,
      codeReviewRepositoryBrief: input.repositoryBrief,
      plannerPromptProfile: 'code-review-planner',
      autoApproveOnPlanning: input.autoApproveOnPlanning,
      maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
      schedulingClass: schedulingClassForPlan(subscription.plan.slug),
    });
  }

  getRun(organizationId: string, runId: string) {
    return this.runService.getById(organizationId, runId);
  }

  listPhases(runId: string) {
    return this.phaseRepository.listByRunId(runId);
  }

  getEvents(runId: string) {
    return this.runService.getEvents(runId);
  }

  getBundle(organizationId: string, runId: string) {
    return this.findingService.getBundle({ organizationId, runId });
  }

  requestFix(input: Parameters<CodeReviewFindingService['requestFix']>[0]) {
    return this.findingService.requestFix(input);
  }

  /**
   * Stop the currently processing phase without allowing another model or
   * tool boundary to start. Durable controller provenance records the exact
   * sessions, so a restart cannot lose Stop ownership.
   */
  async stopRun(
    organizationId: string,
    runId: string,
    reason = 'standalone_code_review_stopped',
  ): Promise<void> {
    const run = await this.runService.getById(organizationId, runId);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return;
    }

    const activeSessions = this.app.sessionStore
      .listByRunId(runId)
      .filter((session) => session.stateMachine?.isProcessing() ?? false);
    try {
      await Promise.all(activeSessions.map(async (session) => {
        const stoppedAt = new Date().toISOString();
        const journalStopped = await this.services.sessionStore.recordStopRequestedAsync(
          session.id,
          reason,
          organizationId,
        );
        session.stateMachine?.stopProcessing(
          'user_paused',
          session.turn ?? 0,
          'standalone_code_review_runtime.stop',
        );
        session.blockedReason = 'user_paused';
        session.blockedMeta = {
          reason,
          runId,
          stoppedAt,
          source: 'standalone_code_review_runtime',
          controller: 'evaluation_lab',
          controllerId: runId,
        };
        await this.app.sessionStore.setAsync(
          session.id,
          session,
          'standalone_code_review_runtime.stopped',
        );
        if (!journalStopped) {
          await this.sessionRepository.setBlockedReason(session.id, 'user_paused', {
            reason,
            runId,
            stoppedAt,
            source: 'standalone_code_review_runtime',
            controller: 'evaluation_lab',
            controllerId: runId,
          });
        }
        await this.services.sessionStore.abortCurrentTurnAsync(session.id, reason);
        await this.services.agentEngine.stopSandbox(session, reason);
      }));
    } finally {
      // Never leave the durable product run claiming "running" after its
      // sessions received Stop markers, even if sandbox teardown reports an
      // error. A failed adapter Stop then escalates through disposal/cancel.
      await this.runService.transitionStatus(organizationId, runId, 'user_paused');
    }
  }

  /**
   * Start only sessions stopped by this runtime. The journal schedules each
   * session before the prerequisite projection is cleared; this method never
   * calls the agent directly.
   */
  async startRun(organizationId: string, runId: string): Promise<void> {
    const sessionIds = await this.sessionRepository.listIdsByRunId(runId);
    let scheduled = 0;
    for (const sessionId of sessionIds) {
      const started = await this.services.sessionStore.recordStartRequestedAsync(
        sessionId,
        `evaluation lab run ${runId} started`,
        organizationId,
      );
      if (started) scheduled += 1;
    }

    if (scheduled === 0) {
      await this.runService.transitionStatus(organizationId, runId, 'running');
      const run = await this.runService.getById(organizationId, runId);
      await this.startRunService.startReadyPhaseForRun({
        orgId: organizationId,
        runId,
        userId: run.userId,
      });
    }
  }

  /**
   * Cancel both durable run state and live work. RunService owns run/phase
   * terminalization; abortLiveRunSessions owns in-memory turn controllers,
   * sandboxes, and workspaces.
   */
  async cancelRun(
    organizationId: string,
    runId: string,
    reason = 'standalone_code_review_cancelled',
  ): Promise<void> {
    try {
      await abortLiveRunSessions({
        runId,
        services: this.services,
        sessionRepository: this.sessionRepository,
        caller: reason,
      });
    } finally {
      // Durable terminalization must still happen if one live cleanup call
      // fails; otherwise the UI can remain "running" after spend has stopped.
      await this.runService.cancel(organizationId, runId);
    }
  }
}

export const createStandaloneCodeReviewRunRuntime = (
  app: AppContext,
  subscriptionPort: SubscriptionPort,
): StandaloneCodeReviewRunRuntime =>
  new StandaloneCodeReviewRunRuntime(app, subscriptionPort);
