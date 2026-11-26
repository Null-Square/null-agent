# SPA Reconnaissance Examples

## Useful Inventory

- A route chunk and router table both identify `/billing/export`; a normal evaluator navigation confirms the route and its API dependency.
- A source map links a minified fetch call to `/api/orgs/:orgId/members`; record parameter origin and authentication state, then hand authorization testing to `idor`.
- Runtime network capture shows an API base URL absent from the initial bundle because it is loaded from environment configuration.

## Do Not Elevate

- An endpoint-like string belongs to a test fixture or dead chunk.
- A feature flag name exists without evidence it is enabled.
- A client bundle contains a public analytics key.

Recon output is a deduplicated inventory with provenance, not a vulnerability. Do not invoke hidden state-changing operations during discovery.
