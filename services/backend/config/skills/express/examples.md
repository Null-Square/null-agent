# Express Examples

## Express-Aware Cases

- `app.set('trust proxy', true)` is active behind an untrusted edge, and a supplied `X-Forwarded-For` changes an evaluator-only rate-limit key. The direct edge control does not.
- A route mounts before authentication middleware and returns a synthetic private record; the neighboring route after middleware denies the same identity.
- `express.static` serves a named build artifact outside the intended public subtree because the resolved root differs from deployment intent.

## Non-Findings

- Express is disclosed by a response header with no security impact.
- Error middleware returns a stack only under test configuration.
- A dangerous-looking route exists but is never mounted.

Require active middleware order and runtime route evidence. Do not submit shell-like input or modify server configuration.
