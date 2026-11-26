/**
 * HTTP Differential Tool (PRD 2.0-B §2).
 *
 * Differential observation primitive: dispatch one request as a baseline plus N variants
 * that change a single parameter, then return a tabulated diff so the model can decide
 * whether the response variance is a signal worth filing as a candidate finding.
 *
 * Collapses the "five manual probes + manual diff" pattern that has been the single
 * largest failure mode in trace reviews into one tool call.
 *
 * @module agent-brain/adapters/tools/builtins/http_differential
 */

import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { executeHttpRequest } from '../runtime/httpRequestExecutor';

type ParameterLocation = 'path' | 'query' | 'header' | 'body_raw' | 'body_json_field';

type MutationKind =
  | 'literal'
  | 'boundary'
  | 'type_confusion'
  | 'injection_sql'
  | 'injection_xss'
  | 'injection_traversal'
  | 'auth_tamper';

interface DifferentialValueInput {
  kind: MutationKind;
  value?: string;
  label?: string;
}

interface DifferentialArgs {
  url_template?: string;
  url?: string;
  parameter?: {
    name?: string;
    in?: ParameterLocation;
  };
  baseline?: string | number | null;
  values?: DifferentialValueInput[];
  signal?: 'status' | 'body_length' | 'response_time' | 'headers' | 'set';
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  follow_redirects?: boolean;
  insecure?: boolean;
  max_body_bytes?: number;
}

const BOUNDARY_VALUES = ['', '0', '-1', '1', '99999999'];
const TYPE_CONFUSION_VALUES = ['abc', 'true', 'false', 'null', '[]', '{}', '[1,2,3]'];
const SQL_INJECTION_VALUES = ["'", '"', "1' OR '1'='1", "1 OR 1=1--", "1');WAITFOR DELAY '0:0:5'--"];
const XSS_INJECTION_VALUES = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "javascript:alert(1)"];
const TRAVERSAL_VALUES = ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '....//....//etc/passwd', '/etc/passwd'];
const AUTH_TAMPER_VALUES = ['REMOVE', 'GARBAGE', 'NEGATE_LAST_CHAR', 'OTHER_USER'];

const MAX_VARIANTS = 20;

const expandValues = (entries: readonly DifferentialValueInput[] | undefined): Array<{ kind: MutationKind; value: string; label: string }> => {
  const expanded: Array<{ kind: MutationKind; value: string; label: string }> = [];
  if (!entries || entries.length === 0) {
    return expanded;
  }
  for (const entry of entries) {
    const label = entry.label?.trim() || entry.kind;
    if (entry.kind === 'literal') {
      const v = typeof entry.value === 'string' ? entry.value : '';
      expanded.push({ kind: 'literal', value: v, label: entry.label?.trim() || `literal:${v}` });
      continue;
    }
    if (entry.kind === 'boundary') {
      for (const v of BOUNDARY_VALUES) expanded.push({ kind: 'boundary', value: v, label: `boundary:${v || '<empty>'}` });
      continue;
    }
    if (entry.kind === 'type_confusion') {
      for (const v of TYPE_CONFUSION_VALUES) expanded.push({ kind: 'type_confusion', value: v, label: `type:${v}` });
      continue;
    }
    if (entry.kind === 'injection_sql') {
      for (const v of SQL_INJECTION_VALUES) expanded.push({ kind: 'injection_sql', value: v, label: `sqli:${v.slice(0, 20)}` });
      continue;
    }
    if (entry.kind === 'injection_xss') {
      for (const v of XSS_INJECTION_VALUES) expanded.push({ kind: 'injection_xss', value: v, label: `xss:${v.slice(0, 20)}` });
      continue;
    }
    if (entry.kind === 'injection_traversal') {
      for (const v of TRAVERSAL_VALUES) expanded.push({ kind: 'injection_traversal', value: v, label: `traversal:${v}` });
      continue;
    }
    if (entry.kind === 'auth_tamper') {
      for (const v of AUTH_TAMPER_VALUES) expanded.push({ kind: 'auth_tamper', value: v, label: `auth:${v}` });
      continue;
    }
    expanded.push({ kind: entry.kind, value: typeof entry.value === 'string' ? entry.value : '', label });
  }
  return expanded.slice(0, MAX_VARIANTS);
};

