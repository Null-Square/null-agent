/**
 * HTTP Payload Tool - Unified HTTP requests for security testing.
 *
 * @module agent-brain/adapters/tools/builtins/browser
 */

import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import { executeHttpRequest, type HttpRequestExecutionArgs } from '../runtime/httpRequestExecutor';
import { executeRawHttpSend, type RawHttpSendArgs } from '../runtime/rawHttpExecutor';

const HTTP_PAYLOAD_DESCRIPTION = [
  'Send a normal HTTP request with full control over method, headers, and body. Returns status, a compact body/header preview, timing, passive observations, and a history handle for the stored exchange.',
  '',
  'THIS IS YOUR PRIMARY EVIDENCE TOOL. Every http_payload call produces a complete, structured request and response pair that can be attached directly to a finding. Prefer this over curl via shell_run for any HTTP interaction you need as evidence.',
  '',
  'WHEN TO USE vs other tools:',
  '- Use http_payload for: normal vulnerability testing, API probing, auth bypass attempts, parameter fuzzing, SSRF payloads, and any HTTP interaction where curl-compatible request/response evidence is sufficient.',
  '- Use http_raw_send for: byte-exact malformed requests, duplicate headers, conflicting Content-Length/Transfer-Encoding, request smuggling/desync, CRLF/header injection, parser differentials, and same-socket low-level probes.',
  '- Use browser_action for: JavaScript-rendered pages, multi-step form flows, cookie/session management with a real browser, and SPA testing.',
  '- Use shell_run for: scanner invocations (nmap, nuclei, ffuf) that are not single HTTP requests.',
  '- If repeated paths return the same SPA shell or auth wall, stop brute forcing with http_payload and pivot to browser_action, recon, or repo/code context.',
  '',
  'REQUEST SHAPE:',
  '- Use method, headers, and body for normal testing. This is the right default for almost all API and web validation.',
  '- raw_request/rawRequest is a legacy convenience for request-line + headers + body, but it is parsed, normalized, and sent through curl. Do not use it when exact wire bytes matter.',
  '- When raw_request is set, method, headers, and body are ignored after normalization. For malformed or low-level wire-control testing, use http_raw_send instead.',
  '- Set follow_redirects=false when redirect behavior itself is part of the evidence or auth logic under test.',
  '',
  'TECHNIQUE TAGGING:',
  '- Always set the technique parameter to describe your testing intent, for example probe, idor, sqli, xss, auth-bypass, ssrf, or header-injection.',
  '- The technique tag feeds into approach.tried notes and memory so future runs know what was already tested on this endpoint.',
  '',
  'AUTH AND SESSION HANDLING:',
  '- Include auth headers (Authorization, Cookie, X-API-Key) directly in the headers parameter.',
  '- For auth bypass testing, send one request WITH auth and one WITHOUT, then compare responses. The response delta is the evidence.',
  '- For IDOR testing, send the same request with two different user sessions and compare.',
  '- When comparing auth or tenant contexts, keep the method, path, and non-auth inputs constant so the response delta is attributable to the credential change.',
  '- Stored traces redact sensitive auth headers automatically; you can still use them in the live request.',
  '',
  'EVIDENCE BEST PRACTICES:',
  '- After a successful probe, you already have the evidence. The tool stores the request and response exchange in HTTP history and returns a compact live preview plus a history handle.',
  '- Prefer attaching the returned exchange directly to findings as structured http_exchange evidence rather than pasting screenshots or shell output.',
  '- Use http_view to inspect the stored response again when the live preview is not enough.',
  '- Save the response to a file only when you need a durable artifact for later comparison, triage, or parent-worker handoff.',
  '- For multi-step exploit chains, number your http_payload calls so the finding evidence chain is clear.',
  '- If the body is truncated and you need more proof, rerun with a higher max_body_bytes instead of guessing what the omitted content contained.',
  '',
  'ERROR RECOVERY:',
  '- Timeouts: increase the timeout parameter or check whether the target is rate-limiting.',
  '- SSL errors: set insecure=true for self-signed certs when the rules of engagement allow it.',
  '- Large responses: keep max_body_bytes small to avoid context bloat. Default is 2048. It bounds the live stream as well as the preview, so a large body costs you nothing until you ask for it.',
  '- Do not repeat the exact same failed request indefinitely. Adjust the hypothesis, the auth context, or the transport settings.',
].join('\n');

