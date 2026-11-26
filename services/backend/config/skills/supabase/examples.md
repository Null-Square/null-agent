# Supabase Examples

## Proof

- Using only the public anon context, a query for the named evaluator row returns another evaluator's synthetic canary because the active RLS policy compares against a mutable column.
- A storage request reads a supplied private test object through a policy that permits all authenticated users; owner and nonexistent objects are controls.
- A database function exposed through RPC performs a harmless evaluator state change without the expected role predicate.

## Non-Findings

- The project URL and anon key are present in the frontend.
- A permissive migration is superseded by a later active RLS policy.
- Schema names are visible but rows remain denied.

Do not use service-role keys, enumerate tables/buckets, or touch non-synthetic rows. Require project/environment and active policy provenance.
