import { createHash, randomUUID } from 'crypto';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolResult } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { findCloudBlockedNetworkTargetInUrl } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { resolveRunnerSessionBindingFromFlags } from '@/domains/security-ops/runners/runnerSession';
import { ScopeBoundaryService } from '@/domains/security-ops/scopes/ScopeBoundaryService';
import { db } from '@/db/client';
import { logger } from '@/shared/logger';
import {
  appendRawHttpHistoryEntry,
  RAW_HTTP_ARTIFACT_ROOT,
  type RawHttpArtifactRef,
  type RawHttpHistoryEntry,
} from './rawHttpHistory';

const RAW_HTTP_HELPER_PATH = `${RAW_HTTP_ARTIFACT_ROOT}/bin/raw_http_send.py`;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_READ_IDLE_TIMEOUT_MS = 750;
const DEFAULT_MAX_RESPONSE_BYTES = 64_000;
const MAX_RESPONSE_PREVIEW_BYTES = 2_048;
const MAX_REQUEST_PREVIEW_BYTES = 1_500;
const MAX_STORED_RESPONSE_BYTES = 2_000_000;
export const RAW_HTTP_RESULT_MARKER = '__NULLAI_RAW_HTTP_RESULT__';
const scopeBoundaryService = new ScopeBoundaryService(db);

export interface RawHttpRequestPartInput {
  raw_request?: string;
  rawRequest?: string;
  raw_request_base64?: string;
  rawRequestBase64?: string;
  label?: string;
  pause_ms?: number;
}

export interface RawHttpSendArgs {
  url?: string;
  raw_request?: string;
  rawRequest?: string;
  raw_request_base64?: string;
  rawRequestBase64?: string;
  requests?: RawHttpRequestPartInput[];
  read_strategy?: 'after_each' | 'after_all';
  timeout?: number;
  read_idle_timeout_ms?: number;
  max_response_bytes?: number;
  insecure?: boolean;
  server_name?: string;
  technique?: string;
}

type PreparedRawRequest = {
  base64: string;
  size: number;
  sha256: string;
  label?: string;
  pause_ms?: number;
};

type HelperArtifact = {
  path: string;
  sha256: string;
  size: number;
};

type HelperResult = {
  ok: boolean;
  id: string;
  status_code: number | null;
  response_time_ms: number;
  request_artifacts: HelperArtifact[];
  response_artifacts: HelperArtifact[];
  manifest_path: string;
  response_preview_base64?: string;
  response_size: number;
  response_truncated: boolean;
  error?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSecurityOpsCloudSession = (
  session: { flags?: Record<string, unknown> } | undefined,
): boolean => {
  if (!isRecord(session?.flags) || !isRecord(session.flags.securityops)) {
    return false;
  }
  return resolveRunnerSessionBindingFromFlags(session.flags).executionTarget === 'cloud';
};

const sha256Buffer = (value: Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const normalizePositiveInt = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
};

const normalizeBase64Request = (input: RawHttpRequestPartInput): PreparedRawRequest | null => {
  const explicitBase64 =
    typeof input.raw_request_base64 === 'string'
      ? input.raw_request_base64
      : typeof input.rawRequestBase64 === 'string'
        ? input.rawRequestBase64
        : '';
  let bytes: Buffer;
  if (explicitBase64.trim()) {
    try {
      bytes = Buffer.from(explicitBase64.trim(), 'base64');
    } catch {
      return null;
    }
  } else {
    const raw =
      typeof input.raw_request === 'string'
        ? input.raw_request
        : typeof input.rawRequest === 'string'
          ? input.rawRequest
          : '';
    if (!raw) {
      return null;
    }
    bytes = Buffer.from(raw, 'utf8');
  }

  if (bytes.length === 0) {
    return null;
  }

  return {
    base64: bytes.toString('base64'),
    size: bytes.length,
    sha256: sha256Buffer(bytes),
    ...(typeof input.label === 'string' && input.label.trim().length > 0
      ? { label: input.label.trim().slice(0, 80) }
      : {}),
    ...(typeof input.pause_ms === 'number' && Number.isFinite(input.pause_ms)
      ? { pause_ms: Math.max(0, Math.min(30_000, Math.floor(input.pause_ms))) }
      : {}),
  };
};

const buildRequestPreview = (requests: PreparedRawRequest[]): string => {
  const first = Buffer.from(requests[0]?.base64 ?? '', 'base64').toString('utf8');
  const redacted = first.replace(
    /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token):[^\r\n]*/gim,
    (_line, name: string) => `${name}: [REDACTED]`,
  );
  if (Buffer.byteLength(redacted, 'utf8') <= MAX_REQUEST_PREVIEW_BYTES) {
    return redacted;
  }
  return `${Buffer.from(redacted, 'utf8').subarray(0, MAX_REQUEST_PREVIEW_BYTES).toString('utf8')}...[truncated]`;
};

