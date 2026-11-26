---
slug: tooling-nmap
name: Nmap Operation
description: Run staged nmap scans with XML output for service inventory.
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
freshScopePriority: medium
use_when: Authorized hosts or subnets need TCP/UDP service discovery and version detection beyond what naabu provides. Use when the scope is host/IP based rather than domain-only, or when a deeper service-version sweep is needed to fingerprint non-HTTP services.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - In-scope host or subnet
  - Approved port range and timing template
expected_outputs:
  - XML artifact ingested with ingest_scan_artifact(parser="nmap")
  - Service banners and version evidence per host
evidence_floor: Keep the XML/normal output, host/port scope, scan flags, and service/version evidence. Use staged, scoped scans and record filtered or unreachable hosts as blocked coverage.
follow_up_triggers:
  - Hand confirmed HTTP ports to httpx for fingerprinting
  - Pair non-HTTP service exposures with network-recon for context
  - Record scan.coverage(family="nmap") with host range and port spec
strong_terms:
  - tooling-nmap
  - nmap
  - service detection
  - version scan
  - port scan
tech_triggers:
  - tcp
  - udp
  - ssh
  - ftp
  - smtp
  - smb
  - rdp
  - mysql
  - postgresql
  - redis
  - mongodb
  - elasticsearch
  - kubernetes
ntype_triggers:
  - asset.host
  - asset.network
  - service.port
technique_ids:
  - B1:tooling-nmap
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
# Nmap Operation

Start narrow, then expand only when the target and rate are approved.
