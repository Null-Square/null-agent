# Azure Public-Surface and Source Review Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Limit work to public application surfaces, repositories, ARM/Bicep/Terraform, and deployment artifacts. Azure credentials, portal/ARM access, managed-identity tokens, IMDS, tenant enumeration, and control-plane changes are outside B1.

Apply when evidence identifies Blob Storage, Front Door/CDN, App Service, Functions, API Management, Cosmos DB endpoints, Key Vault references, or Microsoft Entra application configuration.

## Surface Discovery and Prioritization

1. Map each public hostname to the observed Azure service without guessing adjacent resources.
2. Review blob container public-access intent, Function auth level, App Service auth configuration, APIM policy placement, and secret-reference handling.
3. Trace Entra client/issuer/redirect settings but leave protocol exploitation to OAuth/JWT owners.
4. Distinguish active Bicep/ARM modules from samples and parameter defaults overridden at deployment.

## Safe Test Ladder

1. Compare anonymous and authorized access on one documented application resource.
2. Use a single named synthetic blob or record; never list a container or account.
3. Test one Function/APIM route with its normal method and a missing-auth control.
4. Correlate runtime response to active source/IaC configuration.
5. Stop at minimal synthetic data/action proof or retain a source-only lead.

Never request managed-identity tokens, access IMDS, use discovered secrets, enumerate tenants/subscriptions, or modify Azure resources.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Blob: exact synthetic blob, nonexistent blob, owner-authenticated blob.
- Function: anonymous, function-key-required behavior, and one normal application route.
- Front Door/CDN: cached public path versus origin authorization control.
- APIM: gateway route versus backend-denied control using the same test identity.
- Entra config: issuer, audience, redirect, PKCE, and consent observations handed off.
- IaC: active module, parameter file, environment override, and sample exclusion.

## Proof Standard

Proof is unauthorized anonymous or cross-user access to a synthetic protected resource/action through the public application surface. Source configuration requires active-deployment and reachability evidence before a runtime finding. A secret-shaped setting or service fingerprint is a lead only.

## False Positives and Benign Lookalikes

1. Blob containers intentionally host public static assets.
2. A Function returns a platform error before invoking application code.
3. Front Door caches a public response but cannot reach private content.
4. Bicep defaults are overridden by secure environment parameters.
5. Entra metadata is public by protocol and does not expose tokens or authorization.

## Missing Prerequisites and Blocked Behavior

Block when public intent, synthetic ownership, active deployment, or application identity cannot be established, or when confirmation requires credentials/portal/ARM/IMDS. State the exact named resource and control required.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP/browser traces, DNS/TLS inventory, repository reads, and retained Trivy/secret-scan artifacts. Azure CLI, Az PowerShell, and credentialed SDK operations are not B1 fallbacks.

## Handoffs and Duplicate Prevention

Route Entra flows to `oauth-oidc`/`jwt-attacks`, storage authorization to `access-control`, caching to `web-cache-security`, and Bicep/Terraform to `iac-container-security`. Keep Azure-specific service interpretation here.

## Stop, Cleanup, and Data Minimization

Use only test blobs/records created through the application, remove them through that same authorized path, and redact tenant ids, SAS query strings, tokens, and connection strings. Stop after one reproducible boundary result.

## Sources

- [Microsoft Azure security documentation](https://learn.microsoft.com/azure/security/fundamentals/overview)
- [Azure Storage security recommendations](https://learn.microsoft.com/azure/storage/blobs/security-recommendations)
