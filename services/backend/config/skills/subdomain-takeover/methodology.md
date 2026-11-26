# Subdomain Takeover — Step-by-Step Methodology

## 1. Collect CNAME Records
- After subdomain enumeration, collect all discovered subdomains from `all_domains.txt`.
- Query CNAME records for each:
  ```bash
  while IFS= read -r domain; do
    cname=$(dig +short CNAME "$domain" 2>/dev/null | head -1)
    [ -n "$cname" ] && echo "$domain -> $cname"
  done < /workspace/.artifacts/all_domains.txt > /workspace/.artifacts/cnames.txt
  ```
- Also useful: `dnsx -l /workspace/.artifacts/all_domains.txt -cname -json -o /workspace/.artifacts/cnames.json`

## 2. Identify Dangling CNAMEs
A subdomain is dangling when its CNAME target returns a provider "not found" or "unclaimed" response.
Check each CNAME target:
```bash
while IFS= read -r line; do
  domain=$(echo "$line" | cut -d' ' -f1)
  cname=$(echo "$line" | cut -d' ' -f3)
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$domain" 2>/dev/null)
  echo "$domain -> $cname (HTTP $status)"
done < /workspace/.artifacts/cnames.txt
```

## 3. Provider Fingerprinting
Match provider-specific "unclaimed" response signatures:

| Provider | CNAME pattern | Takeover signal |
|---|---|---|
| GitHub Pages | `*.github.io` | `There isn't a GitHub Pages site here` |
| Heroku | `*.herokudns.com`, `*.herokuapp.com` | `No such app` |
| AWS S3 | `*.s3.amazonaws.com`, `*.s3-website-*.amazonaws.com` | `NoSuchBucket` |
| AWS CloudFront | `*.cloudfront.net` | `Bad request` (if distribution deleted) |
| Azure | `*.azurewebsites.net`, `*.azurestaticapps.net` | `404 Web Site not found` |
| Fastly | `*.fastly.net` | `Fastly error: unknown domain` |
| Shopify | `*.myshopify.com` | `Sorry, this shop is currently unavailable` |
| Zendesk | `*.zendesk.com` | `Help Center Closed` |
| Pantheon | `*.pantheonsite.io` | `404 error unknown site` |
| Surge.sh | `*.surge.sh` | `project not found` |

```bash
# Check response body for fingerprints
while IFS= read -r line; do
  domain=$(echo "$line" | cut -d' ' -f1)
  body=$(curl -s --max-time 5 "http://$domain" 2>/dev/null | head -20)
  echo "=== $domain ==="
  echo "$body" | grep -iE "github pages|no such app|nobucket|not found|unclaimed|doesn't exist" || echo "no fingerprint"
done < /workspace/.artifacts/cnames.txt
```

## 4. Claimability Validation (safe — no destructive action)
Confirm the resource is claimable WITHOUT actually claiming it:
- For GitHub Pages: does `github.com/<org>/<repo>` exist? If no → claimable but do NOT create it.
- For S3: does bucket exist? `aws s3 ls s3://BUCKET_NAME` — if NoSuchBucket → claimable.
- For Heroku: does app exist at target URL? If "No such app" → claimable.
- Document: subdomain, CNAME chain, provider, fingerprint response, claimability evidence.
- DO NOT claim or register the resource — confirm claimability and report.

## 5. DNS Chain Analysis
Some takeovers require multiple hops:
- `sub.target.com → old.target.com → decommissioned.provider.com`
- Check each intermediate CNAME for takeover potential.
- Use `dnsx` or repeated `dig CNAME` to trace full chain.

## 6. Edge Cases
- Wildcard DNS: `*.target.com` CNAME to a defunct provider — all subdomains potentially vulnerable.
- NS delegation: if entire subdomain zone is delegated to a deprovisioned NS, full takeover possible.
- MX records: some email providers allow subdomain takeover via dangling MX records.

## 7. Reporting
- Call `report_note ntype=dns.cname` for each CNAME found (even non-dangling).
- Call `report_finding` for confirmed dangling CNAMEs with provider fingerprint evidence.
- Severity: high for web-serving providers (GitHub, Netlify, S3 website); medium for non-web (non-HTTPS, non-cookie-scoped); critical if affects primary domain or SSO subdomain.
- Evidence: `dig CNAME` output + provider fingerprint response body excerpt.

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
