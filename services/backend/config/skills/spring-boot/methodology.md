# Spring Boot Specialization Methodology

Use this skill for Spring MVC/WebFlux mappings, filter/security chains, method security, data binding/validation, Jackson, Actuator, error handling, caching, messaging, and deployment profiles.

## Preconditions and Fast Applicability

Require confirmed Spring Boot/source, active profile/build revision, evaluator identities/objects, and a safe route. Default cap is twenty requests and one reversible evaluator mutation.

## Surface Discovery and Prioritization

Map controllers/functional routes, servlet/reactive filter chains, request and method authorization, CSRF, argument resolvers/binders, DTO/Jackson views, repositories, Actuator exposure, errors, caches, async/events/queues, proxy headers, and profiles.

## Safe Test Ladder

1. Trace one route through security chain and method.
2. Compare URL and method-security enforcement with evaluator roles.
3. Test one DTO protected canary field.
4. Replay one reversible request with invalid CSRF token when browser auth applies.
5. Inspect only evaluator-authorized Actuator endpoints.
6. Compare cache response across evaluator identities.
7. Confirm active profile/build.

## Variation Matrix

| Axis | Variants |
|---|---|
| web stack | deployed MVC or WebFlux |
| security | request matcher, method authorization |
| binding | DTO/validator/Jackson view |
| management | configured Actuator surface |
| async | direct, observed event/queue |
| deployment | active profile/proxy/cache |

## Proof Standard

Proof requires class-specific behavior tied to exact mapping/security/binding/profile and runtime evidence. Actuator/version presence, default error shape, annotation appearance, or advisory match is not proof.

## False Positives and Benign Lookalikes

- method security can backstop URL rules;
- multiple security chains have matcher order;
- DTOs can prevent entity mass binding;
- Actuator endpoints may be sanitized/authorized;
- profiles differ by deployment;
- reactive filters have different ordering/commit timing.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without active profile/build, evaluator roles/data, or safe management/async path. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser capture, source/config reads, and isolated MockMvc/WebTestClient corroboration. Generic class skills own proof.

## Handoffs and Duplicate Prevention

Hand access/property/CSRF/deserialization/SSTI/cache/resource/GraphQL to owners. Spring owns security-chain/method/profile context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty requests, or profile uncertainty. Restore evaluator entities.

Never perform destructive actions or change Actuator/profile/security configuration.

Research date: 2026-07-23

## Sources

- Spring Security Authorization: https://docs.spring.io/spring-security/reference/servlet/authorization/
- Spring Security CSRF: https://docs.spring.io/spring-security/reference/features/exploits/csrf.html
- Spring Boot Actuator Endpoints: https://docs.spring.io/spring-boot/reference/actuator/endpoints.html
