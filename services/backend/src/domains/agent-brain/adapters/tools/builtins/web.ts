/**
 * Web Search Tool - Search the internet for information.
 * 
 * NOTE: This is for INTERNET SEARCH (Google-like queries), NOT for HTTP requests.
 * For HTTP requests to targets, use the `http_payload` tool in browser.ts.
 * 
 * Providers:
 * - Tavily (primary, requires API key)
 * - DuckDuckGo (fallback, no API key needed)
 * 
 * @module agent-brain/adapters/tools/builtins/web
 */

import * as https from 'https';
import { URL } from 'url';
import { type ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import type { ResolvedConfig } from '@/config/configTypes';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';

interface TavilySearchResultItem {
  title: string;
  url: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResultItem[];
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number | null;
  publishedAt?: string | null;
}

interface WebSearchResultPayload {
  query: string;
  answer?: string | null;
  results: WebSearchResultItem[];
  limit: number;
  provider: 'duckduckgo' | 'tavily' | 'duckduckgo_html' | 'duckduckgo_offline';
  warning?: string;
}

type WebSearchInputArgs = {
  q?: string;
  query?: string;
  limit?: number;
};

const WEB_SEARCH_DESCRIPTION = [
  'Search the public web for reference material such as product intelligence, official documentation, standards, CVEs, exploit writeups, patch guidance, or precise CWE mappings.',
  '',
  'THIS IS A RESEARCH TOOL, NOT A TARGET INTERACTION TOOL.',
  '- Use web_search to gather background context, classification support, remediation references, CVE intelligence, or vendor/version details.',
  '- Do NOT use web_search as proof that the target is vulnerable. Returned results are leads, not evidence.',
  '- Prefer official or primary sources when they exist: vendor advisories, project docs, NVD/CVE entries, OWASP, CWE, RFCs, or standards bodies.',
  '',
  'GOOD QUERY PATTERNS:',
  '- Quote exact versions or product names when they matter: "Grafana 10.2.2 CVE"',
  '- Use site-scoped queries when you know the authority: "CWE SQL injection site:cwe.mitre.org"',
  '- Search for classification support before report_finding: "CWE broken access control idor"',
  '- Search for remediation context when you already have a confirmed issue: "Spring Security disable frame options remediation"',
  '',
  'WHEN NOT TO USE:',
  '- Do not search for secrets, credentials, or anything the operator did not authorize.',
  '- Do not use web_search instead of http_payload, http_raw_send, browser_action, or shell-based scanners against the target.',
  '- Do not over-query the same idea. Read the top results, extract the signal, then move on.',
  '',
  'RESULT HANDLING:',
  '- Treat the returned answer as a convenience summary only. The real value is in the result URLs and snippets.',
  '- Compare source quality and, when relevant, publication date before you rely on a result.',
  '- If results conflict, favor the most specific primary source and verify the conclusion against the target or codebase.',
].join('\n');

const WEB_SEARCH_CONTRACT = registerToolContract({
  name: 'web_search',
  description: WEB_SEARCH_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query. Preferred field name.' },
      query: { type: 'string', description: 'Alias of q. Search query.' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 5, capped by config).' },
    },
  },
});

export const normalizeWebSearchQuery = (args: WebSearchInputArgs): string => {
  if (typeof args.q === 'string' && args.q.trim().length > 0) {
    return args.q.trim();
  }
  if (typeof args.query === 'string' && args.query.trim().length > 0) {
    return args.query.trim();
  }
  return '';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'");
}

