# Kubernetes Security Mutation Algebra

| Axis | Compare | Required invariant |
|---|---|---|
| Rendering | chart/base versus final overlay | same workload and environment |
| Identity | default versus named service account | exact binding subjects |
| Privilege | baseline securityContext versus one risky field | no cluster execution |
| Exposure | service type versus ingress/gateway route | same application backend |
| Image | tag versus resolved digest | deployed workload reference |
| Policy | selected pod labels versus NetworkPolicy selector | offline manifest analysis |

Mutations are source/render comparisons, not API changes. Never apply a manifest to test a hypothesis.
