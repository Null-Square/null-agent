---
slug: tooling-python
name: Python Proof Operation
description: Python Proof Operation methodology. Use python_session and Python safely for stateful PoCs, parsers, bounded concurrency, deterministic artifacts, cleanup, and never as a policy bypass.
phase: validation
compatible_phases:
  - enumeration
  - validation
  - evidence
category: tooling
required_tools:
  - python_session
  - file_read
tool_alternatives: []
risk_tier: low
use_when: Use when the authorized target exposes tooling-python behavior, relevant protocol state, or a source/configuration path that can be validated safely.
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
  - tooling-python
  - python
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:tooling-python
  - STRIX-TOOLING
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# Python Proof Operation

Apply this package only after a fast applicability decision. Read `methodology.md` for the controlled workflow, `examples.md` for interpretation controls, and `fixtures/manifest.yaml` for deterministic evaluation cases.

Stop at proof, falsification, a blocker, or the declared safety cap. Hand final proof decisions to `validation`.
