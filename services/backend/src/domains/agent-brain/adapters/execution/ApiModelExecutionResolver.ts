/**
 * The API execution resolver — the only one production registers (I13).
 *
 * This is a **move, not a rewrite.** The per-deployment caching below is the code that used to sit
 * inside `OrchestratorAdapter.getProvider()` / `getModelStream()`, including its
 * delete-on-rejection behaviour, because a resolver that quietly re-created providers where the
 * orchestrator used to cache them would change request identity and cache lineage without anyone
 * asking for it. The §12.1 characterization matrix is the check on that claim; keeping the code
 * identical is how it passes.
 *
 * `unavailableReason` is the interesting member. It answers the availability question that
 * `SessionService` and `ModelRuntime` each used to answer inline by reading `model.apiKey` — with
 * the same rule, so the API path keeps its exact behaviour and its exact user-visible error text.
 * What changes is only *who is asked*, which is what lets a runtime holding no API key answer
 * honestly instead of being rejected by a test that was never about it.
 */

import type { ChatProvider } from '../../ports/ChatProviderPort';
import type { ModelConfig } from '../../ports/ModelConfigPort';
import type {
  ExecutionAccountingPolicy,
  ModelExecutionDescriptor,
  ModelExecutionResolverPort,
  ModelUnavailableReason,
  ResolvedModelExecution,
} from '../../ports/modelExecution';
import { API_FAULT_DOMAIN } from '../../ports/modelExecution';
import { apiUnavailableReason } from '../../domain/runtime/ExecutionRuntimeRegistry';
import type { ProviderFactoryPort } from '../../ports/orchestration';
import { ModelStream } from '../../application/orchestration/streaming/ModelStream';

const API_ACCOUNTING: ExecutionAccountingPolicy = {
  accountingMode: 'platform',
  consumesPlatformCredits: true,
  requiresPlatformCreditAdmission: true,
};

export class ApiModelExecutionResolver implements ModelExecutionResolverPort {
  readonly backend = 'api' as const;

  private readonly providerCache = new Map<string, Promise<ChatProvider>>();
  private readonly executionCache = new Map<string, Promise<ResolvedModelExecution>>();

  constructor(private readonly providerFactory: ProviderFactoryPort) {}

  async resolve(modelName: string, modelId?: string): Promise<ResolvedModelExecution> {
    const trimmed = modelName.trim();
    const cacheKey = modelId ?? trimmed;
    let resolved = this.executionCache.get(cacheKey);
    if (!resolved) {
      resolved = this.build(trimmed, modelId);
      this.executionCache.set(cacheKey, resolved);
      resolved = resolved.catch((error: unknown) => {
        this.executionCache.delete(cacheKey);
        throw error;
      });
    }
    return resolved;
  }

  private async build(modelName: string, modelId?: string): Promise<ResolvedModelExecution> {
    const provider = await this.getProvider(modelName, modelId);
    const execution = new ModelStream({ provider });
    execution.setModelName(modelName);
    const descriptor: ModelExecutionDescriptor = {
      providerIdentity: provider.name,
      executionBackend: 'api',
      authMode: 'platform-api-key',
      accountingMode: 'platform',
      faultDomain: API_FAULT_DOMAIN,
    };
    return { promptProfile: provider, execution, descriptor, accounting: API_ACCOUNTING };
  }

  /** Kept separate and cached per deployment, exactly as the orchestrator did. */
  private async getProvider(modelName: string, modelId?: string): Promise<ChatProvider> {
    const cacheKey = modelId ?? modelName;
    let providerPromise = this.providerCache.get(cacheKey);
    if (!providerPromise) {
      providerPromise = this.providerFactory.create(modelName, modelId);
      this.providerCache.set(cacheKey, providerPromise);
      providerPromise = providerPromise.catch((error: unknown) => {
        this.providerCache.delete(cacheKey);
        throw error;
      });
    }
    return providerPromise;
  }

  unavailableReason(model: ModelConfig | null | undefined): ModelUnavailableReason | null {
    return apiUnavailableReason(model);
  }

  accountingPolicy(): ExecutionAccountingPolicy {
    return API_ACCOUNTING;
  }
}
