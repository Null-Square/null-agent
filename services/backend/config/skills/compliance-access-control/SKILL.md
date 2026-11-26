---
slug: compliance-access-control
name: Compliance Access-Control Control Checks
description: Dedicated technical control-check skill for selected compliance access-control clusters covering identity, authentication, authorization, privileged access, tenant boundaries, and object-level access.
phase: control_assessment
compatible_phases:
  - control_assessment
category: compliance
required_tools:
  - query_compliance_readiness
  - query_inventory
  - query_findings
  - http_payload
  - http_raw_send
  - http_differential
  - http_list
  - http_view
  - http_repeat
  - browser_action
  - authz_replay
  - file_write
  - record_control_check
  - record_control_request
tool_alternatives: []
risk_tier: low
freshScopePriority: high
use_when: Use only in a control_assessment phase for selected access-control proof obligations supplied by the backend.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Selected scope and in-scope protected resources
  - Available authenticated and unauthenticated access material
  - query_compliance_readiness for current selected-control state
  - Related findings as signals, not verdicts
expected_outputs:
  - Fresh request/replay evidence for authenticated and unauthorized access paths
  - One record_control_check call per selected access-control control
  - Durable evidence refs under .artifacts/phases/control_assessment/
  - A record_control_request when missing credentials, roles, target context, or remediation work blocks a stronger verdict
evidence_floor: Pass requires direct evidence that protected resources enforce authentication and reject unauthorized identities for the tested scope. Fail requires direct evidence that unauthorized access succeeds. Missing credentials, roles, or target context must be recorded as needs_context, not fail.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - compliance-access-control
  - authentication
  - authorization
  - access control
  - authz_replay
  - record_control_check
  - compliance
  - access
  - control
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:compliance-access-control
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
# Compliance Access-Control Control Checks

Assess only the selected controls. Do not hunt for unrelated vulnerabilities.

Use this verdict model:

- `pass`: fresh direct evidence shows protected resources enforce authentication
  and reject unauthorized or cross-role requests across the tested sample.
- `fail`: fresh direct evidence shows unauthorized access to protected resources.
- `needs_context`: the test cannot run because credentials, roles, target
  resources, or environment access are missing.
- `not_attempted`: no meaningful test was attempted before handoff.

Record one `record_control_check` for every selected control. Use the exact
proof obligation id supplied in TARGET CONTEXT:

- `frameworkKey`: the selected framework key from TARGET CONTEXT, such as
  `soc2` or `iso27001`
- `controlId`: one of the selected control ids
- `proofObligationId`: the matching selected proof obligation id
- method describing the actual HTTP differential or authorization replay
- evidence refs and artifact paths that a reviewer can inspect
- replay status: reproduce the safe denial check when possible; when replay is
  not applicable, use a specific `notReplayedReason` and explain the limitation

The selected framework's proof obligation is the control-specific source of
truth. Do not import control IDs or assessment criteria from another framework.

Use durable evidence references only. Accepted formats include
`compliance-evidence:{evidenceItemId}`, structured HTTP/raw-HTTP exchange IDs
returned by HTTP tools, finding evidence paths, and files you wrote under
`/workspace/.artifacts/phases/control_assessment/`. Do not cite note ids, short
HTTP labels, or prose-only refs in `evidenceRefs` or `proof.evidenceIds`.

If related findings exist, cite their IDs in `findingIds`, but do not let a
finding alone determine pass/fail. The verdict must come from this control run.

When the honest result is `needs_context`, call `record_control_request` if a
specific access material, role, credential set, or target list would unblock the
next assessment. Check `.compliance/open-requests.json` first; if an active
request already covers the same missing material, reference that request in the
control-check reason/limitations instead of creating a duplicate. If no active
request exists and the blocker is customer-actionable, the `needs_context`
check is incomplete until you call `record_control_request`. Only omit a request
when the blocker is not customer-actionable, such as target downtime or a tool
limitation, and state that explicitly in the check.

For GDPR, access-control checks support only the selected personal-data access
control or security-of-processing proof obligation. Do not claim GDPR
compliance, lawful processing, DPIA sufficiency, processor agreement validity,
or legal approval from an auth/authz result. State the tested access level,
role/tenant boundary, personal-data processing system assumption, and any
credential limitation.
