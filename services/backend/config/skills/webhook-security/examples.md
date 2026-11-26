# Webhook Security Examples

## Verified Failures

- A recorded evaluator webhook is accepted after its body changes because signature verification covers the wrong byte representation; the original body is the positive control.
- The same signed evaluator event is accepted twice outside the documented replay window and creates two disposable test records.
- A webhook for tenant A includes an attacker-controlled tenant field and the consumer stores a synthetic event under tenant B without binding to the endpoint secret.

## Non-Findings

- The endpoint returns `2xx` before asynchronous verification, but no event is processed.
- Duplicate delivery is idempotently recorded once.
- A provider supports unsigned local-development events on a separate disabled route.

Use recorded/synthetic events and owner keys only, cap replays at two, and clean disposable records. SSRF-like outbound behavior routes to `ssrf`.
