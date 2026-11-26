import { randomUUID } from 'crypto';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolResult } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { findCloudBlockedNetworkTargetsInCommand } from '@/domains/security-ops/scopes/networkTargetPolicy';
import { resolveRunnerSessionBindingFromFlags } from '@/domains/security-ops/runners/runnerSession';
import { logger } from '@/shared/logger';

export const PYTHON_SESSION_ROOT = '.artifacts/python-session';
export const PYTHON_SESSION_SUPERVISOR_PATH = `${PYTHON_SESSION_ROOT}/bin/python_session_supervisor.py`;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
const RESULT_READ_MAX_BYTES = 2_000_000;
const INLINE_OUTPUT_LIMIT_CHARS = 6_000;

export type PythonSessionAction = 'exec' | 'reset' | 'status' | 'stop' | 'replay' | 'replay_poc';

export interface PythonSessionArgs {
  action?: PythonSessionAction;
  code?: string;
  timeout_ms?: number;
  timeoutMs?: number;
  label?: string;
  exchange_id?: string;
  exchangeId?: string;
  poc_path?: string;
  pocPath?: string;
}

interface PythonSupervisorResponse {
  ok?: boolean;
  success?: boolean;
  action?: string;
  data?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

const normalizeTimeoutMs = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
};

const sanitizeSessionKey = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'session';

const isSecurityOpsCloudSession = (flags: Record<string, unknown> | undefined): boolean =>
  resolveRunnerSessionBindingFromFlags(flags).executionTarget === 'cloud';

const readSecurityOpsRunId = (flags: Readonly<Record<string, unknown>> | undefined): string | null => {
  const securityops = isRecord(flags?.securityops) ? flags.securityops : undefined;
  return typeof securityops?.runId === 'string' && securityops.runId.trim().length > 0
    ? securityops.runId.trim()
    : null;
};

const resolveSessionKey = (ctx: ToolContext): string =>
  sanitizeSessionKey(readSecurityOpsRunId(ctx.flags as Record<string, unknown>) ?? ctx.sessionId);

const jsonEscapeForSingleQuotedShell = (value: string): string =>
  value.replace(/'/g, `'\\''`);

const parseSupervisorResponse = (raw: Buffer): PythonSupervisorResponse => {
  const text = raw.toString('utf8').trim();
  if (!text) {
    return { ok: false, success: false, error: 'python_session supervisor returned an empty result' };
  }
  const parsed = JSON.parse(text) as unknown;
  return isRecord(parsed)
    ? parsed as PythonSupervisorResponse
    : { ok: false, success: false, error: 'python_session supervisor returned a non-object result' };
};

export const PYTHON_SESSION_SUPERVISOR_SCRIPT = String.raw`#!/usr/bin/env python3
import ast
import base64
import contextlib
import hashlib
import http.client
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import sys
import time
import traceback
import types
import urllib.parse
import uuid
from pathlib import Path

try:
    import signal
except Exception:
    signal = None


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time() % 1) * 1000):03d}Z"


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def safe_json_dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True)
    tmp.replace(path)


def append_ndjson(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def read_ndjson(path):
    path = Path(path)
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


class ExecutionTimeout(Exception):
    pass


class TimeoutGuard:
    def __init__(self, timeout_ms):
        self.timeout_ms = max(1, int(timeout_ms or 1))
        self.enabled = bool(signal and hasattr(signal, "SIGALRM") and hasattr(signal, "setitimer"))
        self.previous = None

    def __enter__(self):
        if not self.enabled:
            return self
        self.previous = signal.getsignal(signal.SIGALRM)

        def handler(_signum, _frame):
            raise ExecutionTimeout(f"python_session execution exceeded {self.timeout_ms}ms")

        signal.signal(signal.SIGALRM, handler)
        signal.setitimer(signal.ITIMER_REAL, self.timeout_ms / 1000.0)
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        if not self.enabled:
            return False
        signal.setitimer(signal.ITIMER_REAL, 0)
        if self.previous is not None:
            signal.signal(signal.SIGALRM, self.previous)
        return False


class WorkspaceHelper:
    def __init__(self, root, write_root=None):
        self.root = str(root)
        self._root = Path(root).resolve()
        self._write_root = Path(write_root).resolve() if write_root else None
        if self._write_root is not None and self._write_root != self._root and self._root not in self._write_root.parents:
            raise ValueError("workspace write root escapes the run workspace")
        self.write_root = str(self._write_root) if self._write_root is not None else None

    def path(self, relative=""):
        target = (self._root / str(relative)).resolve()
        if target != self._root and self._root not in target.parents:
            raise ValueError("workspace path escapes the run workspace")
        return str(target)

    def rel(self, path):
        target = Path(path).resolve()
        if target != self._root and self._root not in target.parents:
            raise ValueError("workspace path escapes the run workspace")
        return target.relative_to(self._root).as_posix()

    def exists(self, relative):
        return Path(self.path(relative)).exists()

    def writable_path(self, relative=""):
        base = self._write_root if self._write_root is not None else self._root
        target = (base / str(relative)).resolve()
        if target != base and base not in target.parents:
            raise ValueError("workspace write path escapes the allowed artifact root")
        return str(target)

    def read_text(self, relative, encoding="utf-8"):
        return Path(self.path(relative)).read_text(encoding=encoding)

    def write_text(self, relative, content, encoding="utf-8"):
        target = Path(self.writable_path(relative))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding=encoding)
        return self.rel(target)

    def read_bytes(self, relative):
        return Path(self.path(relative)).read_bytes()

    def write_bytes(self, relative, content):
        target = Path(self.writable_path(relative))
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = content.encode("utf-8")
        target.write_bytes(bytes(content))
        return self.rel(target)

    def list(self, relative=".", limit=200):
        target = Path(self.path(relative))
        if not target.exists():
            return []
        rows = []
        for child in sorted(target.iterdir(), key=lambda item: item.name)[: max(1, int(limit))]:
            rows.append({
                "path": self.rel(child),
                "name": child.name,
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else 0,
            })
        return rows