const HTTP_PAYLOAD_CONTRACT = registerToolContract({
  name: 'http_payload',
  description: HTTP_PAYLOAD_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL (http:// or https://).' },
      raw_request: {
        type: 'string',
        description:
          'Optional legacy raw HTTP request shape (request line + headers + body). This is normalized before curl execution; use http_raw_send for byte-exact malformed or wire-level testing.',
      },
      rawRequest: {
        type: 'string',
        description:
          'Alias of raw_request. This is normalized before curl execution; use http_raw_send for byte-exact malformed or wire-level testing.',
      },
      technique: {
        type: 'string',
        description:
          'Declared testing intent for memory/guarding, for example probe, idor, sqli, xss, auth-bypass, ssrf, or header-injection.',
      },
      method: {
        type: 'string',
        description: 'HTTP method (GET, POST, PUT, DELETE, etc.). Default: GET. Ignored when raw_request is provided.',
      },
      headers: {
        type: 'object',
        description: 'HTTP headers as key-value pairs. Include Authorization, Cookie, or X-API-Key here when needed.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT/PATCH requests. Ignored when raw_request is provided.',
      },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 30).' },
      follow_redirects: {
        type: 'boolean',
        description: 'Follow redirects (default: true). Set false when redirect behavior itself is evidence.',
      },
      insecure: { type: 'boolean', description: 'Skip SSL verification (default: false).' },
      max_body_bytes: {
        type: 'number',
        description:
          'Cap how many response bytes reach you, both in body_preview and in the live output stream. Default: 2048. The full body is still stored, so use http_view when you need more than the preview.',
      },
    },
    required: ['url'],
  },
});

export const HttpPayload: ToolImpl = {
  meta: {
    name: 'http_payload',
    description: HTTP_PAYLOAD_CONTRACT.description,
    category: 'web',
    progressKind: 'evidence',
    schema: HTTP_PAYLOAD_CONTRACT.schema,
    risks: ['network', 'read'],
  },

  async run(args: HttpRequestExecutionArgs, ctx) {
    const targetUrl = typeof args.url === 'string' ? args.url.trim() : '';
    const httpMethod = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';

    return runWithGuards(
      HttpPayload.meta,
      ctx,
      async () => executeHttpRequest(args, ctx, { toolName: 'http_payload' }),
      {},
      { url: targetUrl, method: httpMethod },
    );
  },
};

const HTTP_RAW_SEND_DESCRIPTION = [
  'Send byte-exact HTTP/1.1 bytes over a raw TCP or TLS socket from the run sandbox. This tool preserves duplicate headers, header order, conflicting Content-Length/Transfer-Encoding, malformed chunks, literal CRLF/LF boundaries, omitted Host headers, and same-socket request sequences.',
  '',
  'WHEN TO USE:',
  '- Use http_raw_send only when transport fidelity is the test: request smuggling/desync, CRLF/header injection, parser differentials, malformed chunking, duplicate headers, header-order behavior, or same-socket probes.',
  '- Use http_payload for ordinary API/web requests. http_payload is faster, integrates with normal structured history, follows redirects/cookies, and is safer for routine evidence.',
  '',
  'REQUEST BYTES:',
  '- Provide raw_request for readable ASCII/UTF-8 bytes exactly as they should be sent. Escaped JSON \\r\\n becomes CRLF on the wire; plain \\n remains LF on the wire.',
  '- Provide raw_request_base64 when you need arbitrary bytes that cannot be represented safely in JSON text.',
  '- For multi-request same-socket testing, pass requests[] and set read_strategy="after_all" when you need pipelined/desync-style send-before-read behavior.',
  '',
  'EVIDENCE:',
  '- The tool writes exact request and response byte artifacts under .artifacts/raw-http/<id>/ and records an index entry visible through http_list/http_view.',
  '- Returned previews are compact and may redact common secret headers. The artifact bytes are exact and may contain credentials, so review before attaching them to a customer-facing report.',
].join('\n');

