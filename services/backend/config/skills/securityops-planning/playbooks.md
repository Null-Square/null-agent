# Security Operations Planning Playbooks

These playbooks produce bounded pentest mission graphs. Select one from the operator goal and live inventory, then replace every placeholder with canonical evidence. Normal PoC includes safe same-scope consequence validation and stops before material impact.

## Playbook A — Fresh Scope

Use when inventory and coverage notes are absent or stale.

| Order | Objective | Phase | Primary skill |
|---|---|---|---|
| 1 | Confirm the authorized hosts, services, and technologies in scope. | Recon | `broad-surface-scan` |
| 2 | Map observed HTTP routes, parameters, scripts, and identity surfaces. | Enumeration | `api-enumeration`, `js-surface-analysis` |
| 3 | Test one highest-priority class justified by the mapped surface. | Validation | one class-specific skill |
| 4 | Reconcile coverage, blockers, findings, and evidence. | Reporting | `security-reporting` |

The first mission cites the scope record. The second cites confirmed services from mission one. The third names the exact route, feature, technology signal, safety cap, and proof floor. Stop discovery after two iterations with no new in-scope surface.

## Playbook B — Open Candidate Findings

Use when canonical findings include candidates that are not independently validated.

Create at most three validation missions, ordered by expected severity and evidence readiness, followed by reporting. Every mission includes:

- `revalidates_finding_id`;
- the existing evidence identifiers;
- the missing control or proof element;
- a one-variable replay;
- a class-specific stop rule; and
- an expected validated, rejected, or blocked outcome.

Do not rediscover the class or widen the scope. A failed reproduction updates the candidate rather than spawning exploratory work.

## Playbook C — Targeted Class Assessment

Use when the operator names a vulnerability or control class.

1. Add a mapping mission only when the class-specific surface is not already evidenced.
2. Add one class-owner validation mission for the highest-priority surface.
3. Add an independent validation mission only if the first produces candidate evidence that meets the class lead floor.
4. Add reporting closeout.

The plan names the class owner, not a generic exploitation skill. If the class method requires a second evaluator identity, callback, source artifact, or disposable environment and it is absent, plan a blocker-resolution mission instead of a weaker test.

## Playbook D — Confirmation-Only Run

Use when the operator asks to validate, confirm, reproduce, or reject known candidates.

Plan one mission per candidate, capped at three, followed by reporting:

```text
candidate A -> class-specific validation
candidate B -> class-specific validation
candidate C -> class-specific validation
all outcomes -> reporting closeout
```

Do not add broad reconnaissance or new class probes. State which remaining candidate is highest priority for a later run when the cap is reached.

## Playbook E — Impact-Boundary Confirmation

Use when a validated class finding has an unverified impact statement that can be checked safely within the same feature and authorization boundary.

| Order | Objective | Phase | Rule |
|---|---|---|---|
| 1 | Confirm the existing finding still reproduces with its minimum proof. | Validation | reuse the owning skill and evidence |
| 2 | Run one bounded impact canary or safe chain step. | Validation | synthetic/evaluator identity is allowed; no real-user, provider, secret, persistence, disruption, or destruction boundary |
| 3 | Record demonstrated and explicitly untested impact. | Evidence | do not infer adjacent impact |
| 4 | Close out the finding and coverage. | Reporting | one canonical finding |

Examples include confirming that an uploaded inert marker is publicly retrievable, creating two synthetic identities through authorized signup before an IDOR comparison, or proving that an evaluator-owned object can be read by the peer test account. If the proposed impact requires internal traversal, secret access, persistence, real-user privilege use, disruption, or a new namespace, record a handoff requiring separate authorization and do not execute it.

## Playbook F — Blocked-Prerequisite Recovery

Use when a prior digest identifies a missing test account, callback, disposable environment, source artifact, scope decision, or rules-of-engagement limit.

1. Classify the prerequisite as available, provisionable, blocked, or prohibited.
2. If available, replay the previously blocked minimum experiment once.
3. If provisionable under PoC, create the smallest synthetic prerequisite through the authorized application, record it, and include cleanup.
4. If blocked or prohibited, select another productive in-scope hypothesis that does not require it; otherwise record the blocker.
5. Close out with the unmet prerequisite and owner.

Never treat continued absence as a negative test result.

## Playbook G — Closeout Only

Use when the operator requests reporting with no further testing.

1. Run reporting preflight and reconcile canonical findings, notes, evidence, and coverage.
2. Prepare report context and author summary/report artifacts.
3. Write the run digest with an agent-actionable next objective or explicit human prerequisite.
4. Finalize run artifacts at the completion level supported by evidence.

No validation or discovery mission belongs in this playbook.

## Selection Order

Choose by operator intent first:

1. Confirmation-only or closeout-only request: D or G.
2. Unresolved human prerequisite: F.
3. Open candidates ready for evidence: B.
4. Explicit vulnerability/control class: C.
5. Safe impact-boundary question: E.
6. Otherwise, fresh-scope mapping: A.

Do not combine playbooks into a long speculative graph. Every mission must be ready from existing evidence or from a named dependency that an earlier mission will produce.

## Universal Boundary

All playbooks require explicit scope, quantitative caps, bounded PoC, class-specific evidence, controls, cleanup, and reporting. Safe multi-step validation is normal. Do not plan secret collection, persistence, real-user privilege use, disruption/destruction, internal or third-party pivoting, or work against an unauthorized/excluded target. Record those requests as separate authorization handoffs.
