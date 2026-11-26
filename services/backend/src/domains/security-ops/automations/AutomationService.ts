import CronExpressionParser from 'cron-parser';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  automations,
  automationRuns,
  findings,
  runs,
  scopes,
  type AutomationWorkflowDiscipline,
  type AutomationEventType,
  type AutomationRow,
  type TriggerConfig,
  type RunTrigger,
} from '@/db/schema';
import { isComplianceFrameworkKey } from '@/domains/security-ops/compliance/profile';
import { AppError, ERROR_CODES, toAppError } from '@/shared/errors';
import {
  normalizeExecutionTarget,
  type ExecutionTarget,
} from '@/domains/security-ops/runs/executionTargets';
import type { ComplianceFrameworkKey, ModelCategory } from '@null-ai/contracts';
import type { ExecutionSelection } from '@/domains/agent-brain/domain/runtime/ExecutionRuntimeRegistry';

type AutomationTriggerType = 'scheduled' | 'continuous' | 'event';
type RunTriggerType = RunTrigger;
type AutomationEventFilter = Record<string, unknown> & {
  goal_contains?: string;
  confidence_below?: number | string;
};

export type SecurityOpsEvent = {
  type: AutomationEventType;
  payload: Record<string, unknown>;
};

export type AutomationRunExecutor = (params: {
  orgId: string;
  userId: string;
  scopeId: string;
  goal: string;
  modelId?: string | null;
  modelCategory?: ModelCategory | null;
  workflowDiscipline?: AutomationWorkflowDiscipline;
  complianceFrameworkKey?: ComplianceFrameworkKey | null;
  executionTarget?: ExecutionTarget;
  trigger: RunTriggerType;
  vars?: Record<string, unknown>;
  executionSelection?: ExecutionSelection;
}) => Promise<{
  run: {
    id: string;
    displayId?: number | null;
    status: string;
    scopeId: string;
    goal: string;
    createdAt: Date;
  };
  sessionId: string | null;
}>;

type AutomationServiceDeps = {
  db: DatabaseClient;
  runExecutor?: AutomationRunExecutor;
};

type AutomationScopeAssignment = {
  id: string;
  complianceFrameworks: ComplianceFrameworkKey[];
};

export type AutomationListFilters = {
  scopeId?: string;
  isActive?: boolean;
  triggerType?: AutomationTriggerType;
};

export type AutomationListItem = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  scopeId: string;
  scopeName: string;
  modelId: string | null;
  modelCategory: ModelCategory | null;
  workflowDiscipline: AutomationWorkflowDiscipline;
  complianceFrameworkKey: ComplianceFrameworkKey | null;
  executionTarget: ExecutionTarget;
  goal: string;
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig;
  isActive: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  deferredReason: string | null;
  deferredAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationDetail = AutomationListItem & {
  runs: Array<{
    id: string;
    runId: string;
    triggeredAt: Date;
    triggerReason: string | null;
    runStatus: string | null;
    runDisplayId: number | null;
    runCreatedAt: Date | null;
  }>;
};

const EVENT_DEBOUNCE_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asStringRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, unknown] => typeof entry[0] === 'string');
  return Object.fromEntries(entries);
};

const parseNumberLike = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolvePayloadConfidence = (payload: Record<string, unknown>): number | null => {
  for (const key of ['confidenceScore', 'confidence_score', 'confidence']) {
    const parsed = parseNumberLike(payload[key]);
    if (parsed !== null) return parsed;
  }
  return null;
};

const matchesFilter = (
  filter: AutomationEventFilter | undefined,
  payload: Record<string, unknown>,
  resolveConfidenceFromFindingId?: (findingId: string) => Promise<number | null>,
): Promise<boolean> => {
  if (!filter) return Promise.resolve(true);
  return (async () => {
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'goal_contains') {
        if (typeof value !== 'string' || value.trim().length === 0) return false;
        const payloadGoal = typeof payload.goal === 'string' ? payload.goal : null;
        if (!payloadGoal) return false;
        if (!payloadGoal.toLowerCase().includes(value.trim().toLowerCase())) return false;
        continue;
      }

      if (key === 'confidence_below') {
        const threshold = parseNumberLike(value);
        if (threshold === null) return false;

        let confidence = resolvePayloadConfidence(payload);
        const findingId = typeof payload.findingId === 'string' ? payload.findingId : undefined;
        if (confidence === null && findingId && resolveConfidenceFromFindingId) {
          confidence = await resolveConfidenceFromFindingId(findingId);
        }
        if (confidence === null || confidence >= threshold) return false;
        continue;
      }

      if (value === null) {
        if (payload[key] !== null && payload[key] !== undefined) return false;
        continue;
      }

      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return false;
      }
      if (String(payload[key]) !== String(value)) {
        return false;
      }
    }

    return true;
  })();
};

