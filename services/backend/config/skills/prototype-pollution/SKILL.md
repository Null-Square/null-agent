---
slug: prototype-pollution
name: Prototype Pollution Testing
description: "Prototype pollution via __proto__ and constructor.prototype injection in JSON bodies and query strings. Server-side: auth bypass or RCE via template engine gadgets (ejs outputFunctionName, handlebars helpers). Client-side: DOM XSS via polluted properties consumed by innerHTML/eval/document.write sinks. Use when: Node.js/Express detected, JSON merge-patch endpoints exist, or deep object assignment patterns visible in JS bundles."
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
use_when: Use when JavaScript/Node APIs accept nested JSON, merge objects, querystring parsers, settings updates, or config imports that may handle __proto__, constructor, or prototype keys.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Candidate merge/parsing endpoints and payload variants tested
  - Observed pollution indicator, sink impact, or explicit non-reproduction evidence
  - Safety notes avoiding destructive global state changes where possible
evidence_floor: Prototype pollution needs a measurable polluted property or downstream behavior change caused by attacker input. Acceptance of __proto__ text without a sink is not enough.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - prototype-pollution
  - prototype pollution
  - __proto__
  - constructor prototype
  - object merge
  - lodash
  - prototype
  - pollution
tech_triggers:
  - node.js
  - express
  - javascript
  - lodash
  - qs
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:prototype-pollution
  - PS-PROTOTYPE
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
# Prototype Pollution Testing

## Objective

Determine whether an untrusted object key modifies a prototype and whether a
documented benign consumer uses the inherited property. Keep source proof and
consumer proof separate.

## Required Controls

- Generate a unique property name and value for every run.
- Verify the property is absent in a clean browser realm or isolated server
  state before testing.
- Verify a newly created unrelated object inherits the value and does not own
  the property.
- Reset the realm or disposable process and verify the value disappears.

## Safety Boundary

Use only string markers and an owner-provided benign consumer such as a test
response label or DOM data attribute. Do not modify authentication flags,
runtime options, process behavior, or operational configuration. Do not restart
shared services.

Read `methodology.md` before testing and follow its six-mutation cap, proof
standard, cleanup, and handoff rules.