class HttpHistoryHelper:
    def __init__(self, workspace):
        self.workspace = workspace

    def list(self, limit=20, source=None):
        limit = max(1, int(limit or 20))
        rows = []
        if source in (None, "http_payload", "http"):
            for entry in read_ndjson(Path(self.workspace.root) / ".http-history.ndjson"):
                rows.append({"source": "http_payload", **entry})
        if source in (None, "http_raw_send", "raw"):
            for entry in read_ndjson(Path(self.workspace.root) / ".raw-http-history.ndjson"):
                rows.append({"source": "http_raw_send", **entry})
        return rows[-limit:]

    def get(self, exchange_id):
        exchange_id = str(exchange_id)
        for entry in read_ndjson(Path(self.workspace.root) / ".http-history.ndjson"):
            if entry.get("id") == exchange_id:
                return {"source": "http_payload", **entry}
        for entry in read_ndjson(Path(self.workspace.root) / ".raw-http-history.ndjson"):
            if entry.get("id") == exchange_id:
                return {"source": "http_raw_send", **entry}
        return None


class OobHelper:
    def __init__(self, workspace):
        self.workspace = workspace
        self.root = Path(self.workspace.root) / ".artifacts" / "oob"
        self.token_file = self.root / "python-session-tokens.ndjson"
        self.interaction_file = self.root / "python-session-interactions.ndjson"

    def create_token(self, label=None):
        token = f"py-{uuid.uuid4().hex}"
        entry = {"id": str(uuid.uuid4()), "token": token, "label": label or "", "ts": now_iso(), "source": "python_session"}
        append_ndjson(self.token_file, entry)
        return entry

    def check_interactions(self, token=None):
        rows = read_ndjson(self.interaction_file)
        if token:
            rows = [row for row in rows if row.get("token") == token]
        return rows


