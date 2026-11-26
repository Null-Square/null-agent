import { describe, it, expect } from 'vitest';
import { OpenAIChatProvider } from '@/domains/agent-brain/adapters/providers';
import type { ResolvedConfig } from '@/config/configTypes';
import { ERROR_CODES } from '@null-ai/contracts';

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
    apiBaseUrl: 'https://example.com',
    apiKey: 'key',
    turnTimeoutMs: 1000,
    maxToolCallsPerTurn: 1,
    shellTimeoutMs: 1000,
    webTimeoutMs: 1000,
    webMaxBytes: 1000,
    sessionTTLMinutes: 1,
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

describe('OpenAIChatProvider', () => {
  it('translates the deployment reasoning profile into the provider request', () => {
    const provider = new OpenAIChatProvider(makeConfig(), { reasoningEffort: 'high' });
    const request = provider.decorateRequest({ model: 'gpt-5.4', messages: [], stream: true } as any);
    expect((request as any).reasoning_effort).toBe('high');
  });

  it('builds plain system message without cache markers', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const systemMessages = provider.buildSystemMessages({
      staticPrompt: 'STATIC',
      softContext: 'SOFT',
      dynamicPrompt: 'DYNAMIC',
      cacheIntent: { action: 'hit', prefixHash: 'abc' }, // should be ignored
    });

    expect(systemMessages).toHaveLength(1);
    const content = (systemMessages[0] as any).content;
    expect(typeof content).toBe('string');
    expect(content).toContain('STATIC');
    expect(content).toContain('SOFT');
    expect(content).toContain('DYNAMIC');
  });

  it('normalizes usage and handles cached_tokens when present', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const usage = provider.normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cached_tokens: 40,
    });
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      promptTokensDetails: { cachedTokens: 40 },
    });
  });

  it('maps max_tokens to max_completion_tokens for newer OpenAI chat models', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const result = provider.decorateRequest({
      model: 'gpt-5',
      messages: [],
      stream: true,
      max_tokens: 8192,
    } as any);

    expect((result as any).max_completion_tokens).toBe(8192);
    expect((result as any).max_tokens).toBeUndefined();
  });

  it('maps timeout errors to LLM_TIMEOUT with retry metadata', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const err = new Error('Request timed out.') as Error & { retryAfterMs?: number };
    err.name = 'APIConnectionTimeoutError';
    err.retryAfterMs = 1500;

    const appError = provider.mapError(err, { model: 'gpt-4', provider: 'openai' });

    expect(appError.code).toBe(ERROR_CODES.LLM_TIMEOUT);
    expect(appError.retryAfterMs).toBe(1500);
    expect(appError.context?.provider).toBe('openai');
  });

  it('maps rate limit responses to LLM_RATE_LIMIT_EXCEEDED', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const err = Object.assign(new Error('rate limit exceeded'), { status: 429 });

    const appError = provider.mapError(err, { model: 'gpt-4', provider: 'openai' });

    expect(appError.code).toBe(ERROR_CODES.LLM_RATE_LIMIT_EXCEEDED);
    expect(appError.context?.provider).toBe('openai');
  });

  it('maps provider socket-close stream termination to NETWORK_CONNECTION_FAILED', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const socketCause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const err = Object.assign(new TypeError('terminated'), { cause: socketCause });

    const appError = provider.mapError(err, { model: 'gpt-4', provider: 'openai' });

    expect(appError.code).toBe(ERROR_CODES.NETWORK_CONNECTION_FAILED);
    expect(appError.retryable).toBe(true);
    expect(appError.context?.provider).toBe('openai');
  });

  it('maps malformed function arguments errors to LLM_RESPONSE_PARSE_ERROR', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const err = Object.assign(
      new Error('InternalError.Algo.InvalidParameter: The "function.arguments" parameter of the code model must be in JSON format.'),
      { status: 400 },
    );

    const appError = provider.mapError(err, { model: 'qwen3-coder-flash', provider: 'qwen' });

    expect(appError.code).toBe(ERROR_CODES.LLM_RESPONSE_PARSE_ERROR);
    expect(appError.retryable).toBe(true);
    expect(appError.context?.provider).toBe('qwen');
  });

  it('maps Qwen data-inspection failures to LLM_CONTENT_FILTER_TRIGGERED', () => {
    const provider = new OpenAIChatProvider(makeConfig());
    const err = Object.assign(
      new Error('InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.'),
      { status: 400, name: 'error' },
    );

    const appError = provider.mapError(err, { model: 'qwen3.5-plus', provider: 'qwen' });

    expect(appError.code).toBe(ERROR_CODES.LLM_CONTENT_FILTER_TRIGGERED);
    expect(appError.retryable).toBe(false);
    expect(appError.context?.provider).toBe('qwen');
  });
});







