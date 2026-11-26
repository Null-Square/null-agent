---
slug: xss
name: Cross-Site Scripting Testing
description: "Reflected, stored, and DOM-based XSS — context-aware payload selection (HTML/attr/JS/URL), event handler injection, encoding bypass, CSP evasion techniques. Use when: user-controlled values rendered in HTML or JS, any web frontend, http.parameters notes present, or template engines detected."
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
use_when: User-controlled values are reflected, stored, or routed into HTML, attributes, script blocks, templates, URL fragments, or DOM sinks in an in-scope web frontend.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Baseline request and response or browser observation showing the input flow
  - User-controllable parameter, stored field, URL fragment, or DOM source
  - Rendering context such as HTML text, attribute, script, URL, or client-side sink
expected_outputs:
  - Context classification for the affected input
  - Executable payload proof or deterministic exploitable DOM sink path
  - Affected page, parameter or field, payload context, and browser-observed impact
evidence_floor: Confirm only when execution is observed or a deterministic DOM sink path proves controlled input can reach an executable context. Source reflection alone is not enough.
follow_up_triggers:
  - Reflected parameters appear in HTML, JavaScript, attributes, or URLs
  - Stored profile, comment, CMS, or admin fields render to other users
  - Client-side routing, hash fragments, or query values feed DOM sinks
  - Weak or missing CSP increases exploitability
strong_terms:
  - xss
  - cross-site scripting
  - reflected xss
  - stored xss
  - html injection
  - script sink
  - cross
  - site
  - scripting
tech_triggers:
  - react
  - angular
  - vue
  - jquery
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:xss
  - PS-XSS
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
  - scripts/.gitkeep
fixture_manifest: fixtures/manifest.yaml
---
# XSS Testing

## Attack Surface
Focus on user-controllable values rendered into HTML, JS, attributes, templates, or URL fragments.

## Discovery Methodology
1. Probe context first: plain text, attribute, script, URL.
2. Use context-aligned payloads, not generic payload spraying.
3. Validate execution by behavioral signal, not source reflection alone.

## Mutation Algebra
- Quote switching (`'` vs `"`) and tag balancing
- Event handler pivots (`onerror`, `onload`, `onfocus`)
- URL protocol tricks (`javascript:`, `data:`)
- Encoding pivots (HTML entity, URL, mixed encoding)

## Validation
Only confirm when execution is observed or a deterministic DOM sink path is proven exploitable.
