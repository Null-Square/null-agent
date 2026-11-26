# Django Specialization Methodology

Use this skill to specialize Django URL/view/middleware, ORM, forms/serializers, templates, CSRF, sessions, host validation, files, admin, cache, and async/task boundaries.

## Preconditions and Fast Applicability

Require confirmed Django evidence/source, deployed settings context, evaluator users/objects, and safe reversible views. Default cap is twenty requests and one evaluator model mutation.

## Surface Discovery and Prioritization

Map URL patterns/resolvers, middleware order, decorators/mixins, DRF permissions/serializers, model/queryset scoping, templates/autoescape, CSRF exemptions, `ALLOWED_HOSTS`/proxy settings, file storage, cache keys, admin registration, and background tasks.

## Safe Test Ladder

1. Trace one URL to view/queryset/serializer/template.
2. Compare allowed/lower evaluator permission and owner/peer object.
3. Test serializer write fields separately from response fields.
4. Replay one reversible form with invalid CSRF token.
5. Compare canonical/unknown evaluator host.
6. Test cache separation with evaluator nonce content.
7. Corroborate exact deployed settings/revision.

## Variation Matrix

| Axis | Variants |
|---|---|
| stack | Django view/form, DRF view/serializer |
| auth | decorator/mixin/permission/queryset |
| data | owner, peer evaluator, nonexistent |
| rendering | template autoescape, explicit safe boundary |
| deployment | middleware/settings/cache/task |

## Proof Standard

Proof requires class-specific runtime behavior plus exact Django route/guard/queryset/serializer/template/settings evidence. Debug/version/admin presence or dangerous-looking source without reachability is not proof.

## False Positives and Benign Lookalikes

- queryset scoping can enforce object access after view permission;
- DRF read/write serializers may differ;
- template autoescape is on by default but context matters;
- proxy settings can rewrite host/scheme;
- cache middleware order changes keys;
- source settings may not be deployed.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without deployed settings/revision, evaluator permissions/data, or safe route. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP replay, repository reads, and framework test client only in an isolated test environment. Generic class skills own payload/proof.

## Handoffs and Duplicate Prevention

Hand authorization, CSRF, host, cache, upload, SSTI/XSS, and ORM injection to primary class skills. Django owns framework reachability/configuration.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty requests, or revision ambiguity. Restore evaluator models/files.

Never perform destructive actions or change production settings.

Research date: 2026-07-23

## Sources

- Django Security Documentation: https://docs.djangoproject.com/en/stable/topics/security/
- Django Deployment Checklist: https://docs.djangoproject.com/en/stable/howto/deployment/checklist/
