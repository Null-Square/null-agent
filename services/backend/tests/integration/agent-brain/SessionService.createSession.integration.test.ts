import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { randomUUID } from 'crypto';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { PolicyConfigRepositoryAdapter } from '@/domains/agent-brain/adapters/PolicyConfigRepositoryAdapter';
import { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { SandboxProfileRegistry } from '@/domains/agent-brain/adapters/sandbox';
import { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import type { AgentBrainPorts } from '@/domains/agent-brain/application/core/AgentBrainPorts';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('SessionService.createSession (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      if (!process.env.TEST_DATABASE_URL) {
        skip = true;
        return;
      }
      if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      }
      harness = await setupTestDb();
      if (!harness) {
        skip = true;
      }
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.pool.query(
      `
      TRUNCATE TABLE
        models
      RESTART IDENTITY CASCADE;
      `,
    );
    vi.clearAllMocks();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('resolves policy + sandbox image and initializes session', async () => {
    if (!harness) return;
    const imageTag = 'nullsquare/sandbox:ci';
    const modelId = randomUUID();

    const policySlug = 'network-enabled';

    await harness.pool.query(
      `
      INSERT INTO models
        (id, name, provider, model_name, api_key, is_default, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        modelId,
        'Test Model',
        'OPENAI',
        'gpt-test',
        'test-api-key',
        true,
        new Date(),
        new Date(),
      ],
    );

    const createdSessions: SessionState[] = [];
    const sessionStore = {
      create: vi.fn(async (options: any) => {
        const session: SessionState = {
          id: 'session-1',
          version: 0,
          userId: options.userId,
          messages: [],
          plan: [],
          memory: createEmptyMemory(),
          flags: {},
          workspaceDir: '/tmp/ws',
          status: 'idle',
          profileKey: options.profileKey,
          extraContext: options.extraContext,
          createdAt: Date.now(),
          lastActive: Date.now(),
          turn: 0,
          pendingApproval: undefined,
          checkpoints: {},
          toolPolicy: options.toolPolicy,
          sandboxProfile: options.sandboxProfile,
          sandboxImage: options.sandboxImage,
          mode: options.mode ?? 'automated',
          agentType: options.agentType,
        } as SessionState;
        createdSessions.push(session);
        return session;
      }),
      set: vi.fn(),
      remove: vi.fn(),
    };

    const ports: AgentBrainPorts = {
      context: {} as any,
      tools: {} as any,
      sandbox: { provision: {} as any, runtime: {} as any },
      events: { publish: vi.fn() } as any,
    };
    const agentEngine = { initializeSession: vi.fn(async () => undefined) } as any;
    const policyRepository = new PolicyConfigRepositoryAdapter();
    const policyResolver = new PolicyResolver(policyRepository);
    const policyEngine = new PolicyEngine(undefined, policyResolver);
    const registry = new SandboxProfileRegistry({ sandboxProfiles: { default: imageTag, [policySlug]: imageTag } });
    const subscriptionPort = {
      enforceSessionCreation: vi.fn(async () => ({
        userId: 'user-1',
        plan: { slug: 'local' },
      })),
      resolveOrganizationSubscription: vi.fn(),
    };
    const modelConfigPort = {
      getDefaultModel: vi.fn(async () => ({ modelName: 'gpt-test', provider: 'OPENAI', apiKey: 'test-api-key' })),
      getModel: vi.fn(),
      listModelsForCategory: vi.fn().mockResolvedValue([]),
    };

    const service = new SessionService(
      sessionStore as any,
      registry,
      ports,
      agentEngine,
      subscriptionPort as any,
      policyResolver,
      modelConfigPort as any,
      undefined,
      undefined,
      policyEngine,
    );

    const { session } = await service.createSession({
      userId: 'user-1',
      profileKey: policySlug,
      mode: 'automated',
      agentType: 'planner',
      extraContext: 'ctx',
    });

    expect(session.sandboxProfile).toBe(policySlug);
    expect(session.sandboxImage).toBe(imageTag);
    expect(session.flags.brain_policy).toEqual({ profile: policySlug, source: 'explicit' });
    expect(session.flags.subscription?.planSlug).toBe('local');
    expect(agentEngine.initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ session, sandboxImage: imageTag }),
    );
    expect(createdSessions).toHaveLength(1);
  });
});

