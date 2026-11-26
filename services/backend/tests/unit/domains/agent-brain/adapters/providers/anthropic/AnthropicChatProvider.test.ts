import { describe, it, expect } from 'vitest';
import { AnthropicChatProvider } from '@/domains/agent-brain/adapters/providers/anthropic';
import type { ResolvedConfig } from '@/config/configTypes';

const makeConfig = (): ResolvedConfig => ({
  sandbox: {
    image: '',
    network: '',
    devUnsafe: false,
    user: 'agent',
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

describe('AnthropicChatProvider', () => {
  describe('capabilities', () => {
    it('reports correct capabilities', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const caps = provider.getCapabilities();

      expect(caps.explicitCacheControl).toBe(true);
      expect(caps.automaticCaching).toBe(true);
      expect(caps.contextWindow).toBe(200_000);
      expect(caps.maxOutputTokens).toBe(8192);
      expect(caps.toolCalling).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.rateLimitHeaders).toBe(true);
    });

    it('supports cache control', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      expect(provider.supportsCacheControl()).toBe(true);
    });
  });

  describe('buildSystemMessages', () => {
    it('builds system messages with cache marker when cacheIntent provided', () => {
      const provider = new AnthropicChatProvider(makeConfig());
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
      expect(prefixBlock.cache_control).toEqual({ type: 'ephemeral' });
      expect(prefixBlock.text).toContain('STATIC');
      expect(prefixBlock.text).toContain('SOFT');
      expect(dynamicBlock.text).toBe('DYNAMIC');
    });

    it('builds system messages with cache marker for create intent too', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const systemMessages = provider.buildSystemMessages({
        staticPrompt: 'STATIC',
        dynamicPrompt: 'DYNAMIC',
        cacheIntent: { action: 'create' },
      });

      const content = (systemMessages[0] as any).content;
      expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('builds system messages without cache marker when no cacheIntent', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const systemMessages = provider.buildSystemMessages({
        staticPrompt: 'STATIC',
        dynamicPrompt: 'DYNAMIC',
      });

      const content = (systemMessages[0] as any).content;
      expect(content[0].cache_control).toBeUndefined();
      expect(content[0].text).toBe('STATIC');
      expect(content[1].text).toBe('DYNAMIC');
    });
  });

  describe('decorateRequest', () => {
    it('adds max_tokens when not present', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const result = provider.decorateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [],
        stream: true,
      } as any);

      expect((result as any).max_tokens).toBe(8192);
      expect((result as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('preserves existing max_tokens', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const result = provider.decorateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [],
        stream: true,
        max_tokens: 2048,
      } as any);

      expect((result as any).max_tokens).toBe(2048);
      expect((result as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('preserves existing top-level cache_control', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const result = provider.decorateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: [],
        stream: true,
        cache_control: { type: 'ephemeral' },
      } as any);

      expect((result as any).cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('normalizeUsage', () => {
    it('handles Anthropic native format with cache tokens', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const usage = provider.normalizeUsage({
        input_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 100,
      } as any);

      expect(usage).toEqual({
        promptTokens: 1000, // 500 + 200 + 300
        promptTokensDetails: { cachedTokens: 300, cacheWriteTokens: 200 },
        completionTokens: 100,
        totalTokens: 1100,
      });
    });

    it('handles Anthropic native format without cache tokens', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const usage = provider.normalizeUsage({
        input_tokens: 500,
        output_tokens: 100,
      } as any);

      expect(usage).toEqual({
        promptTokens: 500,
        promptTokensDetails: undefined,
        completionTokens: 100,
        totalTokens: 600,
      });
    });

    it('falls through to base normalizeUsage for OpenAI-translated format', () => {
      const provider = new AnthropicChatProvider(makeConfig());
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

    it('returns undefined for empty input', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      expect(provider.normalizeUsage(undefined)).toBeUndefined();
    });
  });

  describe('getClient', () => {
    it('returns a shim with chat.completions.create method', () => {
      const provider = new AnthropicChatProvider(makeConfig());
      const client = provider.getClient();

      expect(client.chat).toBeDefined();
      expect(client.chat.completions).toBeDefined();
      expect(typeof client.chat.completions.create).toBe('function');
    });
  });
});
