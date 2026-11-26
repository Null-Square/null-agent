# Supabase Mutation Algebra

| Layer | Safe variants |
|---|---|
| role | anon → evaluator authenticated → second evaluator |
| PostgREST row | owned canary key → peer synthetic key → nonexistent |
| RLS | active policy predicate with request/session variables |
| RPC | one supplied harmless function and disposable argument |
| storage | named owned object → named private synthetic object |
| realtime | one evaluator channel/event only |

Never use service-role keys, enumerate schema/rows/buckets, or alter policies. Stop at a named canary and retain active migration/deployment provenance.
