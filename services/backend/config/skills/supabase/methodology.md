# Supabase Specialization Methodology

Use this skill for Supabase Auth/JWT-to-Postgres context, Row Level Security, PostgREST/RPC, Storage policies, Realtime channels, Edge Functions, and key/role separation.

## Preconditions and Fast Applicability

Require confirmed project endpoints, evaluator users/rows/buckets, anon/publishable client configuration, and no service-role key use in dynamic tests. Default cap: twenty operations and one reversible evaluator row/object.

## Surface Discovery and Prioritization

Map exposed schemas/tables/views/functions, RLS enablement/policies, `auth.uid()`/JWT claims, PostgREST roles, RPC security, Storage buckets/policies, Realtime subscriptions, Edge Functions, Auth redirect/session flow, and client versus service keys.

## Safe Test Ladder

1. Query owner evaluator row with normal client credentials.
2. Compare peer evaluator and anonymous reads/writes.
3. Test one protected canary column.
4. Compare PostgREST table/view/RPC paths.
5. Test one evaluator Storage object.
6. Subscribe to owner/peer evaluator Realtime channel.
7. Corroborate RLS/policy/config from source/migrations.

## Variation Matrix

| Axis | Variants |
|---|---|
| role | anon, authenticated evaluator A/B |
| resource | table/view/RPC, storage, realtime, function |
| operation | select/insert/update/delete on evaluator fixture |
| claim | supplied evaluator auth/JWT context |
| policy | RLS enabled/policy path |

## Proof Standard

Proof requires unauthorized evaluator row/field/object/event/action with client-role context and owner/peer/nonexistent controls, tied to RLS/storage/realtime/function evidence. Public project URL/anon key, schema names, or absent RLS without exposed grants is not proof.

## False Positives and Benign Lookalikes

- anon keys are intended public identifiers;
- server clients can bypass RLS by design;
- views/functions may use separate security semantics;
- Storage metadata and object access differ;
- Realtime filters may be client-side unless policies apply;
- stale JWT claims can require refresh.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator users/data, policy/migration context, safe cleanup, or client-role path. Never use service credentials to simulate a client. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser/client SDK calls with evaluator credentials and repository migration/policy reads. Generic class skills own proof.

## Handoffs and Duplicate Prevention

Hand auth/JWT/object/property/function/storage/realtime/Edge Function primitives to owners. Supabase owns platform policy/key context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty operations, or role ambiguity. Delete evaluator rows/objects and revoke sessions.

Never perform destructive actions or expose service-role keys.

Research date: 2026-07-23

## Sources

- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Auth: https://supabase.com/docs/guides/auth