const decodePreview = (base64: string | undefined): string => {
  if (!base64) {
    return '';
  }
  const buffer = Buffer.from(base64, 'base64');
  const sliced = buffer.subarray(0, MAX_RESPONSE_PREVIEW_BYTES).toString('utf8');
  return sliced.endsWith('\uFFFD') ? sliced.slice(0, -1) : sliced;
};

const parseTarget = (rawUrl: string): { url: URL; host: string; port: number; tls: boolean } | string => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'url must be a valid http:// or https:// URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url must use http:// or https://';
  }

  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return 'url has an invalid port';
  }

  return {
    url: parsed,
    host: parsed.hostname,
    port,
    tls: parsed.protocol === 'https:',
  };
};

const toArtifactRefs = (items: HelperArtifact[]): RawHttpArtifactRef[] =>
  items
    .filter(
      (item) =>
        typeof item.path === 'string' &&
        typeof item.sha256 === 'string' &&
        typeof item.size === 'number' &&
        Number.isFinite(item.size),
    )
    .map((item) => ({
      path: item.path,
      sha256: item.sha256,
      size: item.size,
    }));

const parseHelperResult = (stdout: string): HelperResult | null => {
  const line = stdout
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith(RAW_HTTP_RESULT_MARKER));
  if (!line) {
    return null;
  }

  try {
    const parsed = JSON.parse(line.slice(RAW_HTTP_RESULT_MARKER.length)) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      ok: parsed.ok === true,
      id: typeof parsed.id === 'string' ? parsed.id : '',
      status_code:
        typeof parsed.status_code === 'number' && Number.isFinite(parsed.status_code)
          ? parsed.status_code
          : null,
      response_time_ms:
        typeof parsed.response_time_ms === 'number' && Number.isFinite(parsed.response_time_ms)
          ? parsed.response_time_ms
          : 0,
      request_artifacts: Array.isArray(parsed.request_artifacts)
        ? (parsed.request_artifacts.filter(isRecord) as HelperArtifact[])
        : [],
      response_artifacts: Array.isArray(parsed.response_artifacts)
        ? (parsed.response_artifacts.filter(isRecord) as HelperArtifact[])
        : [],
      manifest_path: typeof parsed.manifest_path === 'string' ? parsed.manifest_path : '',
      response_preview_base64:
        typeof parsed.response_preview_base64 === 'string' ? parsed.response_preview_base64 : undefined,
      response_size:
        typeof parsed.response_size === 'number' && Number.isFinite(parsed.response_size)
          ? parsed.response_size
          : 0,
      response_truncated: parsed.response_truncated === true,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
};

