import type { SessionState } from '../../../domain/types';
import type { CacheCoordinatorPort, CacheDecision, CacheIntent } from '../../../ports';
import { digestPrefixSections, type PrefixSectionDigest } from './prefixDivergence';

export class CacheCoordinator implements CacheCoordinatorPort {
  /** Digests for the prefix being built, handed to `buildCacheIntent` for persistence. */
  private pendingSectionDigests: PrefixSectionDigest[] | undefined;

  constructor(
    private readonly cacheTtlMs: number = 5 * 60 * 1000,
    private readonly minCacheTokens: number = 1024,
  ) {}

  build({
    session,
    cacheablePrefix,
    providerSupportsCache,
    prefixSections,
  }: {
    session: SessionState;
    cacheablePrefix: string;
    providerSupportsCache: boolean;
    /**
     * D17 - the sections the prefix is built from, so a later turn can say *which* one moved
     * rather than only that the hash did.
     */
    prefixSections?: ReadonlyArray<{ key: string; content: string }>;
  }): CacheDecision {
    const prefixHash = this.hash(cacheablePrefix);
    const approxPrefixTokens = Math.floor((cacheablePrefix || '').length / 4);

    if (!providerSupportsCache) {
      return { prefixHash, approxPrefixTokens };
    }

    if (approxPrefixTokens < this.minCacheTokens) {
      return {
        prefixHash,
        approxPrefixTokens,
        cacheIntent: { action: 'create', prefixHash },
      };
    }

    this.pendingSectionDigests = prefixSections
      ? digestPrefixSections(prefixSections)
      : undefined;
    const intent = this.buildCacheIntent(session, prefixHash);
    return {
      prefixHash,
      approxPrefixTokens,
      cacheIntent: intent,
    };
  }

  private buildCacheIntent(sessionState: SessionState, prefixHash: string): CacheIntent {
    const cacheState = (sessionState.flags?.cache_control as Record<string, unknown>) || {};
    const prevHash = typeof cacheState.prefixHash === 'string' ? cacheState.prefixHash : undefined;
    const prevCreatedAt =
      typeof cacheState.createdAt === 'number' && Number.isFinite(cacheState.createdAt)
        ? cacheState.createdAt
        : undefined;
    const now = Date.now();
    const stillFresh = prevCreatedAt ? now - prevCreatedAt < this.cacheTtlMs : false;
    const action: 'create' | 'hit' = prevHash === prefixHash && stillFresh ? 'hit' : 'create';

    sessionState.flags = sessionState.flags ?? {};
    sessionState.flags.cache_control = {
      prefixHash,
      createdAt: action === 'create' ? now : prevCreatedAt ?? now,
      lastAction: action,
      // D17 - carried forward so the next resume can name what moved.
      ...(this.pendingSectionDigests ? { sectionDigests: this.pendingSectionDigests } : {}),
    };

    return { action, prefixHash };
  }

  private hash(text: string): string {
    const input = text || '';
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= BigInt(input.charCodeAt(i));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  }
}
