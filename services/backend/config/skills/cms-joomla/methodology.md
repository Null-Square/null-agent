# Joomla Specialization Methodology

Use this skill to map Joomla components, modules, plugins, templates, ACL/assets, form tokens, API/web-service routes, media handling, and administrator/site separation.

## Preconditions and Fast Applicability

Require confirmed Joomla indicators/source, evaluator ACL groups/assets, exact origin, and extension/version provenance. Default cap is thirty requests and one reversible evaluator content action.

## Surface Discovery and Prioritization

Map component tasks/views, administrator and site applications, API routes, ACL actions/assets, form token checks, com_ajax/plugin events, media/files, active templates/extensions, and update/config evidence.

## Safe Test Ladder

1. Capture an ordinary component route and evaluator action.
2. Compare allowed and lower evaluator ACL groups.
3. Remove/change form token while holding ACL constant.
4. Change one evaluator content identifier and nonexistent control.
5. Compare site/admin/API representations.
6. Corroborate active extension and deployed version/source.
7. Hand the primitive to its class owner.

## Variation Matrix

| Axis | Variants |
|---|---|
| application | site, administrator, observed API |
| extension | confirmed component/module/plugin/template |
| ACL | supplied groups and asset scope |
| object | owner, peer evaluator, nonexistent |
| request | route/task, token, documented method |

## Proof Standard

Proof requires class-specific unauthorized behavior on evaluator content tied to Joomla ACL/task/extension evidence. Extension directories, generator metadata, administrator route presence, or missing token without a state change is not proof.

## False Positives and Benign Lookalikes

- installed extensions may be inactive;
- ACL inheritance can intentionally grant an action;
- public component views may expose shared content;
- administrator routes still enforce login;
- version strings may be stale;
- template overrides can change output without changing access.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator ACL roles/content, active-extension provenance, safe action, or deployed version mapping. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP capture and repository/config reads. Do not install Joomla scanners or enumerate users.

## Handoffs and Duplicate Prevention

Hand authorization, CSRF, uploads, and generic injection to primary class skills. Joomla owns platform/extension reachability.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, thirty requests, or ACL/extension ambiguity. Restore evaluator content.

Never perform destructive actions, modify extensions, or touch non-evaluator records.

Research date: 2026-07-23

## Sources

- Joomla Manual, Security: https://manual.joomla.org/docs/security/
- Joomla Manual, Access Control: https://manual.joomla.org/docs/general-concepts/acl/
