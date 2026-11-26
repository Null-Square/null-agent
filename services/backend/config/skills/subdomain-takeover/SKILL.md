---
slug: subdomain-takeover
name: Subdomain Takeover Testing
description: "Subdomain takeover via dangling CNAME — provider fingerprint matching, CNAME chain enumeration, claimability validation without destructive action. Use when: AWS/Azure/GCP/Cloudfront stack, dns.cname notes present, subdomains returning provider 404/unclaimed pages detected."
phase: validation
compatible_phases:
  - enumeration
  - validation
category: vulnerability
required_tools:
  - shell_run
  - wait_for_shell_job
  - file_read
  - http_payload
  - report_note
tool_alternatives: []
risk_tier: standard
use_when: Use during enumeration or validation when DNS records, CNAME chains, provider error pages, parked hosts, orphaned cloud resources, or dangling service fingerprints are observed.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - DNS chain and provider fingerprint for each candidate subdomain
  - Provider-specific takeover feasibility decision with evidence refs
  - Blocked or safe disposition when provider verification, account ownership, or scope prevents proof
evidence_floor: Subdomain takeover confirmation requires DNS evidence plus provider-specific claimability proof or a safe verification artifact. A dangling-looking CNAME alone is a candidate, not a finding.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - subdomain-takeover
  - subdomain takeover
  - dangling cname
  - orphaned cloud
  - unclaimed service
  - provider 404
  - cname
  - subdomain
  - takeover
tech_triggers:
  - aws
  - azure
  - gcp
  - cloudfront
ntype_triggers:
  - dns.cname
  - dns.subdomain
technique_ids:
  - B1:subdomain-takeover
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
# Subdomain Takeover Testing

## Attack Surface
Identify subdomains pointing to deprovisioned third-party services.

## Discovery Methodology
1. Enumerate CNAME chains and provider fingerprints.
2. Detect provider-specific orphan states.
3. Validate claimability safely without destructive takeover.

## Mutation Algebra
- Provider response signature matching
- DNS chain depth and alternate aliases
- Region/service endpoint permutations
- Timing checks for transient DNS conditions

## Validation
Confirm when provider explicitly indicates unclaimed resource for a live delegated subdomain.
