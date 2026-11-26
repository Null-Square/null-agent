import { describe, it, expect } from 'vitest';
import { QwenChatProvider } from '@/domains/agent-brain/adapters/providers';
import type { ResolvedConfig } from '@/config/configTypes';

const makeConfig = (): ResolvedConfig => ({
  sandbox: {
    image: '',
    network: '',
    devUnsafe: false,
    user: 'agent',
    // stageProfile removed
    // prodProfile removed
    cpuQuota: 1,
    memoryMb: 512,
    pidsLimit: 128,
    stdoutLimitBytes: 1024,
  },
  runtime: {
    turnTimeoutMs: 1000,
    maxToolCallsPerTurn: 1,
    shellTimeoutMs: 1000,
    webTimeoutMs: 1000,
    webMaxBytes: 1000,
    sessionTTLMinutes: 1,
    apiKey: 'test-api-key',
    apiBaseUrl: 'http://localhost',
  },

  automation: {
    maxGuardRetries: 3,
    requireReport: true,
  },
  accessControl: {
    enabled: true,
  },
  trace: {
    traceInlineLimit: 1,
    stdoutChunkSize: 1,
    traceCompressOverBytes: 1,
    traceRetentionDays: 1,
    traceLogsRoot: '/tmp',
    artifactDirName: '.artifacts',
    artifactMaxChars: 100,
    s3FlushIntervalMs: 5_000,
    s3FlushMaxEvents: 25,
    // keepLocalCopy removed
  },
  network: { corsAllowedOrigins: [] },
  workspace: {
    maxBytesPerWorkspace: 0,
    rootDir: '/tmp',
    objectStoreRoot: '/tmp',
    artifactStorageRoot: '/tmp/artifacts',
  },
  manifests: {
    toolsDir: '/tmp/tools',
    toolDevWatch: false,
  },
  webSearch: {
    provider: 'duck',
    duckBaseUrl: 'https://duckduckgo.com/',
    duckLiteBaseUrl: 'https://duckduckgo.com/html/',
    tavilyBaseUrl: 'https://api.tavily.com/search',
    maxResults: 5,
    timeoutMs: 15_000,
    maxBytes: 1_048_576,
    tavilyApiKey: undefined,
  },
  http: {
    logSlowMs: 750,
    logDebugSampleRate: 0,
    logQuietPaths: [],
    uploadsMaxBytes: 25 * 1024 * 1024,
  },
  tokenGuard: {
    perSessionLimit: 100000,
    perUserDailyLimit: 1_000_000,
    warningThresholdPct: 80,
  },
  oob: {
    pollIntervalSeconds: 10,
    tokenDefaultTtlSeconds: 3600,
    tokenMaxTtlSeconds: 86400,
  },
  sessionLifecycle: {
    maxAgeDays: 30,
    maxCountPerUser: 0,
    retentionEnabled: true,
  },
});

describe('QwenChatProvider', () => {
  it('builds system messages with cache marker', () => {
    const provider = new QwenChatProvider(makeConfig(), { thinkingMode: 'planning_only' });
    const systemMessages = provider.buildSystemMessages({
      staticPrompt: 'STATIC',
      softContext: 'SOFT',
      dynamicPrompt: 'DYNAMIC',
      cacheIntent: { action: 'hit', prefixHash: 'abc' },
    });

    expect(systemMessages).toHaveLength(1);
    const content = (systemMessages[0] as any).content;
    expect(Array.isArray(content)).toBe(true);
    const [prefixBlock, dynamicBlock] = content as any[];
    expect(prefixBlock.cache_control).toEqual({ type: 'ephemeral', action: 'hit' });
    expect(prefixBlock.text).toContain('STATIC');
    expect(prefixBlock.text).toContain('SOFT');
    expect(dynamicBlock.text).toContain('DYNAMIC');
  });

  it('normalizes usage including cached tokens', () => {
    const provider = new QwenChatProvider(makeConfig(), { thinkingMode: 'planning_only' });
    const usage = provider.normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 200 },
    });
    expect(usage).toEqual({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      promptTokensDetails: { cachedTokens: 200 },
    });
  });

  it('enables thinking for Qwen 3.6 Plus planner requests', () => {
    const provider = new QwenChatProvider(makeConfig(), { thinkingMode: 'planning_only' });
    const body = provider.decorateRequest({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'solve' }],
      stream: true,
    }, { agentType: 'planner' });

    expect((body as any).enable_thinking).toBe(true);
  });

  it('enables thinking for Qwen 3.6 Plus planning phase requests', () => {
    const provider = new QwenChatProvider(makeConfig(), { thinkingMode: 'planning_only' });
    const body = provider.decorateRequest({
      model: 'qwen3.6-plus-2026-04-02',
      messages: [{ role: 'user', content: 'solve' }],
      stream: true,
    }, { agentType: 'executor', missionPhaseKey: 'planning' });

    expect((body as any).enable_thinking).toBe(true);
  });

  it('preserves explicit Qwen thinking mode overrides', () => {
    const provider = new QwenChatProvider(makeConfig());
    const body = provider.decorateRequest({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'quick answer' }],
      stream: true,
      enable_thinking: false,
    }, { agentType: 'planner' });

    expect((body as any).enable_thinking).toBe(false);
  });

  it('does not enable thinking for Qwen executor turns by default', () => {
    const provider = new QwenChatProvider(makeConfig());
    const body = provider.decorateRequest({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'quick answer' }],
      stream: true,
    }, { agentType: 'executor', missionPhaseKey: 'recon' });

    expect((body as any).enable_thinking).toBeUndefined();
  });

  it('honors an explicit disabled thinking profile', () => {
    const provider = new QwenChatProvider(makeConfig(), { thinkingMode: 'disabled' });
    const body = provider.decorateRequest({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'quick answer' }],
      stream: true,
    }, { agentType: 'planner' });

    expect((body as any).enable_thinking).toBeUndefined();
  });
});







