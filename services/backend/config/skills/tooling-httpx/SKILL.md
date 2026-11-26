---
slug: tooling-httpx
name: HTTPX Operation
description: Fingerprint HTTP services with JSON output for endpoint and tech inventory.
phase: recon
compatible_phases:
  - recon
  - enumeration
category: tooling
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - file_read
  - report_note
tool_alternatives: []
risk_tier: low
freshScopePriority: high
use_when: Host or port discovery has produced candidate HTTP services that need status-code, title, redirect-chain, and tech-stack confirmation. Use as the canonical step between port discovery (naabu/nmap) and crawl/fuzz steps (katana/ffuf/nuclei). Always run before scoping nuclei templates.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - URL or host list (resolved)
  - Optional path probe set
expected_outputs:
  - JSONL artifact ingested with ingest_scan_artifact(parser="httpx")
  - Tech fingerprints, status codes, redirect chains, and TLS metadata per host
evidence_floor: Keep the httpx JSONL artifact and ingest status-code, title, redirect, TLS, and technology fingerprints. Use this as inventory evidence before crawl or validation work.
follow_up_triggers:
  - Hand confirmed live web roots to katana for crawling
  - Hand fingerprinted stacks to nuclei with tag-scoped templates
  - Hand login/admin surfaces to ffuf for content discovery
  - Record tech.fingerprint notes for downstream class skills to consume
strong_terms:
  - tooling-httpx
  - httpx
  - http probe
  - status code
  - title
  - tech detect
tech_triggers:
  - http
  - https
  - tls
  - tcp
ntype_triggers:
  - asset.host
  - asset.domain
  - service.port
  - http.endpoint
technique_ids:
  - B1:tooling-httpx
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# HTTPX Operation

Use httpx as the canonical live-web fingerprinting step.
