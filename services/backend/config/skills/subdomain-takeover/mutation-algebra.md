# Subdomain Takeover — Coverage Expansion Framework

(Not a traditional "bypass" algebra — this skill has no WAF to bypass.
Instead, this file covers systematic coverage to avoid missing takeover opportunities.)

## Dimension 1: DNS Record Types Beyond CNAME
Most tools check CNAME — but other record types can also dangle:

| Record Type | Takeover Scenario |
|---|---|
| `CNAME` | Most common — points to deprovisioned service |
| `A` / `AAAA` | IP address no longer controlled by target |
| `NS` | Entire subdomain zone delegated to deprovisioned nameserver |
| `MX` | Mail provider subdomain deprovisioned |
| `TXT` | Some verification services allow registering with TXT record content |

## Dimension 2: Provider-Specific Edge Cases

### AWS S3 Static Website
- CNAME: `bucket-name.s3-website-us-east-1.amazonaws.com`
- Non-website hosting: `bucket-name.s3.amazonaws.com`
- Both require bucket name to EXACTLY match subdomain
- If bucket name is different from subdomain: look for `NoSuchBucket` vs name mismatch

### GitHub Pages
- Organization: `org.github.io` (org-level site, harder to claim)
- Repository: `org.github.io/repo` (path-based, no subdomain takeover)
- Custom domain: `target.com` CNAME to `org.github.io` — claimable if org/repo exists but no CNAME on GitHub side

### Azure
- `azurewebsites.net` — App Service: claim by creating same-named app in any Azure subscription
- `azurestaticapps.net` — Static Web Apps
- `blob.core.windows.net` — Storage blob (like S3, name must match)
- `trafficmanager.net` — Traffic Manager profiles

### Cloudfront
- Takeover only when distribution is deleted but CNAME remains
- `NoSuchDistribution` in response body = dangling
- Cannot be claimed by another party easily (Cloudfront assigns random IDs)

## Dimension 3: Wildcard DNS Detection
```bash
# Test if wildcard exists: resolve random subdomain
dig +short "xyzrandom123456.target.com"
# If returns an IP → wildcard DNS exists
# Wildcard CNAME to dangling provider = all subdomains vulnerable
```

## Dimension 4: Subdomain Discovery Completeness
Ensure full coverage before takeover check:
- Tool coverage: subfinder + assetfinder + crt.sh + puredns brute-force + amass
- Alt names: check TLS certificates via `openssl s_client` for SAN entries
- Historical: check Wayback Machine for historical DNS entries
- Zone transfer: test `dig AXFR target.com @ns1.target.com` (almost always blocked but worth trying)

## Dimension 5: Timing and Race Conditions
- Recently deprovisioned resources: provider may still return 200 from cache
- DNS propagation delay: dangling CNAME may resolve to old IP for hours after deprovisioning
- Test multiple times with different DNS resolvers:
  ```bash
  dig @1.1.1.1 CNAME sub.target.com
  dig @8.8.8.8 CNAME sub.target.com
  dig @208.67.222.222 CNAME sub.target.com
  ```

## Dimension 6: Impact Escalation by Subdomain Type
Not all dangling subdomains have equal impact — prioritize:
1. `auth.`, `sso.`, `login.`, `oauth.`, `id.` — cookie scope → session theft
2. `api.`, `app.`, `portal.` — main functionality → phishing + data interception
3. `cdn.`, `static.`, `assets.` — CSP bypass → XSS via compromised CDN
4. `mail.`, `email.` — MX takeover → email interception
5. `dev.`, `staging.`, `test.` — lower priority but often have valid sessions
6. `docs.`, `blog.`, `status.` — lowest impact (phishing only, no cookie scope)
