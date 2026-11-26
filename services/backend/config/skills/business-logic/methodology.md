# Business Logic Methodology

Business-logic testing compares the application's server-enforced rules with the states and transitions an attacker can actually produce. It is not generic parameter fuzzing: every experiment names the invariant, the normal control, the single violated assumption, and the observable server-side consequence.

## Preconditions and Fast Applicability

Apply when the surface contains a workflow, state machine, economic calculation, one-time action, entitlement, approval, quota, eligibility rule, or ordering dependency. Establish synthetic/evaluator-owned records and a reversible stopping point before changing state.

Authorization primitives belong to `idor`/`access-control`; undocumented writable properties to `mass-assignment`; synchronized concurrency to `race-conditions`. A business-logic chain may use those proven primitives as prerequisites when the resulting consequence remains inside bounded PoC.

Never test with real payments, fulfillment, inventory loss, messages to real users, irreversible account changes, or third-party side effects.

Never perform destructive actions. Never convert blocked or ambiguous work into a finding.

## Surface Discovery and Prioritization: Build the Rule and State Model

For each high-value workflow, record:

- actors, roles, tenants, ownership, and separation-of-duty rules;
- states and permitted transitions;
- server-authoritative versus client-supplied fields;
- prerequisites, approvals, freshness, and ordering constraints;
- one-time tokens, idempotency keys, operation/version identifiers;
- quotas, balances, prices, quantities, discounts, credits, and limits;
- external side effects and the last safe pre-side-effect boundary;
- audit/event evidence and cleanup/rollback actions.

Write the hypothesis before the probe:

`invariant → controlled variation → expected secure behavior → bounded consequence if accepted`.

If the invariant cannot be stated from product behavior, documentation, source, or a stable normal control, map the workflow first.

## Safe Test Ladder: Establish the Normal Controls

1. Complete the normal workflow once with synthetic state.
2. Capture every request, response, server-confirmed state, and relevant audit event.
3. Repeat the normal action where needed to learn idempotent behavior.
4. Confirm important state from a clean session or second read path, not only from local UI state.
5. Identify the exact request immediately before any external/irreversible side effect and stop there.

A surprising response without a known normal control is a lead, not proof.

## Test Family 1 — Sequence and State-Transition Abuse

Vary one transition at a time:

- skip a required review/verification step;
- call a later step directly using the normal request shape;
- replay an earlier transition after completion;
- perform steps out of order;
- reuse a stale transition URL/token;
- move from terminal/archived/revoked state back to an active state;
- access a step from a role that should only initiate or approve, not both.

Confirm the resulting state from a clean session and, when safe, exercise the smallest downstream evaluator-owned action that shows the forbidden state has consequence.

## Test Family 2 — Server-Authoritative Value Tampering

Identify fields the server must calculate or constrain, then change one:

- unit price, total, tax, shipping, discount, credit, balance, exchange rate;
- quantity zero, negative, fractional, extreme, or inconsistent with line totals;
- plan/tier/entitlement identifiers;
- approval, verified, paid, fulfilled, or completion flags;
- owner/tenant/account linkage when the flaw is an invariant rather than pure authorization;
- client timestamps, expiration, locale/currency, and state/version fields.

Use non-billable synthetic objects. Verify persisted server state and any safe downstream preview/eligibility result. A client-side display change that is recalculated before commitment is not proof.

## Test Family 3 — Reuse, Replay, and Idempotency

Test one-time or credit-bearing actions sequentially before race testing:

- reuse coupon, invite, password/reset/verification, gift, trial, or redemption tokens;
- resend an operation with the same idempotency key;
- resend with no key or a changed key but identical business operation id;
- replay after cancellation/reversal/expiry;
- duplicate a multi-step request through two documented transports or API versions.

Proof requires duplicate server-side benefit/action, not two `200` responses for one idempotent result. If only simultaneous requests can violate the rule, hand off to `race-conditions` with the established sequential control.

## Test Family 4 — Limit, Eligibility, and Quota Bypass

Probe exact boundaries and alternate enforcement paths:

- below/at/above minimum and maximum;
- cumulative limits split across multiple requests, resources, identities, or versions;
- per-user versus per-tenant accounting;
- trial/discount/feature eligibility after state changes;
- archived/deactivated accounts retaining actions;
- bulk/import endpoints that bypass single-item constraints;
- UI-enforced limits absent from direct API operations.

Use the smallest values needed to decide the invariant. Do not exhaust resources or generate external activity.

## Test Family 5 — Approval and Role Separation

With synthetic roles when available:

- initiator attempts approver transition;
- approver changes the item after approval;
- peer tenant/user reuses approval identifiers;
- one role reaches hidden/direct transition endpoints;
- approval remains valid after material item changes;
- revoked or downgraded role retains a cached transition.

