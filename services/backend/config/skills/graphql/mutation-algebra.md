# GraphQL Mutation Algebra

| GraphQL dimension | Bounded mutation |
|---|---|
| operation | one named query/mutation from supplied schema or traffic |
| identity | evaluator A → evaluator B → no session |
| node | owned global id → peer synthetic id → nonexistent id |
| field | documented public field → one private canary field |
| transport | POST JSON → persisted operation if already observed |
| shape | aliases/fragments only to confirm the same resolver decision |

Depth stays at five and aliases at three; no batching or introspection when disabled. Reduce proof to operation, resolver/field, identity, and canary.
