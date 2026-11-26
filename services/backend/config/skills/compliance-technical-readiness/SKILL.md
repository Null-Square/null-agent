---
slug: compliance-technical-readiness
name: Compliance Technical Readiness Control Checks
description: Dedicated technical-readiness skill for agent-provable compliance controls outside the access-control family, including transport, inventory, vulnerability, monitoring, SDLC, and supply-chain evidence.
phase: control_assessment
compatible_phases:
  - control_assessment
category: compliance
required_tools:
  - query_compliance_readiness
  - query_inventory
  - query_findings
  - query_notes
  - http_payload
  - http_raw_send
  - http_list
  - http_view
  - http_repeat
  - http_sitemap
  - browser_action
  - shell_run
  - wait_for_shell_job
  - python_session
  - file_read
  - file_write
  - record_control_check
  - record_control_request
tool_alternatives: []
risk_tier: low
freshScopePriority: high
use_when: Use only in a control_assessment phase when TARGET CONTEXT selected one or more technical proof obligations that are not covered by compliance-access-control.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Selected control IDs and proof obligation IDs
  - Current inventory, notes, scanner observations, findings, and available artifacts
  - Scope boundaries and execution target
expected_outputs:
  - One record_control_check call per selected control
  - Evidence-bounded verdicts with explicit limitations
  - Durable evidence refs from HTTP history, artifacts, notes, inventory, or scanner outputs
  - A record_control_request when missing scanner output, source access, credentials, artifacts, or remediation work blocks a stronger verdict
evidence_floor: Pass means the selected technical control held for the tested evidence sample, with limitations stated. Fail means direct evidence shows the control did not operate. Missing scanners, source access, credentials, artifacts, or scope coverage must be recorded as needs_context, not guessed as pass or fail.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - compliance-technical-readiness
  - technical readiness
  - transport security
  - monitoring evidence
  - tls
  - attack surface
  - scanner coverage
  - vulnerability detection
  - record_control_check
  - compliance
  - technical
  - readiness
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:compliance-technical-readiness
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - compliance-planning
handoff_skills:
  - compliance-reporting
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# Compliance Technical Readiness Control Checks

Assess only selected controls. Do not hunt for unrelated vulnerabilities and do
not create findings. Existing findings can be cited as supporting signals.

Use this verdict model:

- `pass`: fresh direct evidence supports the proof obligation for the tested
  scope sample. State exactly what was covered and what was not.
- `fail`: fresh direct evidence shows the control did not operate.
- `needs_context`: required scanner output, source access, credentials,
  target reachability, or scope context is missing.
- `not_attempted`: no meaningful check was attempted before handoff.

The selected framework's proof obligation is the control-specific source of
truth. Follow its statement, required evidence, and accepted methods. Do not
import control IDs or assessment criteria from another framework.

For each selected control, call `record_control_check` with:

- `frameworkKey`: the selected framework key from TARGET CONTEXT, such as
  `soc2` or `iso27001`
- `controlId`: the selected control ID
- `proofObligationId`: the matching selected proof obligation ID
- `evidenceRefs` and `proof.evidenceIds`: durable refs a reviewer can inspect
- `limitations`: concise scope limits, missing access, sample boundaries, and
  evidence classes not available
- `proof.replayAttempted`: true when a safe replay is possible
- `proof.notReplayedReason`: only a specific reason when replay is not
  applicable or unsafe

Use durable evidence references only. Accepted formats include
`compliance-evidence:{evidenceItemId}`, structured HTTP/raw-HTTP exchange IDs
returned by HTTP tools, finding evidence paths, and files you wrote under
`/workspace/.artifacts/phases/control_assessment/`. Do not cite note ids, short
HTTP labels, or prose-only refs in `evidenceRefs` or `proof.evidenceIds`.

When the honest result is `needs_context`, call `record_control_request` if a
specific export, scan artifact, repository access, credential, inventory source,
or remediation action would unblock the next assessment. Keep the request tied
to the selected control and evidence class. Check `.compliance/open-requests.json`
first; if an active request already covers the same missing material, reference
that request in the control-check reason/limitations instead of creating a
duplicate. If no active request exists and the blocker is customer-actionable,
the `needs_context` check is incomplete until you call `record_control_request`.
Only omit a request when the blocker is not customer-actionable, such as target
downtime or a tool limitation, and state that explicitly in the check.

Never use a bare green verdict. A pass must read as evidence-bounded, for
example: "pass for HTTPS transport on the tested public services; internal
services were not reachable from this runner."

For GDPR, technical checks support only the selected Article 25/32-style
readiness controls. A TLS check, scanner review, inventory review, or
backup/restore artifact can support security of processing, access control, or
encryption/resilience evidence. It cannot prove lawful basis, DPIA sufficiency,
processor agreement validity, transfer legality, or GDPR compliance. State the
privacy/legal limitation explicitly when recording the check.
