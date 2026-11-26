---
slug: rce
name: Remote Code Execution Testing
description: "Test for command injection, SSTI, deserialization, and file-include paths that lead to code execution. Use when: user input reaches server-side execution contexts or high-risk frameworks are identified."
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
use_when: Use when command, template, deserialization, expression language, file include, plugin, webhook, CI, import, or parser surfaces may execute attacker-controlled input.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Candidate execution sinks and payload classes with safety constraints
  - Non-destructive command/SSTI/deserialization/include proof or rejection evidence
  - Clear impact boundary, environment context, and cleanup notes when relevant
evidence_floor: RCE findings require non-destructive proof of code or command execution, such as controlled output, callback, or sandbox-safe marker. Crashes or errors are only leads.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - rce
  - remote code execution
  - command injection
  - template injection
  - deserialization
  - remote
  - code
  - execution
tech_triggers:
  - php
  - java
  - node.js
  - python
ntype_triggers:
  - http.parameters
  - tech.fingerprint
technique_ids:
  - B1:rce
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
  - scripts/oob_setup.sh
fixture_manifest: fixtures/manifest.yaml
---
# Remote Code Execution Testing

## Attack Surface
Focus on request fields that interact with shell commands, templates, interpreters, and file loaders.

## Discovery Methodology
1. Probe command injection and SSTI quickly.
2. Use out-of-band confirmation for blind execution.
3. Validate with minimal proof commands under ROE limits.
4. Stop at reproducible proof of impact.

## Validation
Confirm only with deterministic execution evidence (direct output or OOB callback).
