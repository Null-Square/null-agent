---
slug: information-disclosure
name: Information Disclosure Testing
description: "Identify unintended data exposure through debug endpoints, stack traces, open repositories, backup files, and sensitive configuration leaks. Use when: reconnaissance starts, unusual errors appear, or technology stack hints exist."
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
use_when: Use when debug data, stack traces, exposed files, public buckets, source leaks, verbose errors, secrets, internal hostnames, or sensitive documents are observed or likely from recon output.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Sensitive exposure inventory with URL/path, data class, and access preconditions
  - Screenshots, response snippets, or artifact refs proving exposed content
  - Disposition separating reportable exposure from benign metadata or scoped noise
evidence_floor: Reportable disclosure needs durable evidence of sensitive content accessible within scope and a clear impact narrative. Redact secrets while preserving enough proof for review.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - information-disclosure
  - information disclosure
  - sensitive data
  - debug endpoint
  - stack trace
  - secret leak
  - metadata exposure
  - information
  - disclosure
tech_triggers:
  - nginx
  - apache
  - spring
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:information-disclosure
  - PS-DISCLOSURE
  - WSTG-ERRH
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
  - scripts/sensitive_probe.py
fixture_manifest: fixtures/manifest.yaml
---
# Information Disclosure Testing

## Attack Surface
Look for any endpoint or artifact that reveals sensitive internals without authorization.

## Discovery Methodology
1. Trigger and inspect verbose errors.
2. Probe high-risk debug paths and metadata endpoints.
3. Enumerate sensitive files and backup artifacts.
4. Validate leaked secrets and impact safely.

## Validation
Confirm only when leaked data is reproducible and materially expands attack capability.