const renderUrl = (template: string, paramName: string, location: ParameterLocation, value: string): string => {
  if (location === 'path') {
    const placeholder = `{${paramName}}`;
    if (template.includes(placeholder)) {
      return template.replace(placeholder, encodeURIComponent(value));
    }
    return template.endsWith('/') ? `${template}${encodeURIComponent(value)}` : `${template}/${encodeURIComponent(value)}`;
  }
  if (location === 'query') {
    try {
      const url = new URL(template);
      url.searchParams.set(paramName, value);
      return url.toString();
    } catch {
      const hashIndex = template.indexOf('#');
      const beforeHash = hashIndex === -1 ? template : template.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : template.slice(hashIndex);
      const queryIndex = beforeHash.indexOf('?');
      const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
      const queryPart = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);
      const search = new URLSearchParams(queryPart);
      search.set(paramName, value);
      const query = search.toString();
      return `${pathPart}${query ? `?${query}` : ''}${fragment}`;
    }
  }
  return template;
};

const findHeaderKey = (headers: Record<string, string>, headerName: string): string | undefined => {
  const normalized = headerName.trim().toLowerCase();
  return Object.keys(headers).find((key) => key.trim().toLowerCase() === normalized);
};

const applyHeaderMutation = (
  baseHeaders: Record<string, string>,
  paramName: string,
  value: string,
): Record<string, string> => {
  const copy = { ...baseHeaders };
  const existingKey = findHeaderKey(copy, paramName);
  const targetKey = existingKey ?? paramName;
  if (value === 'REMOVE') {
    delete copy[targetKey];
    return copy;
  }
  if (value === 'GARBAGE') {
    copy[targetKey] = 'Bearer invalid_probe_value';
    return copy;
  }
  if (value === 'NEGATE_LAST_CHAR') {
    const existing = copy[targetKey];
    if (typeof existing === 'string' && existing.length > 1) {
      const lastChar = existing.slice(-1);
      const swapped = lastChar === 'A' ? 'B' : 'A';
      copy[targetKey] = existing.slice(0, -1) + swapped;
    }
    return copy;
  }
  copy[targetKey] = value;
  return copy;
};

const applyJsonFieldMutation = (baseBody: string | undefined, paramName: string, rawValue: string): string => {
  let parsed: Record<string, unknown>;
  try {
    parsed = baseBody && baseBody.trim().length > 0 ? JSON.parse(baseBody) : {};
  } catch {
    parsed = {};
  }
  let coerced: unknown = rawValue;
  if (rawValue === 'null') coerced = null;
  else if (rawValue === 'true') coerced = true;
  else if (rawValue === 'false') coerced = false;
  else if (rawValue === '[]') coerced = [];
  else if (rawValue === '{}') coerced = {};
  else if (rawValue === '[1,2,3]') coerced = [1, 2, 3];
  else if (/^-?\d+$/.test(rawValue)) coerced = Number(rawValue);
  parsed[paramName] = coerced;
  return JSON.stringify(parsed);
};

const extractStatus = (data: unknown): number | null => {
  if (typeof data === 'object' && data !== null && 'status_code' in data) {
    const v = (data as { status_code?: unknown }).status_code;
    return typeof v === 'number' ? v : null;
  }
  return null;
};

const extractBodySize = (data: unknown): number => {
  if (typeof data === 'object' && data !== null && 'body_size' in data) {
    const v = (data as { body_size?: unknown }).body_size;
    return typeof v === 'number' ? v : 0;
  }
  return 0;
};

const extractResponseTime = (data: unknown): number => {
  if (typeof data === 'object' && data !== null && 'response_time_ms' in data) {
    const v = (data as { response_time_ms?: unknown }).response_time_ms;
    return typeof v === 'number' ? v : 0;
  }
  return 0;
};

const extractBodyPreview = (data: unknown): string => {
  if (typeof data === 'object' && data !== null && 'body_preview' in data) {
    const v = (data as { body_preview?: unknown }).body_preview;
    return typeof v === 'string' ? v : '';
  }
  return '';
};

