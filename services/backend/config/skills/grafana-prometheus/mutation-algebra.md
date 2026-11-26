# Grafana/Prometheus Mutation Algebra

Start with one named synthetic dashboard or metric.

| Component | Variation |
|---|---|
| Grafana identity | anonymous → viewer evaluator → editor control |
| organization | current evaluator org → supplied alternate org |
| dashboard | named private canary → nonexistent uid |
| Prometheus query | exact canary metric only; no wildcard/label discovery |
| datasource proxy | documented path → one harmless supplied restricted path |

No dashboard, alert, user, datasource, rule, target, or query-load changes. Stop after six reads or the first private canary.