const toTriggerType = (value: string): AutomationTriggerType => {
  if (value === 'scheduled' || value === 'continuous' || value === 'event') {
    return value;
  }
  throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Invalid triggerType');
};

const toWorkflowDiscipline = (
  value: unknown,
  fallback: AutomationWorkflowDiscipline = 'pentest',
): AutomationWorkflowDiscipline => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (value === 'pentest' || value === 'compliance') {
    return value;
  }
  throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'workflowDiscipline must be pentest or compliance');
};

const parseComplianceFrameworkKey = (value: unknown): ComplianceFrameworkKey => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_MISSING_REQUIRED,
      'complianceFrameworkKey is required for compliance automations',
    );
  }
  const normalized = value.trim();
  if (!isComplianceFrameworkKey(normalized)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'complianceFrameworkKey must be a supported compliance framework',
    );
  }
  return normalized;
};

const resolveAutomationWorkflow = (
  workflowDisciplineInput: unknown,
  complianceFrameworkKeyInput: unknown,
  scopeAssignment: AutomationScopeAssignment,
  existing?: Pick<AutomationRow, 'workflowDiscipline' | 'complianceFrameworkKey'>,
): {
  workflowDiscipline: AutomationWorkflowDiscipline;
  complianceFrameworkKey: ComplianceFrameworkKey | null;
} => {
  const workflowDiscipline = toWorkflowDiscipline(
    workflowDisciplineInput,
    toWorkflowDiscipline(existing?.workflowDiscipline ?? 'pentest'),
  );

  if (workflowDiscipline === 'pentest') {
    if (
      complianceFrameworkKeyInput !== undefined &&
      complianceFrameworkKeyInput !== null &&
      complianceFrameworkKeyInput !== ''
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'complianceFrameworkKey can only be set when workflowDiscipline is compliance',
      );
    }
    return { workflowDiscipline, complianceFrameworkKey: null };
  }

  const frameworkSource =
    complianceFrameworkKeyInput !== undefined
      ? complianceFrameworkKeyInput
      : existing?.complianceFrameworkKey;
  const complianceFrameworkKey = parseComplianceFrameworkKey(frameworkSource);
  if (!scopeAssignment.complianceFrameworks.includes(complianceFrameworkKey)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      'Compliance framework is not assigned to this scope',
    );
  }

  return {
    workflowDiscipline,
    complianceFrameworkKey,
  };
};

const toEventType = (value: unknown): AutomationEventType => {
  if (value === 'finding_created') return value;
  if (value === 'risk_state_changed') return value;
  if (value === 'run_completed') return value;
  if (value === 'asset_discovered') return value;
  if (value === 'runner_offline') return value;
  throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'Invalid event type');
};

const parseTriggerConfig = (
  triggerType: AutomationTriggerType,
  config: unknown,
): TriggerConfig => {
  if (!isRecord(config)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'triggerConfig must be an object');
  }

  if (triggerType === 'scheduled') {
    const cron = String(config.cron ?? '').trim();
    const timezone = String(config.timezone ?? 'UTC').trim() || 'UTC';
    if (!cron) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'triggerConfig.cron is required');
    }
    try {
      CronExpressionParser.parse(cron, {
        currentDate: new Date(),
        tz: timezone,
      });
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, `Invalid cron expression: ${cron}`);
    }
    return { type: 'scheduled', cron, timezone };
  }

  if (triggerType === 'continuous') {
    const raw = Number(config.intervalMinutes);
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'triggerConfig.intervalMinutes must be a positive number',
      );
    }
    return { type: 'continuous', intervalMinutes: Math.floor(raw) };
  }

  const eventType = toEventType(config.eventType);
  const filter = config.filter ? asStringRecord(config.filter) : undefined;
  if (filter && 'goal_contains' in filter) {
    const goalContainsFilter = filter.goal_contains;
    if (typeof goalContainsFilter !== 'string' || goalContainsFilter.trim().length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'triggerConfig.filter.goal_contains must be a string',
      );
    }
    filter.goal_contains = goalContainsFilter.trim().toLowerCase();
  }
  return {
    type: 'event',
    eventType,
    ...(filter && Object.keys(filter).length > 0 ? { filter } : {}),
  };
};