const extractInterestingHeaders = (data: unknown): Record<string, string> => {
  if (typeof data !== 'object' || data === null || !('interesting_headers' in data)) {
    return {};
  }
  const raw = (data as { interesting_headers?: unknown }).interesting_headers;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
};

const diffHeaders = (
  baselineHeaders: Record<string, string>,
  observedHeaders: Record<string, string>,
): string[] => {
  const names = Array.from(new Set([...Object.keys(baselineHeaders), ...Object.keys(observedHeaders)])).sort();
  const deltas: string[] = [];
  for (const name of names) {
    const baseline = baselineHeaders[name];
    const observed = observedHeaders[name];
    if (baseline !== observed) {
      deltas.push(`${name}: ${baseline ?? '<missing>'} -> ${observed ?? '<missing>'}`);
    }
  }
  return deltas;
};

const summarizeAnomaly = (params: {
  baselineStatus: number | null;
  baselineSize: number;
  observedStatus: number | null;
  observedSize: number;
  baselineTimeMs: number;
  observedTimeMs: number;
  baselinePreview: string;
  observedPreview: string;
  baselineHeaders: Record<string, string>;
  observedHeaders: Record<string, string>;
  signal: NonNullable<DifferentialArgs['signal']>;
}): { anomaly: boolean; reason: string } => {
  const { signal } = params;
  if (signal === 'status') {
    if (params.baselineStatus !== params.observedStatus) {
      return { anomaly: true, reason: `status diverged: baseline=${params.baselineStatus} observed=${params.observedStatus}` };
    }
    return { anomaly: false, reason: 'status equal' };
  }
  if (signal === 'body_length') {
    const delta = Math.abs(params.observedSize - params.baselineSize);
    const ratio = params.baselineSize === 0 ? (params.observedSize > 0 ? Infinity : 0) : delta / params.baselineSize;
    if (delta > 32 && ratio > 0.05) {
      return { anomaly: true, reason: `body length diverged by ${delta} bytes (${(ratio * 100).toFixed(1)}%)` };
    }
    return { anomaly: false, reason: `body length similar (delta=${delta})` };
  }
  if (signal === 'response_time') {
    const delta = params.observedTimeMs - params.baselineTimeMs;
    if (delta > 2000) {
      return { anomaly: true, reason: `response time exceeded baseline by ${delta} ms (possible blind injection)` };
    }
    return { anomaly: false, reason: `response time similar (delta=${delta} ms)` };
  }
  if (signal === 'headers') {
    const headerDeltas = diffHeaders(params.baselineHeaders, params.observedHeaders);
    if (headerDeltas.length > 0) {
      return { anomaly: true, reason: `headers diverged: ${headerDeltas.slice(0, 4).join('; ')}` };
    }
    return { anomaly: false, reason: 'headers equal' };
  }
  // Default: combine status + body length
  const statusChanged = params.baselineStatus !== params.observedStatus;
  const sizeDelta = Math.abs(params.observedSize - params.baselineSize);
  if (statusChanged || sizeDelta > 256) {
    return {
      anomaly: true,
      reason: `status=${params.observedStatus} (baseline=${params.baselineStatus}), body_length delta=${sizeDelta} bytes`,
    };
  }
  return { anomaly: false, reason: 'no meaningful divergence' };
};

const HTTP_DIFFERENTIAL_DESCRIPTION = [
  'Run a differential probe: dispatch one baseline request plus N variants that mutate a single parameter, then return a tabulated diff so you can decide whether the variance is a candidate-worthy signal.',
  '',
  'USE THIS INSTEAD OF five manual http_payload probes when you want to test a single parameter against multiple values. It collapses the "id=1, id=2, id=999, id=null, id=garbage" pattern into one call and returns the deltas already labeled.',
  '',
  'TYPICAL USES:',
  '- IDOR baseline: vary path id={1, 2, 99999999, abc, null} on a parameterized endpoint, observe response variance.',
  '- Mass assignment: vary a JSON body field across boundary, type_confusion, and literals to find accepted unknowns.',
  '- Auth tamper: send the same request with auth header REMOVE / GARBAGE / NEGATE_LAST_CHAR / OTHER_USER to detect missing or weak enforcement.',
  '- Open redirect: vary a redirect parameter across allowed value, attacker-host, scheme-relative, and userinfo bypass.',
  '- Boundary probe: detect off-by-one and integer overflow handling at API boundaries.',
  '',
  'INTERPRETATION:',
  '- If any variant produces an anomaly=true entry with PII-looking content or a privileged response, file a candidate via report_finding with differentialEvidence attached.',
  '- If all variants converge on the same response, the parameter is well-defended for that signal and you should pivot.',
  '- Always note baseline first; then narrow further with http_payload only when one variant warrants follow-up.',
].join('\n');

