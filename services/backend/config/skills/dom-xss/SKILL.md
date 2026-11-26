---
slug: dom-xss
name: DOM XSS Testing
description: DOM-based XSS testing for JavaScript-rendered applications. Use when the target is a SPA, reflected payloads do not appear in raw HTML, or client-side sinks consume attacker-controlled data from location, postMessage, storage, or dynamic template rendering.
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - report_note
  - report_finding
  - submit_validation_lead_outcome
  - submit_validation_outcome
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when JavaScript-heavy pages, reflected URL fragments, query parameters, postMessage handlers, client-side routing, or sink/source clues indicate possible browser-side script execution.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Source-to-sink trace or tested payload path with page and parameter context
  - Browser-backed execution proof or explicit non-reproduction notes
  - Relevant JS artifact refs and route context for follow-up validation
evidence_floor: DOM XSS confirmation requires browser-executed evidence at a real sink or a precise source-to-sink trace with a tested payload. A suspicious source or sink by itself is only a lead.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - dom-xss
  - dom xss
  - client-side xss
  - location hash
  - postmessage
  - innerhtml
  - javascript sink
  - dom
  - xss
tech_triggers:
  - react
  - angular
  - vue
  - next.js
  - nuxt
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:dom-xss
  - PS-DOM
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
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
# DOM XSS Testing

## Attack Surface
Focus on client-side sources and sinks that only become visible after the page executes JavaScript.

## Discovery Methodology
1. Launch the target in `browser_action` and let the page render fully before testing sinks.
2. Trace attacker-controlled inputs from URL/query/hash, `postMessage`, storage, and API responses into DOM sinks.
3. Confirm execution or a deterministic exploit path before reporting.

## Validation
Only confirm when JavaScript execution or a sink-to-source exploit path is reproducible in the rendered page.
