---
slug: network-recon
name: Network Reconnaissance
description: "Perform structured port scanning and service fingerprinting to build the network attack surface. Use when: scope includes hosts/IPs, service inventory is incomplete, or web-only recon is exhausted."
phase: recon
compatible_phases:
  - recon
  - enumeration
category: recon
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - report_note
  - query_inventory
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when host/IP scope requires port discovery, service fingerprinting, TLS/banner collection, or non-HTTP service triage before web or vulnerability-specific testing.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Open port and service inventory with scanner artifacts and confidence
  - HTTP handoff targets, non-HTTP service notes, and technology fingerprints
  - Blocked coverage for filtered, rate-limited, or out-of-scope ranges
evidence_floor: Network recon must produce durable scanner artifacts or ingested notes for open services and explicitly mark filtered/unreachable coverage. Do not infer services without command evidence.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - network-recon
  - network recon
  - port scan
  - service discovery
  - nmap
  - naabu
  - open port
  - network
  - recon
  - reconnaissance
tech_triggers:
  - nginx
  - apache
  - ssh
ntype_triggers:
  - tech.fingerprint
technique_ids:
  - B1:network-recon
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - broad-surface-scan
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
# Network Reconnaissance

## Attack Surface
Map open ports, protocols, service versions, and TLS metadata for each in-scope host.

## Discovery Methodology
1. Run fast port discovery to establish coverage.
2. Fingerprint discovered services and protocols.
3. Identify exposed web services and weak service versions.
4. Feed service inventory back into planning and vulnerability tasks.

## Validation
Confirm with command output showing open port plus service fingerprint.
