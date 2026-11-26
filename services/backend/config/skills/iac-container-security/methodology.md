# Infrastructure-as-Code and Container Security Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply to in-scope Terraform, CloudFormation, Bicep/ARM, Kubernetes/Helm, Dockerfiles, Compose, image metadata, and retained scanner artifacts. Establish which environment and deployment pipeline consumes the artifact. This package reviews code and artifacts; it does not apply infrastructure, use cloud credentials, start untrusted images, or change registries.

Prioritize misconfiguration with a reachable public workload, excessive runtime privilege, secret material, unsigned/unpinned supply, or a concrete missing boundary. Scanner severity alone is not exploitability.

## Surface Discovery and Prioritization

1. Inventory modules, stacks, workspaces, overlays, values, Docker stages, base images, and deployment references.
2. Resolve variables through the active environment while preserving secret redaction.
3. Map public resources, trust policies, security groups/firewalls, storage exposure, workload identities, mounts/capabilities, and image digests.
4. Correlate Trivy/Semgrep/secret-scan records to the actual built/deployed artifact.
5. Exclude examples, fixtures, vendored code, dead stages, and overridden defaults.

## Safe Test Ladder

1. Reproduce the scanner/config observation offline from the exact source revision.
2. Resolve active variables/overlays without contacting provider control planes.
3. Tie the object to a deployment manifest, build artifact, image digest, or public application route.
4. Use only a synthetic public/application control when runtime confirmation is needed.
5. Stop before applying plans, pulling untrusted mutable images, running containers with privilege, or using credentials.

Never execute `terraform apply`, provider mutations, privileged containers, image install scripts, or credential validation as proof.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Environment resolution: default, tfvars/parameters, CI variables, and final rendered value.
- Module reachability: referenced module versus example/dead module.
- Network exposure: public listener, source range, security group/firewall, and application auth.
- Container privilege: user, capabilities, host namespaces, mounts, seccomp, read-only root.
- Image provenance: digest pin, mutable tag, registry, signature/attestation, and deployed digest.
- Secret handling: literal, build arg, environment reference, secret mount, and placeholder.

## Proof Standard

Proof requires exact active source/artifact, resolved insecure value, deployment/reachability evidence, and the concrete affected boundary. A scanner row without file/line, variable resolution, active use, or compensating-control review is a lead. Runtime public exposure may be proven only with synthetic application data/actions.

## False Positives and Benign Lookalikes

1. A risky default is securely overridden in the deployed environment.
2. The flagged Docker stage is not part of the final image.
3. A mutable tag resolves to an approved pinned digest in deployment.
4. A secret-shaped string is a documented placeholder or test fixture.
5. A broad rule is constrained by an upstream identity-aware proxy or private network boundary established by evidence.
6. The vulnerable package exists in a non-runtime layer or is unreachable.

## Missing Prerequisites and Blocked Behavior

Block when variable resolution, artifact digest, active deployment, or public mapping is unavailable. Do not fill the gap with provider credentials or deployment actions. Record the exact plan output, rendered manifest, SBOM, or environment binding needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `tooling-trivy`, `tooling-semgrep`, `tooling-gitleaks`, `tooling-trufflehog`, repository reads, and offline parsers. Preserve machine-readable scanner output. Provider CLIs, Terraform apply, Docker privileged runs, and registry credential use are excluded.

## Handoffs and Duplicate Prevention

Cloud-service semantics belong to `cloud-aws`, `cloud-azure`, or `cloud-gcp`; Kubernetes runtime posture belongs to `kubernetes-security`; dependency provenance belongs to `software-supply-chain`; source reachability belongs to `source-aware-whitebox`. This package owns cross-format IaC/container resolution.

## Stop, Cleanup, and Data Minimization

Delete only temporary local rendered output, never repository or infrastructure state. Retain sanitized excerpts, variable provenance, artifact/image digests, scan record ids, and deployment references. Redact secrets and private topology.

## Sources

- [OWASP Infrastructure as Code Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Infrastructure_as_Code_Security_Cheat_Sheet.html)
- [NIST SP 800-190 Application Container Security Guide](https://csrc.nist.gov/publications/detail/sp/800-190/final)
