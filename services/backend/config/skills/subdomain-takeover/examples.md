# Subdomain Takeover — Annotated Examples

## CNAME Enumeration
```bash
# Collect all CNAMEs from discovered subdomains
while IFS= read -r domain; do
  cname=$(dig +short CNAME "$domain" 2>/dev/null | head -1)
  [ -n "$cname" ] && echo "$domain CNAME $cname"
done < /workspace/.artifacts/all_domains.txt > /workspace/.artifacts/cnames.txt

# Alternative: use dnsx
dnsx -l /workspace/.artifacts/all_domains.txt -cname -json -o /workspace/.artifacts/cnames.json 2>/dev/null
```

## Provider Fingerprint Examples

### GitHub Pages — dangling
```bash
curl -s http://blog.target.com
# Response: "There isn't a GitHub Pages site here."
# dig CNAME blog.target.com → blog.target.com. CNAME target-org.github.io.
# Claimable if no GitHub repo with target-org/target-org.github.io exists
```

### Heroku — dangling
```bash
curl -s http://app.target.com
# Response: "No such app"
# dig CNAME app.target.com → decommissioned-app-name.herokudns.com.
# Claimable by registering new Heroku app with that exact name
```

### AWS S3 — dangling
```bash
curl -s http://assets.target.com
# Response: <Error><Code>NoSuchBucket</Code>...
# dig CNAME assets.target.com → assets.target.com.s3-website-us-east-1.amazonaws.com.
# Claimable by creating S3 bucket named "assets.target.com" in same region
```

### Azure App Service — dangling
```bash
curl -s http://api.target.com -I
# Response: HTTP 404 — "404 Web Site not found"
# dig CNAME api.target.com → decommissioned-app.azurewebsites.net.
# Claimable by creating Azure App Service with same name
```

### Fastly — dangling
```bash
curl -s http://cdn.target.com
# Response: "Fastly error: unknown domain: cdn.target.com"
# dig CNAME cdn.target.com → nonssl.global.fastly.net.
# Indicates Fastly distribution decommissioned
```

## DNS Chain Analysis
```bash
# Trace multi-hop CNAME chain
dig +trace CNAME sub.target.com
# May show: sub.target.com → old.target.com → decommissioned.provider.com
# Check each intermediate hop
dig CNAME old.target.com
dig CNAME decommissioned.provider.com
```

## Wildcard DNS Detection
```bash
# Test for wildcard
dig +short "xyznotexist987654.target.com"
# If returns IP → wildcard DNS present
# Then check: does wildcard CNAME point to dangling provider?
dig CNAME "xyznotexist987654.target.com"
# If CNAME returned → wildcard CNAME to dangling service
```

## Automated Takeover Scan with nuclei
```bash
# nuclei has templates for subdomain takeover detection
nuclei -l /workspace/.artifacts/all_domains.txt \
  -t /root/nuclei-templates/takeovers/ \
  -jsonl -o /workspace/.artifacts/takeover_results.jsonl 2>/dev/null

# Review results
jq 'select(.info.severity == "high")' /workspace/.artifacts/takeover_results.jsonl
```

## Reporting Format
```bash
# For each confirmed dangling subdomain:
report_note(
  assetRef={kind="domain", value="blog.target.com"},
  ntype="dns.cname",
  data={
    name: "blog.target.com",
    value: "target-org.github.io"
  },
  evidence=[{path: "/workspace/.artifacts/cnames.txt", label: "CNAME output", excerpt: "blog.target.com CNAME target-org.github.io"}]
)

# Then report finding:
report_finding(
  assetRef={kind="domain", value="blog.target.com"},
  title="Subdomain Takeover via Dangling GitHub Pages CNAME",
  severity="high",
  summary="blog.target.com points to an unclaimed GitHub Pages target-org.github.io hostname and matches the provider fingerprint for an unbound site.",
  confidence=0.9,
  evidence=[{path: "/workspace/.artifacts/cnames.txt", label: "CNAME proof", excerpt: "blog.target.com CNAME target-org.github.io; provider fingerprint indicates claimable GitHub Pages site."}]
)
```
Note: DO NOT actually claim or register the resource. Confirm claimability and stop.
