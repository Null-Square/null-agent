# NestJS Mutation Algebra

| Nest construct | Comparison |
|---|---|
| module graph | active imported controller/resolver only |
| guard | global → controller → method metadata override |
| interceptor/pipe | effective order and transformed DTO |
| identity | evaluator A → evaluator B → anonymous |
| transport | REST → GraphQL only when the same service exposes both |
| DTO | documented field → one server-managed extra |

Trace decorator metadata through runtime behavior. Do not invoke providers, jobs, or administrative modules directly.
