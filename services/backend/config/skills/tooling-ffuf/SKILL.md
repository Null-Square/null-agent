---
slug: tooling-ffuf
name: FFUF Operation
description: Run content discovery with JSON output and disciplined filters.
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
use_when: A live HTTP service is confirmed (httpx) and crawl-only enumeration (katana) has not surfaced the expected admin/API/spec/asset paths. Use for directory/path discovery, parameter discovery (mode=fuzz with FUZZ in body or query), and virtual-host discovery. Always tune filters on the baseline response before escalating findings.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Base URL
  - Wordlist (path, parameter, or vhost)
  - Filter set tuned to the baseline response
expected_outputs:
  - JSON artifact ingested with ingest_scan_artifact(parser="ffuf")
  - Newly discovered paths, parameters, or vhosts with status and length
evidence_floor: Keep the ffuf JSON artifact, wordlist/filter settings, status/size baselines, and ingested coverage notes. Promote only responses with manual follow-up evidence or clear exposure impact.
follow_up_triggers:
  - Hand admin/login paths to broken-auth or jwt-attacks class skills
  - Hand parameter discoveries to sqlmap, dalfox, or relevant injection class skills
  - Hand spec paths (swagger.json, openapi.yaml) to api-enumeration
  - Record scan.coverage(family="ffuf") with wordlist and target prefix
strong_terms:
  - tooling-ffuf
  - ffuf
  - content discovery
  - fuzzing
  - wordlist
  - directory brute force
tech_triggers:
  - http
  - https
  - php
  - aspnet
  - jsp
  - nodejs
  - swagger
  - openapi
ntype_triggers:
  - http.endpoint
  - http.parameters
  - asset.discovered
  - tech.fingerprint
technique_ids:
  - B1:tooling-ffuf
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
# FFUF Operation

Use filters to remove baseline noise before escalating findings.
