---
slug: kubernetes-security
name: Kubernetes Configuration and Surface Testing
description: Kubernetes Configuration and Surface Testing methodology. Review manifests, RBAC, service accounts, secrets, workloads, network policy, exposed APIs, dashboards, ingress, container boundaries, and admission evidence with no credentialed cluster mutation.
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - file_read
tool_alternatives: []
risk_tier: sensitive
use_when: Use when the authorized target exposes kubernetes-security behavior, relevant protocol state, or a source/configuration path that can be validated safely.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Applicability decision with coverage and blockers
  - Durable baseline, test, and negative-control evidence
  - Validated proof, bounded lead, rejection, or explicit blocker
evidence_floor: Require reproducible objective application data, action, state, control, or safe execution impact with durable evidence and a negative control; fingerprints, errors, headers, versions, scanners, and code appearance remain leads.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - kubernetes-security
  - kubernetes
tech_triggers:
  - kubernetes
  - k8s
  - helm
ntype_triggers: []
technique_ids:
  - B1:kubernetes-security
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - iac-container-security
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
fixture_manifest: fixtures/manifest.yaml
---
# Kubernetes Configuration and Surface Testing

Apply this package only after a fast applicability decision. Read `methodology.md` for the controlled workflow, `examples.md` for interpretation controls, and `fixtures/manifest.yaml` for deterministic evaluation cases.

Stop at proof, falsification, a blocker, or the declared safety cap. Hand final proof decisions to `validation`.