const HTTP_DIFFERENTIAL_CONTRACT = registerToolContract({
  name: 'http_differential',
  description: HTTP_DIFFERENTIAL_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      url_template: {
        type: 'string',
        description: 'URL template with {paramName} placeholder for path parameters, or plain URL for query/header/body mutations.',
      },
      url: {
        type: 'string',
        description: 'Alias of url_template. If both provided, url_template wins.',
      },
      parameter: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Parameter name (path param, query key, header name, JSON field name).' },
          in: {
            type: 'string',
            enum: ['path', 'query', 'header', 'body_raw', 'body_json_field'],
            description: 'Where the parameter lives in the request.',
          },
        },
        required: ['name', 'in'],
      },
      baseline: { description: 'Baseline value (string, number, or null). The single value used to establish the comparison baseline.' },
      values: {
        type: 'array',
        description: 'Mutation classes plus optional literal values. Total expanded variants are capped at ' + MAX_VARIANTS + '.',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['literal', 'boundary', 'type_confusion', 'injection_sql', 'injection_xss', 'injection_traversal', 'auth_tamper'],
            },
            value: { type: 'string', description: 'Required for kind="literal". Ignored for class kinds.' },
            label: { type: 'string', description: 'Optional friendly label for trace readability.' },
          },
          required: ['kind'],
        },
      },
      signal: {
        type: 'string',
        enum: ['status', 'body_length', 'response_time', 'headers', 'set'],
        description: 'Primary signal to diff on. Defaults to combined status+body_length.',
      },
      method: { type: 'string', description: 'HTTP method (default GET). Use POST/PUT/PATCH when mutating body fields.' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string', description: 'Baseline request body. Required for body_json_field mutations.' },
      timeout: { type: 'number' },
      follow_redirects: { type: 'boolean' },
      insecure: { type: 'boolean' },
      max_body_bytes: { type: 'number' },
    },
    required: ['parameter', 'values'],
  },
});