const buildHelperInput = (input: {
  id: string;
  target: { url: URL; host: string; port: number; tls: boolean };
  artifactDir: string;
  requests: PreparedRawRequest[];
  readStrategy: 'after_each' | 'after_all';
  timeoutSec: number;
  readIdleTimeoutMs: number;
  maxResponseBytes: number;
  insecure: boolean;
  serverName?: string;
}): Record<string, unknown> => ({
  id: input.id,
  target: {
    url: input.target.url.toString(),
    host: input.target.host,
    port: input.target.port,
    tls: input.target.tls,
    server_name: input.serverName ?? input.target.host,
    insecure: input.insecure,
  },
  artifact_dir: `/workspace/${input.artifactDir}`,
  requests: input.requests,
  read_strategy: input.readStrategy,
  timeout_sec: input.timeoutSec,
  read_idle_timeout_ms: input.readIdleTimeoutMs,
  max_response_bytes: input.maxResponseBytes,
});

export const RAW_HTTP_HELPER_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import socket
import ssl
import sys
import time

RESULT_MARKER = "__NULLAI_RAW_HTTP_RESULT__"

def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()

def write_bytes(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(value)

def rel(path):
    prefix = "/workspace/"
    return path[len(prefix):] if path.startswith(prefix) else path

def parse_status_code(response_bytes):
    if not response_bytes.startswith(b"HTTP/"):
        return None
    first_line = response_bytes.split(b"\r\n", 1)[0].split(b"\n", 1)[0]
    parts = first_line.split()
    if len(parts) < 2:
        return None
    try:
        return int(parts[1])
    except Exception:
        return None

def read_available(sock, idle_timeout, max_bytes):
    chunks = []
    total = 0
    sock.settimeout(idle_timeout)
    while total < max_bytes:
        try:
            chunk = sock.recv(min(16384, max_bytes - total))
        except socket.timeout:
            break
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)

def connect_socket(target, timeout_sec):
    raw = socket.create_connection((target["host"], int(target["port"])), timeout=timeout_sec)
    if not target.get("tls"):
        return raw
    if target.get("insecure"):
        context = ssl._create_unverified_context()
    else:
        context = ssl.create_default_context()
    return context.wrap_socket(raw, server_hostname=target.get("server_name") or target["host"])

def main():
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    exchange_id = payload["id"]
    artifact_dir = payload["artifact_dir"]
    target = payload["target"]
    requests = payload["requests"]
    read_strategy = payload.get("read_strategy", "after_each")
    timeout_sec = max(1, float(payload.get("timeout_sec", 30)))
    idle_timeout = max(0.05, float(payload.get("read_idle_timeout_ms", 750)) / 1000.0)
    max_response_bytes = max(1, int(payload.get("max_response_bytes", 64000)))

    started = time.time()
    request_artifacts = []
    response_artifacts = []
    responses = []
    error = None

    try:
        sock = connect_socket(target, timeout_sec)
        try:
            for index, request in enumerate(requests, start=1):
                req_bytes = base64.b64decode(request["base64"])
                req_path = os.path.join(artifact_dir, f"request-{index}.bin")
                write_bytes(req_path, req_bytes)
                request_artifacts.append({
                    "path": rel(req_path),
                    "sha256": sha256_bytes(req_bytes),
                    "size": len(req_bytes),
                })
                sock.sendall(req_bytes)
                pause_ms = int(request.get("pause_ms") or 0)
                if pause_ms > 0:
                    time.sleep(min(pause_ms, 30000) / 1000.0)
                if read_strategy == "after_each":
                    response = read_available(sock, idle_timeout, max_response_bytes)
                    responses.append(response)
                    resp_path = os.path.join(artifact_dir, f"response-{index}.bin")
                    write_bytes(resp_path, response)
                    response_artifacts.append({
                        "path": rel(resp_path),
                        "sha256": sha256_bytes(response),
                        "size": len(response),
                    })
            if read_strategy == "after_all":
                response = read_available(sock, idle_timeout, max_response_bytes)
                responses.append(response)
                resp_path = os.path.join(artifact_dir, "response-all.bin")
                write_bytes(resp_path, response)
                response_artifacts.append({
                    "path": rel(resp_path),
                    "sha256": sha256_bytes(response),
                    "size": len(response),
                })
        finally:
            try:
                sock.close()
            except Exception:
                pass
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"

    combined = b"".join(responses)
    status_code = parse_status_code(combined)
    elapsed_ms = int((time.time() - started) * 1000)
    preview = combined[:2048]
    manifest_path = os.path.join(artifact_dir, "manifest.json")
    manifest = {
        "id": exchange_id,
        "tool": "http_raw_send",
        "target": target,
        "request_count": len(requests),
        "read_strategy": read_strategy,
        "status_code": status_code,
        "success": error is None,
        "response_time_ms": elapsed_ms,
        "request_artifacts": request_artifacts,
        "response_artifacts": response_artifacts,
        "response_size": len(combined),
        "response_truncated": len(combined) >= max_response_bytes,
        "error": error,
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)

    result = dict(manifest)
    result["ok"] = error is None
    result["manifest_path"] = rel(manifest_path)
    result["response_preview_base64"] = base64.b64encode(preview).decode("ascii")
    print(RESULT_MARKER + json.dumps(result, separators=(",", ":")))
    return 0 if error is None else 2

