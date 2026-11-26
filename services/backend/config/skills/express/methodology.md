# Express Specialization Methodology

Use this skill to map Express router/middleware order, `trust proxy`, parsers, static/files, template engines, sessions/cookies, error handlers, and Node async boundaries.

## Preconditions and Fast Applicability

Require confirmed Express/source, deployed middleware/config order, evaluator identities/data, and safe routes. Default cap is twenty requests and one reversible evaluator mutation.

## Surface Discovery and Prioritization

Map app/router mounts, middleware order, authentication/authorization middleware, body/query parsers, error handlers, proxy/host/IP trust, static/download paths, template engine, sessions, CORS/headers, and async/background integrations.

## Safe Test Ladder

1. Trace one route through global/router/route middleware.
2. Compare allowed/lower evaluator role and owner/peer object.
3. Test one documented alternate parser/content type.
4. Compare direct versus observed proxy headers without spoofing external infrastructure.
5. Exercise one safe error path and one static/download marker.
6. Verify session/cookie behavior in browser.
7. Corroborate deployed revision/config.

## Variation Matrix

| Axis | Variants |
|---|---|
| routing | app, router, route middleware |
| parser | configured query/body parsers |
| proxy | direct baseline, observed trusted proxy path |
| rendering/files | template, static, download |
| async | normal response, observed background completion |

## Proof Standard

Proof requires class-specific runtime behavior tied to exact middleware/parser/route/config order. Express presence, missing hardening header, stack style, or source appearance is not proof.

## False Positives and Benign Lookalikes

- auth middleware can be mounted above visible route code;
- `trust proxy` can be safe behind a fixed gateway;
- parsers intentionally coerce types;
- static middleware may be constrained by root/canonicalization;
- error handlers can redact production responses;
- async errors can be handled by framework/version-specific paths.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without deployed middleware/config, evaluator identities/data, or safe route. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser replay and source/config reads. Use Node tests only in isolated fixtures. Generic class skills own payload/proof.

## Handoffs and Duplicate Prevention

Hand proxy/host, parameter confusion, sessions, files, templates, CORS, and generic auth/injection to their owners. Express owns middleware/order context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty requests, or middleware uncertainty. Restore evaluator state.

Never perform destructive actions or alter production middleware.

Research date: 2026-07-23

## Sources

- Express Production Security Best Practices: https://expressjs.com/en/advanced/best-practice-security.html
- Express Middleware Guide: https://expressjs.com/en/guide/using-middleware.html
- Express Behind Proxies: https://expressjs.com/en/guide/behind-proxies.html
