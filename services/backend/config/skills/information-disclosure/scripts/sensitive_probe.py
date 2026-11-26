#!/usr/bin/env python3
"""
sensitive_probe.py — Comprehensive sensitive file and path discovery tool.

Probes a target for exposed configuration files, credentials, backup files,
debug endpoints, version control directories, and cloud metadata endpoints.

Usage:
  python3 sensitive_probe.py --target https://target.com --output /workspace/id-findings.json
  python3 sensitive_probe.py --target https://target.com --category credentials
  python3 sensitive_probe.py --target https://target.com --concurrency 20 --timeout 8

Output: JSON file with all HTTP 200/206 responses plus a console summary.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ── Probe categories ──────────────────────────────────────────────────────────

PROBE_PATHS = {
    "credentials": [
        "/.env", "/.env.production", "/.env.local", "/.env.backup",
        "/.env.old", "/.env.example", "/.env.staging", "/.env.test",
        "/config.php", "/config.ini", "/config.yaml", "/config.yml",
        "/configuration.php", "/settings.py", "/settings.php",
        "/application.properties", "/application.yml", "/application.yaml",
        "/database.php", "/db.php", "/db.ini", "/db.yml",
        "/wp-config.php", "/wp-config.php.bak",
        "/web.config", "/.htaccess", "/.htpasswd",
        "/credentials", "/credentials.json", "/credentials.yml",
        "/secrets.json", "/secrets.yml", "/keys.json",
        "/serviceaccount.json", "/sa.json", "/gcp-credentials.json",
    ],
    "backups": [
        "/backup.sql", "/dump.sql", "/database.sql", "/db.sql",
        "/backup.zip", "/backup.tar.gz", "/backup.tar",
        "/site.zip", "/www.zip", "/htdocs.zip", "/public.zip",
        "/files.tar.gz", "/data.zip",
        "/index.php.bak", "/index.php~", "/index.bak",
        "/config.php.bak", "/config.php.old", "/config.php~",
        "/database.php.bak", "/settings.py.bak",
    ],
    "vcs": [
        "/.git/HEAD", "/.git/config", "/.git/COMMIT_EDITMSG",
        "/.git/info/refs", "/.git/logs/HEAD",
        "/.svn/entries", "/.svn/wc.db",
        "/.hg/hgrc", "/.hg/store/00manifest.i",
        "/.bzr/branch/branch.conf",
    ],
    "debug": [
        "/debug", "/debug/vars", "/debug/pprof",
        "/metrics", "/prometheus/metrics",
        "/actuator", "/actuator/env", "/actuator/beans",
        "/actuator/mappings", "/actuator/httptrace",
        "/actuator/logfile", "/actuator/dump", "/actuator/health",
        "/server-status", "/server-info", "/nginx_status",
        "/phpinfo.php", "/info.php", "/test.php",
        "/_profiler", "/__admin", "/__admin/mappings",
        "/console", "/h2-console",
        "/env", "/config", "/trace",
    ],
    "cloud_metadata": [
        # AWS IMDS (if target is on EC2 and SSRF exists — probe from sandbox context)
        "/latest/meta-data/",
        "/latest/meta-data/iam/security-credentials/",
        # GCP metadata
        "/computeMetadata/v1/",
        # Azure metadata
        "/metadata/instance",
    ],
    "packages": [
        "/composer.json", "/composer.lock",
        "/package.json", "/package-lock.json", "/yarn.lock",
        "/Gemfile", "/Gemfile.lock",
        "/requirements.txt", "/Pipfile", "/poetry.lock",
        "/pom.xml", "/build.gradle",
        "/Dockerfile", "/docker-compose.yml", "/docker-compose.yaml",
        "/.dockerignore", "/.gitignore",
    ],
    "ide_and_os": [
        "/.DS_Store",
        "/.idea/workspace.xml", "/.idea/dataSources.xml",
        "/.vscode/settings.json", "/.vscode/launch.json",
        "/.project", "/.classpath",
        "/nbproject/private/private.properties",
        "/crossdomain.xml", "/clientaccesspolicy.xml",
    ],
    "logs": [
        "/logs/error.log", "/logs/access.log", "/log/error.log",
        "/var/log/nginx/error.log", "/var/log/apache2/error.log",
        "/app.log", "/application.log", "/debug.log",
        "/storage/logs/laravel.log", "/laravel.log",
    ],
}

ALL_PATHS = [p for paths in PROBE_PATHS.values() for p in paths]


def probe_path(target, path, timeout):
    url = f"{target.rstrip('/')}{path}"
    try:
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", "Mozilla/5.0 (compatible; security-assessment)")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(4096)  # Read first 4KB only
            return {
                "url": url,
                "path": path,
                "status": resp.status,
                "content_type": resp.headers.get("Content-Type", ""),
                "content_length": resp.headers.get("Content-Length", ""),
                "body_preview": body.decode("utf-8", errors="replace")[:500],
                "timestamp": datetime.utcnow().isoformat(),
            }
    except urllib.error.HTTPError as e:
        if e.code not in (404, 410):  # Report non-404 errors
            return {
                "url": url, "path": path, "status": e.code,
                "content_type": "", "content_length": "",
                "body_preview": "", "timestamp": datetime.utcnow().isoformat(),
            }
        return None
    except Exception:
        return None


def categorize_finding(result):
    """Assign severity and category based on path and content."""
    path = result["path"].lower()
    body = result["body_preview"].lower()

    if any(x in path for x in [".env", "credentials", "secrets", "keys"]):
        if any(x in body for x in ["password", "secret", "token", "key", "api"]):
            return "critical", "Credentials/Secrets"
        return "high", "Configuration File"

    if ".git/head" in path or "/.git/" in path:
        return "critical", "Git Repository Exposure"

    if any(x in path for x in ["actuator/env", "actuator/dump", "/env"]):
        if any(x in body for x in ["password", "secret", "key"]):
            return "critical", "Debug Endpoint — Credentials Leaked"
        return "high", "Debug Endpoint"

    if any(x in path for x in ["phpinfo", "server-status", "actuator"]):
        return "medium", "Debug/Admin Endpoint"

    if ".sql" in path or "backup" in path or ".tar" in path:
        return "high", "Backup File"

    if ".log" in path:
        return "medium", "Log File Exposure"

    if "ds_store" in path or ".idea" in path or ".vscode" in path:
        return "medium", "IDE/OS Metadata"

    if "composer.json" in path or "package.json" in path:
        return "low", "Package Manifest"

    return "medium", "Sensitive File"


def main():
    parser = argparse.ArgumentParser(description="Sensitive file discovery tool")
    parser.add_argument("--target", required=True, help="Target base URL (e.g., https://target.com)")
    parser.add_argument("--output", default="/workspace/id-sensitive-files.json",
                        help="Output JSON file path")
    parser.add_argument("--category", choices=list(PROBE_PATHS.keys()) + ["all"],
                        default="all", help="Probe category (default: all)")
    parser.add_argument("--concurrency", type=int, default=15,
                        help="Concurrent requests (default: 15)")
    parser.add_argument("--timeout", type=int, default=8,
                        help="Per-request timeout in seconds (default: 8)")
    args = parser.parse_args()

    paths = ALL_PATHS if args.category == "all" else PROBE_PATHS[args.category]
    findings = []
    total = len(paths)

    print(f"[*] Target: {args.target}")
    print(f"[*] Probing {total} paths (concurrency={args.concurrency}, timeout={args.timeout}s)")
    print(f"[*] Output: {args.output}\n")

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {executor.submit(probe_path, args.target, p, args.timeout): p for p in paths}
        completed = 0
        for future in as_completed(futures):
            completed += 1
            result = future.result()
            if result and result["status"] in (200, 206):
                severity, category = categorize_finding(result)
                result["severity"] = severity
                result["category"] = category
                findings.append(result)
                print(f"  [{severity.upper()}] HTTP {result['status']} {result['path']} ({category})")

    # Write output
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(findings, f, indent=2)

    print(f"\n[+] Summary: {len(findings)} findings from {total} probes")
    by_sev = {}
    for f in findings:
        s = f["severity"]
        by_sev[s] = by_sev.get(s, 0) + 1
    for sev in ["critical", "high", "medium", "low"]:
        if sev in by_sev:
            print(f"    {sev.upper()}: {by_sev[sev]}")

    print(f"\n[*] Full results: {args.output}")


if __name__ == "__main__":
    main()
