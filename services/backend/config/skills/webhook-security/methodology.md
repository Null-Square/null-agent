# Webhook Security Methodology

Use this method for inbound webhook signature, timestamp, replay, event/object authorization, ordering, idempotency, and callback registration with evaluator-owned senders and objects.

## Preconditions and Fast Applicability

Require an evaluator webhook endpoint or provider test mode, signing test secret/key, documented signature construction, evaluator event/object, and cleanup path. Default cap is twelve deliveries and a two-event reorder test.

## Surface Discovery and Prioritization

Map registration/verification, destination allowlist, signature inputs, raw-body handling, timestamp window, event identifiers, retries, ordering, idempotency, event-to-tenant binding, and downstream action.

## Safe Test Ladder

1. Deliver one valid signed evaluator event.
2. Alter body after signing.
3. Remove/corrupt signature.
4. Replay the valid event within and outside the documented window.
5. Use a valid signature with a peer evaluator object/tenant reference.
6. Send two evaluator events in reversed order.
7. Repeat one event identifier to verify idempotency.
8. Confirm final state and delete registration.

## Variation Matrix

| Axis | Variants |
|---|---|
| integrity | valid, body changed, signature absent/corrupt |
| freshness | current, replay, expired timestamp |
| object | owner, supplied peer evaluator, nonexistent |
| delivery | once, duplicate, reversed pair |
| registration | evaluator callback, one disallowed evaluator URL |

## Proof Standard

Proof requires an invalid/replayed/misbound event to produce a material evaluator-owned state change, or callback registration to violate a concrete destination policy. HTTP acceptance, retries, signature error text, or duplicate receipts without duplicate effect is not proof.

## False Positives and Benign Lookalikes

- providers legitimately retry;
- queues can deliver out of order while consumers remain correct;
- gateways can verify signatures before application logs;
- raw-body reserialization can invalidate a test incorrectly;
- event IDs can be scoped per provider/account;
- asynchronous actions can later roll back.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without provider test mode/signing material, evaluator objects, authoritative final state, or cleanup. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use local signing libraries, `http_payload`, callback logs, and source/config reads. Preserve raw bytes and timestamps. Do not guess signing secrets.

## Handoffs and Duplicate Prevention

Hand outbound webhook URL fetching to `ssrf`, unsafe provider responses to `unsafe-api-consumption`, and workflow/idempotency effects to `business-logic`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced control failure, twelve deliveries, or unexpected external delivery. Delete evaluator subscriptions/events and secrets.

Never perform destructive actions or send events about non-evaluator objects.

Research date: 2026-07-23

## Sources

- OWASP Web Service Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Web_Service_Security_Cheat_Sheet.html
- RFC 9421, HTTP Message Signatures: https://www.rfc-editor.org/rfc/rfc9421
