# Mass-Assignment Mutation Algebra

Hold endpoint and evaluator object constant:

| Field class | Variant |
|---|---|
| documented mutable | baseline value |
| server-managed scalar | one harmless boolean/label candidate |
| nested relation | one supplied evaluator-owned relation id |
| alias/casing | only forms accepted by the declared binder |
| media type | one alternate supported binder |
| follow-up | fresh read from authoritative endpoint |

Do not mutate roles, billing, ownership, or real records. Stop after six fields and report only a persisted unauthorized property.
