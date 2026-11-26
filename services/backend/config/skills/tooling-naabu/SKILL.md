---
slug: tooling-naabu
name: Naabu Operation
description: Run naabu port discovery with JSON output and httpx handoff.
phase: recon
compatible_phases:
  - recon
  - enumeration
category: tooling
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - file_read
  - report_note
tool_alternatives: []
risk_tier: low
freshScopePriority: high
use_when: A host or host list needs fast TCP port discovery before HTTP fingerprinting. Use when subfinder has produced subdomains needing port mapping, or when scope is IP/host based and the planner needs a quick port baseline before deeper nmap or httpx steps.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Host list or single host
  - Port set (top-N or explicit list)
expected_outputs:
  - JSONL artifact ingested with ingest_scan_artifact(parser="naabu")
  - Open-port records per host, ready for httpx handoff
evidence_floor: Keep the naabu artifact, target list, rate settings, and open-port evidence. Hand HTTP-like services to httpx before web vulnerability testing.
follow_up_triggers:
  - Hand discovered web ports to httpx for tech fingerprinting
  - Escalate non-HTTP services to nmap for version detection
  - Record scan.coverage(family="naabu") for the host list and port set
strong_terms:
  - tooling-naabu
  - naabu
  - port scan
  - open port
  - tcp discovery
tech_triggers:
  - tcp
  - http
  - https
ntype_triggers:
  - asset.host
  - asset.discovered
  - service.port
technique_ids:
  - B1:tooling-naabu
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
# Naabu Operation

Use naabu for fast discovery, then hand web ports to httpx.
