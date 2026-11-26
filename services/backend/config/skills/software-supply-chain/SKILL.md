---
slug: software-supply-chain
name: Software Supply Chain Testing
description: Software Supply Chain Testing methodology. Test dependency confusion and typosquatting indicators, lockfile, registry, and source trust, install scripts, provenance, leaked publishing tokens, and dependency scanner results with exploitability triage.
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when the authorized target exposes software-supply-chain behavior, relevant protocol state, or a source/configuration path that can be validated safely.
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
  - software-supply-chain
  - software
  - supply
  - chain
tech_triggers:
  - npm
  - pip
  - maven
  - lockfile
  - sbom
ntype_triggers: []
technique_ids:
  - B1:software-supply-chain
  - GENAI-SUPPLY
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - source-aware-whitebox
  - information-disclosure
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
# Software Supply Chain Testing

Apply this package only after a fast applicability decision. Read `methodology.md` for the controlled workflow, `examples.md` for interpretation controls, and `fixtures/manifest.yaml` for deterministic evaluation cases.

Stop at proof, falsification, a blocker, or the declared safety cap. Hand final proof decisions to `validation`.
