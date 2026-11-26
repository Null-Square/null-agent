import { normalizeModelCategory, type ModelCategory } from '@null-ai/contracts';

import type {
  PreToolUseHookContext,
  PreToolUseHookResult,
  ToolLifecycleHook,
} from '@/domains/agent-brain/application/tools';
import type { ModelConfigPort } from '@/domains/agent-brain/ports';
import type { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { AppError, ERROR_CODES, toAppError } from '@/shared/errors';

type AccessControlGate = Pick<
  AccessControlService,
  | 'enforceAutomationCreation'
  | 'enforcePrivateRunnerAccess'
  | 'enforceModelCategoryAccess'
  | 'enforceComplianceAccess'
  | 'enforceGitHubIntegrationAccess'
  | 'enforceCodeReviewAccess'
  | 'enforceRunObservabilityAccess'
>;

type ToolEntitlementGuardDeps = {
  accessControl: AccessControlGate;
  automationService: Pick<AutomationService, 'countAutomations'>;
  modelConfigPort: Pick<ModelConfigPort, 'getModel' | 'listModelsForCategory'>;
};

type ToolGate =
  | 'automation.create'
  | 'compliance'
  | 'github.integration'
  | 'code_review'
  | 'run_observability';

const TOOL_GATES: Record<string, ToolGate[]> = {
  create_scope_automation: ['automation.create'],
  query_compliance_readiness: ['compliance'],
  query_compliance_evidence: ['compliance'],
  query_compliance_proof_package: ['compliance'],
  query_compliance_missing_evidence: ['compliance'],
  record_control_check: ['compliance'],
  record_control_request: ['compliance'],
  review_control_request: ['compliance'],
  annotate_compliance_evidence: ['compliance'],
  map_compliance_evidence: ['compliance'],
  list_connected_repositories: ['github.integration'],
  search_connected_repository: ['github.integration'],
  read_connected_repository_file: ['github.integration'],
  list_code_review_repository_files: ['github.integration', 'code_review'],
  search_code_review_repository: ['github.integration', 'code_review'],
  query_code_review_memory: ['github.integration', 'code_review'],
  record_code_review_memory: ['github.integration', 'code_review'],
};

const UUID_V4ISH_PATTERN = /^[0-9a-fA-F-]{36}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readSecurityOpsFlags = (context: PreToolUseHookContext): Record<string, unknown> => {
  const flags = context.session?.flags;
  return isRecord(flags?.securityops) ? flags.securityops as Record<string, unknown> : {};
};

const isHostedResearchLabContext = (context: PreToolUseHookContext): boolean =>
  asString(readSecurityOpsFlags(context).runHost) === 'research_lab';

const resolveOrganizationId = (context: PreToolUseHookContext): string | undefined => {
  const securityops = readSecurityOpsFlags(context);
  return asString(securityops.organizationId) ?? asString(context.args.organizationId);
};

const resolveUserId = (context: PreToolUseHookContext): string | undefined =>
  asString(context.session?.userId);

const isComplianceSession = (context: PreToolUseHookContext): boolean => {
  const securityops = readSecurityOpsFlags(context);
  return asString(securityops.workflowDiscipline)?.toLowerCase() === 'compliance' ||
    isRecord(securityops.complianceAssessment) ||
    isRecord(securityops.complianceReport);
};

const isCodeReviewSession = (context: PreToolUseHookContext): boolean =>
  asString(readSecurityOpsFlags(context).workflowDiscipline)?.toLowerCase() === 'code_review';

const requestsScopeRunner = (args: Record<string, unknown>): boolean =>
  asString(args.executionTarget)?.toLowerCase() === 'scope_runner';

const requestsComplianceFrameworks = (context: PreToolUseHookContext): boolean => {
  if (context.toolName !== 'update_scope_brief') return false;
  const frameworks = context.args.complianceFrameworks;
  return Array.isArray(frameworks) && frameworks.length > 0;
};

const parseModelCategoryInput = (value: unknown): ModelCategory | null => {
  if (value === undefined || value === null) return null;
  const normalized = normalizeModelCategory(value);
  if (!normalized) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelCategory must be one of low, medium, high, extra_high');
  }
  return normalized;
};

