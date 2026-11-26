---
slug: js-surface-analysis
name: JavaScript Surface Analysis
description: "Extract hidden API endpoints, credentials, and auth flow clues from JavaScript bundles. Use when: crawl output contains .js files, SPA frontends are present, or auth testing is blocked."
phase: enumeration
compatible_phases:
  - enumeration
  - recon
category: enumeration
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - report_note
  - query_inventory
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when SPA bundles, source maps, static assets, route manifests, API clients, or client-side config may reveal hidden endpoints, secrets, auth flows, or technology-specific routes.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Extracted endpoints, routes, secrets, and auth clues with bundle/source refs
  - Confidence labels for static, dynamic, and inferred routes
  - Follow-up inventory or validation leads for high-signal discoveries
evidence_floor: JS discoveries need file path, line/context, extraction method, and confidence. Potential secrets must be redacted and verified safely before being treated as reportable.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - js-surface-analysis
  - javascript
  - source map
  - bundle
  - api key
  - hidden endpoint
  - client route
  - webpack
  - js
  - surface
  - analysis
tech_triggers:
  - react
  - angular
  - vue
  - next.js
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:js-surface-analysis
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - broad-surface-scan
handoff_skills:
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
fixture_manifest: fixtures/manifest.yaml
---
# JavaScript Surface Analysis

## Attack Surface
Analyze web bundles and client assets to discover endpoints, secrets, and dependency risk.

## Discovery Methodology
1. Collect JavaScript URLs from crawl results and page source.
2. Extract route patterns and endpoint candidates from code.
3. Scan for leaked tokens, keys, and internal hosts.
4. Audit third-party library versions for known vulnerabilities.

## Validation
Confirm only when endpoint or secret evidence is reproducible and tied to a source file.