async function performTavilySearch(
  query: string,
  limit: number,
  apiKey: string,
  config: ResolvedConfig,
): Promise<WebSearchResultPayload> {
  const endpoint = config.webSearch.tavilyBaseUrl;
  const payload = JSON.stringify({
    api_key: apiKey,
    query,
    search_depth: 'advanced',
    max_results: limit,
    include_answer: true,
  });

  const requestOptions: https.RequestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const timeoutMs = config.webSearch.timeoutMs;

  const data = await new Promise<TavilySearchResponse>((resolve, reject) => {
    const req = https.request(endpoint, requestOptions, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString('utf-8');
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(
            new Error(
              `Web search request failed with status ${status}: ${responseBody || res.statusMessage || 'No response body'
              }`
            )
          );
          return;
        }

        try {
          resolve(JSON.parse(responseBody) as TavilySearchResponse);
        } catch (error) {
          reject(new Error('Failed to parse web search response: ' + (error as Error).message));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Web search request timed out after ${timeoutMs}ms`));
    });

    req.write(payload);
    req.end();
  });

  const results = (data.results || []).map((item) => ({
    title: item.title || 'Untitled result',
    url: item.url,
    snippet: item.content || '',
    score: item.score ?? null,
    publishedAt: item.published_date ?? null,
  }));

  return {
    query: data.query || query,
    answer: data.answer || null,
    results,
    limit,
    provider: 'tavily',
  };
}

async function performDuckDuckGoSearch(query: string, limit: number, config: ResolvedConfig): Promise<WebSearchResultPayload> {
  const apiUrl = new URL(config.webSearch.duckBaseUrl);
  apiUrl.searchParams.set('q', query);
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('no_redirect', '1');
  apiUrl.searchParams.set('no_html', '1');

  const timeoutMs = config.webSearch.timeoutMs;

  const data = await new Promise<unknown>((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString('utf-8');
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(
            new Error(
              `DuckDuckGo request failed with status ${status}: ${responseBody || res.statusMessage || 'No response body'
              }`
            )
          );
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(new Error('Failed to parse DuckDuckGo response: ' + (error as Error).message));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`DuckDuckGo request timed out after ${timeoutMs}ms`));
    });
  });

  const record = isRecord(data) ? data : {};
  const abstract = typeof record.Abstract === 'string' ? record.Abstract : '';
  const relatedTopics = Array.isArray(record.RelatedTopics) ? record.RelatedTopics : [];
  const flattenTopics = (topics: unknown[]): unknown[] =>
    topics.flatMap((topic) => {
      if (isRecord(topic) && Array.isArray(topic.Topics)) {
        return flattenTopics(topic.Topics);
      }
      return topic;
    });

  const flatTopics = flattenTopics(relatedTopics)
    .filter((topic): topic is Record<string, unknown> => isRecord(topic) && typeof topic.FirstURL === 'string')
    .slice(0, limit);

  const results: WebSearchResultItem[] = flatTopics.map((topic) => ({
    title:
      (typeof topic.Text === 'string' && topic.Text) ||
      (typeof topic.Result === 'string' && topic.Result) ||
      'DuckDuckGo Result',
    url: topic.FirstURL as string,
    snippet: typeof topic.Text === 'string' ? topic.Text : '',
    score: null,
    publishedAt: null,
  }));

  if (results.length === 0 && Array.isArray(record.Results)) {
    const fallback = record.Results;
    fallback.slice(0, limit).forEach((item) => {
      if (isRecord(item) && typeof item.FirstURL === 'string') {
        results.push({
          title:
            (typeof item.Text === 'string' && item.Text) ||
            (typeof item.Result === 'string' && item.Result) ||
            'DuckDuckGo Result',
          url: item.FirstURL,
          snippet: typeof item.Text === 'string' ? item.Text : '',
          score: null,
          publishedAt: null,
        });
      }
    });
  }

  return {
    query,
    answer: abstract || null,
    results,
    limit,
    provider: 'duckduckgo',
  };
}

// Lightweight HTML scrape fallback keeps DuckDuckGo results working when the API is empty/offline.
async function performDuckDuckGoLiteSearch(
  query: string,
  limit: number,
  config: ResolvedConfig,
): Promise<WebSearchResultPayload> {
  const url = new URL(config.webSearch.duckLiteBaseUrl);
  url.searchParams.set('q', query);

  const timeoutMs = config.webSearch.timeoutMs;

  const html = await new Promise<string>((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf-8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`DuckDuckGo lite request failed with status ${status}`));
            return;
          }
          resolve(body);
        });
      }
    );

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`DuckDuckGo lite request timed out after ${timeoutMs}ms`));
    });
  });

  const results: WebSearchResultItem[] = [];
  const sections = html.split('<div class="result">').slice(1);

  for (const section of sections) {
    if (results.length >= limit) {
      break;
    }
    const linkMatch = section.match(/<a rel="nofollow" class="result-link" href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!linkMatch) {
      continue;
    }
    const urlValue = decodeHtmlEntities(linkMatch[1]);
    const rawTitle = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    const title = decodeHtmlEntities(rawTitle);
    if (!urlValue) {
      continue;
    }
    const snippetMatch = section.match(/<div class="result-snippet">([\s\S]*?)<\/div>/);
    const rawSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const snippet = decodeHtmlEntities(rawSnippet);

    results.push({
      title: title || urlValue,
      url: urlValue,
      snippet,
      score: null,
      publishedAt: null,
    });
  }

  return {
    query,
    answer: null,
    results,
    limit,
    provider: 'duckduckgo_html',
  };
}

export const WebSearch: ToolImpl = {
  meta: {
    name: 'web_search',
    description: WEB_SEARCH_CONTRACT.description,
    category: 'web',
    schema: WEB_SEARCH_CONTRACT.schema,
    risks: ['network', 'read'],
  },
  async run({ q, query, limit }: WebSearchInputArgs, ctx) {
    return runWithGuards(
      WebSearch.meta,
      ctx,
      async () => {
        const normalizedQuery = normalizeWebSearchQuery({ q, query });
        if (!normalizedQuery) {
          return { ok: false, data: { error: 'q or query is required' } };
        }

        const config = ctx.config;
        if (!config) {
          return { ok: false, data: { error: 'tool configuration is unavailable' } };
        }
        const requestedLimit =
          typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5;
        const cappedLimit = Math.min(
          requestedLimit,
          Math.max(1, config.webSearch.maxResults)
        );

        const provider = config.webSearch.provider.toLowerCase();
        // Fallback chain: API → HTML scrape → structured warning so the model knows results are missing.
        const runDuckDuckGo = async (initialWarning?: string) => {
          const warnings: string[] = [];
          if (initialWarning) {
            warnings.push(initialWarning);
          }

          try {
            const apiResults = await performDuckDuckGoSearch(normalizedQuery, cappedLimit, config);
            if (apiResults.results.length > 0) {
              const combinedWarning = warnings.join(' ');
              return {
                ok: true,
                data: combinedWarning ? { ...apiResults, warning: combinedWarning } : apiResults,
              };
            }
            warnings.push('DuckDuckGo API returned no results; attempting HTML fallback.');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`DuckDuckGo API failed (${message}); attempting HTML fallback.`);
          }

          try {
            const liteResults = await performDuckDuckGoLiteSearch(normalizedQuery, cappedLimit, config);
            if (liteResults.results.length > 0) {
              const combinedWarning = warnings.join(' ');
              return {
                ok: true,
                data: combinedWarning ? { ...liteResults, warning: combinedWarning } : liteResults,
              };
            }
            warnings.push('DuckDuckGo HTML fallback returned no results.');
          } catch (htmlError) {
            const message = htmlError instanceof Error ? htmlError.message : String(htmlError);
            warnings.push(`DuckDuckGo HTML fallback failed (${message}).`);
          }

          const combinedWarning = warnings.join(' ');
          return {
            ok: true,
            data: {
              query: normalizedQuery,
              answer: null,
              results: [],
              limit: cappedLimit,
              provider: 'duckduckgo_offline',
              warning: combinedWarning || 'DuckDuckGo returned no results.',
            },
          };
        };

        if (provider === 'tavily') {
          const apiKey = config.webSearch.tavilyApiKey || '';
          if (!apiKey) {
            return runDuckDuckGo('Tavily API key missing; fell back to DuckDuckGo results.');
          }
          try {
            const results = await performTavilySearch(normalizedQuery, cappedLimit, apiKey, config);
            return { ok: true, data: results };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return runDuckDuckGo(
              `Tavily search failed (${message}). Returned DuckDuckGo results instead.`
            );
          }
        }

        return runDuckDuckGo();
      },
      {},
      { query: normalizeWebSearchQuery({ q, query }) }
    );
  },
};

export const WebBuiltins = [WebSearch];

/** Registry-compatible export - ToolModuleDefinition format */
export const tools: ToolModuleDefinition[] = WebBuiltins.map(fromToolImpl);
