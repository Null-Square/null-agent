# Null-AI Pentest Sandbox

This directory owns the SecurityOps sandbox image used for agent runs.

## Architecture

**Base:** `projectdiscovery/nuclei:latest`
Ships: `nuclei` plus the ProjectDiscovery baseline (`subfinder`, `httpx`, `naabu`, `dnsx`, `katana`, `interactsh-client`, `cvemap`).

**Stage 1 (go-builder):** `golang:1.25-alpine`
Compiles extra Go tools. Only the built binaries are copied into the final image.

**Built by:** `docker compose up` (or `docker compose build sandbox-image`), as `null-ai-sandbox:local`. Nothing is published to a registry.

## Full Toolchain

| Tool | Source | Purpose |
|------|--------|---------|
| nuclei + templates | PD base | Template-based vulnerability scanning |
| subfinder | PD base | Passive subdomain enumeration |
| httpx | PD base | HTTP probing and tech detection |
| naabu | PD base | Fast port scanning |
| dnsx | PD base | DNS resolution and brute force |
| katana | PD base | Active crawling for modern web apps |
| interactsh-client | PD base | OOB listener for blind issues |
| cvemap | PD base | CVE-to-service mapping |
| nmap + NSE libs/scripts | apk | Deep service scanning with NSE support |
| ncat / nping | apk | Socket helpers and packet probing |
| nikto | apk | Web server misconfiguration checks |
| assetfinder | go-builder | Passive subdomain enumeration |
| amass | go-builder | OSINT subdomain enumeration |
| gospider | go-builder | Web crawling and JS link extraction |
| ffuf | go-builder | Directory, endpoint, and parameter fuzzing |
| gobuster | go-builder | Directory, DNS, and vhost brute force |
| puredns | go-builder | Mass DNS validation |
| urlfinder | go-builder | Passive URL discovery from public indexes |
| gau | go-builder | Historical URL collection |
| unfurl | go-builder | URL component extraction for endpoint/parameter pipelines |
| qsreplace | go-builder | Query-string payload replacement for fuzz preparation |
| anew | go-builder | Append-only deduplication for URL and artifact pipelines |
| tlsx | go-builder | TLS probing and certificate metadata collection |
| grpcurl | go-builder | gRPC reflection and manual method calls |
| kiterunner (`kr`) | release binary | API route discovery |
| dalfox | go-builder | XSS-oriented testing |
| gitleaks | go-builder | Secret scanning in repos and fetched assets |
| trufflehog | go-builder | Secret scanning in JS and responses |
| trivy | release binary | Container, filesystem, dependency, and SBOM scanning |
| semgrep | pip | Multi-language SAST and rule-driven code scanning |
| bandit | pip | Python-specific SAST |
| mitmproxy | pip | Transparent HTTP capture for agent/browser/scanner traffic |
| arjun | pip | HTTP parameter discovery |
| schemathesis | pip | OpenAPI/GraphQL schema-backed API testing |
| sqlmap | pip | SQL injection confirmation |
| wafw00f | pip | WAF detection |
| LinkFinder | git | JS endpoint extraction |
| dirsearch | git | Recursive path and file discovery |
| SecretFinder | git | JS secret extraction |
| jwt-tool | git | JWT analysis and attack support |
| retire | npm | Vulnerable JS dependency discovery |
| ast-grep | npm | AST-aware code search and rewrites |
| ripgrep / fd / yq | apk | Fast local artifact search and structured data processing |
| dig / whois / openssl / iproute2 | apk | DNS, registration, TLS, and network diagnostics |
| socat | apk | Socket diagnostics and low-level TCP helpers |
| testssl.sh | release archive | TLS configuration review |
| SecLists and PayloadsAllTheThings wordlists | curl | Paths, params, API routes, DNS names, and common XSS/SQLi/LFI/SSTI/SSRF payloads |

Version pins for added non-APK tools live in `tool-versions.lock.json`. Runtime availability checks live in `tools-manifest.json`.

## Test the Image

The build and the smoke test are separate steps:

| Step | What it does |
|------|-------------|
| `docker build` | Builds the image, even if a tool install silently degraded |
| `smoke.sh` | Runs inside the built image and verifies the shipped tools and assets actually work |

**Run both.** A successful build alone does not prove the image is usable.

### Local verify

```bash
# From the repo root
bash services/sandbox/test/verify-local.sh
```

The helper builds the same runtime tag the backend uses locally:

- `null-ai-sandbox:local`
- `null-ai-sandbox:dev`

To force a clean local replacement of the existing tags before rebuilding:

```bash
CLEAN=1 bash services/sandbox/test/verify-local.sh
```

To skip the rebuild and re-run only the smoke test:

```bash
SKIP_BUILD=1 bash services/sandbox/test/verify-local.sh
```

The smoke test now validates:

- Nmap binary plus NSE engine loading
- every shipped recon, crawling, fuzzing, vuln, secret, and auth tool
- manifest-driven callable/version checks via `smoke-matrix.sh`
- optional CycloneDX SBOM generation via `generate-sbom.sh`
- bundled wordlists and kite route lists
- URL helper pipeline behavior (`unfurl`, `qsreplace`, `anew`)
- Chromium and the private-runner bridge

Expected output:

```text
Building null-ai-sandbox:local ...
...

Running smoke test against null-ai-sandbox:local ...

=== Null-AI Sandbox Smoke Test ===

[1/9] Surface discovery
[2/9] Port and service scanning
  [PASS] nmap: NSE engine loads
...
[9/9] Private runner bridge

All checks passed. Image is ready.
```

If a tool fails, the test prints the failed check and invocation so the Dockerfile can be corrected before deploy.

## CI

CI runs the same smoke test automatically on every push to `main` that touches:

- `services/sandbox/**`
- `services/shell-server/**`
- `.github/workflows/agent-images.yml`

The image is only pushed to GHCR if the smoke test exits `0`.

## Add a Tool

1. Edit `services/sandbox/Dockerfile`.
2. Add a corresponding smoke check in `services/sandbox/test/smoke.sh`.
3. Add the tool to `services/sandbox/tools-manifest.json` and assign it to one backend smoke phase in `services/backend/tests/smoke/sandbox/groups/`.
4. Run `bash services/sandbox/test/verify-local.sh` from the repo root.
5. Run `SANDBOX_TOOL_SMOKE_IMAGE=<tag> npm run test:smoke -w services/backend` against the locally built tag.
6. Commit and push once the image and backend smoke test both pass.