class RawHttpSender:
    def __init__(self, workspace, cloud_private_block=False):
        self.workspace = workspace
        self.cloud_private_block = bool(cloud_private_block)

    def _rel(self, path):
        return self.workspace.rel(path)

    def _blocked_ip_reason(self, ip_text):
        try:
            ip = ipaddress.ip_address(ip_text)
        except Exception:
            return None
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return str(ip)
        if ip.version == 4:
            if ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("198.18.0.0/15"):
                return str(ip)
        return None

    def _enforce_target_policy(self, host, port):
        if not self.cloud_private_block:
            return
        literal = self._blocked_ip_reason(host)
        if literal:
            raise PermissionError(
                f"Cloud execution cannot target private or reserved network addresses ({literal}). "
                "Select an attached private runner for internal CIDR assessment."
            )
        if host.lower() == "localhost" or host.lower().endswith(".localhost"):
            raise PermissionError(
                "Cloud execution cannot target private or reserved network addresses (localhost). "
                "Select an attached private runner for internal CIDR assessment."
            )
        for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
            resolved = info[4][0]
            blocked = self._blocked_ip_reason(resolved)
            if blocked:
                raise PermissionError(
                    f"Cloud execution cannot target private or reserved network addresses ({blocked}). "
                    "Select an attached private runner for internal CIDR assessment."
                )

    def _prepare_requests(self, raw_request=None, raw_request_base64=None, requests=None):
        if requests:
            items = requests
        else:
            items = [{"raw_request": raw_request, "raw_request_base64": raw_request_base64}]
        prepared = []
        for item in items:
            if isinstance(item, (bytes, bytearray)):
                data = bytes(item)
                label = None
                pause_ms = 0
            elif isinstance(item, str):
                data = item.encode("utf-8")
                label = None
                pause_ms = 0
            elif isinstance(item, dict):
                label = item.get("label")
                pause_ms = int(item.get("pause_ms") or 0)
                encoded = item.get("raw_request_base64") or item.get("rawRequestBase64")
                if encoded:
                    data = base64.b64decode(str(encoded))
                else:
                    raw = item.get("raw_request", item.get("rawRequest", ""))
                    if isinstance(raw, (bytes, bytearray)):
                        data = bytes(raw)
                    else:
                        data = str(raw).encode("utf-8")
            else:
                continue
            if not data:
                continue
            prepared.append({"bytes": data, "label": label, "pause_ms": max(0, min(30000, pause_ms))})
        if not prepared:
            raise ValueError("raw_request, raw_request_base64, or requests[] with raw bytes is required")
        return prepared

    def _connect(self, host, port, tls, timeout, insecure, server_name):
        self._enforce_target_policy(host, port)
        raw = socket.create_connection((host, int(port)), timeout=max(1.0, float(timeout)))
        if not tls:
            return raw
        context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
        return context.wrap_socket(raw, server_hostname=server_name or host)

    def _read_available(self, sock, idle_timeout_ms, max_response_bytes):
        sock.settimeout(max(0.05, float(idle_timeout_ms) / 1000.0))
        chunks = []
        total = 0
        max_response_bytes = max(1, int(max_response_bytes))
        while total < max_response_bytes:
            try:
                chunk = sock.recv(min(16384, max_response_bytes - total))
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)

    def _status_code(self, response):
        if not response.startswith(b"HTTP/"):
            return None
        first = response.split(b"\r\n", 1)[0].split(b"\n", 1)[0]
        parts = first.split()
        if len(parts) < 2:
            return None
        try:
            return int(parts[1])
        except Exception:
            return None

    def send(
        self,
        url,
        raw_request=None,
        raw_request_base64=None,
        requests=None,
        read_strategy="after_each",
        timeout=30,
        read_idle_timeout_ms=750,
        max_response_bytes=64000,
        insecure=False,
        server_name=None,
        technique=None,
    ):
        parsed = urllib.parse.urlparse(str(url))
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("url must be a valid http:// or https:// URL")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        tls = parsed.scheme == "https"
        read_strategy = "after_all" if read_strategy == "after_all" else "after_each"
        prepared = self._prepare_requests(raw_request=raw_request, raw_request_base64=raw_request_base64, requests=requests)

        exchange_id = str(uuid.uuid4())
        artifact_dir = Path(self.workspace.root) / ".artifacts" / "raw-http" / exchange_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        request_artifacts = []
        response_artifacts = []
        responses = []
        error = None
        started = time.time()

        try:
            sock = self._connect(parsed.hostname, port, tls, timeout, insecure, server_name)
            try:
                for index, request in enumerate(prepared, start=1):
                    request_bytes = request["bytes"]
                    request_path = artifact_dir / f"request-{index}.bin"
                    request_path.write_bytes(request_bytes)
                    request_artifacts.append({
                        "path": self._rel(request_path),
                        "sha256": sha256_bytes(request_bytes),
                        "size": len(request_bytes),
                    })
                    sock.sendall(request_bytes)
                    if request["pause_ms"] > 0:
                        time.sleep(request["pause_ms"] / 1000.0)
                    if read_strategy == "after_each":
                        response = self._read_available(sock, read_idle_timeout_ms, max_response_bytes)
                        responses.append(response)
                        response_path = artifact_dir / f"response-{index}.bin"
                        response_path.write_bytes(response)
                        response_artifacts.append({
                            "path": self._rel(response_path),
                            "sha256": sha256_bytes(response),
                            "size": len(response),
                        })
                if read_strategy == "after_all":
                    response = self._read_available(sock, read_idle_timeout_ms, max_response_bytes)
                    responses.append(response)
                    response_path = artifact_dir / "response-all.bin"
                    response_path.write_bytes(response)
                    response_artifacts.append({
                        "path": self._rel(response_path),
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
        status_code = self._status_code(combined)
        elapsed_ms = int((time.time() - started) * 1000)
        request_preview = prepared[0]["bytes"].decode("utf-8", errors="replace")
        request_preview = re.sub(r"^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token):[^\r\n]*", r"\1: [REDACTED]", request_preview, flags=re.I | re.M)
        request_preview = request_preview[:1500]
        response_preview = combined[:2048].decode("utf-8", errors="replace")
        manifest_path = artifact_dir / "manifest.json"
        manifest = {
            "id": exchange_id,
            "tool": "http_raw_send",
            "target": {
                "url": urllib.parse.urlunparse(parsed),
                "host": parsed.hostname,
                "port": port,
                "tls": tls,
                "server_name": server_name or parsed.hostname,
                "insecure": bool(insecure),
            },
            "request_count": len(prepared),
            "read_strategy": read_strategy,
            "status_code": status_code,
            "success": error is None,
            "response_time_ms": elapsed_ms,
            "request_artifacts": request_artifacts,
            "response_artifacts": response_artifacts,
            "response_size": len(combined),
            "response_truncated": len(combined) >= int(max_response_bytes),
            "error": error,
        }
        safe_json_dump(manifest_path, manifest)
        entry = {
            "id": exchange_id,
            "ts": now_iso(),
            "source": "http_raw_send",
            "target": {
                "url": urllib.parse.urlunparse(parsed),
                "host": parsed.hostname,
                "port": port,
                "tls": tls,
            },
            "request_count": len(prepared),
            "read_strategy": read_strategy,
            "status_code": status_code,
            "success": error is None,
            "response_time_ms": elapsed_ms,
            "request_artifacts": request_artifacts,
            "response_artifacts": response_artifacts,
            "manifest_path": self._rel(manifest_path),
            "request_preview": request_preview,
            "response_preview": response_preview,
            "body_size": len(combined),
            "response_truncated": len(combined) >= int(max_response_bytes),
        }
        if error:
            entry["error"] = error
        append_ndjson(Path(self.workspace.root) / ".raw-http-history.ndjson", entry)
        return {
            "success": error is None,
            "raw_exchange_id": exchange_id,
            "url": urllib.parse.urlunparse(parsed),
            "host": parsed.hostname,
            "port": port,
            "tls": tls,
            "status_code": status_code,
            "response_time_ms": elapsed_ms,
            "request_count": len(prepared),
            "read_strategy": read_strategy,
            "exact_wire_bytes": True,
            "normalized": False,
            "request_sha256": [item["sha256"] for item in request_artifacts],
            "request_size": [item["size"] for item in request_artifacts],
            "response_sha256": [item["sha256"] for item in response_artifacts],
            "response_size": len(combined),
            "response_truncated": len(combined) >= int(max_response_bytes),
            "request_preview": request_preview,
            "response_preview": response_preview,
            "artifacts": {
                "manifest_path": self._rel(manifest_path),
                "request_paths": [item["path"] for item in request_artifacts],
                "response_paths": [item["path"] for item in response_artifacts],
            },
            "report_safe": False,
            "sensitivity_note": "Raw request/response artifacts preserve exact bytes and may contain credentials. Review before attaching to customer-facing reports.",
            "error": error,
        }


class PythonSession:
    def __init__(self, config):
        self.config = config
        self.enumeration_local_only = config.get("enumeration_local_only") is True
        self.artifact_write_root = config.get("artifact_write_root")
        self.workspace = WorkspaceHelper(
            config["workspace_root"],
            self.artifact_write_root,
        )
        self.session_dir = Path(config["session_dir"])
        self.output_limit_chars = int(config.get("inline_output_limit_chars") or 6000)
        self.started_at = now_iso()
        self.execution_count = 0
        self.stop_requested = False
        self.raw_sender = RawHttpSender(self.workspace, config.get("cloud_private_block") is True)
        self.http_history = HttpHistoryHelper(self.workspace)
        self.oob = OobHelper(self.workspace)
        self.reset_namespace()

    def reset_namespace(self):
        self.globals = {
            "__name__": "__python_session__",
            "workspace": self.workspace,
            "http_history": self.http_history,
        }
        if not self.enumeration_local_only:
            self.globals.update({
                "raw_send": self.raw_sender.send,
                "replay": self.replay,
                "oob": self.oob,
                "save_poc": self.save_poc,
            })
        self.execution_count = 0

    def visible_names(self):
        return sorted(
            name for name in self.globals.keys()
            if not name.startswith("__") and name not in {"workspace", "http_history", "raw_send", "replay", "oob", "save_poc"}
        )

    def blocked_targets_in_text(self, text):
        if not self.raw_sender.cloud_private_block:
            return []
        matches = set()

        def add_host(host):
            host = str(host or "").strip().strip("[]")
            if not host:
                return
            lowered = host.lower()
            if lowered == "localhost" or lowered.endswith(".localhost"):
                matches.add("localhost")
                return
            literal = self.raw_sender._blocked_ip_reason(host)
            if literal:
                matches.add(literal)

        for url_text in re.findall(r"\bhttps?://[^\s\"'<>)]*", str(text), flags=re.I):
            try:
                parsed = urllib.parse.urlparse(url_text)
            except Exception:
                continue
            if parsed.hostname:
                add_host(parsed.hostname)

        for match in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", str(text)):
            add_host(match)
        if re.search(r"\blocalhost(?:\.localhost)?\b", str(text), flags=re.I):
            matches.add("localhost")
        if re.search(r"(^|[^:\da-f])::1([^:\da-f]|$)", str(text), flags=re.I):
            matches.add("::1")
        if re.search(r"\bfc[0-9a-f]{2}:", str(text), flags=re.I) or re.search(r"\bfd[0-9a-f]{2}:", str(text), flags=re.I):
            matches.add("fc00::/7")
        if re.search(r"\bfe80:", str(text), flags=re.I):
            matches.add("fe80::/10")
        return sorted(matches)

    def enforce_code_target_policy(self, code):
        blocked = self.blocked_targets_in_text(code)
        if blocked:
            raise PermissionError(
                "Cloud execution cannot target private or reserved network addresses "
                f"({', '.join(blocked)}). Select an attached private runner for internal CIDR assessment."
            )

    def enforce_enumeration_local_only(self, tree):
        if not self.enumeration_local_only:
            return
        safe_imports = {
            "base64", "collections", "csv", "datetime", "decimal", "fractions",
            "hashlib", "html", "itertools", "json", "math", "re", "statistics",
        }
        blocked_names = {
            "__import__", "breakpoint", "compile", "delattr", "eval", "exec",
            "getattr", "globals", "help", "input", "locals", "open", "oob",
            "raw_send", "replay", "save_poc", "setattr", "vars",
        }
        blocked_attributes = {
            "connect", "fork", "popen", "request", "send", "sendall", "socket",
            "spawn", "system", "urlopen",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] not in safe_imports:
                        raise PermissionError(
                            f"enumeration_worker Python import denied: {alias.name}"
                        )
            elif isinstance(node, ast.ImportFrom):
                module = str(node.module or "").split(".")[0]
                if node.level or module not in safe_imports:
                    raise PermissionError(
                        f"enumeration_worker Python import denied: {node.module or '(relative import)'}"
                    )
            elif isinstance(node, ast.Name) and node.id in blocked_names:
                raise PermissionError(
                    f"enumeration_worker Python capability denied: {node.id}"
                )
            elif isinstance(node, ast.Attribute):
                if node.attr.startswith("__") or node.attr in blocked_attributes:
                    raise PermissionError(
                        f"enumeration_worker Python attribute denied: {node.attr}"
                    )

    def artifact_for_text(self, request_id, name, value):
        outputs_dir = (
            Path(self.workspace.write_root) / "python-session"
            if self.workspace.write_root
            else self.session_dir / "outputs"
        )
        outputs_dir.mkdir(parents=True, exist_ok=True)
        path = outputs_dir / f"{request_id}-{name}.txt"
        path.write_text(value, encoding="utf-8")
        return self.workspace.rel(path)

    def cap_text(self, request_id, name, value):
        if not isinstance(value, str):
            value = str(value)
        if len(value) <= self.output_limit_chars:
            return value, False, None
        path = self.artifact_for_text(request_id, name, value)
        preview = value[: self.output_limit_chars].rstrip() + "...[truncated by python_session]"
        return preview, True, {"path": path, "chars": len(value), "sha256": hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()}

    def save_poc(self, name_or_code, code=None):
        if code is None:
            code = str(name_or_code)
            name = f"poc-{int(time.time())}.py"
        else:
            name = str(name_or_code)
        name = re.sub(r"[^a-zA-Z0-9._-]+", "-", name).strip(".-") or "poc.py"
        if not name.endswith(".py"):
            name += ".py"
        target = (
            Path(self.workspace.write_root) / "poc" / name
            if self.workspace.write_root
            else Path(self.workspace.root) / ".artifacts" / "poc" / name
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        content = str(code)
        target.write_text(content, encoding="utf-8")
        return {"path": self.workspace.rel(target), "bytes": len(content.encode("utf-8")), "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}

    def execute_python(self, code, timeout_ms, request_id):
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()
        result_value = None
        result_repr = None
        success = True
        error = None
        started = time.time()

        try:
            self.enforce_code_target_policy(code)
            tree = ast.parse(code, filename="<python_session>", mode="exec")
            self.enforce_enumeration_local_only(tree)
            with TimeoutGuard(timeout_ms):
                with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
                    if tree.body and isinstance(tree.body[-1], ast.Expr):
                        prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
                        ast.fix_missing_locations(prefix)
                        if prefix.body:
                            exec(compile(prefix, "<python_session>", "exec"), self.globals, self.globals)
                        expr = ast.Expression(tree.body[-1].value)
                        ast.fix_missing_locations(expr)
                        result_value = eval(compile(expr, "<python_session>", "eval"), self.globals, self.globals)
                    else:
                        exec(compile(tree, "<python_session>", "exec"), self.globals, self.globals)
                if result_value is not None:
                    try:
                        result_repr = repr(result_value)
                    except Exception:
                        result_repr = f"<unrepresentable {type(result_value).__name__}>"
        except Exception as exc:
            success = False
            error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc(file=stderr_buffer)

        self.execution_count += 1
        elapsed_ms = int((time.time() - started) * 1000)
        stdout_full = stdout_buffer.getvalue()
        stderr_full = stderr_buffer.getvalue()
        stdout, stdout_truncated, stdout_artifact = self.cap_text(request_id, "stdout", stdout_full)
        stderr, stderr_truncated, stderr_artifact = self.cap_text(request_id, "stderr", stderr_full)
        artifacts = {}
        if stdout_artifact:
            artifacts["stdout"] = stdout_artifact
        if stderr_artifact:
            artifacts["stderr"] = stderr_artifact
        if isinstance(result_repr, str):
            result_repr, result_truncated, result_artifact = self.cap_text(request_id, "result", result_repr)
            if result_truncated and result_artifact:
                artifacts["result"] = result_artifact
        else:
            result_truncated = False

        return {
            "success": success,
            "action": "exec",
            "execution_count": self.execution_count,
            "elapsed_ms": elapsed_ms,
            "stdout": stdout,
            "stderr": stderr,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
            "result_repr": result_repr,
            "result_truncated": result_truncated,
            "defined_names": self.visible_names(),
            "artifacts": artifacts,
            "error": error,
        }

    def replay_raw(self, entry):
        requests = []
        for artifact in entry.get("request_artifacts") or []:
            path = artifact.get("path") if isinstance(artifact, dict) else None
            if not path:
                continue
            data = Path(self.workspace.path(path)).read_bytes()
            requests.append({"raw_request_base64": base64.b64encode(data).decode("ascii")})
        if not requests:
            raise ValueError("raw exchange has no request artifacts to replay")
        target = entry.get("target") or {}
        result = self.raw_sender.send(
            target.get("url"),
            requests=requests,
            read_strategy=entry.get("read_strategy") or "after_each",
        )
        diff = {
            "status_code": {"before": entry.get("status_code"), "after": result.get("status_code"), "matched": entry.get("status_code") == result.get("status_code")},
            "body_size": {"before": entry.get("body_size"), "after": result.get("response_size"), "matched": entry.get("body_size") == result.get("response_size")},
            "response_sha256": {
                "before": [item.get("sha256") for item in (entry.get("response_artifacts") or []) if isinstance(item, dict)],
                "after": result.get("response_sha256") or [],
            },
        }
        diff["response_sha256"]["matched"] = diff["response_sha256"]["before"] == diff["response_sha256"]["after"]
        return {
            "success": result.get("success") is True,
            "source": "http_raw_send",
            "exchange_id": entry.get("id"),
            "new_exchange_id": result.get("raw_exchange_id"),
            "matched": all(item.get("matched") is True for item in diff.values() if isinstance(item, dict)),
            "diff": diff,
            "result": result,
        }

    def replay_http(self, entry):
        request = entry.get("request") or {}
        url = urllib.parse.urlparse(request.get("url") or "")
        if url.scheme not in ("http", "https") or not url.hostname:
            raise ValueError("stored HTTP exchange has no replayable URL")
        body = request.get("body")
        body_bytes = body.encode("utf-8") if isinstance(body, str) else None
        headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
        timeout = ((request.get("options") or {}).get("timeout") if isinstance(request.get("options"), dict) else None) or 30
        context = None
        if url.scheme == "https" and isinstance(request.get("options"), dict) and request["options"].get("insecure") is True:
            context = ssl._create_unverified_context()
        connection_cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        port = url.port or (443 if url.scheme == "https" else 80)
        self.raw_sender._enforce_target_policy(url.hostname, port)
        started = time.time()
        conn = connection_cls(url.hostname, port=port, timeout=max(1, float(timeout)), context=context) if url.scheme == "https" else connection_cls(url.hostname, port=port, timeout=max(1, float(timeout)))
        path = urllib.parse.urlunparse(("", "", url.path or "/", url.params, url.query, ""))
        response_body = b""
        response_headers = ""
        status_code = None
        error = None
        try:
            conn.request(str(request.get("method") or "GET").upper(), path, body=body_bytes, headers=headers)
            response = conn.getresponse()
            status_code = response.status
            response_headers = "\r\n".join(f"{key}: {value}" for key, value in response.getheaders())
            response_body = response.read(2_000_000)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            try:
                conn.close()
            except Exception:
                pass
        elapsed_ms = int((time.time() - started) * 1000)
        new_id = str(uuid.uuid4())
        text = response_body.decode("utf-8", errors="replace")
        new_entry = {
            "id": new_id,
            "ts": now_iso(),
            "request": request,
            "success": error is None,
            "status_code": status_code,
            "response_time_ms": elapsed_ms,
            "body_size": len(response_body),
            "body_truncated": False,
            "body_preview": text[:2048],
            "response_body": text,
            "response_headers": response_headers,
            "replayed_from": entry.get("id"),
        }
        if error:
            new_entry["curl_error"] = error
        append_ndjson(Path(self.workspace.root) / ".http-history.ndjson", new_entry)
        diff = {
            "status_code": {"before": entry.get("status_code"), "after": status_code, "matched": entry.get("status_code") == status_code},
            "body_size": {"before": entry.get("body_size"), "after": len(response_body), "matched": entry.get("body_size") == len(response_body)},
            "body_sha256": {"before": hashlib.sha256(str(entry.get("response_body") or "").encode("utf-8")).hexdigest(), "after": sha256_bytes(response_body)},
        }
        diff["body_sha256"]["matched"] = diff["body_sha256"]["before"] == diff["body_sha256"]["after"]
        return {
            "success": error is None,
            "source": "http_payload",
            "exchange_id": entry.get("id"),
            "new_exchange_id": new_id,
            "matched": all(item.get("matched") is True for item in diff.values() if isinstance(item, dict)),
            "diff": diff,
            "result": new_entry,
        }

    def replay(self, exchange_id):
        entry = self.http_history.get(exchange_id)
        if not entry:
            raise KeyError(f"exchange id not found: {exchange_id}")
        source = entry.get("source")
        if source == "http_raw_send":
            return self.replay_raw(entry)
        return self.replay_http(entry)

    def replay_poc(self, poc_path, timeout_ms, request_id):
        target = Path(self.workspace.path(str(poc_path)))
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(str(poc_path))
        code = target.read_text(encoding="utf-8")
        return self.execute_python(code, timeout_ms, request_id)

    def status(self):
        return {
            "success": True,
            "action": "status",
            "pid": os.getpid(),
            "started_at": self.started_at,
            "execution_count": self.execution_count,
            "defined_names": self.visible_names(),
            "helpers": (
                ["workspace", "http_history"]
                if self.enumeration_local_only
                else ["workspace", "http_history", "raw_send", "replay", "oob", "save_poc"]
            ),
            "session_dir": self.workspace.rel(self.session_dir),
        }

    def handle(self, request):
        request_id = str(request.get("id") or uuid.uuid4())
        action = str(request.get("action") or "exec")
        timeout_ms = max(1, int(request.get("timeout_ms") or 30000))
        started = time.time()
        try:
            if action == "status":
                data = self.status()
            elif action == "reset":
                self.reset_namespace()
                data = {"success": True, "action": "reset", "execution_count": self.execution_count, "defined_names": self.visible_names()}
            elif action == "stop":
                self.stop_requested = True
                data = {"success": True, "action": "stop", "pid": os.getpid()}
            elif action == "replay":
                exchange_id = request.get("exchange_id")
                if not exchange_id:
                    raise ValueError("exchange_id is required for replay")
                data = self.replay(exchange_id)
                data["action"] = "replay"
            elif action == "replay_poc":
                poc_path = request.get("poc_path")
                if not poc_path:
                    raise ValueError("poc_path is required for replay_poc")
                data = self.replay_poc(poc_path, timeout_ms, request_id)
                data["action"] = "replay_poc"
            elif action == "exec":
                code = request.get("code")
                if not isinstance(code, str) or not code.strip():
                    raise ValueError("code is required for python_session exec")
                data = self.execute_python(code, timeout_ms, request_id)
            else:
                raise ValueError(f"unsupported python_session action: {action}")
            ok = data.get("success") is not False
            return {"ok": ok, "success": ok, "request_id": request_id, "elapsed_ms": int((time.time() - started) * 1000), **data}
        except Exception as exc:
            stderr = traceback.format_exc()
            preview, truncated, artifact = self.cap_text(request_id, "stderr", stderr)
            return {
                "ok": False,
                "success": False,
                "request_id": request_id,
                "action": action,
                "elapsed_ms": int((time.time() - started) * 1000),
                "error": f"{type(exc).__name__}: {exc}",
                "stderr": preview,
                "stderr_truncated": truncated,
                "artifacts": {"stderr": artifact} if artifact else {},
            }


def main():
    config_path = Path(sys.argv[1])
    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    session = PythonSession(config)
    session_dir = Path(config["session_dir"])
    requests_dir = session_dir / "requests"
    results_dir = session_dir / "results"
    requests_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)
    safe_json_dump(session_dir / "status.json", session.status())
    stop_flag = session_dir / "stop.flag"

    while not session.stop_requested and not stop_flag.exists():
        for request_path in sorted(requests_dir.glob("*.json"), key=lambda item: item.name):
            try:
                with request_path.open("r", encoding="utf-8") as handle:
                    request = json.load(handle)
            except json.JSONDecodeError:
                if time.time() - request_path.stat().st_mtime < 1:
                    continue
                request = {"id": request_path.stem, "action": "error", "code": "", "decode_error": True}
            except FileNotFoundError:
                continue
            request_id = str(request.get("id") or request_path.stem)
            result = session.handle(request)
            safe_json_dump(results_dir / f"{request_id}.json", result)
            safe_json_dump(session_dir / "status.json", session.status())
            try:
                request_path.unlink()
            except FileNotFoundError:
                pass
        time.sleep(0.05)


if __name__ == "__main__":
    main()
`;

async function ensureSupervisor(ctx: ToolContext, sessionKey: string, cloudPrivateBlock: boolean): Promise<{
  sessionDir: string;
  requestsDir: string;
  resultsDir: string;
}> {
  const session = getSessionFromContext(ctx);
  if (!session) {
    throw new Error(`Session ${ctx.sessionId} not found`);
  }

  const sessionDir = `${PYTHON_SESSION_ROOT}/${sessionKey}`;
  const requestsDir = `${sessionDir}/requests`;
  const resultsDir = `${sessionDir}/results`;
  const configPath = `${sessionDir}/config.json`;
  const pidPath = `${sessionDir}/pid`;
  const enumerationLocalOnly =
    session.coordination?.role === 'worker' &&
    session.coordination.workerType === 'enumeration_worker';
  const enumerationTaskId = enumerationLocalOnly
    ? session.coordination?.parentTaskId?.replace(/[^a-zA-Z0-9._-]/gu, '_')
    : undefined;
  if (enumerationLocalOnly && !enumerationTaskId) {
    throw new Error('enumeration_worker artifact_scope_missing: parent task id is required');
  }
  const artifactWriteRoot =
    session.coordination?.role === 'worker' &&
    Array.isArray(session.coordination.writeScope) &&
    session.coordination.writeScope.length === 1 &&
    session.coordination.writeScope[0].startsWith('/workspace/.artifacts/')
      ? session.coordination.writeScope[0]
      : undefined;

  await ctx.sandbox.writeFile(session, PYTHON_SESSION_SUPERVISOR_PATH, PYTHON_SESSION_SUPERVISOR_SCRIPT);
  await ctx.sandbox.writeFile(
    session,
    configPath,
    JSON.stringify(
      {
        workspace_root: '/workspace',
        session_dir: `/workspace/${sessionDir}`,
        inline_output_limit_chars: INLINE_OUTPUT_LIMIT_CHARS,
        cloud_private_block: cloudPrivateBlock,
        enumeration_local_only: enumerationLocalOnly,
        ...(artifactWriteRoot ? { artifact_write_root: artifactWriteRoot } : {}),
        ...(enumerationTaskId
          ? {
              artifact_write_root:
                `/workspace/.artifacts/workers/enumeration/${enumerationTaskId}`,
            }
          : {}),
      },
      null,
      2,
    ),
  );

  const quotedSupervisor = `/workspace/${PYTHON_SESSION_SUPERVISOR_PATH}`;
  const quotedConfig = `/workspace/${configPath}`;
  const quotedSessionDir = `/workspace/${sessionDir}`;
  const quotedPidPath = `/workspace/${pidPath}`;
  const command = [
    `mkdir -p '${jsonEscapeForSingleQuotedShell(`/workspace/${requestsDir}`)}' '${jsonEscapeForSingleQuotedShell(`/workspace/${resultsDir}`)}'`,
    `if [ -f '${jsonEscapeForSingleQuotedShell(quotedPidPath)}' ] && kill -0 "$(cat '${jsonEscapeForSingleQuotedShell(quotedPidPath)}')" 2>/dev/null; then echo running; else rm -f '${jsonEscapeForSingleQuotedShell(`${quotedSessionDir}/stop.flag`)}'; nohup python3 '${jsonEscapeForSingleQuotedShell(quotedSupervisor)}' '${jsonEscapeForSingleQuotedShell(quotedConfig)}' >> '${jsonEscapeForSingleQuotedShell(`${quotedSessionDir}/stdout.log`)}' 2>> '${jsonEscapeForSingleQuotedShell(`${quotedSessionDir}/stderr.log`)}' & echo $! > '${jsonEscapeForSingleQuotedShell(quotedPidPath)}'; echo started; fi`,
  ].join(' && ');

  const started = await ctx.sandbox.exec({
    session,
    cmd: command,
    timeoutMs: 10_000,
    signal: ctx.abortSignal,
  });
  if (started.aborted) {
    const abortError = new Error(started.abortReason ?? 'Aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
  if (started.exitCode !== 0) {
    throw new Error(`python_session supervisor failed to start: ${(started.stderr || started.stdout || '').slice(0, 1000)}`);
  }

  return { sessionDir, requestsDir, resultsDir };
}

export async function stopPythonSession(ctx: ToolContext): Promise<ToolResult> {
  return executePythonSession({ action: 'stop' }, ctx);
}

export async function executePythonSession(args: PythonSessionArgs, ctx: ToolContext): Promise<ToolResult> {
  const session = getSessionFromContext(ctx);
  if (!session) {
    return { ok: false, data: { success: false, error: `Session ${ctx.sessionId} not found` } };
  }

  const action = args.action ?? 'exec';
  const code = typeof args.code === 'string' ? args.code : '';
  const timeoutMs = normalizeTimeoutMs(args.timeout_ms ?? args.timeoutMs);
  const exchangeId =
    typeof args.exchange_id === 'string'
      ? args.exchange_id.trim()
      : typeof args.exchangeId === 'string'
        ? args.exchangeId.trim()
        : '';
  const pocPath =
    typeof args.poc_path === 'string'
      ? args.poc_path.trim()
      : typeof args.pocPath === 'string'
        ? args.pocPath.trim()
        : '';

  if (action === 'exec' && code.trim().length === 0) {
    return { ok: false, data: { success: false, error: 'code is required for python_session exec' } };
  }
  if (action === 'replay' && !exchangeId) {
    return { ok: false, data: { success: false, error: 'exchange_id is required for python_session replay' } };
  }
  if (action === 'replay_poc' && !pocPath) {
    return { ok: false, data: { success: false, error: 'poc_path is required for python_session replay_poc' } };
  }
  const enumerationLocalOnly =
    session.coordination?.role === 'worker' &&
    session.coordination.workerType === 'enumeration_worker';
  if (enumerationLocalOnly && (action === 'replay' || action === 'replay_poc')) {
    return {
      ok: false,
      data: {
        success: false,
        error:
          `enumeration_worker unmetered_network_denied: Python ${action} is disabled; use the scoped HTTP tools`,
      },
    };
  }

  const cloudPrivateBlock = isSecurityOpsCloudSession(session.flags as Record<string, unknown>);
  if (cloudPrivateBlock && (action === 'exec' || action === 'replay_poc')) {
    const blockedTargets = findCloudBlockedNetworkTargetsInCommand(action === 'exec' ? code : pocPath);
    if (blockedTargets.length > 0) {
      return {
        ok: false,
        data: {
          success: false,
          error:
            `Cloud execution cannot target private or reserved network addresses (${blockedTargets.join(', ')}). ` +
            'Select an attached private runner for internal CIDR assessment.',
        },
      };
    }
  }

  const log = logger.child({ scope: 'python_session', sessionId: ctx.sessionId });
  try {
    const sessionKey = resolveSessionKey(ctx);
    const dirs = await ensureSupervisor(ctx, sessionKey, cloudPrivateBlock);
    const requestId = randomUUID();
    const requestPath = `${dirs.requestsDir}/${requestId}.json`;
    const resultPath = `${dirs.resultsDir}/${requestId}.json`;
    const request: Record<string, unknown> = {
      id: requestId,
      action,
      timeout_ms: timeoutMs,
      ...(code ? { code } : {}),
      ...(typeof args.label === 'string' && args.label.trim().length > 0 ? { label: args.label.trim().slice(0, 120) } : {}),
      ...(exchangeId ? { exchange_id: exchangeId } : {}),
      ...(pocPath ? { poc_path: pocPath } : {}),
    };

    await ctx.sandbox.writeFile(session, requestPath, JSON.stringify(request, null, 2));

    const deadline = Date.now() + timeoutMs + 5_000;
    while (Date.now() < deadline) {
      if (ctx.abortSignal.aborted) {
        const abortError = new Error('Aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      try {
        const raw = await ctx.sandbox.readFile(session, resultPath, RESULT_READ_MAX_BYTES);
        const response = parseSupervisorResponse(raw);
        return {
          ok: response.ok === true || response.success === true,
          data: response,
        };
      } catch (error) {
        const codeValue = (error as NodeJS.ErrnoException | undefined)?.code;
        if (codeValue !== 'ENOENT') {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('ENOENT') && !message.includes('no such file')) {
            throw error;
          }
        }
      }
      await sleep(POLL_INTERVAL_MS, ctx.abortSignal);
    }

    return {
      ok: false,
      data: {
        success: false,
        action,
        error: `python_session timed out waiting for supervisor result after ${timeoutMs}ms`,
        request_id: requestId,
        result_path: resultPath,
      },
    };
  } catch (error) {
    log.warn({ err: error, action }, 'python_session execution failed');
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    return {
      ok: false,
      data: {
        success: false,
        action,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
