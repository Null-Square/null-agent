import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { ResolvedConfig } from '@/config/configTypes';
import { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

const mocks = vi.hoisted(() => ({
  loadSandboxProfilesConfig: vi.fn(),
  getDefaultSandboxImage: vi.fn(),
  sandboxManagerAdapter: vi.fn(),
  streamBrokerAdapter: vi.fn(),
  taskCatalogAdapter: vi.fn(),
  telemetryRecorderAdapter: vi.fn(),
  toolsRegistryAdapter: vi.fn(),
  contextGatewayAdapter: vi.fn(),
  toolsRegistryCtor: vi.fn(),
  toolExecutionAdapterCtor: vi.fn(),
  artifactServiceCtor: vi.fn(),
  orchestratorAdapterCtor: vi.fn(),
}));

vi.mock('@/config/sandboxProfilesConfig', () => ({
  loadSandboxProfilesConfig: mocks.loadSandboxProfilesConfig,
  getDefaultSandboxImage: mocks.getDefaultSandboxImage,
}));

vi.mock('@/domains/agent-brain/adapters', () => ({
  SandboxManagerAdapter: class {
    constructor(...args: any[]) {
      mocks.sandboxManagerAdapter(...args);
    }
  },
  StreamBrokerAdapter: class {
    constructor(...args: any[]) {
      mocks.streamBrokerAdapter(...args);
    }
  },
  TaskCatalogAdapter: class {
    constructor(...args: any[]) {
      mocks.taskCatalogAdapter(...args);
    }
  },
  TelemetryRecorderAdapter: class {
    constructor(...args: any[]) {
      mocks.telemetryRecorderAdapter(...args);
    }
  },
  ToolsRegistryAdapter: class {
    constructor(...args: any[]) {
      mocks.toolsRegistryAdapter(...args);
    }
  },
  ContextGatewayAdapter: class {
    constructor(...args: any[]) {
      mocks.contextGatewayAdapter(...args);
    }
  },
}));

vi.mock('@/domains/agent-brain/adapters/tools/ToolsRegistry', () => ({
  ToolsRegistry: class {
    constructor(...args: any[]) {
      mocks.toolsRegistryCtor(...args);
    }
  },
}));

vi.mock('@/domains/agent-brain/adapters/ToolExecutionAdapter', () => ({
  ToolExecutionAdapter: class {
    constructor(db: unknown) {
      (this as any).db = db;
      mocks.toolExecutionAdapterCtor(db);
    }
  },
}));

vi.mock('@/domains/agent-brain/infrastructure/artifacts/ArtifactService', () => ({
  ArtifactService: class {
    constructor(...args: any[]) {
      mocks.artifactServiceCtor(...args);
    }
  },
}));

vi.mock('@/domains/agent-brain/application/orchestration/OrchestratorAdapter', () => ({
  OrchestratorAdapter: class {
    constructor(...args: any[]) {
      mocks.orchestratorAdapterCtor(...args);
    }
  },
}));


vi.mock('@/db/client', () => ({
  db: { name: 'db' },
}));

import {
  createSandboxProfileRegistry,
  createPorts,
  createToolsRegistry,
  createOrchestrator,
  createArtifactService,
  shouldPersistAgentSessions,
} from '@/app/factories/orchestration';

describe('orchestration factories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists hosted sessions when a product-path sidecar requests them', () => {
    expect(shouldPersistAgentSessions()).toBe(true);
    expect(shouldPersistAgentSessions({ productHost: 'research_lab' })).toBe(false);
    expect(shouldPersistAgentSessions({
      productHost: 'research_lab',
      persistSessions: true,
    })).toBe(true);
    expect(shouldPersistAgentSessions({
      runtimeHostCapabilities: createOrganizationRuntimeHostCapabilities(),
    })).toBe(true);
    expect(shouldPersistAgentSessions({
      runtimeHostCapabilities: createResearchLabRuntimeHostCapabilities(),
    })).toBe(false);
  });

  it('builds registry from static sandbox profile config', async () => {
    mocks.loadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'base',
      profiles: {
        base: 'base-image',
        hardened: 'hardened-image',
        custom: 'custom-image',
      },
    });
    mocks.getDefaultSandboxImage.mockReturnValue('default-image');
    const registry = await createSandboxProfileRegistry();
    expect(mocks.loadSandboxProfilesConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getDefaultSandboxImage).toHaveBeenCalledTimes(1);
    expect(registry.resolveImage()).toBe('default-image');
    expect(registry.resolveImage('custom')).toBe('custom-image');
  });

  it('falls back to default profile alias when explicit default key is absent', async () => {
    mocks.loadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'base',
      profiles: {
        base: 'base-image',
        hardened: 'hardened-image',
      },
    });
    mocks.getDefaultSandboxImage.mockReturnValue('base-image');
    const registry = await createSandboxProfileRegistry();
    expect(registry.resolveImage()).toBe('base-image');
    expect(registry.resolveImage('default')).toBe('base-image');
  });

  it('preserves configured profile tags', async () => {
    mocks.loadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'base',
      profiles: {
        base: 'base-image',
        hardened: 'hardened-image',
        custom: 'custom-image',
      },
    });
    mocks.getDefaultSandboxImage.mockReturnValue('default-image');
    const registry = await createSandboxProfileRegistry();
    expect(registry.resolveImage('base')).toBe('base-image');
    expect(registry.resolveImage('hardened')).toBe('hardened-image');
    expect(registry.resolveImage('custom')).toBe('custom-image');
  });

  it('keeps compatibility with existing default alias mapping', async () => {
    mocks.loadSandboxProfilesConfig.mockResolvedValue({
      defaultProfile: 'base',
      profiles: {
        base: 'base-image',
        hardened: 'hardened-image',
        custom: 'custom-image',
      },
    });
    mocks.getDefaultSandboxImage.mockReturnValue('default-image');
    const registry = await createSandboxProfileRegistry();
    expect(registry.resolveImage('default')).toBe('default-image');
  });

  it('creates ports with adapters and optional telemetry', () => {
    const ports = createPorts(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    expect(mocks.sandboxManagerAdapter).toHaveBeenCalled();
    expect(mocks.toolsRegistryAdapter).toHaveBeenCalled();
    expect(mocks.streamBrokerAdapter).toHaveBeenCalled();
    expect(mocks.contextGatewayAdapter).toHaveBeenCalledWith(expect.anything());
    expect(mocks.telemetryRecorderAdapter).toHaveBeenCalled();
    expect(ports.telemetry).toBeDefined();
  });

  it('skips telemetry adapter when trace recorder is missing', () => {
    const ports = createPorts(
      {} as any,
      {} as any,
      undefined as any,
      {} as any,
    );

    expect(mocks.telemetryRecorderAdapter).not.toHaveBeenCalled();
    expect(ports.telemetry).toBeUndefined();
  });

  it('creates tools registry with config and tool execution adapter', () => {
    const config = { manifests: { toolsDir: '/tools', toolDevWatch: true } } as ResolvedConfig;

    createToolsRegistry(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      config,
    );

    const options = mocks.toolsRegistryCtor.mock.calls[0][5];
    expect(options.toolsDir).toBe('/tools');
    expect(options.devWatch).toBe(true);
    expect(mocks.toolExecutionAdapterCtor).toHaveBeenCalledWith({ name: 'db' });
  });

  it('creates orchestrator with traces config and provider factory', () => {
    const config = { runtime: {} } as ResolvedConfig;

    createOrchestrator(
      { events: {}, tools: {}, context: {} } as any,
      {
        sessionStore: {} as any,
        usageTracker: {} as any,
        artifactService: {} as any,
        usageStore: {} as any,
        traceRecorder: {} as any,
        s3Bundle: { s3TracesClient: { s3: true }, s3TracesBucket: 'traces' } as any,
        config,
        policyResolver: {} as any,
        tokenGuard: new TokenGuard(),
      },
    );

    const options = mocks.orchestratorAdapterCtor.mock.calls[0][0];
    expect(options.tracesS3).toEqual({ client: { s3: true }, bucket: 'traces' });
    expect(typeof options.providerFactory?.create).toBe('function');
  });

  it('creates artifact service with optional s3 bundle', () => {
    createArtifactService(
      {} as any,
      { name: 'repo' } as any,
      { s3Client: { s3: true }, s3ArtifactsBucket: 'artifacts' } as any,
    );

    const args = mocks.artifactServiceCtor.mock.calls[0];
    expect(args[2]).toBe(path.join('storage', 'artifacts'));
    expect(args[3]).toEqual({ bucket: 'artifacts', client: { s3: true } });
  });

  it('creates artifact service without s3 when client missing', () => {
    createArtifactService(
      {} as any,
      { name: 'repo' } as any,
      { s3Client: null, s3ArtifactsBucket: 'artifacts' } as any,
    );

    const args = mocks.artifactServiceCtor.mock.calls[0];
    expect(args[3]).toBeUndefined();
  });
});
