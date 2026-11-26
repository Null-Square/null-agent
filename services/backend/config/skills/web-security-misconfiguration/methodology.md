# Web Security Misconfiguration Methodology

Use this method to validate deployment-wide security control gaps: unsafe debug modes, directory listing, dangerous methods, default content, security headers, permissive error handling, and inconsistent proxy/application policy. Technology banners alone are inventory.

## Preconditions and Fast Applicability

Require an in-scope origin, normal baseline, deployment context, and documented expectation where configuration is policy-dependent. Default cap is thirty read-only requests and no configuration changes.

## Surface Discovery and Prioritization

Map response/security headers, allowed methods, debug/error routes, directory behavior, default/sample applications, admin consoles, proxy normalization, TLS redirect/HSTS context, and framework environment indicators.

## Safe Test Ladder

1. Capture normal HTTP/TLS responses.
2. Compare root, one known file, and one nonexistent path.
3. Request one known directory path with/without trailing slash.
4. Use `OPTIONS` and one harmless unsupported method.
5. Trigger one syntax-neutral validation error.
6. Compare anonymous/evaluator behavior on a documented diagnostic route.
7. Corroborate with source/deployment config when available.

## Variation Matrix

| Axis | Variants |
|---|---|
| route | root, known, nonexistent, observed diagnostic |
| method | normal, OPTIONS, one harmless unsupported |
| layer | HTTP redirect, TLS origin, proxy, app |
| identity | anonymous, evaluator |
| evidence | runtime response, source/config |

## Proof Standard

Proof requires objective exposure or control failure: directory contents, sensitive debug data, unsafe method effect on evaluator data, accessible management function, or missing/misapplied defense with demonstrated context. Header absence, version presence, or a generic error is not automatically a finding.

## False Positives and Benign Lookalikes

- headers may be enforced by another layer;
- `OPTIONS` can advertise methods the route denies;
- public documentation/sample content may be intended;
- SPA shells mimic directory/default pages;
- development names can exist in production-safe builds;
- redirects can obscure the final TLS policy.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when expected policy, final origin, identity, or configuration layer cannot be established. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload`, browser capture, TLS tooling, and read-only configuration review. Do not run generic vulnerability templates as proof.

## Handoffs and Duplicate Prevention

Hand TLS to `tooling-tls`, CORS/CSP framing to their specific skills, disclosure to `information-disclosure`, and access controls to their owners.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced configuration effect, thirty requests, or layer ambiguity. Retain minimal headers/config excerpts.

Never perform destructive actions or alter server configuration.

Research date: 2026-07-23

## Sources

- OWASP WSTG, Configuration and Deployment Management Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/
- OWASP Secure Headers Project: https://owasp.org/www-project-secure-headers/
