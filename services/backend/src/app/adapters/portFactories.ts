import type { SubscriptionPort, SessionGateParams, SubscriptionRecord } from '@/domains/agent-brain/ports';
import type { ModelConfigPort, ModelConfig } from '@/domains/agent-brain/ports';
import type { ScopeVerificationPort, ScopeVerificationResult } from '@/domains/agent-brain/ports';
import {
  scopeVerificationMessage,
  type ScopeVerificationBlockReason,
} from '@/domains/security-ops/scopes/scopeVerificationGate';
import { scopeVerificationGate } from '@/domains/security-ops/scopes/securityOpsScopeVerificationGate';
import type { ModelCategory } from '@null-ai/contracts';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { ModelRepository } from '@/domains/platform/models/ModelRepository';
import { decryptModelApiKey } from '@/domains/platform/models/modelApiKeyCipher';
import { runsOnOwnServer } from '@/domains/platform/models/modelProviders';
import { logger } from '@/shared/logger';

const log = logger.child({ scope: 'PortFactories' });

const toModelConfig = (row: {
  id?: string;
  modelName: string;
  provider: string;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  selectionCategory?: ModelCategory | null;
  selectionPriority?: number | null;
  requestProfile?: Record<string, unknown>;
} | null): ModelConfig | null => {
  if (!row) return null;
  let apiKey: string | undefined;
  try {
    apiKey = decryptModelApiKey(row.apiKey) ?? undefined;
  } catch (err) {
    log.warn(
      {
        err,
        modelId: row.id,
        modelName: row.modelName,
        provider: row.provider,
      },
      'Model API key could not be decrypted; treating model as unconfigured',
    );
  }
  return {
    id: row.id,
    modelName: row.modelName,
    provider: row.provider,
    apiKey,
    apiBaseUrl: row.apiBaseUrl ?? undefined,
    runsOnOwnServer: runsOnOwnServer(row.provider, row.apiBaseUrl),
    contextWindow: row.contextWindow ?? null,
    maxOutputTokens: row.maxOutputTokens ?? null,
    isDefault: Boolean(row.isDefault),
    isActive: row.isActive ?? true,
    selectionCategory: row.selectionCategory ?? null,
    selectionPriority: row.selectionPriority ?? null,
    requestProfile: row.requestProfile ?? {},
  };
};

export const createScopeVerificationPort = (
  gate = scopeVerificationGate,
): ScopeVerificationPort => ({
  checkScope: async (scopeId: string): Promise<ScopeVerificationResult> => {
    const status = await gate.check(scopeId);
    if (status.verified) {
      return { verified: true };
    }
    const reason: ScopeVerificationBlockReason = status.reason ?? 'unverified';
    return {
      verified: false,
      reason,
      message: scopeVerificationMessage(reason, 'assistant'),
    };
  },
});

export const createSubscriptionPort = (
  accessControl: AccessControlService = new AccessControlService(),
): SubscriptionPort => ({
  resolveOrganizationSubscription: (params: {
    organizationId?: string | null;
    userId?: string;
  }): Promise<SubscriptionRecord> =>
    accessControl.resolveOrganizationSubscription(params),
  enforceSessionCreation: (params: SessionGateParams): Promise<SubscriptionRecord> =>
    accessControl.enforceSessionCreation(params),
});

export const createModelConfigPort = (
  repo: ModelRepository = new ModelRepository(),
): ModelConfigPort => ({
  getModel: async (id: string): Promise<ModelConfig | null> =>
    toModelConfig(await repo.getById(id)),
  getByModelName: async (modelName: string): Promise<ModelConfig | null> =>
    toModelConfig(await repo.getByModelName(modelName)),
  listModelsForCategory: async (category: ModelCategory): Promise<ModelConfig[]> =>
    (await repo.listActiveByCategory(category))
      .map(toModelConfig)
      .filter((model): model is ModelConfig => model !== null),
  getDefaultModel: async (): Promise<ModelConfig | null> =>
    toModelConfig(await repo.getDefault()),
});
