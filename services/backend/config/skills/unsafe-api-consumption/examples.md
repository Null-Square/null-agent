# Unsafe API Consumption Examples

## Corroborated Trust Failure

- A supplied upstream fixture returns `role=admin`; the application trusts it without binding to the evaluator identity and creates a disposable administrator-like local state.
- A webhook consumer follows an upstream-provided URL to a second owner-controlled public endpoint despite configuration requiring a fixed provider host. Stop before any internal destination.
- The application deserializes an upstream field into a server-managed model property and a synthetic record confirms the change.

## Rejections

- Third-party JSON contains unexpected fields that are ignored.
- An upstream outage produces a handled error and no stale or privileged state.
- A dependency has a CVE but the vulnerable response path is unused.

Use recorded or owner-controlled upstream fixtures. Never impersonate real providers, use their credentials, or redirect traffic beyond public owner endpoints.