Pure role denial belongs to access control; the business-logic finding is the invalid workflow/state consequence produced by the broken separation.

## Test Family 6 — Alternate Channels and Representations

When the normal rule is established, compare a small number of plausible alternate paths:

- browser endpoint versus API/mobile endpoint;
- current versus observed legacy version;
- single-item versus batch/import route;
- form versus JSON content type where both are supported;
- preview/draft versus commit endpoint;
- object clone/copy/reorder actions that carry stale protected state.

Do not enumerate speculative versions or content types without an observed signal.

## Safe Chain Reasoning

A primitive becomes more valuable when it unlocks a concrete evaluator-owned consequence. For every accepted invalid transition/value:

1. name the next security hypothesis;
2. identify the smallest downstream action;
3. execute only if it stays in the authorized namespace, uses synthetic state, is reversible, and has no material/third-party effect;
4. retain a normal/negative control;
5. clean up; and
6. preserve but do not execute any step crossing into real-user impact, money, fulfillment, secrets, persistence, disruption, destruction, or another provider.

Examples include proving that a bypassed approval exposes a test-only download or that a tampered synthetic tier unlocks one evaluator-only feature. Do not place an order, issue a refund, send a message, or consume real inventory.

## Adaptation After a Failed Probe

Do not treat one secure response as complete coverage. Use the failure to choose one relevant alternative:

- UI blocks but direct API has a known operation → call the known operation;
- request accepted but state unchanged → inspect server-confirmed state and required version/idempotency fields;
- current version enforces the rule → test one observed legacy/batch path;
- action is idempotent sequentially → hand off to race only if concurrency is applicable;
- role is blocked → test separation/staleness with another supplied or provisionable synthetic role;
- side effect boundary is too risky → use preview/draft/test-only state and record the unexecuted material hypothesis.

Stop after the applicable variation matrix is decided; do not spray arbitrary values.

## Variation Matrix

| Axis | Examples |
|---|---|
| state | draft, reviewed, approved, completed, cancelled, archived, revoked |
| sequence | normal, skipped, reordered, replayed, stale token |
| authority | initiator, approver, peer, tenant peer, documented manager |
| value | server-derived, client-supplied, boundary, negative/fractional, inconsistent total |
| reuse | same key, no key, changed key, same operation id, post-expiry |
| channel | browser/API, current/observed legacy, single/batch, draft/commit |

Change one material variable per comparison and preserve the normal control.

## False Positives and Benign Lookalikes

Reject client-only state, duplicate success responses that map to one idempotent operation, documented manager behavior, previews that are recalculated before commitment, and intended discount/eligibility composition. When product intent is unclear, retain the observation as an ambiguous lead until a stable rule or owner-backed invariant exists.

## Proof Standard

Proof is a reproducible server-side invariant violation on synthetic state: forbidden transition, persisted client-controlled economic/state value, duplicate one-time benefit, bypassed approval/eligibility/limit, or a safe downstream evaluator-owned consequence. Retain request/control pairs, identity/state evidence, before/after server reads, and cleanup.

The following are not proof:

- hidden routes or client-side controls alone;
- different status/body length without server-state consequence;
- repeated success responses mapping to one operation;
- intended discount stacking, sharing, manager behavior, or preview values;
- speculative business rules without owner/product evidence.

## Missing Prerequisites and Blocked Behavior

Classify the missing prerequisite as available, provisionable, blocked, or prohibited. Create synthetic accounts/objects through normal public flows when safe. Block when the invariant cannot be established or proof requires real payment, fulfillment, communications, other-user impact, or irreversible state. Never call missing prerequisites a negative result.

## Tool Selection and Fallback

Use browser capture to establish the normal workflow, HTTP replay/differential tools for one-variable experiments, `python_session` for offline state-table comparison, and repository evidence only to clarify server-side rules. Avoid generic fuzzing.

If browser capture is unavailable, use a supplied normal request plus a clean-session readback. If HTTP replay is unavailable, keep the exact request mutation as a blocked experiment rather than substituting an uncorrelated scanner result.

## Handoffs and Duplicate Prevention

Hand object/role authorization to `idor`/`access-control`, property overposting to `mass-assignment`, synchronized operations to `race-conditions`, and parser/method differentials to their owning skills. Link the resulting primitive back into one business-invariant evidence bundle.

## Stop, Cleanup, and Data Minimization

Restore synthetic balances/labels, revoke test approvals/shares, cancel test orders before any external processing, remove evaluator-created records through authorized owner actions, and clear session state. Retain only identifiers, audit events, request/control pairs, and rule evidence necessary to reproduce the issue.

Research date: 2026-08-31

## Sources

- [OWASP WSTG - Testing for Business Logic](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/)
- [PortSwigger Web Security Academy - Business logic vulnerabilities](https://portswigger.net/web-security/logic-flaws)
