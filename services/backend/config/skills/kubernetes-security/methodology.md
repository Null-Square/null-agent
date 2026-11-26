# Kubernetes Public-Surface and Manifest Review Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply to Kubernetes manifests, Helm/Kustomize output, container deployment descriptors, and publicly exposed application or management surfaces already in scope. B1 does not authorize cluster credentials, `kubectl`, service-account token use, API enumeration, exec, port-forwarding, secret reads, or control-plane changes.

Record the workload, namespace if disclosed, ingress/service path, identity boundary, and whether the reviewed manifest is rendered and deployed. A Kubernetes banner or risky YAML line is not runtime proof.

## Surface Discovery and Prioritization

1. Trace public hosts through Ingress/Gateway/Service to the named workload using source and existing inventory.
2. Review workload security context, host namespaces, privileged mode, capabilities, mounts, service-account selection, automount, and image provenance.
3. Review NetworkPolicy and RBAC bindings as source controls, without using credentials.
4. Distinguish rendered Helm/Kustomize output from chart defaults and environment-specific values.
5. Prioritize public dashboards/APIs and application paths whose config exposes a concrete unauthorized capability.

## Safe Test Ladder

1. Validate one public route with anonymous and authorized application controls.
2. Correlate the route to rendered manifests and the active workload.
3. Demonstrate only a synthetic application-level data/action boundary; do not cross into pods or the Kubernetes API.
4. For source-only workload weaknesses, establish deployability, reachability, and the missing compensating control.
5. Stop before token use, API discovery, workload execution, or secret access.

Never use discovered kubeconfigs or service-account tokens, contact internal cluster addresses, create workloads, exec into containers, or alter policies.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Rendered source: base manifest, overlay, Helm values, and final generated object.
- Exposure: ClusterIP intent, NodePort/LoadBalancer, Ingress/Gateway, and public route.
- Workload identity: default versus named service account; automount true/false.
- Pod isolation: privileged, host PID/network/IPC, capabilities, seccomp, read-only root, volume mounts.
- Authorization source: namespaced RoleBinding versus ClusterRoleBinding and exact subject.
- Image: immutable digest, mutable tag, registry trust, and scanner finding reachability.

## Proof Standard

Runtime proof is a public unauthorized application effect tied to the Kubernetes deployment. Manifest findings require active rendered configuration, reachable workload, exact privilege/exposure, and absence of a compensating control; they must be labeled source/config evidence rather than credentialed cluster validation.

## False Positives and Benign Lookalikes

1. Helm chart defaults are overridden by secure production values.
2. A privileged init container is absent from the rendered deployment.
3. A broad ClusterRole is not bound to the workload's service account.
4. A dashboard hostname is public but enforces the approved identity proxy.
5. Scanner findings belong to an image not deployed by the reviewed workload.

## Missing Prerequisites and Blocked Behavior

Block when rendered manifests or deployment linkage are missing, the only verification needs cluster credentials, or a public route cannot be tied to the workload. State which rendered object, binding, or application control would resolve the lead.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use repository reads, rendered manifest artifacts, `tooling-trivy` results, HTTP/browser evidence, and offline YAML analysis. Kubernetes clients and credentialed API tools are not B1 fallbacks.

## Handoffs and Duplicate Prevention

Send container/IaC policy to `iac-container-security`, source dataflows to `source-aware-whitebox`, public app authorization to the relevant vulnerability owner, and final disposition to `validation`. Do not duplicate raw Trivy findings without deployment reachability.

## Stop, Cleanup, and Data Minimization

No cluster resource should be created or changed. Retain the minimal rendered YAML excerpts, image digest, route mapping, and application controls; redact tokens, secrets, internal addresses, and unrelated environment data.

## Sources

- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)