const HTTP_RAW_SEND_CONTRACT = registerToolContract({
  name: 'http_raw_send',
  description: HTTP_RAW_SEND_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Target network URL (http:// or https://). This controls host, port, TLS, policy guards, and routing; it does not alter raw request bytes.',
      },
      raw_request: {
        type: 'string',
        description:
          'Exact request bytes as JSON text. Use explicit \\r\\n when CRLF is required. Not parsed or normalized.',
      },
      rawRequest: {
        type: 'string',
        description: 'Alias of raw_request.',
      },
      raw_request_base64: {
        type: 'string',
        description:
          'Base64-encoded exact request bytes. Prefer this for arbitrary binary, invalid UTF-8, null bytes, or byte-level mutation tests.',
      },
      rawRequestBase64: {
        type: 'string',
        description: 'Alias of raw_request_base64.',
      },
      requests: {
        type: 'array',
        description:
          'Optional same-socket request sequence. Each item accepts raw_request/rawRequest or raw_request_base64/rawRequestBase64 plus optional label and pause_ms.',
        items: {
          type: 'object',
          properties: {
            raw_request: { type: 'string' },
            rawRequest: { type: 'string' },
            raw_request_base64: { type: 'string' },
            rawRequestBase64: { type: 'string' },
            label: { type: 'string' },
            pause_ms: { type: 'number' },
          },
        },
      },
      read_strategy: {
        type: 'string',
        enum: ['after_each', 'after_all'],
        description:
          'after_each sends one request then reads idle response bytes. after_all sends every request on the same socket before reading once.',
      },
      timeout: { type: 'number', description: 'Connection/helper timeout in seconds. Default: 30.' },
      read_idle_timeout_ms: {
        type: 'number',
        description:
          'Stop reading after this many idle milliseconds. Default: 750. Increase for slow or timing-based probes.',
      },
      max_response_bytes: {
        type: 'number',
        description:
          'Maximum raw response bytes to store per read. Default: 64000; capped by runtime guard.',
      },
      insecure: {
        type: 'boolean',
        description: 'Skip TLS certificate verification for self-signed targets when allowed.',
      },
      server_name: {
        type: 'string',
        description:
          'Optional TLS SNI override. Does not change the raw HTTP Host header bytes.',
      },
      technique: {
        type: 'string',
        description:
          'Declared testing intent for memory/guarding, for example request-smuggling, desync, crlf, header-injection, or parser-differential.',
      },
    },
    required: ['url'],
  },
});

export const HttpRawSend: ToolImpl = {
  meta: {
    name: 'http_raw_send',
    description: HTTP_RAW_SEND_CONTRACT.description,
    category: 'web',
    progressKind: 'evidence',
    schema: HTTP_RAW_SEND_CONTRACT.schema,
    risks: ['network', 'read'],
  },

  async run(args: RawHttpSendArgs, ctx) {
    const targetUrl = typeof args.url === 'string' ? args.url.trim() : '';
    return runWithGuards(
      HttpRawSend.meta,
      ctx,
      async () => executeRawHttpSend(args, ctx),
      {},
      { url: targetUrl, raw: true },
    );
  },
};

export const BrowserBuiltins: ToolImpl[] = [HttpPayload, HttpRawSend];

export const tools: ToolModuleDefinition[] = BrowserBuiltins.map(fromToolImpl);