const parseModelIdInput = (value: unknown): string | null => {
  const modelId = asString(value);
  if (!modelId) return null;
  if (!UUID_V4ISH_PATTERN.test(modelId)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelId must be a valid UUID');
  }
  return modelId;
};

const resolveRequestedModelCategory = async (
  args: Record<string, unknown>,
  modelConfigPort: ToolEntitlementGuardDeps['modelConfigPort'],
): Promise<ModelCategory | null> => {
  const modelCategory = parseModelCategoryInput(args.modelCategory);
  if (modelCategory) {
    const models = await modelConfigPort.listModelsForCategory(modelCategory);
    if (models.length === 0) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model category not found', {
        httpStatus: 404,
      });
    }
    return modelCategory;
  }

  const modelId = parseModelIdInput(args.modelId);
  if (!modelId) return null;

  const model = await modelConfigPort.getModel(modelId);
  if (!model || model.isActive === false) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model not found', {
      httpStatus: 404,
    });
  }
  return model.selectionCategory ?? null;
};

const deny = (toolName: string, error: unknown): PreToolUseHookResult => {
  const appErr = toAppError(error);
  return {
    continue: false,
    reason: `Plan gate denied ${toolName}: ${appErr.message}`,
  };
};

const gateContext = (context: PreToolUseHookContext) => ({
  userId: resolveUserId(context),
  organizationId: resolveOrganizationId(context),
});

export const createToolEntitlementGuard = (
  deps: ToolEntitlementGuardDeps,
): ToolLifecycleHook => ({
  // Reads entitlement state and decides; performs no external mutation. See
  // ToolLifecycleHook.preToolUseIsEffectFree for why this must stay true.
  preToolUseIsEffectFree: true,
  async onPreToolUse(context): Promise<PreToolUseHookResult | void> {
    // Hosted products provide their own repository/file entitlement boundary.
    // Organization sessions never carry this explicit runHost marker and
    // continue through every existing plan gate below.
    if (isHostedResearchLabContext(context)) return undefined;
    const gates = new Set<ToolGate>(TOOL_GATES[context.toolName] ?? []);
    if (isComplianceSession(context) || requestsComplianceFrameworks(context)) {
      gates.add('compliance');
    }
    if (isCodeReviewSession(context)) {
      gates.add('code_review');
    }
    if (gates.size === 0 && !requestsScopeRunner(context.args) && context.args.modelCategory === undefined && context.args.modelId === undefined) {
      return undefined;
    }

    const base = gateContext(context);
    try {
      if (gates.has('compliance')) {
        await deps.accessControl.enforceComplianceAccess(base);
      }
      if (gates.has('github.integration')) {
        await deps.accessControl.enforceGitHubIntegrationAccess(base);
      }
      if (gates.has('code_review')) {
        await deps.accessControl.enforceCodeReviewAccess(base);
      }
      if (gates.has('run_observability')) {
        await deps.accessControl.enforceRunObservabilityAccess(base);
      }
      if (gates.has('automation.create')) {
        const existingAutomationCount = await deps.automationService.countAutomations(base.organizationId ?? '');
        await deps.accessControl.enforceAutomationCreation({
          ...base,
          existingAutomationCount,
        });
      }
      if (requestsScopeRunner(context.args)) {
        await deps.accessControl.enforcePrivateRunnerAccess(base);
      }

      const requestedModelCategory = await resolveRequestedModelCategory(context.args, deps.modelConfigPort);
      if (requestedModelCategory) {
        await deps.accessControl.enforceModelCategoryAccess({
          ...base,
          requestedModelCategory,
        });
      }

      return undefined;
    } catch (error) {
      return deny(context.toolName, error);
    }
  },
});
