# Host Header Attack Methodology

Use this method to test trusted-host routing and absolute-URL generation with evaluator-owned hostnames and accounts. It does not pivot to internal hosts.

## Preconditions and Fast Applicability

Require an in-scope origin, expected host allowlist, evaluator-controlled comparison hostname, and a safe URL-generation or routing flow. Password-reset tests use only the evaluator mailbox and invalidate the token afterward.

Default cap: ten host variants and one evaluator reset message.

## Surface Discovery and Prioritization

Map authority/Host handling across gateway and application, forwarded-host headers actually used by the deployment, absolute links, redirects, canonical tags, reset emails, cache keys, and virtual-host routing.

## Safe Test Ladder

1. Capture the canonical host baseline.
2. Send an unknown evaluator hostname and expect rejection.
3. Test one observed forwarded-host header at a time.
4. Trigger one evaluator reset/notification and inspect the generated link without following an altered destination.
5. Use a nonce cache key for any cache interaction.
6. Compare request-line authority only through normal supported HTTP versions.
7. Repeat the decisive case and clean up.

## Variation Matrix

| Axis | Variants |
|---|---|
| authority | canonical, evaluator unknown, approved alias |
| override | only observed proxy header names |
| consumer | redirect, email link, body link, routing, isolated cache |
| protocol | HTTP/1 Host, HTTP/2 authority through normal client |
| identity | evaluator account, anonymous control |

## Proof Standard

Proof requires the evaluator host value to control a security-relevant absolute URL, route to an unauthorized in-scope virtual host, or persist in an isolated cache, with canonical/unknown controls. Reflection, `400`, a harmless canonical link, or an uncorrelated email is not proof.

## False Positives and Benign Lookalikes

- proxies can rewrite the host before the app;
- approved aliases can be intentional;
- emails can use configured public base URLs;
- default virtual hosts may contain only public content;
- cache keys usually include authority;
- redirects can canonicalize safely.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an evaluator hostname, mailbox, safe URL consumer, or layer attribution. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for raw authority/header control and browser/email capture for generated URLs. Do not scan internal virtual-host names.

## Handoffs and Duplicate Prevention

Hand isolated cache delivery to `web-cache-security`, redirect policy to `open-redirect`, and outbound request behavior to `ssrf` only with a separately approved evaluator target.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced security-relevant use, ten variants, or routing uncertainty. Invalidate evaluator reset tokens and expire cache keys.

Never perform destructive actions, target internal services, or send reset links to others.

Research date: 2026-07-23

## Sources

- PortSwigger Web Security Academy, HTTP Host Header Attacks: https://portswigger.net/web-security/host-header
- RFC 9110, HTTP Semantics: https://www.rfc-editor.org/rfc/rfc9110
