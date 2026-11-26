# Next.js Security Methodology

Use this platform skill to map Next.js Pages/App Router boundaries and specialize validation of middleware, Route Handlers, Server Actions, React Server Components, caching/ISR, image optimization, and deployed runtime differences. Generic vulnerability proof remains with its class owner.

## Preconditions and Fast Applicability

Require a confirmed Next.js application from build artifacts or multiple framework indicators, the deployed build identifier when observable, and ordinary evaluator navigation. Use evaluator accounts/objects for identity or cache comparisons.

Default limits: twenty framework-specific requests, two evaluator identities, one cache revalidation window, image inputs under 100 KiB, and no on-demand revalidation or action invocation unless the normal UI exposes a reversible evaluator operation.

## Surface Discovery and Prioritization

Map:

- Pages versus App Router routes and route groups;
- middleware matchers and rewrites;
- Route Handlers and API routes;
- Server Actions invoked by observed forms/UI;
- RSC/navigation requests and response variants;
- static, dynamic, ISR, and fetch-cache behavior;
- image optimizer inputs and remote patterns;
- authentication/session integration; and
- Node versus edge runtime placement.

Prioritize inconsistent authorization/cache behavior across direct navigation, RSC requests, and action/API endpoints. Treat framework version as inventory only.

## Safe Test Ladder

1. Capture ordinary document and client-navigation requests for one route.
2. Compare anonymous, owner, and supplied peer evaluator access.
3. Request the same route through observed document and RSC representations without inventing internal headers.
4. Compare middleware-protected route, direct Route Handler/API route, and normal redirect behavior.
5. Invoke one observed reversible Server Action through its normal form and verify server-side authorization.
6. Test cache separation using evaluator-specific nonce content and a fresh session.
7. For ISR, observe before/after only through the documented wait/reload path.
8. Test image optimizer only with evaluator-hosted allowed/disallowed small images.
9. Corroborate with source/config when available.

Do not replay stale action identifiers from another build or trigger operational cache purge.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| router | Pages, App |
| request form | document, observed RSC navigation, Route Handler/API |
| runtime | Node, edge as deployed |
| identity | anonymous, owner, supplied peer |
| rendering/cache | static, dynamic, ISR, per-user fetch |
| action | observed reversible Server Action |
| image | owner-hosted allowed URL, owner-hosted disallowed URL |
| build | exact active build identifier |

One framework boundary changes per replay.

## Proof Standard

A Next.js platform finding requires objective inconsistent behavior caused by a framework boundary: unauthorized evaluator data/action, cross-identity cache response, middleware/handler enforcement mismatch, or unsafe optimizer fetch proven with evaluator-owned resources. Retain raw request variants, build/runtime evidence, identities, cache controls, final state, and cleanup.

Route manifests, source maps, action identifiers, framework headers, or a vulnerable version advisory are leads only.

## False Positives and Benign Lookalikes

- CDN caching can be external to Next.js;
- RSC responses intentionally differ from documents;
- stale chunks/action identifiers can survive a deployment;
- middleware can redirect while a handler independently rejects;
- static public pages can be shared safely;
- edge and Node runtimes can emit different headers without security impact.

Use active-build identifiers, final server state, and class-specific controls.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when the active build cannot be identified, evaluator identities or reversible actions are absent, cache state cannot be isolated, or source/config is required to interpret runtime behavior. Do not guess action identifiers or purge shared caches.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for navigation/action/RSC provenance and `http_payload` for exact replays. Use `file_read` for manifests, middleware, route files, and config. Use class skills for payload/proof logic.

If client navigation cannot be automated reliably, capture one manual browser flow rather than fabricating framework headers.

## Handoffs and Duplicate Prevention

- Hand authentication/authorization to `broken-auth`, `idor`, or `access-control`.
- Hand Server Action CSRF to `csrf`.
- Hand cache poisoning/separation to `web-cache-security`.
- Hand optimizer request behavior to `ssrf`.
- Hand client bundles to `js-surface-analysis`.
- Hand generic injection/XSS to their owners.

Next.js owns the platform boundary and affected versions/configuration; the class skill owns the primitive.

## Stop, Cleanup, and Data Minimization

Stop at first reproduced boundary failure, twenty requests, or cache uncertainty. Delete evaluator action objects and hosted image fixtures; retain redacted RSC/action metadata and build hashes.

Never perform destructive actions, operational cache invalidation, or requests against non-evaluator data.

Research date: 2026-07-23

## Sources

- Next.js Security Guidelines: https://nextjs.org/docs/app/guides/data-security
- Next.js Server Actions Configuration: https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions
- Next.js Caching Guide: https://nextjs.org/docs/app/guides/caching
- Next.js Image Component: https://nextjs.org/docs/app/api-reference/components/image
