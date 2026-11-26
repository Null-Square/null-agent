import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as https from 'https';
import { WebSearch } from '@/domains/agent-brain/adapters/tools/builtins';
import type { ToolContext } from '@/domains/agent-brain/application/tools';

vi.mock('https', () => ({
  get: vi.fn(),
  request: vi.fn(),
}));

type MockResponseOptions = {
  statusCode?: number;
  headers?: Record<string, string | undefined>;
  body?: string;
  chunks?: string[];
};

const createResponse = ({ statusCode = 200, headers = {}, body = '', chunks }: MockResponseOptions) => {
  const res = new EventEmitter() as any;
  res.statusCode = statusCode;
  res.headers = headers;
  const dataChunks = chunks ?? [body];
  process.nextTick(() => {
    for (const chunk of dataChunks) {
      res.emit('data', Buffer.from(chunk, 'utf-8'));
    }
    res.emit('end');
  });
  return res;
};

const createRequest = () => {
  const req = new EventEmitter() as any;
  req.destroy = vi.fn();
  req.write = vi.fn();
  req.end = vi.fn();
  req.setTimeout = vi.fn((_ms: number, handler: () => void) => {
    req._timeoutHandler = handler;
    return req;
  });
  return req;
};

const baseWebSearchConfig = {
  provider: 'duck' as const,
  duckBaseUrl: 'https://duckduckgo.com/',
  duckLiteBaseUrl: 'https://duckduckgo.com/html/',
  tavilyBaseUrl: 'https://api.tavily.com/search',
  maxResults: 5,
  timeoutMs: 15_000,
  maxBytes: 1_048_576,
  tavilyApiKey: undefined as string | undefined,
};

const mockGetSequence = (responses: Array<() => any>) => {
  let callIndex = 0;
  vi.mocked(https.get).mockImplementation((...args: any[]) => {
    const callback = args.find((arg) => typeof arg === 'function') as ((res: any) => void) | undefined;
    const responseFactory = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    const req = createRequest();
    if (callback && responseFactory) {
      const res = responseFactory();
      callback(res);
    }
    return req as any;
  });
};

const mockRequestResponse = (responseFactory: () => any) => {
  vi.mocked(https.request).mockImplementation((_url: any, _options: any, callback: any) => {
    const req = createRequest();
    if (callback) {
      const res = responseFactory();
      callback(res);
    }
    return req as any;
  });
};

const makeContext = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 'session-1',
    workspaceDir: '/tmp/workspace',
    sandbox: {} as any,
    sessionStore: {} as any,
    streamBroker: { emit: vi.fn() } as any,
    trace: undefined,
    approvals: { require: vi.fn().mockResolvedValue(undefined) },
    checkpoints: undefined,
    guards: {
      pathGuard: { ensureInsideWorkspace: vi.fn() } as any,
      cmdGuard: { validate: vi.fn() } as any,
    },
    policies: { requireApproval: false, maxStdoutBytes: 0, timeoutMs: 0 },
    flags: {},
    planRuntime: {} as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  }) as ToolContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(https.get).mockImplementation((...args: any[]) => {
    const callback = args.find((arg) => typeof arg === 'function') as ((res: any) => void) | undefined;
    const req = createRequest();
    if (callback) {
      callback(createResponse({ body: '{}' }));
    }
    return req as any;
  });
  vi.mocked(https.request).mockImplementation((_url: any, _options: any, callback: any) => {
    const req = createRequest();
    if (callback) {
      callback(createResponse({ body: '{}' }));
    }
    return req as any;
  });
});

// WebFetch tests removed - tool deprecated in favor of curl via shell_run

describe('WebSearch', () => {
  it('requires a query', async () => {
    const ctx = makeContext();

    const result = await WebSearch.run({ q: '  ' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'q or query is required' });
  });

  it('uses Tavily when configured with an API key', async () => {
    const tavilyBody = JSON.stringify({
      query: 'latest news',
      answer: 'summary',
      results: [
        { title: 'Result', url: 'https://tavily.test', content: 'snippet', score: 0.9 },
      ],
    });
    mockRequestResponse(() => createResponse({ body: tavilyBody }));

    const ctx = makeContext({
      config: {
        webSearch: { ...baseWebSearchConfig, provider: 'tavily', tavilyApiKey: 'key', maxResults: 3 },
        runtime: {},
      } as any,
    });

    const result = await WebSearch.run({ q: 'latest news', limit: 2 }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as { provider?: string; results?: Array<Record<string, unknown>> } | undefined;
    expect(data?.provider).toBe('tavily');
    expect(data?.results?.[0]).toMatchObject({
      title: 'Result',
      url: 'https://tavily.test',
      snippet: 'snippet',
    });
  });

  it('falls back to DuckDuckGo when Tavily API key is missing', async () => {
    const ddgBody = JSON.stringify({
      Abstract: 'Answer',
      RelatedTopics: [{ Text: 'Example', FirstURL: 'https://duck.test' }],
    });
    mockGetSequence([() => createResponse({ body: ddgBody })]);

    const ctx = makeContext({
      config: { webSearch: { ...baseWebSearchConfig, provider: 'tavily' }, runtime: {} } as any,
    });

    const result = await WebSearch.run({ q: 'query', limit: 1 }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as {
      provider?: string;
      warning?: string;
      results?: Array<{ url?: string }>;
    } | undefined;
    expect(data?.provider).toBe('duckduckgo');
    expect(data?.warning).toContain('Tavily API key missing');
    expect(data?.results?.[0]?.url).toBe('https://duck.test');
  });

  it('uses HTML fallback when DuckDuckGo API is empty', async () => {
    const ddgEmpty = JSON.stringify({ Abstract: '', RelatedTopics: [] });
    const htmlBody =
      '<div class="result">' +
      '<a rel="nofollow" class="result-link" href="https://example.com/path">Example &amp; Test</a>' +
      '<div class="result-snippet">Snippet &amp; more</div>' +
      '</div>';

    mockGetSequence([
      () => createResponse({ body: ddgEmpty }),
      () => createResponse({ body: htmlBody }),
    ]);

    const ctx = makeContext({
      config: { webSearch: { ...baseWebSearchConfig, provider: 'duck' }, runtime: {} } as any,
    });

    const result = await WebSearch.run({ q: 'query', limit: 1 }, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as { provider?: string; results?: Array<Record<string, unknown>> } | undefined;
    expect(data?.provider).toBe('duckduckgo_html');
    expect(data?.results?.[0]).toMatchObject({
      title: 'Example & Test',
      url: 'https://example.com/path',
      snippet: 'Snippet & more',
    });
  });
});