const buildTriggerReason = (
  triggerType: AutomationTriggerType,
  triggerConfig: TriggerConfig,
  eventType?: AutomationEventType,
): string => {
  if (triggerType === 'scheduled' && triggerConfig.type === 'scheduled') {
    return `Scheduled (${triggerConfig.cron} ${triggerConfig.timezone})`;
  }
  if (triggerType === 'continuous' && triggerConfig.type === 'continuous') {
    return `Continuous (${triggerConfig.intervalMinutes}m interval)`;
  }
  if (triggerType === 'event' && triggerConfig.type === 'event') {
    return `Event (${eventType ?? triggerConfig.eventType})`;
  }
  return `Automation (${triggerType})`;
};

const classifyDeferredRunnerReason = (error: AppError): string | null => {
  if (error.code !== ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED) {
    return null;
  }

  const reason = typeof error.context?.reason === 'string' ? error.context.reason : null;
  if (reason === 'RUNNER_OFFLINE' || reason === 'RUNNER_NOT_ASSIGNED' || reason === 'RUNNER_INCOMPATIBLE') {
    return 'runner_unavailable';
  }
  return null;
};

export class AutomationService {
  constructor(private readonly deps: AutomationServiceDeps) {}

  async countAutomations(orgId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(automations)
      .where(eq(automations.organizationId, orgId));

    return Number(row?.count ?? 0);
  }

