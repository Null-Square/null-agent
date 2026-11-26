---
slug: broad-surface-scan
name: Broad Surface Scan
description: Breadth-first automated discovery for an in-scope asset before any targeted class-specific testing. Runs port scanning, HTTP surface confirmation, WAF detection, web crawl, content/endpoint enumeration, API spec discovery, JS secret scanning, and inventory enrichment. Produces a complete baseline inventory of services, endpoints, technologies, and initial findings. Use when query_inventory marks assets as needsBroadScan=true, or on first contact with any target.
phase: recon
compatible_phases:
  - recon
  - enumeration
category: recon
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - report_note
  - query_inventory
  - file_read
tool_alternatives: []
risk_tier: standard
freshScopePriority: high
use_when: query_inventory returns needsBroadScan=true for one or more assets. Usually the first task on a fresh scope. Also appropriate when the attack surface has materially changed since the last scan, especially after new services or major tech fingerprints are discovered.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope domains, IP addresses, or application entry points
  - Scope exclusions, rate limits, and any safe-scan constraints
  - Existing inventory state or query_inventory result when available
expected_outputs:
  - Confirmed reachable HTTP/HTTPS services with status codes and tech
  - Crawled URL set including API prefixes, admin panels, and parameterised routes
  - Enumerated paths and endpoints from content discovery and spec files
  - Technology fingerprints (frameworks, CDNs, WAFs, server versions)
  - JS file secret leaks (API keys, tokens, internal endpoints)
  - Evidence of exposed specs, management panels, directory listing, or leaked files found during crawl and content discovery
  - scan.coverage note closing the broad-scan requirement for the asset
evidence_floor: Produce durable inventory evidence for reachable services, crawled routes, discovered endpoints, technology fingerprints, and scan coverage. Exposures still require finding-specific evidence before promotion.
follow_up_triggers:
  - New API, admin, auth, upload, import, export, or callback surfaces are found
  - Technology fingerprints suggest class-specific testing such as SQLi, XSS, SSRF, IDOR, or file upload
  - Content discovery identifies exposed panels, login surfaces, or sensitive files that need targeted follow-up
  - Broad coverage is blocked by scope, rate limits, authentication, WAF behavior, or unreachable services
strong_terms:
  - broad-surface-scan
  - broad scan
  - attack surface
  - surface discovery
  - subdomain
  - httpx
  - katana
  - ffuf
  - technology fingerprint
  - broad
  - surface
  - scan
tech_triggers:
  - http
  - https
  - swagger
  - openapi
  - graphql
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
  - asset.discovered
technique_ids:
  - B1:broad-surface-scan
  - WSTG-INFO
  - STRIX-RECON
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills: []
handoff_skills:
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
  - wordlists/api-endpoints.txt
  - wordlists/raft-medium-directories.txt
  - wordlists/swagger-paths.txt
fixture_manifest: fixtures/manifest.yaml
---
# Broad Surface Scan

## Purpose
Establish complete baseline coverage for an in-scope asset before any
targeted exploitation begins. This skill answers four questions:

1. **What services are running?** - ports, HTTP vs HTTPS, non-standard ports
2. **What does the surface look like?** - routes, API paths, admin panels, docs
3. **What tech stack is in play?** - frameworks, CDNs, WAFs, server versions
4. **Are there obvious exposures?** - misconfigs, leaked keys, default creds,
   exposed panels

## Scope Boundaries
Safe, breadth-first discovery only. This skill does **not** attempt
exploitation. No SQLi, no auth bypass, no destructive fuzzing. All output is triage material for the planner to
route into targeted class skills in the next run.

## Execution Order
1. Port scan + service detection
2. WAF detection on confirmed HTTP surfaces
3. HTTP surface confirmation and tech fingerprinting (httpx)
4. Subdomain expansion (if domain target)
5. Web crawl (katana)
6. Conditional content and endpoint enumeration (one targeted ffuf pass only when crawl/spec coverage is still missing)
7. JS secret scanning (trufflehog)
8. Reporting and scan.coverage note

Run deterministic steps as phase-sized batches. Prefer one shell execution per
phase that writes all planned artifacts, then one wait, then the related ingest
calls together. Do not insert extra model checkpoints between fixed recon steps
unless a previous phase changed the target list, failed, or produced a signal
that changes the plan.

Vulnerability scanning (nuclei) is **out of scope for this skill**. Run it
separately, scoped per managed asset, after broad-surface coverage has
populated inventory. Do not run nuclei against the full subdomain set in this
phase - it dominates wall-clock with low yield and is the wrong shape for
breadth-first discovery.

## Completion Contract
This task is done only when all of the following are true:
- reachable HTTP/HTTPS services are confirmed and reported
- crawl has run on all confirmed web roots; content discovery has run only when a concrete endpoint/spec coverage gap remained
- supported scanner artifacts (`subfinder`, `naabu`, `httpx`, `katana` JSONL, `ffuf` JSON) are ingested with `ingest_scan_artifact`
- supported scanner artifacts are written under `/workspace/.artifacts/...` so remote-runner sessions can hydrate and publish them reliably
- remaining discoveries (endpoints, techs, findings, unsupported formats) are reported
- `scan.coverage` note is written for the target asset

## Ingest Contract
After every scanner shell job finishes, you MUST call `ingest_scan_artifact` for
each supported scanner output (`subfinder`, `naabu`, `httpx`, `katana`, `ffuf`).
`katana` must emit JSONL and `ffuf` must emit JSON. If ingest returns an error,
fix the format/path and retry rather than falling back to manual
`report_asset`, `report_service`, or `report_note` for rows that scanner output
already covers.
Do not write `scan.coverage` until at least one `ingest_scan_artifact` call has
succeeded for the scanner family you ran. The error message will tell you the
canonical artifact location (`.artifacts/shell-jobs/<jobId>/stdout.log` for
shell-job stdout; the `-o` path you passed for explicit output files).
