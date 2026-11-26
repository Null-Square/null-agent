#!/usr/bin/env python3
"""
numeric_boundary_fuzz.py — Test numeric input fields for business logic flaws.

Sends boundary-probing values to a target endpoint and reports any response
that differs from the baseline (same status + similar body length).

Tests: negative, zero, fractional, overflow, extreme positive, string injection.

Usage:
  python3 numeric_boundary_fuzz.py \
    --url "https://target.com/api/cart/add" \
    --method POST \
    --body '{"productId":"PROD-1","quantity":FUZZ}' \
    --header "Authorization: Bearer TOKEN" \
    --header "Content-Type: application/json" \
    --baseline 1 \
    --output /workspace/boundary-results.json

  The string FUZZ in --body is replaced with each test value.
  Baseline is the value for the normal/expected request (used as comparison).
"""

import argparse
import json
import os
import urllib.request
import urllib.error
from datetime import datetime

TEST_VALUES = [
    # Negative values
    (-1, "negative one"),
    (-100, "negative hundred"),
    (-2147483648, "INT32_MIN"),
    (-9223372036854775808, "INT64_MIN"),
    # Zero
    (0, "zero"),
    # Fractions
    (0.001, "near-zero fraction"),
    (0.01, "small fraction"),
    (-0.01, "small negative fraction"),
    # Overflow candidates
    (2147483647, "INT32_MAX"),
    (2147483648, "INT32_MAX+1 (overflow)"),
    (9223372036854775807, "INT64_MAX"),
    (9223372036854775808, "INT64_MAX+1"),
    (4294967295, "UINT32_MAX"),
    # Extreme positive
    (1000000, "one million"),
    (999999999, "near-billion"),
    # String injection (when server doesn't validate type)
    ('"string"', "quoted string"),
    ("null", "null"),
    ("true", "boolean true"),
    ('[1,2,3]', "array injection"),
    ('{"nested": 1}', "object injection"),
]


def send_request(url, method, headers, body_template, value, timeout):
    """Send request with FUZZ replaced by value."""
    body_str = body_template.replace("FUZZ", str(value))
    data = body_str.encode("utf-8")

    req = urllib.request.Request(url, data=data, method=method)
    for h in headers:
        name, _, val = h.partition(":")
        req.add_header(name.strip(), val.strip())

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(2048).decode("utf-8", errors="replace")
            return resp.status, body, None
    except urllib.error.HTTPError as e:
        body = e.read(1024).decode("utf-8", errors="replace")
        return e.code, body, None
    except Exception as ex:
        return 0, "", str(ex)


def main():
    parser = argparse.ArgumentParser(description="Numeric boundary fuzzer for business logic testing")
    parser.add_argument("--url", required=True)
    parser.add_argument("--method", default="POST")
    parser.add_argument("--body", required=True,
                        help="Request body template with FUZZ placeholder")
    parser.add_argument("--header", action="append", dest="headers", default=[])
    parser.add_argument("--baseline", type=float, default=1,
                        help="Baseline value for normal request comparison")
    parser.add_argument("--output", default="/workspace/boundary-results.json")
    parser.add_argument("--timeout", type=int, default=10)
    args = parser.parse_args()

    print(f"[*] Target: {args.method} {args.url}")
    print(f"[*] Baseline value: {args.baseline}")
    print(f"[*] Testing {len(TEST_VALUES)} boundary values\n")

    # Establish baseline
    baseline_status, baseline_body, err = send_request(
        args.url, args.method, args.headers, args.body,
        args.baseline, args.timeout
    )
    print(f"[*] Baseline (value={args.baseline}): HTTP {baseline_status}, body_len={len(baseline_body)}")
    print(f"    {baseline_body[:100]}\n")

    results = []
    anomalies = []

    for value, label in TEST_VALUES:
        status, body, error = send_request(
            args.url, args.method, args.headers, args.body, value, args.timeout
        )

        # Detect anomalies: same 200 status as baseline but with edge-case value
        is_anomaly = (
            status == 200 and baseline_status == 200 and
            str(value) not in [str(args.baseline)]
        )

        # Or: different status from baseline (unexpected acceptance/rejection)
        status_diff = (status != baseline_status)

        result = {
            "value": str(value),
            "label": label,
            "status": status,
            "body_preview": body[:200],
            "body_length": len(body),
            "baseline_status": baseline_status,
            "is_anomaly": is_anomaly or status_diff,
            "anomaly_reason": [],
            "timestamp": datetime.utcnow().isoformat(),
        }

        if status_diff:
            result["anomaly_reason"].append(
                f"Status changed: {baseline_status} → {status}"
            )
        if is_anomaly and "success" in body.lower():
            result["anomaly_reason"].append("Accepted negative/zero/overflow value with success response")
        if status == 200 and ("error" not in body.lower()) and value in (-1, -100, 0):
            result["anomaly_reason"].append(
                f"No validation error for boundary value {value}"
            )

        results.append(result)

        flag = "[!!!]" if result["is_anomaly"] else "[ - ]"
        print(f"{flag} {label:35s} (value={str(value):25s}) → HTTP {status}, len={len(body)}")
        if result["anomaly_reason"]:
            for reason in result["anomaly_reason"]:
                print(f"         ^ {reason}")

        if result["is_anomaly"]:
            anomalies.append(result)

    # Write output
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)
    with open(args.output, "w") as f:
        json.dump({"baseline": baseline_status, "results": results, "anomalies": anomalies}, f, indent=2)

    print(f"\n[+] Anomalies found: {len(anomalies)} / {len(TEST_VALUES)}")
    if anomalies:
        print("[!] Investigate these values — server accepted boundary inputs without validation:")
        for a in anomalies:
            print(f"    value={a['value']} ({a['label']}) → HTTP {a['status']}")
            for r in a["anomaly_reason"]:
                print(f"      - {r}")

    print(f"\n[*] Full results: {args.output}")


if __name__ == "__main__":
    main()
