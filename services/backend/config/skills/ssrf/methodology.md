# Server-Side Request Forgery Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use when a public in-scope application accepts a URL/host/resource reference for import, preview, webhook test, image/PDF fetch, feed, proxy, or integration. B1 proof is limited to evaluator-controlled public callback infrastructure and synthetic content. Internal services, cloud metadata, credentials, and private-address probing are outside the locked boundary.

Define whether the request is expected from the server, browser, security scanner, or integration provider. A URL field or DNS lookup alone does not prove SSRF.

## Surface Discovery and Prioritization

1. Map URL inputs, redirects, scheme/host validation, DNS resolution, and asynchronous jobs.
2. Create a fresh single-use callback token for each candidate and a separate unsubmitted control token.
3. Capture browser traffic so client-side fetches can be excluded.
4. Record expected third-party reputation/resolver services and target egress identifiers when already known.

## Safe Test Ladder

1. Submit a public evaluator-controlled HTTPS URL returning a unique inert marker.
2. Correlate callback token, application job id, timestamps, source, method, and path.
3. Pair with a nonexistent path and an unsubmitted token.
4. Test one evaluator-controlled redirect only when redirect behavior is the hypothesis.
5. Repeat once with a fresh token. Stop at attributed HTTP proof.

Do not request loopback, RFC1918/link-local ranges, metadata services, file schemes, credentials, or uncontrolled callback destinations. Use concurrency 1 and at most six candidates per endpoint.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Filter-Bypass Techniques — To Reach The Evaluator Callback

When a plain evaluator URL is blocked, the hypothesis is *the URL validator is bypassable*, and the proof is still a callback to **your own OOB host**. Point every bypass form below at the evaluator OOB host, never at an internal or metadata address. Escalate one form at a time and stop at the first attributed callback.

- **Scheme/host shape:** `https://token.OOB_HOST/` then DNS-only `token.OOB_HOST` when HTTP egress is filtered but DNS resolves.
- **Alternate host encodings of the OOB host** (prove the validator normalises inconsistently): decimal, octal, hex, short-form, IPv6, and IPv4-mapped IPv6 forms of the OOB host's address.
- **Parser confusion (validator vs. fetcher disagree):** `https://OOB_HOST@allowed-host/`, `https://allowed-host@OOB_HOST/`, and fragment `https://allowed-host#@OOB_HOST/`. A callback to OOB_HOST proves the fetch host is attacker-chosen.
- **Redirect:** submit an allowed host that 302-redirects to your OOB host (a single evaluator-controlled hop).
- **Case/encoding of the URL:** one percent-encoded or mixed-case variant when a canonical form was rejected.

The natural next step — swapping the OOB host for `169.254.169.254`, a loopback service, or `file://` — is **out of bounded-PoC scope**. Record it as a blocked impact hypothesis in the finding ("validator bypassable; internal/metadata reachability not tested under this RoE") and stop. Do not execute it in normal mode.

## Variation Matrix

- Callback channel: DNS plus HTTPS versus DNS-only observation.
- Fetch output: blind callback versus returned synthetic marker.
- Redirect: direct evaluator URL versus one controlled 302 destination.
- Parser: canonical URL versus one URL-encoding/host-encoding variation.
- Lifecycle: synchronous response versus known async job.
- Origin: server egress versus browser/proxy/reputation service attribution.

## Proof Standard

Proof requires an HTTP request or returned synthetic marker attributable to the target server/application job, with a unique token and no-request control. DNS-only callbacks may be leads when prefetchers exist. Never use access to internal/metadata resources as the proof standard.

## False Positives and Benign Lookalikes

1. The evaluator's browser or enterprise proxy makes the callback.
2. A security/reputation service resolves the hostname but the application never fetches it.
3. Email/link preview infrastructure follows the URL outside the tested server boundary.
4. A cached prior token appears without the current job correlation.
5. The application validates a URL then safely rejects or never schedules a fetch.

## Missing Prerequisites and Blocked Behavior

Block when the approved callback service is unavailable, job correlation cannot be observed, or the only proposed validation uses internal/metadata targets. Preserve the endpoint, token design, and exact attribution evidence needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `oob_token_create`/`oob_check_interactions`, HTTP replay, browser network capture, and source reads. Prefer returned synthetic content when available. Do not substitute arbitrary internet hosts or local/internal scans.

## Handoffs and Duplicate Prevention

Open redirects belong to `open-redirect`, webhook signature/trust to `webhook-security`, browser fetches to client-side owners, and cloud configuration to cloud skills. `validation` decides the final SSRF evidence bundle.

## Stop, Cleanup, and Data Minimization

Expire callback tokens, cancel test jobs, and retain only token hashes, timestamps, sanitized request/callback metadata, and synthetic marker. Stop after one direct and one redirect hypothesis.

## Sources

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [PortSwigger Web Security Academy - SSRF](https://portswigger.net/web-security/ssrf)
