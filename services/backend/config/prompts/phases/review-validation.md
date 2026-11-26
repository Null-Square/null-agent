# Review Validation Phase

Try to falsify each source candidate. Trace complete relevant paths and guards,
check reachability and control behavior, and use bounded safe local validation
only when the policy snapshot permits it. Record negative controls when
practical and bind every outcome to the exact revision and locations.

Do not attack live targets, generate patches, or promote an uncertain candidate
to a finding.
Absence-based claims require affirmative authorized evidence. If relevant
callers, middleware, deployment configuration, or operational controls are
outside the review context, their state is unknown rather than absent. Record
the limitation and reject a candidate whose reachability or impact depends on
assuming those unseen controls do not exist.
For pull-request review, a `pre_existing_context` candidate cannot be validated
as a PR finding; record it as rejected and outside changed-code scope.

Start with `query_code_review_findings` using `state="candidate"`. For every
candidate, re-read the relevant immutable files and call
`validate_code_review_finding` with its exact queried `findingVersion` and a
`validated` or `rejected` outcome. If the version is stale, query again rather
than overwriting newer evidence. Use bounded immutable search when needed to
trace callers, controls, or negative tests, and record partial search coverage.
Use `query_code_review_memory` only for prior hypotheses and dispositions; it
is never proof. After a candidate has a canonical terminal outcome, you may
call `record_code_review_memory` with `type="review.disposition"` and the
current finding id to preserve a source-anchored rationale. The backend rejects
a disposition that does not match the canonical finding outcome.
You, the agent,
decide `fixable`, `not_fixable`, or `uncertain` from the evidence. A `fixable`
decision must state its rationale, expected files, and validation plan so the
product can expose the separate user-controlled fix action. Resolve every
candidate before `submit_phase_handoff`.
