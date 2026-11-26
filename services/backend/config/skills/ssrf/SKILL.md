---
slug: ssrf
name: SSRF Testing
description: "SSRF and blind SSRF testing — cloud metadata endpoints (AWS/GCP/Azure), OOB interaction via interactsh, protocol confusion, redirect chain bypass. Use when: cloud stack detected, URL-fetching features present, webhook/import/export/callback or PDF renderer endpoints in scope."
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
use_when: In-scope features fetch attacker-supplied or user-configured URLs, including webhooks, callbacks, URL previews, importers, exporters, PDF/image renderers, and integrations in cloud or Kubernetes-backed environments.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Endpoint, parameter, or configuration field that causes a server-side fetch
  - Baseline request and response for the URL-fetching feature
  - Controlled OOB listener or safe restricted target for correlation
expected_outputs:
  - Direct restricted-target response or OOB interaction tied to the tested request
  - Affected feature, parameter, and fetch behavior
  - Redirect, scheme, host encoding, or header bypass details when used
evidence_floor: Confirm only with a direct response from a restricted target or an OOB interaction uniquely correlated to the tested endpoint and payload.
follow_up_triggers:
  - URL, webhook, callback, import, export, preview, or renderer parameters appear
  - Cloud, Kubernetes, or metadata service fingerprints are present
  - Redirects, alternate schemes, or host parser differences affect fetch behavior
  - Fetch responses leak internal status, headers, or content
strong_terms:
  - ssrf
  - server-side request forgery
  - metadata service
  - webhook
  - url fetch
  - internal host
tech_triggers:
  - aws
  - gcp
  - azure
  - kubernetes
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:ssrf
  - PS-SSRF
  - OWASP-API7
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
# SSRF Testing

## Attack Surface
Identify features that fetch remote resources: URL preview, webhooks, PDF renderers, importers, callback configs.

## Discovery Methodology
1. Attempt loopback, link-local, and cloud metadata targets safely.
2. Use OOB callbacks for blind behaviors.
3. Test alternate schemes and redirect handling.

## Mutation Algebra
- Hostname forms: IPv4, IPv6, decimal, octal, mixed
- Redirect chains and protocol smuggling
- DNS rebinding-style host changes across retries
- Header-based routing hints (`Host`, `X-Forwarded-*`)

## Validation
Confirm with direct response from restricted target or OOB interaction tied to tested endpoint.
