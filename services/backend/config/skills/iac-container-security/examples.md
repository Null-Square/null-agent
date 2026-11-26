# IaC and Container Examples

## Resolved public database rule

Active Terraform resolves a database ingress source to `0.0.0.0/0`, deployment records reference the module, and no identity proxy applies. Runtime connection testing would require credentials and is unnecessary. Expected disposition: configuration proof with exact resolved source.

## Overridden default

A module default allows public storage, but production tfvars and the retained plan resolve public access false. Named application objects also reject anonymous reads. Expected disposition: reject.

## Non-final image stage

Trivy finds a critical package only in a build stage. The final SBOM and image digest omit it. Expected disposition: reject runtime exploitability while retaining build-stage hygiene if relevant.

## Mutable tag

Deployment uses `app:latest`, but the admission record pins the approved digest and rejects tag drift. Expected disposition: control evidence, not an unpinned-deployment finding.

## Secret literal

A real-looking token appears in active Terraform. Preserve a redacted hash and source provenance; never use it. Secret validity/rotation is handled separately.
