# CORS Decision Examples

## Proof

- From an owner-controlled origin, an evaluator browser reads a response containing a synthetic private canary because the server reflects that origin and allows credentials. The same request without the evaluator session returns no canary.
- A credentialed API whitelists an attacker-suffix origin such as `https://app.example.test.owner.invalid`; browser capture confirms readable private data.

## Not Proof

- `Access-Control-Allow-Origin: *` is present on a public, unauthenticated status response.
- A response reflects `Origin`, but credentials are disabled and the body contains no non-public data.
- A preflight succeeds while the actual response omits the allow-origin header.

Opaque browser failures are `ambiguous`. Without an owner-controlled test origin and evaluator data, credentialed-read confirmation is `blocked`.
