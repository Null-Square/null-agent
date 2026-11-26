# AWS Public-Surface and Source Review Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

This B1 package is limited to repositories, IaC, deployment artifacts, and publicly reachable AWS-backed application surfaces. It does not authorize AWS credentials, console/API control-plane access, role assumption, instance metadata access, or use of discovered keys.

Apply when DNS, headers, URLs, source, or manifests identify S3, CloudFront, API Gateway, Lambda URLs, Cognito, AppSync, or Elastic Load Balancing. A provider fingerprint or policy text is inventory until an externally observable boundary is proven.

## Surface Discovery and Prioritization

1. Map public hostnames to the AWS service and retain region/account identifiers only when already disclosed.
2. Review S3 bucket policies/ACL intent, CloudFront origin controls, API Gateway authorizers, Lambda URL auth type, Cognito client configuration, and secret references.
3. Separate deployable templates from examples, tests, and inactive modules.
4. Prioritize public data or actions reachable without credentials and configuration paths that make that exposure plausible.

## Safe Test Ladder

1. Capture anonymous and authenticated baselines from the documented public application route.
2. For storage, request only a named evaluator-owned object or harmless known test prefix; do not enumerate a bucket.
3. For APIs/functions, compare one public route with an authenticated control and a nonexistent resource.
4. Correlate observed behavior to active IaC or runtime headers without invoking provider APIs.
5. Stop at minimal synthetic disclosure/action proof or a configuration-only lead.

Never query metadata endpoints, use AWS credentials, assume roles, list accounts, modify policies, upload public objects, or test cross-service exploit chains.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Storage: named object, nonexistent object, authenticated owner object; no bucket listing.
- Distribution: CloudFront cached response versus origin-denied control.
- API: execute-api route, custom domain, stage prefix, and one supported method.
- Function URL: `AWS_IAM` versus `NONE` behavior inferred from public response and source config.
- Identity config: Cognito issuer/client/redirect settings handed to OAuth/JWT owners.
- Source: active Terraform/CloudFormation/CDK module versus example or unused stack.

## Proof Standard

Runtime proof is anonymous access to non-public synthetic data or an unauthorized test action through a public AWS-backed route, with a matched owner/nonexistent control. A permissive IaC policy is a source lead until deployment/reachability is established. A leaked key is evidence of secret exposure, never permission to use it.

## False Positives and Benign Lookalikes

1. Intentionally public website assets or documentation objects.
2. CloudFront serves cached public content while the private origin remains protected.
3. A template contains a wildcard in an unused example or constrained resource policy.
4. API Gateway returns a service banner or default `403` without reaching an application route.
5. A credential-shaped string is a placeholder, revoked test value, or scanner false match.

## Missing Prerequisites and Blocked Behavior

Block when object ownership/public intent cannot be determined, active deployment cannot be tied to source, or confirmation would require AWS credentials, metadata, listing, writes, or another tenant's data. Record the exact named synthetic object or deployment evidence needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/DNS evidence, browser capture, repository reads, and IaC/scanner artifacts. `tooling-trivy`, `tooling-gitleaks`, and `tooling-trufflehog` provide leads. Do not use AWS CLI or SDK credential flows in B1.

## Handoffs and Duplicate Prevention

Send Cognito/OIDC behavior to `oauth-oidc` and `jwt-attacks`, S3-like application authorization to `access-control`, CDN behavior to `web-cache-security`, and templates to `iac-container-security`. This package owns AWS service interpretation and the locked public/source boundary.

## Stop, Cleanup, and Data Minimization

Stop after one named synthetic proof, remove no provider resources, and retain only sanitized HTTP records, active config fragments, and hashes. Redact account ids, signed URLs, tokens, and secret material beyond the minimum identifier.

## Sources

- [AWS S3 security best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
