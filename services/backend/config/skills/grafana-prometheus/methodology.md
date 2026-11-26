# Grafana and Prometheus Specialization Methodology

Use this skill for Grafana organizations/folders/dashboards/data sources/service accounts/snapshots/provisioning/plugins and Prometheus query/targets/config exposure. Testing is read-only unless a disposable evaluator dashboard/folder is supplied.

## Preconditions and Fast Applicability

Require confirmed Grafana/Prometheus origin, evaluator Grafana roles/orgs/folders, safe dashboard/data source, and deployment type (OSS/Enterprise/Cloud). Default cap is twenty queries/requests and one reversible evaluator dashboard edit.

## Surface Discovery and Prioritization

Map Grafana org/server roles, folder/dashboard permissions, data-source query permissions, service accounts/tokens, snapshots/sharing, annotations/alerts, proxy routes, plugins/provisioning, and Prometheus query/targets/status/config exposure.

## Safe Test Ladder

1. Capture evaluator viewer/editor/admin controls.
2. Compare one folder/dashboard across evaluator roles/orgs.
3. Test one harmless dashboard edit and restore it.
4. Query one evaluator-safe metric/data source.
5. Test snapshot/share visibility with evaluator data.
6. Observe Prometheus metadata/query endpoints read-only.
7. Corroborate edition/config/version provenance.

## Variation Matrix

| Axis | Variants |
|---|---|
| role | viewer, editor, org admin, supplied server/RBAC role |
| scope | organization, folder, dashboard, data source |
| artifact | dashboard, snapshot, annotation, alert |
| backend | Grafana API/proxy, Prometheus query/status |
| deployment | OSS, Enterprise, Cloud as observed |

## Proof Standard

Proof requires unauthorized evaluator dashboard/folder/data-source/metric/config access or modification with role/org controls and exact deployment behavior. Login page, version, public dashboard, or Prometheus liveness alone is not proof.

## False Positives and Benign Lookalikes

- Viewer may query organization data sources by documented policy;
- server admin differs from org admin;
- folder inheritance changes dashboard access;
- public/snapshot sharing can be intentional;
- Grafana Cloud differs from OSS;
- proxy/cache responses can obscure backend authorization.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator roles/orgs, safe data source/dashboard, deployment edition/config, or cleanup. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP APIs and read-only Prometheus queries/config review. Do not execute plugin code or broad metric collection.

## Handoffs and Duplicate Prevention

Hand generic auth/IDOR/access control, SSRF via data sources, secrets, and plugin supply-chain issues to owners. This skill owns Grafana/Prometheus scope semantics.

## Stop, Cleanup, and Data Minimization

Stop at one platform-specific proof, twenty operations, or role/edition uncertainty. Restore/delete evaluator dashboards/snapshots/tokens.

Never perform destructive actions, query unrelated metrics, or alter alerting/data sources.

Research date: 2026-07-23

## Sources

- Grafana Roles and Permissions: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/
- Prometheus Security Model: https://prometheus.io/docs/operating/security/