if __name__ == "__main__":
    raise SystemExit(main())
`;

export async function executeRawHttpSend(args: RawHttpSendArgs, ctx: ToolContext): Promise<ToolResult> {
  const targetUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (!targetUrl) {
    return { ok: false, data: { success: false, error: 'url is required' } };
  }

  const target = parseTarget(targetUrl);
  if (typeof target === 'string') {
    return { ok: false, data: { success: false, error: target } };
  }

  if (ctx.scopeId) {
    try {
      await scopeBoundaryService.assertTarget(ctx.scopeId, target.url.toString());
    } catch (error) {
      return {
        ok: false,
        data: {
          success: false,
          error: error instanceof Error ? error.message : 'Target is outside the authorized pentest scope',
        },
      };
    }
  }

  const requestsInput = Array.isArray(args.requests) && args.requests.length > 0
    ? args.requests
    : [
        {
          raw_request: args.raw_request,
          rawRequest: args.rawRequest,
          raw_request_base64: args.raw_request_base64,
          rawRequestBase64: args.rawRequestBase64,
        },
      ];

  const requests = requestsInput
    .map((entry) => (isRecord(entry) ? normalizeBase64Request(entry) : null))
    .filter((entry): entry is PreparedRawRequest => entry !== null);
  if (requests.length === 0) {
    return {
      ok: false,
      data: {
        success: false,
        error: 'raw_request, raw_request_base64, or requests[] with raw bytes is required',
      },
    };
  }

  const session = getSessionFromContext(ctx);
  if (!session) {
    return { ok: false, data: { success: false, error: `Session ${ctx.sessionId} not found` } };
  }

  if (isSecurityOpsCloudSession(session)) {
    const blockedTarget = findCloudBlockedNetworkTargetInUrl(target.url.toString());
    if (blockedTarget) {
      return {
        ok: false,
        data: {
          success: false,
          error:
            `Cloud execution cannot target private or reserved network addresses (${blockedTarget}). ` +
            'Select an attached private runner for internal CIDR assessment.',
        },
      };
    }
  }

  const exchangeId = randomUUID();
  const artifactDir = `${RAW_HTTP_ARTIFACT_ROOT}/${exchangeId}`;
  const inputPath = `${artifactDir}/input.json`;
  const readStrategy = args.read_strategy === 'after_all' ? 'after_all' : 'after_each';
  const timeoutSec = normalizePositiveInt(args.timeout, DEFAULT_TIMEOUT_SECONDS, 1, 120);
  const readIdleTimeoutMs = normalizePositiveInt(
    args.read_idle_timeout_ms,
    DEFAULT_READ_IDLE_TIMEOUT_MS,
    50,
    30_000,
  );
  const maxResponseBytes = normalizePositiveInt(
    args.max_response_bytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_STORED_RESPONSE_BYTES,
  );

  await ctx.sandbox.writeFile(session, RAW_HTTP_HELPER_PATH, RAW_HTTP_HELPER_SCRIPT);
  await ctx.sandbox.writeFile(
    session,
    inputPath,
    JSON.stringify(
      buildHelperInput({
        id: exchangeId,
        target,
        artifactDir,
        requests,
        readStrategy,
        timeoutSec,
        readIdleTimeoutMs,
        maxResponseBytes,
        insecure: args.insecure === true,
        ...(typeof args.server_name === 'string' && args.server_name.trim().length > 0
          ? { serverName: args.server_name.trim() }
          : {}),
      }),
      null,
      2,
    ),
  );

  const log = logger.child({ scope: 'http_raw_send', sessionId: ctx.sessionId });
  const execResult = await ctx.sandbox.exec({
    session,
    cmd: `python3 /workspace/${RAW_HTTP_HELPER_PATH} /workspace/${inputPath}`,
    timeoutMs: (timeoutSec + Math.ceil(readIdleTimeoutMs / 1000) + 5) * 1000,
    signal: ctx.abortSignal,
  });

  if (execResult.aborted) {
    const abortError = new Error(execResult.abortReason ?? 'Aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  const helper = parseHelperResult(execResult.stdout || '');
  if (!helper) {
    return {
      ok: false,
      data: {
        success: false,
        error: 'raw HTTP helper did not return a parseable result',
        code: execResult.exitCode,
        stderr: (execResult.stderr || '').slice(0, 1000),
      },
    };
  }

  const requestArtifacts = toArtifactRefs(helper.request_artifacts);
  const responseArtifacts = toArtifactRefs(helper.response_artifacts);
  const responsePreview = decodePreview(helper.response_preview_base64);
  const requestPreview = buildRequestPreview(requests);
  const success = helper.ok && !execResult.timedOut && !execResult.aborted && execResult.exitCode === 0;

  const data: Record<string, unknown> = {
    success,
    raw_exchange_id: exchangeId,
    url: target.url.toString(),
    host: target.host,
    port: target.port,
    tls: target.tls,
    status_code: helper.status_code,
    response_time_ms: helper.response_time_ms,
    request_count: requests.length,
    read_strategy: readStrategy,
    exact_wire_bytes: true,
    normalized: false,
    request_sha256: requests.map((request) => request.sha256),
    request_size: requests.map((request) => request.size),
    response_sha256: responseArtifacts.map((artifact) => artifact.sha256),
    response_size: helper.response_size,
    response_truncated: helper.response_truncated,
    request_preview: requestPreview,
    response_preview: responsePreview,
    artifacts: {
      manifest_path: helper.manifest_path,
      request_paths: requestArtifacts.map((artifact) => artifact.path),
      response_paths: responseArtifacts.map((artifact) => artifact.path),
      input_path: inputPath,
    },
    report_safe: false,
    sensitivity_note:
      'Raw request/response artifacts preserve exact bytes and may contain credentials. Review before attaching to customer-facing reports.',
    code: execResult.exitCode,
    timedOut: execResult.timedOut,
    ...(helper.error ? { error: helper.error } : {}),
  };

  if (typeof session.workspaceDir === 'string' && session.workspaceDir.trim().length > 0) {
    const historyEntry: RawHttpHistoryEntry = {
      id: exchangeId,
      ts: new Date().toISOString(),
      source: 'http_raw_send',
      target: {
        url: target.url.toString(),
        host: target.host,
        port: target.port,
        tls: target.tls,
      },
      request_count: requests.length,
      read_strategy: readStrategy,
      status_code: helper.status_code,
      success,
      response_time_ms: helper.response_time_ms,
      request_artifacts: requestArtifacts,
      response_artifacts: responseArtifacts,
      manifest_path: helper.manifest_path,
      request_preview: requestPreview,
      response_preview: responsePreview,
      body_size: helper.response_size,
      response_truncated: helper.response_truncated,
      ...(helper.error ? { error: helper.error } : {}),
    };
    try {
      await appendRawHttpHistoryEntry(session.workspaceDir, historyEntry);
    } catch (error) {
      log.warn({ err: error }, 'Failed to append raw HTTP history entry');
    }
  }

  return {
    ok: success,
    data,
  };
}
