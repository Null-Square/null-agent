---
slug: spa-recon
name: SPA Reconnaissance
description: Browser-driven reconnaissance for JavaScript applications where the meaningful routes, forms, and authenticated flows only appear after client-side rendering. Use when the HTTP surface is thin but the frontend is clearly interactive or route-heavy.
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
use_when: Use when client-side routes, forms, API calls, auth flows, or dynamic content are only visible through browser execution or hydrated JavaScript state.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Browser-observed route, form, storage, and API interaction inventory
  - Screenshots or artifacts for important states and hidden surfaces
  - Follow-up leads for auth, IDOR, XSS, upload, or business-logic testing
evidence_floor: SPA recon must record browser-observed routes and API calls with evidence refs. Do not treat client-side hints as server-confirmed endpoints until probed or ingested.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - spa-recon
  - spa
  - single page app
  - client route
  - react
  - vue
  - angular
  - front-end route
  - recon
  - reconnaissance
tech_triggers:
  - react
  - angular
  - vue
  - next.js
  - nuxt
ntype_triggers:
  - tech.fingerprint
  - http.endpoint
technique_ids:
  - B1:spa-recon
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
# SPA Reconnaissance

## Attack Surface
Use a browser session to enumerate rendered routes, forms, navigation states, and client-side behaviors that are invisible to static HTTP crawling.

## Discovery Methodology
1. Launch the application in `browser_action`.
2. Walk interactive elements and rendered routes.
3. Record newly discovered forms, paths, and high-value actions for follow-on testing.

## Validation
Only promote observations that are reproducible from the rendered UI or browser runtime.
