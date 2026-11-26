# API Enumeration Mutation Algebra

Enumeration mutates evidence sources, not arbitrary paths.

| Dimension | Bounded sequence |
|---|---|
| specification | supplied OpenAPI → linked docs → observed traffic |
| namespace | current version → one adjacent version named in evidence |
| operation | read-only → disposable write only if explicitly approved |
| parameter source | path template → query schema → request model |

Merge equivalent operations by method, normalized path, auth context, and content type. Cap speculative route confirmation at five evidence-backed candidates and stop on repeated `404/405`.
