# Open Redirect — Step-by-Step Methodology

## 0. HYPOTHESIS BEFORE PROBE

`endpoint, redirect-target-mutation, expected signal, why this matters`.

Example: `GET /login?next=, mutation=//evil.example, expected: Location header points to evil.example, why: confirms scheme-relative bypass of same-host check.`

## 0.1 USE http_differential

Vary `next` (or whichever redirect parameter) across mutation classes in one call. This is the canonical use of http_differential for this skill.

```
http_differential(
  url_template="https://target/login?next={next}",
  parameter={ name: "next", in: "query" },
  baseline="/dashboard",
  values=[
    { kind: "literal", value: "https://evil.example/" },
    { kind: "literal", value: "//evil.example/" },
    { kind: "literal", value: "https://target.com.evil.example/" },
    { kind: "literal", value: "https://evil.example@target.com/" },
    { kind: "literal", value: "javascript:alert(1)" },
  ],
  signal="status",
  follow_redirects=false,
)
```

Then call `report_finding` for each variant whose response Location header contains the attacker-controlled host. `signalClass="open-redirect-accepted"`. Severity medium for plain redirect; high if chained with OAuth `redirect_uri` bypass.

## 1. Attack Surface Discovery
Find parameters and endpoints that redirect users:
- URL parameters: `?redirect=`, `?next=`, `?url=`, `?return=`, `?returnUrl=`, `?goto=`, `?dest=`, `?destination=`, `?redir=`, `?continue=`
- OAuth flows: `redirect_uri=`, `return_url=` in authorization requests
- Post-login navigation: `GET /login?next=/dashboard` → where is `next` validated?
- Post-logout redirect: `GET /logout?returnTo=`
- Email unsubscribe links with redirect
- API responses containing redirect URLs in JSON body

## 2. Baseline Legitimate Redirect
- Confirm the redirect works with a legitimate value: `?next=/dashboard`
- Observe: status code (301/302/303), `Location` header value, final destination.
- Understand: does it redirect to relative paths, absolute paths, or full URLs?

## 3. Basic External Redirect Test
```
?next=https://evil.example.com/
?return=http://attacker.com/phish
```
- Check `Location` header in response — does it point to attacker domain?
- If yes → open redirect confirmed (no bypass needed).

## 4. Absolute URL with Same-Host Check Bypass
When app only allows redirects to same domain, test bypasses:
```
?next=https://evil.com@target.com/          (@ userinfo trick)
?next=https://target.com.evil.com/          (subdomain lookalike)
?next=//evil.com/                           (scheme-relative)
?next=https://evil.com\target.com/          (backslash confusion)
```
Read `/workspace/.skills/open-redirect/mutation-algebra.md` for full bypass matrix.

## 5. OAuth redirect_uri Bypass
OAuth is a common high-impact source:
- Test parameter manipulation in `/oauth/authorize?redirect_uri=`
- Valid: `redirect_uri=https://legit-app.com/callback`
- Try: `redirect_uri=https://legit-app.com.evil.com/callback` (subdomain trick)
- Try: `redirect_uri=https://legit-app.com/callback@evil.com` (@ trick)
- Try: `redirect_uri=https://legit-app.com/../../../callback?redirectTo=https://evil.com`
- Impact: redirect_uri bypass in OAuth leaks auth codes to attacker (authorization code theft).

## 6. Chaining with Other Bugs
- Open redirect + phishing: craft URL that looks like `target.com` but redirects to phishing page.
- Open redirect + SSRF: if the redirect URL is fetched server-side → SSRF via redirect.
- Open redirect + OAuth: steal auth tokens via `redirect_uri` bypass.
- Open redirect + XSS: `?next=javascript:alert(1)` — if executed by browser, XSS via redirect.

## 7. javascript: Protocol Test
```
?next=javascript:alert(1)
?url=javascript:void(0)
```
- If response `Location: javascript:alert(1)` → XSS via redirect possible (browser executes on follow).
- Not always user-exploitable (browsers may block) — but document as misconfiguration.

## 8. Validation Criteria
- Confirmed: `Location` header in redirect response points to attacker-controlled domain.
- For OAuth: attacker can capture auth code from redirect_uri bypass.
- Confidence ≥0.85: redirect response with `Location: https://external-domain.com/`.

## 9. Reporting
- Call `report_finding` with: parameter, redirect payload, response headers, impact scenario.
- Severity: medium (plain redirect + phishing); high (OAuth token theft via redirect_uri); 
  high if chained with XSS via `javascript:`.

## B1 Existing-Package Contract

This appendix normalizes the existing package; the package-specific procedure above remains authoritative.

### Preconditions and Fast Applicability

Confirm the exact target or artifact is authorized, the package-specific input exists, and the earlier procedure's controls and quantitative limits can be met. Otherwise record not-applicable or blocked coverage.

### Surface Discovery and Prioritization

Start from durable inventory and prioritize only the surfaces named by this package. A technology, route, banner, or version string establishes inventory, not a vulnerability.

### Safe Test Ladder

Run the package's baseline first, then its smallest one-variable candidate and a matched negative control. Stop at proof, falsification, the package cap, or a missing prerequisite.

### Variation Matrix

Apply only variations justified by the observed parser, identity, state, transport, platform, or tool behavior. Change one dimension per replay and retain the invariant baseline.

### Proof Standard

Use the package-specific proof floor above. Scanner labels, generic errors, reflection, timing outliers, and source appearance remain leads unless the documented control and impact are reproduced.

### False Positives and Benign Lookalikes

Compare the candidate with a normal baseline, a syntax-neutral or nonexistent control, and any package-specific benign condition. Reject results that are equally explained by caching, rate limiting, intended public behavior, or unstable infrastructure.

### Missing Prerequisites and Blocked Behavior

Name the missing identity, state, protocol support, repository context, callback, or safe environment and the exact evidence that would unblock testing. Never convert blocked or ambiguous work into a finding.

### Tool Selection and Fallback

Use only the tools declared by this skill and prefer machine-readable, rate-bounded output. If the preferred tool is unavailable, use the package's documented fallback or stop; do not broaden permissions.

### Handoffs and Duplicate Prevention

Keep this package focused on its declared primitive. Reuse baseline and evidence identifiers when a related skill owns another protocol, platform, or final validation decision.

### Stop, Cleanup, and Data Minimization

Stop at the first sufficient proof or rejection. Remove evaluator-created state, expire callbacks, close special connections, redact secrets and personal data, and retain only the minimum reproducible evidence. Never perform destructive actions or expand beyond the authorized target.

Research date: 2026-07-23

## Sources

- Package-specific sources and references listed above.
- Locked B1 authoring and evaluation PRD: ../../../../../docs/prd/3.0/agent-skill-authoring-and-evaluation.md
