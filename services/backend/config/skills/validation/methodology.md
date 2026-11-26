# Independent Finding Validation Methodology

Validation decides whether a candidate is promoted, rejected, or explicitly blocked. It does not rediscover the surface and does not strengthen impact beyond the candidate’s authorized proof boundary.

## Preconditions and Fast Applicability

Require a candidate identifier, owning skill, exact target, original request or artifact, evidence references, claimed impact, and the owner skill’s proof floor. Also require the identities, state, callback, or disposable fixture needed for an independent replay.

Reject validation intake that contains only a scanner label, version match, screenshot without request context, or prose claim. Return it to the owning skill as an insufficient lead.

## Surface Discovery and Prioritization

Do not enumerate new surface. Reconstruct only:

- the candidate’s input-to-effect path;
- baseline, candidate, and negative-control conditions;
- identity and state transitions;
- transient dependencies such as cache, queue, or callback; and
- cleanup obligations.

Prioritize candidates with complete raw evidence and material impact. Cap a validation mission at three candidates.

## Safe Test Ladder

1. Verify scope and candidate hash/version.
2. Replay the unmodified baseline once.
3. Replay the candidate once with a fresh nonce, identity, or state as the class requires.
4. Run the class-specific negative control.
5. Repeat only the decisive candidate/control pair once to reject noise.
6. Apply the owning methodology’s proof floor.
7. Submit one outcome: `validated`, `rejected`, or `blocked`.

If the original proof cannot be safely replayed, do not substitute a more aggressive payload. Use a documented not-replayed reason.

## Variation Matrix

Validation permits only variations needed for independence:

| Dimension | Allowed change |
|---|---|
| nonce | fresh evaluator marker |
| identity | second supplied evaluator identity |
| session | fresh isolated session |
| time | repeat inside the documented validity window |
| route | exact route from the candidate |
| payload | minimum reproducer, then one matched negative control |

Changing endpoint, vulnerability class, privilege boundary, or target creates a new lead owned elsewhere.

## Proof Standard

A validated outcome requires:

- the candidate’s claimed effect is objectively reproduced;
- the owning skill’s baseline and negative controls behave as expected;
- evidence identifies the exact target, identity/state, request or artifact, and time;
- a fresh replay excludes stale/cache-only output; and
- cleanup is complete.

`finding_allowed` is true only for a validated proof. A lead, blocked result, infrastructure failure, or ambiguous response cannot create or promote a finding.

Allowed not-replayed reasons are limited to: prerequisite withdrawn, target state changed, safe fixture unavailable, authorization no longer covers the replay, or environment failure. Each reason names the missing condition and keeps the Risk in verifying.

## False Positives and Benign Lookalikes

- cached output reproduces the body but not the underlying state;
- a scanner and the validator share the same incorrect signature;
- the control identity still carries a privileged session;
- a public or same-owner resource matches the claimed unauthorized object;
- a callback comes from a gateway or scanner;
- dynamic values create response differences after normalization;
- a patched target rejects both candidate and control for a new reason.

Reject or block according to observed evidence; never preserve severity merely because the original candidate was high.

## Missing Prerequisites and Blocked Behavior

Use `blocked` when a required evaluator identity, stable baseline, callback attribution, source revision, protocol capability, disposable environment, or current authorization is absent. Record the attempted steps, evidence that the blocker is real, exact prerequisite and owner, and minimum safe replay after unblocking.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use the same class-compatible HTTP, browser, repository-read, or file tool needed to replay the minimum evidence. Use `report_note` for rejected hypotheses and `submit_validation_lead_outcome` for unresolved candidate disposition. Use `submit_validation_outcome` only after all controls are evaluated.

Tool failure is infrastructure evidence, not vulnerability evidence. One fallback is allowed when it preserves the request semantics; otherwise stop.

## Handoffs and Duplicate Prevention

The originating skill remains owner of class methodology and remediation. Validation owns the independent disposition and links back through `validatesFindingId` or the candidate identifier. Do not create a second finding for the same root cause, transport variant, or identity replay.

When validation discovers a genuinely different sink or boundary, record a new lead for its primary skill without testing it in this mission.

## Stop, Cleanup, and Data Minimization

Stop after one independent proof plus control, one decisive rejection, two failed replays, or a blocker. Remove evaluator-created state and expire callback tokens. Retain normalized evidence, hashes, and redacted identity labels.

Never perform destructive actions, expand impact, or retain live credentials. Never infer a finding from fingerprint or version presence alone.

Research date: 2026-07-23

## Sources

- OWASP Web Security Testing Guide, Testing Framework: https://owasp.org/www-project-web-security-testing-guide/latest/3-The_OWASP_Testing_Framework/
- NIST SP 800-115, Technical Guide to Information Security Testing and Assessment: https://csrc.nist.gov/pubs/sp/800/115/final
- Locked B1 authoring and evaluation PRD: ../../../../../docs/prd/3.0/agent-skill-authoring-and-evaluation.md
