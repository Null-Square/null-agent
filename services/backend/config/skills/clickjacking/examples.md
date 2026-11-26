# Clickjacking Examples

## Positive

An owner-hosted framing page can visibly align a transparent target control over a benign decoy. A single evaluator click changes the supplied synthetic preference, while the direct-page control shows the same authenticated action. This is proof only when the action is sensitive enough to require framing protection.

## Negative

- The browser blocks framing because `frame-ancestors 'none'` is enforced.
- A page is frameable but contains only public documentation and no authenticated action.
- `X-Frame-Options` is absent, yet CSP blocks every tested owner-controlled framing origin.

## Ambiguous or Blocked

- A nested iframe renders blank because of cookie partitioning; do not infer protection or impact.
- If no evaluator session or harmless state-changing action exists, return `blocked`.

Route cross-origin data-read questions to `cors`.
