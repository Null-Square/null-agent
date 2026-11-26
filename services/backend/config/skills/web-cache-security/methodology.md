# Web Cache Security Methodology

Use this method to test cache-key separation, authenticated-content caching, deception, poisoning, and normalization with unique evaluator-only cache keys. Never place a candidate on a shared popular URL.

## Preconditions and Fast Applicability

Require a confirmed cache, observable age/hit indicator, evaluator-owned route/data, and a unique cache-buster namespace. Default cap is twenty requests, two evaluator identities, one cache lifetime, and no shared-key persistence.

## Surface Discovery and Prioritization

Record cache layers, key inputs, `Vary`, cache-control, age/status headers, normalization, cookies/authorization, query handling, path extensions, and invalidation. Prioritize identity leakage and unkeyed inputs that affect an evaluator-busted response.

## Safe Test Ladder

1. Establish miss then hit on a nonce URL.
2. Change one candidate key input and compare.
3. Prime only a nonce-isolated key with an inert marker.
4. Fetch the same key without that input and from a second evaluator identity.
5. Test authenticated/public separation using evaluator data.
6. Test one path/query normalization pair.
7. Wait or explicitly purge only the evaluator key and confirm cleanup.

## Variation Matrix

| Axis | Variants |
|---|---|
| key input | query, one observed header/cookie, path form |
| identity | anonymous, evaluator A, evaluator B |
| state | miss, hit, expired |
| response | public, evaluator-private |
| normalization | one encoded/canonical pair |

## Proof Standard

Proof requires an input that changes a response but is omitted from the cache key, or private evaluator content served to the wrong evaluator/public context, with miss/hit chronology and exact nonce key. Reflection without persistence, cache headers without a hit, or a private browser cache is not proof.

## False Positives and Benign Lookalikes

- application state can mimic a cache hit;
- multiple cache layers can disagree;
- dynamic content can change independently;
- a CDN may bypass authenticated requests correctly;
- a cache buster may itself be unkeyed;
- stale responses can predate the test.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an isolated cache key, hit evidence, evaluator identities, or safe expiry/purge. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for exact request sequences and timestamps. Browser tooling is needed for browser-cache behavior. Avoid automated header mining without per-request nonce isolation.

## Handoffs and Duplicate Prevention

Hand the response-generating primitive to `host-header-attacks`, `header-injection`, `xss`, or its owner; hand CDN/platform configuration to the platform skill. Cache security owns keying and cross-request delivery.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced isolated cache failure, twenty requests, or uncertain sharing. Expire/purge the nonce key and retain only marker data.

Never perform destructive actions or poison a non-isolated shared response.

Research date: 2026-07-23

## Sources

- PortSwigger Web Security Academy, Web Cache Poisoning: https://portswigger.net/web-security/web-cache-poisoning
- RFC 9111, HTTP Caching: https://www.rfc-editor.org/rfc/rfc9111
