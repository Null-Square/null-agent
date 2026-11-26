# Drupal Specialization Methodology

Use this skill to map Drupal routes/access checks, entities/fields, forms/tokens, JSON:API/REST, views, files, cache contexts/tags, modules/themes, and multisite boundaries.

## Preconditions and Fast Applicability

Require confirmed Drupal indicators/source, exact site, evaluator roles/entities, and module/core provenance. Default cap: thirty requests and one reversible evaluator entity operation.

## Surface Discovery and Prioritization

Map route requirements/access callbacks, permissions, entity/field access, form tokens, JSON:API/REST resources, views arguments, private/public files, cache contexts/tags, active modules/themes, and multisite settings.

## Safe Test Ladder

1. Capture normal route and cache metadata.
2. Compare one route/entity with allowed and lower evaluator roles.
3. Test field access separately from entity access.
4. Replay one evaluator form/API action with missing/invalid token.
5. Compare cached output across evaluator roles using nonce content.
6. Corroborate route/module/config at the deployed revision.
7. Hand the primitive to its class owner.

## Variation Matrix

| Axis | Variants |
|---|---|
| interface | HTML form, JSON:API/REST, view |
| role | supplied Drupal permissions |
| entity/field | owner, peer evaluator, nonexistent |
| cache | contexts/tags across roles |
| extension | confirmed active module/theme |
| site | exact observed multisite host |

## Proof Standard

Proof requires a class-specific unauthorized evaluator effect/data result or cross-role cache leak, tied to route/access/entity/field/module evidence. Drupal/version/module presence, public JSON:API metadata, or token errors are leads only.

## False Positives and Benign Lookalikes

- entity and field access differ intentionally;
- cache contexts can vary by role/user;
- modules can be installed but disabled;
- views may expose public data by design;
- reverse proxies can obscure Drupal cache metadata;
- vendor patches may retain upstream version strings.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator permissions/entities, active-module provenance, cache isolation, or deployed revision. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP capture and source/config reads; generic class tools provide proof. Do not install Drupal scanners.

## Handoffs and Duplicate Prevention

Hand object/property/function access, cache, uploads, and generic injection to their primary skills. Drupal owns platform reachability/configuration context.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, thirty requests, or cache/extension uncertainty. Restore evaluator entities/config.

Never perform destructive actions, enable modules, or alter non-evaluator content.

Research date: 2026-07-23

## Sources

- Drupal Security Documentation: https://www.drupal.org/docs/develop/security
- Drupal Securing Your Site: https://www.drupal.org/docs/administering-a-drupal-site/security-in-drupal/securing-your-site
