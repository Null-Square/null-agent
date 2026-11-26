# GCP Public-Surface and Source Review Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Work only from public application behavior, source, Terraform/deployment descriptors, and existing scan artifacts. Do not use Google Cloud credentials, service-account keys, metadata tokens, `gcloud`, project enumeration, IAM APIs, or control-plane changes.

Apply when evidence identifies Cloud Storage, Cloud CDN/Load Balancing, Cloud Run, Cloud Functions, API Gateway/Endpoints, Identity Platform, Pub/Sub webhooks, or service-account configuration.

## Surface Discovery and Prioritization

1. Map documented public hosts and URLs to observed services; avoid guessing project-wide resource names.
2. Review named bucket/object policy intent, Cloud Run/Function invoker settings, gateway auth configuration, and service-account key handling.
3. Treat Firebase/Firestore behavior as a handoff to the dedicated package.
4. Confirm whether Terraform/deployment YAML is active and which environment overrides apply.

## Safe Test Ladder

1. Capture anonymous and authorized application baselines.
2. Request one evaluator-owned named object or record and a nonexistent control; never list buckets/projects.
3. Exercise one documented Cloud Run/Function route with and without application authentication.
4. Correlate public response and active config without provider APIs.
5. Stop at synthetic disclosure/action proof or retain the configuration as a lead.

Never access metadata, exchange or use service-account keys, invoke IAM, enumerate projects, publish messages, or alter cloud resources.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Storage: named synthetic object, nonexistent object, authorized object.
- Compute: Cloud Run/Function custom domain versus documented service URL.
- Invoker: application-authenticated versus anonymous public request.
- Gateway: one documented API method and a missing-auth control.
- Identity config: issuer/client/audience observations handed to protocol skills.
- Source: active Terraform/deployment descriptor versus example or stale environment.

## Proof Standard

Proof requires unauthorized public or peer access to a synthetic protected resource/action through the application surface, plus controls. IaC or a service-account key in source establishes exposure/configuration evidence, not permission to validate the credential. Provider banners and public OAuth metadata are not findings.

## False Positives and Benign Lookalikes

1. Public website objects are intentionally readable.
2. Cloud Run returns a default platform page without invoking the application.
3. A broad IAM example is not referenced by an active deployment.
4. Cloud CDN serves public cached content while protected paths enforce auth.
5. A service-account JSON sample contains nonfunctional placeholder material.

## Missing Prerequisites and Blocked Behavior

Block when synthetic ownership or deployment linkage is absent, the route requires provider credentials, or confirmation would touch metadata/IAM/another tenant. Document the exact named object, application identity, and deployment record needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser capture, DNS/TLS inventory, repository reads, and existing Trivy/Gitleaks/TruffleHog output. `gcloud` and credentialed client libraries are not allowed in this B1 methodology.

## Handoffs and Duplicate Prevention

Send Firebase rules to `firebase-firestore`, identity flows to `oauth-oidc`/`jwt-attacks`, storage auth to `access-control`, CDN behavior to `web-cache-security`, and Terraform/container descriptors to `iac-container-security`.

## Stop, Cleanup, and Data Minimization

Remove synthetic records through the authorized application path. Retain sanitized config, request/control evidence, and service mapping. Redact project ids when unnecessary, signed URLs, tokens, keys, and personal data.

## Sources

- [Google Cloud security best practices center](https://cloud.google.com/security/best-practices)
- [Cloud Storage access control overview](https://cloud.google.com/storage/docs/access-control)
