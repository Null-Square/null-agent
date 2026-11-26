import json
import os
import time

from mitmproxy import http


CAPTURE_PATH = os.environ.get("NULLAI_HTTP_CAPTURE_PATH", "/workspace/.http-proxy.ndjson")
BODY_LIMIT = int(os.environ.get("NULLAI_HTTP_CAPTURE_BODY_LIMIT", "131072"))
REDACT_HEADERS = {
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
}


def _redact_headers(headers):
    output = {}
    for key, value in headers.items():
        output[key] = "[REDACTED]" if key.lower() in REDACT_HEADERS else value
    return output


def _body_preview(content):
    if not content:
        return "", False
    truncated = len(content) > BODY_LIMIT
    data = content[:BODY_LIMIT]
    return data.decode("utf-8", errors="replace"), truncated


def response(flow: http.HTTPFlow) -> None:
    request_body, request_truncated = _body_preview(flow.request.raw_content or b"")
    response_body, response_truncated = _body_preview(flow.response.raw_content or b"")
    record = {
        "id": flow.id,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "mitmproxy",
        "request": {
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "host": flow.request.host,
            "path": flow.request.path,
            "headers": _redact_headers(flow.request.headers),
            "body": request_body,
            "body_truncated": request_truncated,
        },
        "response": {
            "status_code": flow.response.status_code,
            "headers": _redact_headers(flow.response.headers),
            "body": response_body,
            "body_truncated": response_truncated,
        },
    }
    os.makedirs(os.path.dirname(CAPTURE_PATH), exist_ok=True)
    with open(CAPTURE_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
