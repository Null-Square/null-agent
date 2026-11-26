---
slug: spring-boot
name: Spring Boot Security Testing
description: Spring Boot Security Testing methodology. Test Actuator and configuration exposure, Spring Security filter and method authorization, data binding, SpEL, templates, Jackson, CORS, CSRF, path matching, resources, and source/dynamic validation.
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when the authorized target exposes spring-boot behavior, relevant protocol state, or a source/configuration path that can be validated safely.
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
  - spring-boot
  - spring
  - boot
tech_triggers:
  - spring boot
  - actuator
  - spring security
ntype_triggers: []
technique_ids:
  - B1:spring-boot
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - source-aware-whitebox
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
fixture_manifest: fixtures/manifest.yaml
---
# Spring Boot Security Testing

Apply this package only after a fast applicability decision. Read `methodology.md` for the controlled workflow, `examples.md` for interpretation controls, and `fixtures/manifest.yaml` for deterministic evaluation cases.

Stop at proof, falsification, a blocker, or the declared safety cap. Hand final proof decisions to `validation`.
