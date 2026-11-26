# Backend Smoke Tests

Backend smoke tests are deterministic runtime checks. They do not call an LLM,
do not spend model API credits, and are part of the root `npm run verify`
gate. They are still skipped by the backend package's default `test` command
unless the explicit smoke runner enables them.

## Sandbox Tool Capability Smoke

Run:

```bash
npm run test:smoke -w services/backend
```

or from the repo root:

```bash
npm run test:backend:smoke
```

This suite is organized the same way as behavior smoke tests: the runner only
selects smoke files, while grouped modules define the actual checks.

```text
tests/smoke/
  agent-tools.smoke.test.ts
  sandbox-tools.smoke.test.ts
  worker-sandbox.smoke.test.ts
  sandbox/
    config.ts
    constants.ts
    fixture.ts
    manifest.ts
    types.ts
    groups/
      sandboxBehavior.ts
      coreRuntime.ts
      recon.ts
      enumeration.ts
      validation.ts
      evidence.ts
```

`sandbox-tools.smoke.test.ts` provisions the configured sandbox image through
the real backend `SandboxManager`, starts a local HTTP fixture inside the
sandbox, and checks the toolchain by group:

- `sandbox-behavior`: workspace persistence, agent shell scripting patterns,
  JSON artifact interop across Python/JQ/Node, and headless Chromium against the
  local fixture.
- `core-runtime`: shell runtime, workspace mount, canonical scanner artifact
  layout under `.artifacts/scans/`, wordlists, Chromium, mitmproxy, and
  private-runner bridge files. It also verifies local artifact helpers such as
  ripgrep, fd, and yq against the sandbox workspace.
- `recon`: passive DNS, DNS resolution, port/service probing, HTTP probing, and
  WAF/TLS fingerprinting tools.
- `enumeration`: crawlers, content/API discovery, JS endpoint extraction, and
  route-discovery tools, plus URL normalization and deduplication helpers.
- `validation`: vulnerability scanners, injection/auth helpers, OOB client, and
  scoped local nuclei and schema-backed API checks.
- `evidence`: code/dependency/secret scanning tools plus a local semgrep rule
  execution.

The smoke test also verifies every entry in
`services/sandbox/tools-manifest.json` is assigned to one of those phase groups.

`agent-tools.smoke.test.ts` is deterministic and does not provision Docker. It
checks that builtin tool names are unique, manifests mirror tool metadata, tool
schemas are advertiseable, and the sandbox-facing tool surface used by agents is
still present (`file_read`, `shell_run`, `wait_for_shell_job`, `http_payload`,
`browser_action`, worker handoff tools, phase handoff, and finding tools).

`worker-sandbox.smoke.test.ts` provisions a scoped worker session through the
real `SandboxManager`, runs a managed shell job, verifies runtime-owned writable
submounts such as `.http_sessions` and `.artifacts/shell-jobs`, and proves the
worker still cannot write outside its declared evidence scope.

## Requirements

- Docker must be running.
- The sandbox image must already exist locally. By default this is
  `null-ai-sandbox:local`, the image `docker compose up` builds.

To build and verify the image-level smoke first:

```bash
bash services/sandbox/test/verify-local.sh
```

To test another image tag:

```bash
SANDBOX_TOOL_SMOKE_IMAGE=null-ai-sandbox:dev npm run test:smoke -w services/backend
```

LLM/API session tests should stay in a separate explicit suite. They should not
be added to this smoke command.

## OOB Dev Parity Smoke

The OOB callback loop has an opt-in external smoke because it reaches the
configured public Interactsh ingress. It is not part of default smoke or CI.

Prerequisites:

- `services/backend/.env.local` has `INTERACTSH_SERVER_URL`,
  `INTERACTSH_SERVER_AUTH_TOKEN`, `INTERACTSH_CALLBACK_DOMAIN`, and
  `INTERACTSH_CALLBACK_SCHEME`.
- The deployed OOB ingress is reachable from the dev machine.

Run:

```bash
npm run test:smoke:oob-dev -w services/backend
```

The smoke registers a token, calls the returned public callback URL, polls the
server, and asserts the interaction was persisted through `OobService`.

If it fails before registration with a DNS delegation error, fix Route53
`oast.nullsquare.net` NS records and public TCP/UDP 53 reachability first. Local
dev can load the env vars and still be unable to prove OOB value when the public
callback domain does not resolve.
