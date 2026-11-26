# Rails Specialization Methodology

Use this skill for Rails routes/controllers, before-actions and policy layers, Active Record scoping/strong parameters, serializers/views, CSRF/sessions/signed/encrypted data, Active Storage, caching, Active Job, Action Cable, and deployment credentials/config.

## Preconditions and Fast Applicability

Require confirmed Rails/source, deployed environment/revision, evaluator users/records, and safe action. Default cap is twenty requests/messages and one reversible evaluator record mutation.

## Surface Discovery and Prioritization

Map routes/controllers, authentication/before-actions, policy/scopes, strong parameters, Active Record queries, serializers/views, CSRF/session/cookies, signed IDs, Active Storage, cache keys, Active Job/mail, Action Cable, admin routes, and environment config.

## Safe Test Ladder

1. Trace one route through filters/policy/scope/params.
2. Compare evaluator roles and owner/peer records.
3. Add one protected canary parameter.
4. Alter one evaluator signed identifier.
5. Replay one safe form with invalid authenticity token.
6. Compare cache or cable channel across evaluator identities.
7. Correlate one evaluator job and deployed revision.

## Variation Matrix

| Axis | Variants |
|---|---|
| auth | before-action, policy, scope |
| binding | strong params, nested canary |
| state | session, signed/encrypted identifier |
| output | serializer/view |
| storage | evaluator attachment |
| async | job/mail/cable observed path |

## Proof Standard

Proof requires class-specific runtime behavior tied to exact Rails route/filter/policy/scope/params/config. Route presence, framework version, unsafe-looking query source, or missing UI control is not proof.

## False Positives and Benign Lookalikes

- policy scopes can enforce access after controller auth;
- strong params may be applied in service/form objects;
- signed IDs can have intended purposes/expiry;
- cached fragments can vary by key not visible in view;
- jobs can reject later;
- Turbo requests preserve CSRF via metadata.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without deployed environment/revision, evaluator records/roles, safe signed artifact/job/channel, or final state. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP/cable capture, source/config reads, and isolated Rails request/system tests for corroboration. Generic class skills own proof.

## Handoffs and Duplicate Prevention

Hand authorization/property/CSRF/SQLi/XSS/files/cache/real-time to owners. Rails owns route/filter/policy/parameter/config context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty interactions, or environment uncertainty. Remove evaluator records/attachments/jobs.

Never perform destructive actions or access production credentials.

Research date: 2026-07-23

## Sources

- Rails Security Guide: https://guides.rubyonrails.org/security.html
- Rails Action Controller Overview: https://guides.rubyonrails.org/action_controller_overview.html
