# Firebase and Firestore Specialization Methodology

Use this skill for Firebase Auth, Firestore/Realtime Database/Storage Rules, App Check context, callable/HTTP Functions, custom claims, and emulator-backed rule validation.

## Preconditions and Fast Applicability

Require a project explicitly in scope, evaluator users/documents/objects, deployed rules/source when available, and preferably the Local Emulator Suite. Admin SDK/service account paths are excluded from client-rule conclusions.

Default cap: twenty client operations and one reversible evaluator document/object.

## Surface Discovery and Prioritization

Map project IDs/endpoints, auth providers/custom claims, Firestore collections/rules, Realtime Database paths/rules, Storage buckets/rules, Functions, App Check enforcement, indexes/query constraints, and emulator/deployed rule versions.

## Safe Test Ladder

1. Read/write owner evaluator fixture as authenticated client.
2. Compare peer evaluator and unauthenticated clients.
3. Test one protected canary field/query shape.
4. Repeat for one observed Storage/Realtime path.
5. Invoke one evaluator-safe callable Function.
6. Run the same matrix in emulator with rule coverage when source exists.
7. Confirm deployed rule version and cleanup.

## Variation Matrix

| Axis | Variants |
|---|---|
| identity | unauthenticated, evaluator A/B, supplied custom claim |
| service | Firestore, RTDB, Storage, Function |
| operation | read/query/create/update/delete on fixture |
| data | owner, peer evaluator, nonexistent |
| environment | deployed client path, emulator corroboration |

## Proof Standard

Proof requires a client SDK/REST path to perform unauthorized evaluator data/action under deployed rules, with auth context and controls. Public API keys/project IDs, emulator-only failure, Admin SDK access, or rule source appearance is not proof.

## False Positives and Benign Lookalikes

- Admin SDK bypasses rules;
- query rules are not filters and may reject broad queries safely;
- App Check and Auth are distinct;
- custom claims can be stale until token refresh;
- emulator rules can differ from deployed;
- public configuration is expected in clients.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator users/data, deployed rule provenance, client path, or cleanup. Never use production service accounts. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use client SDK/REST with evaluator tokens, browser capture, and Firebase Emulator rule tests/coverage. Generic class skills own final primitive.

## Handoffs and Duplicate Prevention

Hand auth/JWT/object/property/storage/function issues to owners. Firebase owns rule/service/client-versus-admin context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty operations, or rule-version uncertainty. Delete fixtures and revoke sessions.

Never perform destructive actions or access non-evaluator documents.

Research date: 2026-07-23

## Sources

- Firestore Security Rules: https://firebase.google.com/docs/firestore/security/get-started
- Test Rules with Emulator: https://firebase.google.com/docs/firestore/security/test-rules-emulator