  async createAutomation(
    orgId: string,
    userId: string,
    params: {
      name: string;
      description?: string;
      scopeId: string;
      modelId?: string | null;
      modelCategory?: ModelCategory | null;
      workflowDiscipline?: AutomationWorkflowDiscipline;
      complianceFrameworkKey?: ComplianceFrameworkKey | null;
      executionTarget?: ExecutionTarget;
      goal: string;
      triggerType: AutomationTriggerType;
      triggerConfig: unknown;
      isActive?: boolean;
    },
  ): Promise<AutomationListItem> {
    const name = params.name?.trim();
    if (!name) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'name is required');
    }
    const goal = params.goal?.trim();
    if (!goal) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'goal is required');
    }

    const scopeAssignment = await this.assertScopeOwned(orgId, params.scopeId);

    const triggerType = toTriggerType(params.triggerType);
    const triggerConfig = parseTriggerConfig(triggerType, params.triggerConfig);
    const workflow = resolveAutomationWorkflow(
      params.workflowDiscipline,
      params.complianceFrameworkKey,
      scopeAssignment,
    );
    const executionTarget = normalizeExecutionTarget(params.executionTarget);
    const isActive = params.isActive ?? true;
    const now = new Date();
    const nextRunAt = isActive ? this.calculateNextRunAt(triggerConfig) : null;

    const [row] = await this.deps.db
      .insert(automations)
      .values({
        organizationId: orgId,
        name,
        description: params.description?.trim() || null,
        scopeId: params.scopeId,
        modelId: params.modelId?.trim() || null,
        modelCategory: params.modelCategory ?? null,
        workflowDiscipline: workflow.workflowDiscipline,
        complianceFrameworkKey: workflow.complianceFrameworkKey,
        executionTarget,
        goal,
        triggerType,
        triggerConfig,
        isActive,
        nextRunAt,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapAutomationListItem(row.id, orgId);
  }

  async updateAutomation(
    orgId: string,
    automationId: string,
    params: Partial<{
      name: string;
      description: string;
      triggerType: AutomationTriggerType;
      triggerConfig: unknown;
      modelId: string | null;
      modelCategory: ModelCategory | null;
      workflowDiscipline: AutomationWorkflowDiscipline;
      complianceFrameworkKey: ComplianceFrameworkKey | null;
      executionTarget: ExecutionTarget;
      goal: string;
      scopeId: string;
      isActive: boolean;
    }>,
  ): Promise<AutomationListItem> {
    const existing = await this.getAutomationRow(orgId, automationId);
    const now = new Date();

    const triggerType = toTriggerType(params.triggerType ?? existing.triggerType);
    const triggerConfig =
      params.triggerConfig !== undefined
        ? parseTriggerConfig(triggerType, params.triggerConfig)
        : (existing.triggerConfig as TriggerConfig);
    const executionTarget =
      params.executionTarget !== undefined
        ? normalizeExecutionTarget(params.executionTarget)
        : normalizeExecutionTarget(existing.executionTarget);
    const scopeAssignment = await this.assertScopeOwned(orgId, params.scopeId ?? existing.scopeId);
    const workflow = resolveAutomationWorkflow(
      params.workflowDiscipline,
      params.complianceFrameworkKey,
      scopeAssignment,
      existing,
    );

    if (params.goal !== undefined && params.goal.trim().length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'goal cannot be empty');
    }
    const isActive = params.isActive ?? existing.isActive;
    const shouldRecalcNextRun =
      params.triggerType !== undefined ||
      params.triggerConfig !== undefined ||
      params.isActive !== undefined;

    const nextRunAt = shouldRecalcNextRun
      ? isActive
        ? this.calculateNextRunAt(triggerConfig, existing.lastRunAt ?? undefined)
        : null
      : existing.nextRunAt;

    await this.deps.db
      .update(automations)
      .set({
        ...(params.name !== undefined ? { name: params.name.trim() } : {}),
        ...(params.description !== undefined ? { description: params.description.trim() || null } : {}),
        ...(params.scopeId !== undefined ? { scopeId: params.scopeId } : {}),
        ...(params.modelId !== undefined ? { modelId: params.modelId?.trim() || null } : {}),
        ...(params.modelCategory !== undefined ? { modelCategory: params.modelCategory ?? null } : {}),
        ...(
          params.workflowDiscipline !== undefined || params.complianceFrameworkKey !== undefined
            ? {
                workflowDiscipline: workflow.workflowDiscipline,
                complianceFrameworkKey: workflow.complianceFrameworkKey,
              }
            : {}
        ),
        ...(params.executionTarget !== undefined ? { executionTarget } : {}),
        ...(params.goal !== undefined ? { goal: params.goal.trim() } : {}),
        ...(params.triggerType !== undefined ? { triggerType } : {}),
        ...(params.triggerConfig !== undefined ? { triggerConfig } : {}),
        ...(params.isActive !== undefined ? { isActive } : {}),
        ...(shouldRecalcNextRun ? { nextRunAt } : {}),
        updatedAt: now,
      })
      .where(eq(automations.id, existing.id));

    return this.mapAutomationListItem(existing.id, orgId);
  }

  async deleteAutomation(orgId: string, automationId: string): Promise<void> {
    const deleted = await this.deps.db
      .delete(automations)
      .where(and(eq(automations.id, automationId), eq(automations.organizationId, orgId)))
      .returning({ id: automations.id });

    if (deleted.length === 0) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Automation not found');
    }
  }

  async listAutomations(orgId: string, filters?: AutomationListFilters): Promise<AutomationListItem[]> {
    const conditions = [eq(automations.organizationId, orgId)];
    if (filters?.scopeId) {
      conditions.push(eq(automations.scopeId, filters.scopeId));
    }
    if (typeof filters?.isActive === 'boolean') {
      conditions.push(eq(automations.isActive, filters.isActive));
    }
    if (filters?.triggerType) {
      conditions.push(eq(automations.triggerType, filters.triggerType));
    }

    const rows = await this.deps.db
      .select({ id: automations.id })
      .from(automations)
      .where(and(...conditions))
      .orderBy(desc(automations.createdAt));

    if (rows.length === 0) return [];
    return Promise.all(rows.map((row) => this.mapAutomationListItem(row.id, orgId)));
  }

  async getAutomation(orgId: string, automationId: string): Promise<AutomationDetail> {
    const item = await this.mapAutomationListItem(automationId, orgId);
    const rows = await this.deps.db
      .select({
        id: automationRuns.id,
        runId: automationRuns.runId,
        triggeredAt: automationRuns.triggeredAt,
        triggerReason: automationRuns.triggerReason,
        runStatus: runs.status,
        runDisplayId: runs.displayId,
        runCreatedAt: runs.createdAt,
      })
      .from(automationRuns)
      .leftJoin(runs, eq(runs.id, automationRuns.runId))
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.triggeredAt))
      .limit(100);

    return {
      ...item,
      runs: rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        triggeredAt: row.triggeredAt,
        triggerReason: row.triggerReason ?? null,
        runStatus: row.runStatus ?? null,
        runDisplayId: row.runDisplayId ?? null,
        runCreatedAt: row.runCreatedAt ?? null,
      })),
    };
  }

  async toggleActive(orgId: string, automationId: string): Promise<AutomationListItem> {
    const existing = await this.getAutomationRow(orgId, automationId);
    const triggerConfig = existing.triggerConfig as TriggerConfig;
    const nextIsActive = !existing.isActive;
    const now = new Date();

    await this.deps.db
      .update(automations)
      .set({
        isActive: nextIsActive,
        nextRunAt: nextIsActive ? this.calculateNextRunAt(triggerConfig, existing.lastRunAt ?? undefined) : null,
        updatedAt: now,
      })
      .where(eq(automations.id, automationId));

    return this.mapAutomationListItem(automationId, orgId);
  }

  async triggerNow(
    orgId: string,
    automationId: string,
    executionSelection?: ExecutionSelection,
  ): Promise<{
    run: {
      id: string;
      displayId?: number | null;
      status: string;
      scopeId: string;
      goal: string;
      createdAt: Date;
    };
    sessionId: string | null;
  }> {
    if (!this.deps.runExecutor) {
      throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'Automation execution is not available on this node');
    }

    const automation = await this.getAutomationRow(orgId, automationId);

    const triggerConfig = automation.triggerConfig as TriggerConfig;
    const result = await this.deps.runExecutor({
      orgId,
      userId: automation.createdBy,
      scopeId: automation.scopeId,
      goal: automation.goal,
      modelId: automation.modelId ?? null,
      modelCategory: automation.modelCategory ?? null,
      workflowDiscipline: automation.workflowDiscipline,
      complianceFrameworkKey: automation.complianceFrameworkKey ?? null,
      executionTarget: normalizeExecutionTarget(automation.executionTarget),
      trigger: 'manual',
      executionSelection,
    });

    const now = new Date();
    await this.deps.db.transaction(async (tx) => {
      await tx.insert(automationRuns).values({
        automationId: automation.id,
        runId: result.run.id,
        triggeredAt: now,
        triggerReason: 'Manual trigger',
      });

      await tx
        .update(automations)
        .set({
          lastRunAt: now,
          nextRunAt: automation.isActive ? this.calculateNextRunAt(triggerConfig, now) : null,
          deferredReason: null,
          deferredAt: null,
          updatedAt: now,
        })
        .where(eq(automations.id, automation.id));
    });

    return result;
  }

  async evaluateDueAutomations(): Promise<{ triggered: number; errors: string[] }> {
    const now = new Date();
    const due = await this.deps.db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.isActive, true),
          lte(automations.nextRunAt, now),
        ),
      )
      .orderBy(asc(automations.nextRunAt))
      .limit(100);

    if (due.length === 0) {
      return { triggered: 0, errors: [] };
    }

    if (!this.deps.runExecutor) {
      return {
        triggered: 0,
        errors: due.map((row) => `Execution unavailable for automation ${row.id}`),
      };
    }

    const errors: string[] = [];
    let triggered = 0;

    for (const automation of due) {
      try {
        const triggerConfig = automation.triggerConfig as TriggerConfig;
        const runTrigger: RunTriggerType = automation.triggerType === 'event' ? 'event' : 'scheduled';
        const result = await this.deps.runExecutor({
          orgId: automation.organizationId,
          userId: automation.createdBy,
          scopeId: automation.scopeId,
          goal: automation.goal,
          modelId: automation.modelId ?? null,
          modelCategory: automation.modelCategory ?? null,
          workflowDiscipline: automation.workflowDiscipline,
          complianceFrameworkKey: automation.complianceFrameworkKey ?? null,
          executionTarget: normalizeExecutionTarget(automation.executionTarget),
          trigger: runTrigger,
        });

        const ranAt = new Date();
        await this.deps.db.transaction(async (tx) => {
          await tx.insert(automationRuns).values({
            automationId: automation.id,
            runId: result.run.id,
            triggeredAt: ranAt,
            triggerReason: buildTriggerReason(
              toTriggerType(automation.triggerType),
              triggerConfig,
            ),
          });

          await tx
            .update(automations)
            .set({
              lastRunAt: ranAt,
              nextRunAt: this.calculateNextRunAt(triggerConfig, ranAt),
              deferredReason: null,
              deferredAt: null,
              updatedAt: ranAt,
            })
            .where(eq(automations.id, automation.id));
        });

        triggered += 1;
      } catch (error) {
        const appErr = toAppError(error);
        const deferredReason = classifyDeferredRunnerReason(appErr);
        const message = appErr.message;
        errors.push(`Automation ${automation.id}: ${message}`);

        // Classify the failure and advance nextRunAt so the cron does not
        // immediately retry. Permanent failures (credits, feature gate) use a
        // 6-hour backoff; transient failures (concurrency cap) use 5–10 minutes.
        const PERMANENT_CODES: string[] = [
          ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED,
          ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
        ];
        const isPermanent = PERMANENT_CODES.includes(appErr.code);
        const backoffMs = isPermanent
          ? 6 * 60 * 60 * 1000
          : (5 + Math.floor(Math.random() * 6)) * 60 * 1000; // 5–10 min

        const now = new Date();
        const nextRunAt = new Date(now.getTime() + backoffMs);
        try {
          await this.deps.db
            .update(automations)
            .set({
              nextRunAt,
              ...(deferredReason ? { deferredReason, deferredAt: now } : {}),
              ...(!deferredReason ? { deferredReason: null, deferredAt: null } : {}),
              updatedAt: now,
            })
            .where(eq(automations.id, automation.id));
        } catch (dbErr) {
          const dbAppErr = toAppError(dbErr);
          errors.push(`Automation ${automation.id}: failed to set backoff nextRunAt: ${dbAppErr.message}`);
        }
      }
    }

    return { triggered, errors };
  }

  async evaluateEvent(orgId: string, event: SecurityOpsEvent): Promise<{ triggered: number }> {
    const now = new Date();
    const rows = await this.deps.db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organizationId, orgId),
          eq(automations.isActive, true),
          eq(automations.triggerType, 'event'),
        ),
      );

    if (rows.length === 0) {
      return { triggered: 0 };
    }

    let triggered = 0;
    for (const automation of rows) {
      const triggerConfig = automation.triggerConfig as TriggerConfig;
      if (triggerConfig.type !== 'event') {
        continue;
      }
      if (triggerConfig.eventType !== event.type) {
        continue;
      }
      if (
        !(await matchesFilter(triggerConfig.filter as AutomationEventFilter | undefined, event.payload, async (findingId) =>
          this.getFindingConfidenceScore(orgId, findingId),
        ))
      ) {
        continue;
      }

      const lastRunAtMs = automation.lastRunAt?.getTime();
      if (typeof lastRunAtMs === 'number' && now.getTime() - lastRunAtMs < EVENT_DEBOUNCE_MS) {
        continue;
      }

      const sourceScopeIdRaw =
        triggerConfig.eventType === 'run_completed' && typeof event.payload.scopeId === 'string'
          ? event.payload.scopeId
          : null;
      const sourceScopeId = sourceScopeIdRaw?.trim() || null;
      if (sourceScopeId) {
        const [scope] = await this.deps.db
          .select({ id: scopes.id })
          .from(scopes)
          .where(and(eq(scopes.id, sourceScopeId), eq(scopes.organizationId, orgId)))
          .limit(1);
        if (!scope) {
          continue;
        }
      }

      await this.deps.db
        .update(automations)
        .set({
          ...(sourceScopeId ? { scopeId: sourceScopeId } : {}),
          nextRunAt: now,
          updatedAt: now,
        })
        .where(eq(automations.id, automation.id));
      triggered += 1;
    }

    return { triggered };
  }

  private async getFindingConfidenceScore(orgId: string, findingId: string): Promise<number | null> {
    const [row] = await this.deps.db
      .select({ confidenceScore: findings.confidenceScore })
      .from(findings)
      .where(and(eq(findings.organizationId, orgId), eq(findings.id, findingId)))
      .limit(1);
    return row?.confidenceScore ?? null;
  }

  private calculateNextRunAt(triggerConfig: TriggerConfig, lastRunAt?: Date): Date | null {
    if (triggerConfig.type === 'event') {
      return null;
    }

    if (triggerConfig.type === 'continuous') {
      const base = lastRunAt ?? new Date();
      return new Date(base.getTime() + triggerConfig.intervalMinutes * 60_000);
    }

    try {
      const expression = CronExpressionParser.parse(triggerConfig.cron, {
        currentDate: lastRunAt ?? new Date(),
        tz: triggerConfig.timezone || 'UTC',
      });
      return expression.next().toDate();
    } catch {
      return null;
    }
  }

  private async getAutomationRow(orgId: string, automationId: string): Promise<AutomationRow> {
    const [row] = await this.deps.db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.organizationId, orgId)))
      .limit(1);

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Automation not found');
    }
    return row;
  }

  private async assertScopeOwned(orgId: string, scopeId: string): Promise<AutomationScopeAssignment> {
    const [scope] = await this.deps.db
      .select({ id: scopes.id, complianceFrameworks: scopes.complianceFrameworks })
      .from(scopes)
      .where(and(eq(scopes.id, scopeId), eq(scopes.organizationId, orgId)))
      .limit(1);

    if (!scope) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Scope not found');
    }

    return {
      id: scope.id,
      complianceFrameworks: Array.isArray(scope.complianceFrameworks)
        ? scope.complianceFrameworks.filter(isComplianceFrameworkKey)
        : [],
    };
  }

  private async mapAutomationListItem(automationId: string, orgId: string): Promise<AutomationListItem> {
    const [row] = await this.deps.db
      .select({
        automation: automations,
        scopeName: scopes.name,
      })
      .from(automations)
      .innerJoin(scopes, eq(scopes.id, automations.scopeId))
      .where(and(eq(automations.id, automationId), eq(automations.organizationId, orgId)))
      .limit(1);

    if (!row) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Automation not found');
    }

    return {
      id: row.automation.id,
      organizationId: row.automation.organizationId,
      name: row.automation.name,
      description: row.automation.description ?? null,
      scopeId: row.automation.scopeId,
      scopeName: row.scopeName,
      modelId: row.automation.modelId ?? null,
      modelCategory: row.automation.modelCategory ?? null,
      workflowDiscipline: toWorkflowDiscipline(row.automation.workflowDiscipline),
      complianceFrameworkKey: row.automation.workflowDiscipline === 'compliance'
        ? parseComplianceFrameworkKey(row.automation.complianceFrameworkKey)
        : null,
      executionTarget: normalizeExecutionTarget(row.automation.executionTarget),
      goal: row.automation.goal,
      triggerType: toTriggerType(row.automation.triggerType),
      triggerConfig: row.automation.triggerConfig as TriggerConfig,
      isActive: row.automation.isActive,
      lastRunAt: row.automation.lastRunAt ?? null,
      nextRunAt: row.automation.nextRunAt ?? null,
      deferredReason: row.automation.deferredReason ?? null,
      deferredAt: row.automation.deferredAt ?? null,
      createdBy: row.automation.createdBy,
      createdAt: row.automation.createdAt,
      updatedAt: row.automation.updatedAt,
    };
  }

  async getActiveAutomationStats(orgId: string): Promise<{ activeCount: number; nextRunAt: Date | null }> {
    const [active] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(automations)
      .where(and(eq(automations.organizationId, orgId), eq(automations.isActive, true)));

    const [next] = await this.deps.db
      .select({ nextRunAt: automations.nextRunAt })
      .from(automations)
      .where(
        and(
          eq(automations.organizationId, orgId),
          eq(automations.isActive, true),
          sql`${automations.nextRunAt} IS NOT NULL`,
        ),
      )
      .orderBy(asc(automations.nextRunAt))
      .limit(1);

    return {
      activeCount: Number(active?.count ?? 0),
      nextRunAt: next?.nextRunAt ?? null,
    };
  }
}
