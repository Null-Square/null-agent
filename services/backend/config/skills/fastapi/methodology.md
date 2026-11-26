# FastAPI Specialization Methodology

Use this skill for FastAPI/Starlette routing, dependency-based auth, Pydantic validation/serialization, OpenAPI, background tasks, async boundaries, uploads/static files, middleware, and proxy/root-path configuration.

## Preconditions and Fast Applicability

Require confirmed FastAPI/source, evaluator identities/objects, deployed schema/revision, and a safe operation. Default cap: twenty requests, one reversible evaluator mutation, and no event-loop load testing.

## Surface Discovery and Prioritization

Map routers/operations, dependencies and overrides, security scopes, Pydantic input/output models, response filtering, OpenAPI exposure, middleware/CORS/trusted hosts, background tasks, file/static mounts, WebSockets, proxy headers, and exception handlers.

## Safe Test Ladder

1. Correlate OpenAPI operation to router/dependencies.
2. Compare allowed/lower evaluator scope and owner/peer object.
3. Send one extra protected canary field and verify response/persistence.
4. Test missing dependency credential.
5. Correlate accepted background job to final evaluator state.
6. Compare direct/proxy path only with observed configuration.
7. Verify deployed model/revision.

## Variation Matrix

| Axis | Variants |
|---|---|
| handler | sync, async, background task |
| auth | dependency, security scope |
| model | input, output, one extra canary field |
| transport | HTTP, observed WebSocket handoff |
| deployment | middleware, root path, proxy headers |

## Proof Standard

Proof requires class-specific behavior tied to exact FastAPI operation/dependency/model/task/config. OpenAPI exposure, validation errors, async use, or version matches alone are leads.

## False Positives and Benign Lookalikes

- response models can correctly filter sensitive fields;
- dependencies may be global/router-level;
- background acceptance can later reject;
- Pydantic coercion can be intentional;
- generated OpenAPI can omit custom middleware;
- proxy/root-path differences can be deployment-correct.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator scopes/data, task completion evidence, deployed schema/revision, or safe operation. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser capture, OpenAPI parsing, source reads, and FastAPI test client only in isolated tests. Generic class skills own proof.

## Handoffs and Duplicate Prevention

Hand property/auth/object controls, CORS, WebSockets, uploads, resource, and injection to their owners. FastAPI owns dependency/model/task configuration context.

## Stop, Cleanup, and Data Minimization

Stop at one framework-specific proof, twenty requests, or task uncertainty. Delete evaluator objects/jobs.

Never perform destructive actions or stress the event loop.

Research date: 2026-07-23

## Sources

- FastAPI Security: https://fastapi.tiangolo.com/tutorial/security/
- FastAPI Dependencies: https://fastapi.tiangolo.com/tutorial/dependencies/
- FastAPI Response Models: https://fastapi.tiangolo.com/tutorial/response-model/
