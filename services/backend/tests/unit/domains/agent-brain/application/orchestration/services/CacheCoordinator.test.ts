import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * CacheCoordinator Tests
 * 
 * Locks cache hit/create logic to prevent drift.
 * These tests ensure:
 * 1. Same prefix → same hash → cache hit (when TTL valid)
 * 2. Different prefix → different hash → cache create
 * 3. TTL expiry triggers cache create
 * 4. Provider without cache support → no cacheIntent
 */

import { CacheCoordinator } from '@/domains/agent-brain/application/orchestration/services/CacheCoordinator';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const createMockSession = (cacheFlags?: Record<string, unknown>): SessionState => ({
  id: 'test-session',
  userId: 'user-1',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: cacheFlags ? { cache_control: cacheFlags } : {},
  workspaceDir: '/tmp/test-workspace',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 1,
  pendingApproval: undefined,
  checkpoints: {},
});

describe('CacheCoordinator', () => {
  describe('prefixHash calculation', () => {
    it('returns same hash for same prefix', () => {
      const coordinator = new CacheCoordinator();
      const prefix = 'You are a helpful AI assistant.';
      const session1 = createMockSession();
      const session2 = createMockSession();

      const result1 = coordinator.build({
        session: session1,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      const result2 = coordinator.build({
        session: session2,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(result1.prefixHash).toBe(result2.prefixHash);
    });

    it('returns different hash for different prefix', () => {
      const coordinator = new CacheCoordinator();
      const session1 = createMockSession();
      const session2 = createMockSession();

      const result1 = coordinator.build({
        session: session1,
        cacheablePrefix: 'Prefix A',
        providerSupportsCache: true,
      });

      const result2 = coordinator.build({
        session: session2,
        cacheablePrefix: 'Prefix B',
        providerSupportsCache: true,
      });

      expect(result1.prefixHash).not.toBe(result2.prefixHash);
    });

    it('calculates approximate tokens as length/4', () => {
      const coordinator = new CacheCoordinator();
      const prefix = 'a'.repeat(8000); // 8000 chars → ~2000 tokens
      const session = createMockSession();

      const result = coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(result.approxPrefixTokens).toBe(2000);
    });
  });

  describe('cache hit/create logic', () => {
    it('returns "create" on first call (no previous hash)', () => {
      const coordinator = new CacheCoordinator();
      const prefix = 'a'.repeat(5000); // Above minCacheTokens
      const session = createMockSession();

      const result = coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(result.cacheIntent).toBeDefined();
      expect(result.cacheIntent!.action).toBe('create');
    });

    it('returns "hit" when prefixHash matches and TTL not expired', () => {
      const coordinator = new CacheCoordinator(5 * 60 * 1000); // 5 min TTL
      const prefix = 'a'.repeat(5000);
      const prefixHash = coordinator.build({
        session: createMockSession(),
        cacheablePrefix: prefix,
        providerSupportsCache: false,
      }).prefixHash;
      
      // Session with existing cache state (created 1 minute ago)
      const session = createMockSession({
        prefixHash,
        createdAt: Date.now() - 60 * 1000, // 1 minute ago
      });

      const result = coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(result.cacheIntent).toBeDefined();
      expect(result.cacheIntent!.action).toBe('hit');
    });

    it('returns "create" when prefixHash matches but TTL expired', () => {
      const coordinator = new CacheCoordinator(5 * 60 * 1000); // 5 min TTL
      const prefix = 'a'.repeat(5000);
      const prefixHash = coordinator.build({
        session: createMockSession(),
        cacheablePrefix: prefix,
        providerSupportsCache: false,
      }).prefixHash;
      
      // Session with expired cache (created 10 minutes ago)
      const session = createMockSession({
        prefixHash,
        createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago (expired)
      });

      const result = coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(result.cacheIntent).toBeDefined();
      expect(result.cacheIntent!.action).toBe('create');
    });

    it('returns "create" when prefix changes', () => {
      const coordinator = new CacheCoordinator();
      const oldPrefix = 'a'.repeat(5000);
      const newPrefix = 'b'.repeat(5000);
      const oldHash = coordinator.build({
        session: createMockSession(),
        cacheablePrefix: oldPrefix,
        providerSupportsCache: false,
      }).prefixHash;
      
      // Session with different prefix hash
      const session = createMockSession({
        prefixHash: oldHash,
        createdAt: Date.now() - 60 * 1000,
      });

      const result = coordinator.build({
        session,
        cacheablePrefix: newPrefix,
        providerSupportsCache: true,
      });

      expect(result.cacheIntent).toBeDefined();
      expect(result.cacheIntent!.action).toBe('create');
    });
  });

  describe('provider cache support', () => {
    it('returns no cacheIntent when provider does not support cache', () => {
      const coordinator = new CacheCoordinator();
      const session = createMockSession();

      const result = coordinator.build({
        session,
        cacheablePrefix: 'a'.repeat(5000),
        providerSupportsCache: false,
      });

      expect(result.cacheIntent).toBeUndefined();
      expect(result.prefixHash).toBeDefined();
    });
  });

  describe('minCacheTokens threshold', () => {
    it('returns "create" for small prefixes below threshold', () => {
      const coordinator = new CacheCoordinator(5 * 60 * 1000, 1024);
      const smallPrefix = 'Short prompt'; // ~3 tokens, below 1024
      const session = createMockSession();

      const result = coordinator.build({
        session,
        cacheablePrefix: smallPrefix,
        providerSupportsCache: true,
      });

      // Should still return cacheIntent but with create (not worth caching)
      expect(result.cacheIntent).toBeDefined();
      expect(result.cacheIntent!.action).toBe('create');
    });
  });

  describe('session state mutation', () => {
    it('updates session.flags.cache_control on create', () => {
      const coordinator = new CacheCoordinator();
      const prefix = 'a'.repeat(5000);
      const session = createMockSession();

      coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      expect(session.flags?.cache_control).toBeDefined();
      const cacheControl = session.flags!.cache_control as Record<string, unknown>;
      expect(cacheControl.prefixHash).toBeDefined();
      expect(cacheControl.createdAt).toBeDefined();
      expect(cacheControl.lastAction).toBe('create');
    });

    it('preserves createdAt on cache hit', () => {
      const coordinator = new CacheCoordinator();
      const prefix = 'a'.repeat(5000);
      const prefixHash = coordinator.build({
        session: createMockSession(),
        cacheablePrefix: prefix,
        providerSupportsCache: false,
      }).prefixHash;
      const originalCreatedAt = Date.now() - 60 * 1000;
      
      const session = createMockSession({
        prefixHash,
        createdAt: originalCreatedAt,
      });

      coordinator.build({
        session,
        cacheablePrefix: prefix,
        providerSupportsCache: true,
      });

      const cacheControl = session.flags!.cache_control as Record<string, unknown>;
      expect(cacheControl.createdAt).toBe(originalCreatedAt);
      expect(cacheControl.lastAction).toBe('hit');
    });
  });
});







