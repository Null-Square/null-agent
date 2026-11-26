# NestJS Examples

## Accepted

- A controller has an authentication guard at class level, but a method decorated with a custom “public” marker unintentionally exposes a synthetic private DTO.
- A global validation pipe uses transformation without whitelisting and an extra server-managed field reaches the disposable persistence object.
- A GraphQL resolver omits the tenant guard used by the corresponding REST controller; evaluator A reads evaluator B's canary.

## Rejected

- Swagger is exposed by design and every operation still enforces guards.
- A guard exists in source but the affected controller is not in the active module graph.
- Exception filters reveal class names without secrets or exploitable state.

Map module import, controller/resolver, guard/interceptor/pipe order, and runtime route. Do not invoke queues, scheduled jobs, or administrative providers.
