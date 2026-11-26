---
slug: tooling-katana
name: Katana Operation
description: Crawl scoped web applications with JSONL output for endpoint inventory.
phase: enumeration
compatible_phases:
  - enumeration
  - recon
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
use_when: A live web service has been confirmed by httpx, AND endpoint inventory does not yet cover the navigable surface. Use to populate the endpoint catalogue for downstream class skills (idor, xss, ssrf, etc.) and to feed a fuzzing baseline for ffuf. Avoid on pure-API surfaces with Swagger/OpenAPI specs where api-enumeration is the better fit.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - In-scope URL (live web root)
  - Crawl depth and scope filter
expected_outputs:
  - JSONL artifact ingested with ingest_scan_artifact(parser="katana")
  - Endpoint catalogue with method, body shape, and parameter hints
evidence_floor: Keep the Katana JSONL artifact, crawl scope, depth settings, and ingested endpoint refs. Mark dynamic or unauthenticated crawl gaps explicitly.
follow_up_triggers:
  - Hand parameterised endpoints to ffuf, dalfox, sqlmap, or class skills
  - Pair JS-heavy SPAs with js-surface-analysis or spa-recon
  - Record scan.coverage(family="katana") for the crawled web root
strong_terms:
  - tooling-katana
  - katana
  - crawler
  - crawl
  - endpoint discovery
  - jsonl
tech_triggers:
  - http
  - https
  - spa
  - react
  - vue
  - angular
  - nextjs
  - jsp
  - php
  - aspnet
ntype_triggers:
  - http.endpoint
  - asset.discovered
  - tech.fingerprint
technique_ids:
  - B1:tooling-katana
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
# Katana Operation

Keep crawling scope-bounded and output JSONL.
