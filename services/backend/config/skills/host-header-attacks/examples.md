# Host Header Examples

## Strong Evidence

- A password-reset request for an evaluator produces an email whose link host equals the supplied owner-controlled test host, while the normal-host control uses the canonical application host.
- `X-Forwarded-Host` changes an absolute administrative link in an authenticated evaluator response despite an untrusted proxy path.
- A cache key omits the host while the response body embeds it; a fresh owner-controlled host request changes a later canonical-host response. Hand cache persistence to `web-cache-security`.

## Weak or Benign

- The server returns a generic `400` for an unknown host.
- Host changes only a reflected diagnostic page with no consumer.
- The altered host is explicitly configured as a valid custom domain.

Never send reset mail to real users or persist poisoned cache entries. Missing an evaluator mailbox or fresh cache makes confirmation `blocked`.
