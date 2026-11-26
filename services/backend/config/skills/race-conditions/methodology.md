# Race Condition Methodology

Use this method to determine whether concurrent processing violates a state invariant on evaluator-owned, reversible data. It is not a load test.

## Preconditions and Fast Applicability

Require:

- an evaluator-owned object or isolated test account;
- a single-request action with a documented limit or state transition;
- authoritative pre/post-state and transaction history;
- a cleanup or reset path; and
- an approved concurrency cap.

Default cap is two concurrent requests, three bursts, one in-flight connection group, and thirty total requests including controls. Financial, inventory, messaging, quota, and security-setting actions require a sandbox or owner-provided zero-impact fixture.

## Surface Discovery and Prioritization

Map the state machine:

`pre-state -> eligibility check -> transient sub-state -> commit -> post-state`

Identify actions sharing the same record, idempotency key, quota, nonce, balance, or status. Prioritize a reversible single-use evaluator coupon, test credit, test object creation quota, or owner-provided transition canary.

Record whether requests are serialized by session, connection, queue partition, or database lock. Background completion must be correlated by job or transaction identifier.

## Safe Test Ladder

1. Record authoritative pre-state and history.
2. Execute one request and verify exactly one expected transition.
3. Reset the fixture.
4. Send the same two requests sequentially; only the first should commit.
5. Reset again.
6. Send two requests concurrently using the minimum synchronization supported by the normal protocol.
7. Wait for all background work and read authoritative post-state/history.
8. Repeat the sequential/concurrent pair once if the invariant was violated.
9. Restore the fixture.

Increase neither concurrency nor burst count after a positive. If two requests cannot expose the suspected window, record a bounded negative or blocked result.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| schedule | single, sequential pair, concurrent pair |
| endpoint | same endpoint, two observed endpoints sharing one state record |
| session | same evaluator session, two supplied evaluator sessions |
| protocol | HTTP/1 separate connections, HTTP/2 streams when normally supported |
| idempotency | fresh key, same key on the pair, omitted key when optional |
| state | clean fixture for every burst |
| observation | responses, authoritative record, transaction/audit history |

Run one schedule at a time and keep the business input identical.

## Proof Standard

Proof requires:

1. an explicit invariant such as “at most one commit for this evaluator token”;
2. single and sequential controls enforce it;
3. the concurrent pair produces two committed effects or an otherwise forbidden intermediate state;
4. transaction identifiers and final state attribute both effects to the pair;
5. a fresh fixture reproduces once; and
6. cleanup is verified.

Two success responses without two committed effects, timing overlap alone, or an inconsistent UI counter is not proof.

## False Positives and Benign Lookalikes

- both responses can be accepted while one transaction later rolls back;
- eventual consistency can temporarily display a stale count;
- retries by a client or proxy can create extra requests unrelated to concurrency;
- two distinct evaluator objects may not share an invariant;
- background jobs can finish in reverse order but remain correct;
- a missing idempotency key can be documented behavior rather than a race.

Use server transaction history and compare sequential behavior.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when the action has real financial/user impact, reset is unavailable, authoritative state cannot be read, or the owner has not approved even two concurrent requests. Preserve the state-machine hypothesis and requested disposable fixture.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use a bounded concurrency tool that can release exactly two prepared requests and preserve raw timing. Use `http_payload` for single/sequential controls and `report_note` for state snapshots. Avoid scanner presets with hidden concurrency.

If protocol synchronization is unavailable, use two ordinary concurrent connections; do not raise volume to compensate for jitter.

## Handoffs and Duplicate Prevention

- Hand non-concurrent workflow replay to `business-logic`.
- Hand authentication lockout races to `broken-auth`.
- Hand idempotency and API workflow ownership to `unsafe-api-consumption` when the defect is upstream-consumer behavior.
- Hand availability degradation to `resource-consumption`; it is excluded here.

This skill owns the concurrency-dependent invariant violation. Record multiple affected endpoints under one shared-state root cause.

## Stop, Cleanup, and Data Minimization

Stop after one reproduced concurrent violation, three bursts, thirty total requests, or any instability. Reset evaluator state and remove test objects. Retain state hashes and transaction identifiers, not unrelated records.

Never perform destructive actions, load testing, real-value duplication, or concurrency above the approved cap.

Research date: 2026-07-23

## Sources

- PortSwigger Web Security Academy, Race Conditions: https://portswigger.net/web-security/race-conditions
- CWE-362, Concurrent Execution using Shared Resource with Improper Synchronization: https://cwe.mitre.org/data/definitions/362.html
- OWASP Web Security Testing Guide, Business Logic Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/
