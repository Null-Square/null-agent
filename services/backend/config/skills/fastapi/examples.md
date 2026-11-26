# FastAPI Examples

## Accepted

- A dependency enforcing tenant membership is present on the collection route but absent from `GET /items/{id}`; evaluator A receives evaluator B's canary object.
- A Pydantic request model accepts a server-managed `is_admin` field and the persistence layer stores it for a disposable evaluator account. Route the primitive to `mass-assignment`.
- OpenAPI declares authentication, but the route omits the security dependency and returns a synthetic private response anonymously.

## Rejected

- `/docs` is intentionally public and reveals only already-public schema.
- A dependency override exists only in tests.
- Validation returns verbose field names without secrets or internal state.

Tie OpenAPI, router inclusion, dependency resolution, and observed runtime together. Never start background jobs or mutate non-disposable records.
