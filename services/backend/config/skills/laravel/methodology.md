# Laravel Specialization Methodology

Use this skill for Laravel routes/middleware, gates/policies, Eloquent scopes and mass assignment, validation/resources, Blade, CSRF/sessions, signed URLs, files, queues/events, caches, and trusted proxies/hosts.

## Preconditions and Fast Applicability

Require confirmed Laravel/source, deployed config/revision, evaluator users/models, and safe route/job. Default cap is twenty requests and one reversible evaluator model mutation.

## Surface Discovery and Prioritization

Map route groups/middleware, gates/policies, controller/form requests, Eloquent queries/scopes and fillable/guarded fields, API resources, Blade escaping, Sanctum/Passport/session state, signed URLs, disks/files, queues/events, cache, debug/config, proxies/hosts.

## Safe Test Ladder

1. Trace one route through middleware/policy/model/resource.
2. Compare evaluator roles and owner/peer model.
3. Add one protected canary attribute.
4. Test one signed evaluator URL after altering one parameter.
5. Replay one safe form with invalid CSRF token.
6. Correlate one evaluator queue job.
7. Verify deployed config/revision.

## Variation Matrix

| Axis | Variants |
|---|---|
| auth | middleware, gate/policy, model scope |
| binding | form request, Eloquent canary field |
| output | API resource, Blade |
| state | session/token/signed URL |
| storage | evaluator disk/file |
| async | direct, queue/event |

## Proof Standard

Proof requires class-specific runtime behavior tied to exact route/policy/model/resource/config. Debug/version presence, writable-looking model property, Blade syntax, or source appearance is not proof.

## False Positives and Benign Lookalikes

- policies may be invoked in service code;
- global scopes can enforce tenancy;
- API resources can filter fields;
- guarded/fillable behavior depends on binding path;
- signed URLs can intentionally ignore selected parameters;
- queue acceptance can later reject.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without deployed config/revision, evaluator models/roles, safe signed URL/file/job, or final state. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser replay and source/config reads; isolated feature tests corroborate. Generic class skills own proof.

## Handoffs and Duplicate Prevention

Hand auth/property/CSRF/SSTI/files/queues/cache to primary skills. Laravel owns framework policy/model/config context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty requests, or config uncertainty. Delete evaluator models/files/jobs.

Never perform destructive actions or alter production config/queues.

Research date: 2026-07-23

## Sources

- Laravel Authorization: https://laravel.com/docs/authorization
- Laravel Eloquent Mass Assignment: https://laravel.com/docs/eloquent#mass-assignment
- Laravel CSRF Protection: https://laravel.com/docs/csrf
