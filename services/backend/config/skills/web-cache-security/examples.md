# Web Cache Security Examples

## Cache-Key Proof

- A harmless owner-controlled header changes a synthetic response marker; after a fresh-cache request, a canonical request receives that marker. Repeat once with a new cache buster and retain age/cache-status evidence.
- An authenticated evaluator response containing `B1_PRIVATE_8` is served to an unauthenticated control because the session-bearing request and anonymous request share a cache key.
- A path normalization difference makes the cache store a dynamic evaluator response under a static-looking public key.

## Reject

- The candidate response is never cached (`Age` absent and cache status is bypass).
- A variation appears only in the attacker's own browser cache.
- The response differs because the origin generated random content.

Use synthetic markers, unique cache busters, and at most two persistence checks. Never poison high-traffic shared paths or security-sensitive real-user responses.
