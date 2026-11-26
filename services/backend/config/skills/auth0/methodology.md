# Auth0 Specialization Methodology

Use this skill for Auth0 tenant/application/API configuration, Universal Login, Connections, Organizations, Actions, redirect/logout URLs, MFA/attack protection, and issued-token context. OAuth/OIDC/JWT proof stays with protocol owners.

## Preconditions and Fast Applicability

Require an explicitly in-scope Auth0 tenant/client/API, evaluator identities/organization memberships, and owner-approved configuration evidence. Default cap is eight login flows and no management changes outside a disposable evaluator tenant.

## Surface Discovery and Prioritization

Map tenant domain/custom domain, applications/client types, connections, APIs/audiences, redirect/logout/web origins, Organizations, roles/permissions, Actions/hooks, MFA, attack protection, token settings, and logs.

## Safe Test Ladder

1. Capture one normal evaluator login and token audience/issuer hashes.
2. Compare allowed and minimally altered evaluator callback/logout URI.
3. Test organization/connection selection with supplied evaluator memberships.
4. Compare evaluator role/permission at resource server.
5. Observe Action-added claims without altering production Actions.
6. Test MFA/recovery only on evaluator identity.
7. Corroborate tenant/client/API configuration and clean sessions.

## Variation Matrix

| Axis | Variants |
|---|---|
| client | supplied registered evaluator application |
| identity | evaluator A/B, organization memberships |
| binding | redirect/logout/origin, issuer/audience |
| extension | observed Action/Connection |
| assurance | normal, evaluator MFA/recovery |

## Proof Standard

Proof requires class-specific wrong transaction/identity/org/permission outcome tied to exact Auth0 tenant/client/API configuration and resource evidence. Auth0 domain/client ID, metadata, Action code, or public keys are not proof.

## False Positives and Benign Lookalikes

- client IDs/domains are public;
- multiple callbacks can be explicitly registered;
- Auth0 roles do not enforce resource APIs automatically;
- custom claims can be namespaced/filtered;
- organization selection may be optional by design;
- logs/config can lag propagation.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without in-scope tenant/client, evaluator identities/orgs, configuration provenance, or resource-server observation. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP capture, offline token inspection, and read-only tenant configuration supplied by owner. Do not use management credentials for active testing unless disposable and explicit.

## Handoffs and Duplicate Prevention

Hand OAuth/OIDC/JWT/session/auth/access-control primitives to their owners. Auth0 owns tenant/client/connection/org/Action context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, eight flows, or configuration uncertainty. Revoke evaluator sessions/grants.

Never perform destructive actions or change production tenant settings.

Research date: 2026-07-23

## Sources

- Auth0 Security Guidance: https://auth0.com/docs/secure/security-guidance
- Auth0 Organizations: https://auth0.com/docs/manage-users/organizations
