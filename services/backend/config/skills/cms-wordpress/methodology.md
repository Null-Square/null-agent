# WordPress Specialization Methodology

Use this skill to map WordPress core, REST/AJAX/XML-RPC surfaces, roles/capabilities, nonces, plugins/themes, uploads, and multisite boundaries. Class-specific proof remains with the owning vulnerability skill.

## Preconditions and Fast Applicability

Require multiple WordPress indicators or source/config, exact origin, evaluator users/roles, and plugin/theme inventory provenance. Default cap is thirty read-only requests and one reversible evaluator post/setting action.

## Surface Discovery and Prioritization

Map core version confidence, REST namespaces/routes, admin-AJAX actions, XML-RPC policy, roles/capabilities, nonces, multisite/blog IDs, upload paths, active plugins/themes, and custom code.

## Safe Test Ladder

1. Capture generator/assets/REST index without version conclusions.
2. Enumerate observed REST namespaces and evaluator-visible routes.
3. Compare one action with allowed/lower evaluator roles.
4. Remove/change its nonce while preserving capability controls.
5. Test evaluator object ownership and one reversible setting/post.
6. Corroborate affected plugin/theme code/version from artifacts.
7. Hand the primitive to its class owner.

## Variation Matrix

| Axis | Variants |
|---|---|
| interface | REST, admin-AJAX, ordinary admin, XML-RPC when enabled |
| role | supplied capability roles |
| object | evaluator-owned, peer evaluator, nonexistent |
| extension | confirmed active plugin/theme |
| deployment | single-site, observed multisite |

## Proof Standard

Proof requires runtime behavior meeting a class owner’s proof floor plus exact WordPress route/action, role/capability, extension/core provenance, and evaluator controls. Version/plugin presence or a valid nonce without capability bypass is not proof.

## False Positives and Benign Lookalikes

- asset versions are cacheable/spoofable;
- installed extensions may be inactive;
- nonces are not authorization;
- REST discovery can be public by design;
- multisite roles differ by blog/network;
- advisories may not match patched vendor builds.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without active-extension/version provenance, evaluator roles, safe object/action, or source/runtime mapping. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP inventory and repository reads. No new WP-specific binary is installed in B1. Use generic class/tooling skills for proof.

## Handoffs and Duplicate Prevention

Hand REST/API auth to generic owners, uploads to `insecure-file-uploads`, code/supply chain to their skills, and final proof to `validation`.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific class proof, thirty requests, or extension ambiguity. Restore evaluator content/settings.

Never perform destructive actions, modify plugins/themes, or enumerate real users.

Research date: 2026-07-23

## Sources

- WordPress Security APIs: https://developer.wordpress.org/apis/security/
- WordPress Nonces: https://developer.wordpress.org/apis/security/nonces/
- WordPress Roles and Capabilities: https://developer.wordpress.org/apis/security/user-roles-and-capabilities/
