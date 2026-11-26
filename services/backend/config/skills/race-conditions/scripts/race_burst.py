#!/usr/bin/env python3
"""
race_burst.py — Synchronized concurrent HTTP request tool for race condition testing.

Uses threading.Barrier to fire all threads as close to simultaneously as possible,
minimizing the network timing window compared to xargs-based approaches.

Usage:
  python3 race_burst.py \
    --url "https://target.com/api/redeem" \
    --method POST \
    --header "Authorization: Bearer TOKEN" \
    --header "Content-Type: application/json" \
    --body '{"code":"SAVE50"}' \
    --concurrency 20 \
    --output /workspace/race-results/

Output: writes response-N.json for each thread. Prints summary to stdout.
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime


def parse_args():
    p = argparse.ArgumentParser(description="Race condition HTTP burst tool")
    p.add_argument("--url", required=True, help="Target URL")
    p.add_argument("--method", default="POST", help="HTTP method (default: POST)")
    p.add_argument("--header", action="append", dest="headers", default=[],
                   help="Header in 'Name: Value' format (repeatable)")
    p.add_argument("--body", default="", help="Request body (for POST/PUT/PATCH)")
    p.add_argument("--concurrency", type=int, default=20,
                   help="Number of simultaneous requests (default: 20)")
    p.add_argument("--output", default="/workspace/race-results/",
                   help="Output directory for response files")
    p.add_argument("--timeout", type=int, default=30, help="Per-request timeout seconds")
    return p.parse_args()


def send_request(thread_id, url, method, headers, body, timeout, barrier, results, output_dir):
    """Wait at barrier then fire request. Record result."""
    try:
        barrier.wait()  # All threads synchronize here — fire simultaneously
        start = time.time()

        data = body.encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method)
        for h in headers:
            name, _, value = h.partition(":")
            req.add_header(name.strip(), value.strip())

        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - start
            body_bytes = resp.read()
            result = {
                "thread": thread_id,
                "status": resp.status,
                "elapsed_ms": round(elapsed * 1000),
                "body": body_bytes.decode("utf-8", errors="replace"),
                "timestamp": datetime.utcnow().isoformat(),
            }

    except urllib.error.HTTPError as e:
        elapsed = time.time() - start
        result = {
            "thread": thread_id,
            "status": e.code,
            "elapsed_ms": round(elapsed * 1000),
            "body": e.read().decode("utf-8", errors="replace"),
            "timestamp": datetime.utcnow().isoformat(),
            "error": str(e),
        }
    except Exception as e:
        result = {
            "thread": thread_id,
            "status": 0,
            "elapsed_ms": 0,
            "body": "",
            "timestamp": datetime.utcnow().isoformat(),
            "error": str(e),
        }

    results[thread_id] = result

    # Write individual response file
    out_file = os.path.join(output_dir, f"response-{thread_id:03d}.json")
    with open(out_file, "w") as f:
        json.dump(result, f, indent=2)


def main():
    args = parse_args()
    os.makedirs(args.output, exist_ok=True)

    print(f"[*] Race burst: {args.concurrency} threads → {args.method} {args.url}")
    print(f"[*] Output: {args.output}")
    print(f"[*] Synchronizing threads at barrier...")

    barrier = threading.Barrier(args.concurrency)
    results = {}
    threads = []

    for i in range(args.concurrency):
        t = threading.Thread(
            target=send_request,
            args=(i, args.url, args.method, args.headers, args.body,
                  args.timeout, barrier, results, args.output)
        )
        threads.append(t)

    # Start all threads
    for t in threads:
        t.start()

    # Wait for completion
    for t in threads:
        t.join()

    # Summary
    status_counts = {}
    for r in results.values():
        code = r.get("status", 0)
        status_counts[code] = status_counts.get(code, 0) + 1

    print(f"\n[+] Results ({args.concurrency} requests):")
    for code, count in sorted(status_counts.items()):
        print(f"    HTTP {code}: {count} responses")

    # Print bodies of 200 responses (potential successes)
    successes = [r for r in results.values() if r.get("status") == 200]
    if successes:
        print(f"\n[!] {len(successes)} HTTP 200 response(s):")
        for r in successes[:5]:  # Show up to 5
            body_preview = r["body"][:200].replace("\n", " ")
            print(f"    Thread {r['thread']} ({r['elapsed_ms']}ms): {body_preview}")

    if len(successes) > 1:
        print(f"\n[!!!] POTENTIAL RACE CONDITION: {len(successes)} successful responses for single-use operation")
    elif len(successes) == 1:
        print(f"\n[~] Single success — race window may be too narrow. Try higher concurrency.")
    else:
        print(f"\n[-] No successes — operation may be well-protected or concurrency too low.")


if __name__ == "__main__":
    main()
