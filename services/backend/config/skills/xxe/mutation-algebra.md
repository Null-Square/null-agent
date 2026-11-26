# XML External Entity Mutation Algebra

Let `X` be a valid baseline document, `N` a fresh callback nonce, `F` an owner-provided local marker, and `P` the confirmed parser entrypoint.

Only one dimension changes per document.

## Axis 1 — Reference class

1. Internal entity control.
2. External general entity to the nonce callback.
3. External general entity to `F`, only when the owner supplied it.
4. XInclude to the nonce callback when the parser supports XInclude.

Chained remote definitions, data-bearing callbacks, and entity amplification are excluded.

## Axis 2 — Carrier

- Direct XML request body derived from `X`.
- One approved XML-based upload format derived from its valid minimal file.

Do not cross-product carriers. A positive direct entrypoint does not justify testing every upload processor.

## Axis 3 — Observation point

- An ordinary text node reflected by the application.
- A known asynchronous processing result.
- A nonce-only callback correlated to request or job.

Every observation has a nonexistent host or invalid marker control.

## Axis 4 — Content type

Use the route’s documented XML media type first. One alternate content type is allowed only when the baseline route accepts it and the goal is to identify a parser reached through content negotiation.

## Axis 5 — Parser security state

For white-box or integration tests, compare:

- declarations and external access disabled;
- declarations allowed but external access disabled; and
- the deployed configuration.

The expected secure result is rejection or inert treatment of external references.

## Reduction

After a positive result:

1. return to the smallest valid baseline;
2. keep one external declaration or include;
3. keep one nonce or fixture marker;
4. remove unrelated namespaces and fields; and
5. replay once with a new nonce.

## Stop rules

Stop on the first independently replayed external marker, at eight submissions, on parser instability, or when the valid baseline stops working. Expire callback nonces and delete uploaded evaluator artifacts.