export const HttpDifferential: ToolImpl = {
  meta: {
    name: 'http_differential',
    description: HTTP_DIFFERENTIAL_CONTRACT.description,
    category: 'web',
    progressKind: 'evidence',
    schema: HTTP_DIFFERENTIAL_CONTRACT.schema,
    risks: ['network', 'read'],
    returns: 'json',
  },

  async run(args: DifferentialArgs, ctx) {
    const templateOuter = (args.url_template ?? args.url ?? '').trim();
    const methodOuter = (args.method ?? 'GET').toUpperCase();
    return runWithGuards(HttpDifferential.meta, ctx, async () => {
      const template = templateOuter;
      const paramName = args.parameter?.name?.trim() ?? '';
      const paramLocation = args.parameter?.in;
      if (!template || !paramName || !paramLocation) {
        return { ok: false, data: { error: 'url_template (or url), parameter.name, and parameter.in are required' } };
      }
      const variants = expandValues(args.values);
      if (variants.length === 0) {
        return { ok: false, data: { error: 'at least one value entry is required' } };
      }
      const signal = args.signal ?? 'set';
      const method = (args.method ?? 'GET').toUpperCase();
      const baseHeaders: Record<string, string> = args.headers ?? {};
      const baseBody = typeof args.body === 'string' ? args.body : '';
      const baselineValue = args.baseline === undefined ? '' : String(args.baseline);

      const buildRequest = (
        value: string,
        kind: MutationKind,
      ): { url: string; headers: Record<string, string>; body: string } => {
        if (paramLocation === 'path' || paramLocation === 'query') {
          return { url: renderUrl(template, paramName, paramLocation, value), headers: baseHeaders, body: baseBody };
        }
        if (paramLocation === 'header' || kind === 'auth_tamper') {
          const target = kind === 'auth_tamper' ? (paramName || 'Authorization') : paramName;
          return { url: template, headers: applyHeaderMutation(baseHeaders, target, value), body: baseBody };
        }
        if (paramLocation === 'body_json_field') {
          return { url: template, headers: baseHeaders, body: applyJsonFieldMutation(baseBody, paramName, value) };
        }
        // body_raw: replace whole body
        return { url: template, headers: baseHeaders, body: value };
      };

      const baselineRequest = buildRequest(baselineValue, 'literal');
      const baselineResult = await executeHttpRequest(
        {
          url: baselineRequest.url,
          method,
          headers: baselineRequest.headers,
          body: baselineRequest.body,
          timeout: args.timeout,
          follow_redirects: args.follow_redirects,
          insecure: args.insecure,
          max_body_bytes: args.max_body_bytes,
          technique: 'differential-baseline',
        },
        ctx,
        { toolName: 'http_differential' },
      );

      const baselineStatus = extractStatus(baselineResult.data);
      const baselineSize = extractBodySize(baselineResult.data);
      const baselineTime = extractResponseTime(baselineResult.data);
      const baselinePreview = extractBodyPreview(baselineResult.data);
      const baselineHeaders = extractInterestingHeaders(baselineResult.data);

      const observations: Array<Record<string, unknown>> = [];
      const anomalies: Array<{ value: string; label: string; reason: string }> = [];

      for (const variant of variants) {
        const variantRequest = buildRequest(variant.value, variant.kind);
        const result = await executeHttpRequest(
          {
            url: variantRequest.url,
            method,
            headers: variantRequest.headers,
            body: variantRequest.body,
            timeout: args.timeout,
            follow_redirects: args.follow_redirects,
            insecure: args.insecure,
            max_body_bytes: args.max_body_bytes,
            technique: `differential-${variant.kind}`,
          },
          ctx,
          { toolName: 'http_differential' },
        );
        const status = extractStatus(result.data);
        const size = extractBodySize(result.data);
        const time = extractResponseTime(result.data);
        const preview = extractBodyPreview(result.data);
        const headers = extractInterestingHeaders(result.data);
        const verdict = summarizeAnomaly({
          baselineStatus,
          baselineSize,
          observedStatus: status,
          observedSize: size,
          baselineTimeMs: baselineTime,
          observedTimeMs: time,
          baselinePreview,
          observedPreview: preview,
          baselineHeaders,
          observedHeaders: headers,
          signal,
        });
        const entry: Record<string, unknown> = {
          label: variant.label,
          kind: variant.kind,
          parameter: paramName,
          baselineValue,
          observedValue: variant.value,
          signal,
          value: variant.value,
          url: variantRequest.url,
          status,
          body_size: size,
          delta_status: status === baselineStatus ? null : `${baselineStatus}->${status}`,
          delta_body_size: size - baselineSize,
          delta: verdict.reason,
          response_time_ms: time,
          delta_response_time_ms: time - baselineTime,
          anomaly: verdict.anomaly,
          reason: verdict.reason,
          note: verdict.reason,
        };
        if (Object.keys(headers).length > 0) {
          entry.headers = headers;
        }
        observations.push(entry);
        if (verdict.anomaly) {
          anomalies.push({ value: variant.value, label: variant.label, reason: verdict.reason });
        }
      }

      const summary = anomalies.length === 0
        ? `All ${observations.length} variants converged on baseline ${signal}. No candidate-worthy differential signal.`
        : `${anomalies.length} of ${observations.length} variants diverged from baseline. Inspect anomalies and consider filing report_finding with differentialEvidence attached.`;

      return {
        ok: true,
        data: {
          baseline: {
            value: baselineValue,
            url: baselineRequest.url,
            status: baselineStatus,
            body_size: baselineSize,
            response_time_ms: baselineTime,
            ...(Object.keys(baselineHeaders).length > 0 ? { headers: baselineHeaders } : {}),
          },
          parameter: { name: paramName, in: paramLocation },
          signal,
          observations,
          anomalies,
          summary,
        },
      };
    }, {}, { url: templateOuter, method: methodOuter });
  },
};

export const tools: ToolModuleDefinition[] = [HttpDifferential].map(fromToolImpl);
