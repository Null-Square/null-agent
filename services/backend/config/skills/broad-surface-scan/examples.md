# Broad Surface Scan - Annotated Examples

---

## Example 1 - Full Pipeline on a Fresh Web Application

Scenario: first run on `app.example.com`. Inventory is empty.
`needsBroadScan=true`.

### Port scan

```bash
naabu -host app.example.com -top-ports 1000 -rate 500 -silent \
  -o /workspace/.artifacts/broad/ports.txt
```

Output:

```text
app.example.com:80
app.example.com:443
app.example.com:8080
```

Signal: port `8080` is open. Add it to the target list.

### httpx surface confirmation

```bash
httpx -l /workspace/.artifacts/broad/http-targets.txt \
  -title -status-code -tech-detect -web-server \
  -follow-redirects -timeout 10 -rate-limit 30 \
  -nc -silent -json \
  -o /workspace/.artifacts/broad/httpx.jsonl
```

Output:

```text
https://app.example.com [200] [App Dashboard] [nginx/1.24.0][React][Bootstrap 5]
http://app.example.com [301] [Redirect] [nginx/1.24.0]
http://app.example.com:8080 [200] [Actuator] [Spring Boot 3.1][Java]
```

Action:

- `ingest_scan_artifact({ parser: "naabu", artifactPath: "/workspace/.artifacts/broad/ports.txt" })`
- `ingest_scan_artifact({ parser: "httpx", artifactPath: "/workspace/.artifacts/broad/httpx.jsonl" })`

Only add manual `report_note(ntype="tech.fingerprint")` entries for extra
context not already represented by the ingested artifact.

### WAF detection

```bash
wafw00f https://app.example.com
```

Output:

```text
No WAF detected
```

Decision: standard rate limits are safe.

### Crawl

```bash
katana -list /workspace/.artifacts/broad/http-targets.txt \
  -jc -js-crawl -kf all \
  -d 3 -c 10 -rate-limit 20 \
  -timeout 10 -jsonl -silent \
  -o /workspace/.artifacts/broad/katana.jsonl

python3 -c "import json; [print(json.loads(line).get('url','')) for line in open('/workspace/.artifacts/broad/katana.jsonl') if line.strip()]" \
  > /workspace/.artifacts/broad/katana.txt
```

Output excerpt:

```text
https://app.example.com/login
https://app.example.com/api/v1/users
https://app.example.com/api/v1/admin/settings
https://app.example.com/static/js/main.abc123.js
https://app.example.com/.well-known/openapi
```

Action:

- `ingest_scan_artifact({ parser: "katana", artifactPath: "/workspace/.artifacts/broad/katana.jsonl" })`
- do not manually duplicate the crawled URLs as `http.endpoint` notes unless
  you are adding extra context the artifact does not already carry

### Spec discovery

The crawl found `/.well-known/openapi`. Verify:

```bash
curl -s https://app.example.com/.well-known/openapi | head -30
```

Output:

```json
{"openapi":"3.0.1","info":{"title":"App API","version":"1.0"},"paths":{"/api/v1/users":{}}}
```

Action: `report_finding` for exposed OpenAPI spec, then hand the spec path to
the next planner run for targeted API follow-up.

### Conditional ffuf spec discovery

Run this only if crawl and direct spec probes did not already provide enough
endpoint/spec coverage.

```bash
BSIZE=$(curl -s -o /dev/null -w "%{size_download}" "https://app.example.com/doesnotexist-$(date +%s)")
ffuf -u "https://app.example.com/FUZZ" \
  -w /workspace/.skills/broad-surface-scan/wordlists/swagger-paths.txt \
  -mc 200,401,403 -fc 404,429 \
  -fs "$BSIZE" \
  -t 20 -rate 50 -timeout 10 -c -s \
  -o /workspace/.artifacts/broad/ffuf-specs.json -of json
```

Action:

- `ingest_scan_artifact({ parser: "ffuf", artifactPath: "/workspace/.artifacts/broad/ffuf-specs.json" })`
- reserve manual endpoint notes for URLs or context not already represented by
  the ingested `ffuf` artifact
- stop after one pass if results are mostly identical-size rows, repeated
  redirects, or other wildcard noise

---

## Example 2 - WAF Detected, Rate Limiting Required

Scenario: target is behind Cloudflare. Initial `httpx` returns `429` on fast
probes.

```bash
wafw00f https://shop.example.com
```

Output:

```text
The site https://shop.example.com is behind Cloudflare (Cloudflare Inc.)
```

Decision:

- drop all rates to `10` req/s
- set timeout to `15s`
- add a browser-like `User-Agent`

```bash
ffuf -u "https://shop.example.com/FUZZ" \
  -w /workspace/.skills/broad-surface-scan/wordlists/swagger-paths.txt \
  -mc 200,401,403 -fc 404,429 \
  -t 5 -rate 10 -timeout 15 \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -c -s \
  -o /workspace/.artifacts/broad/ffuf-specs.json -of json
```

If more than 20% of requests still hit `429`, write `scan.coverage` as blocked
with the WAF reason instead of pretending coverage succeeded.

---

## Example 3 - API Target (No HTML, REST Only)

Scenario: target is `api.example.com` and serves JSON only.

`httpx` output:

```text
https://api.example.com [200] [{"status":"ok"}] [nginx]
```

If `katana` produces near-zero output, skip deeper crawl work and do direct
spec probes first. Use `ffuf` only if the direct probes do not answer the
coverage question.

```bash
for path in /openapi.json /openapi.yaml /swagger.json /swagger.yaml \
            /api-docs /v1/openapi.json /v2/api-docs; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://api.example.com${path}")
  [ "$code" != "404" ] && [ "$code" != "000" ] && echo "${code} https://api.example.com${path}"
done
```

Output:

```text
200 https://api.example.com/v2/api-docs
```

Action: `report_finding` for exposed spec, then parse the spec for targeted API
follow-up in a later run.

```bash
ffuf -u "https://api.example.com/FUZZ" \
  -w /workspace/.skills/broad-surface-scan/wordlists/api-endpoints.txt \
  -mc 200,201,204,401,403 -fc 404,429 \
  -t 20 -rate 50 -timeout 10 -c -s \
  -o /workspace/.artifacts/broad/ffuf-api.json -of json
```

Immediately ingest:

```text
ingest_scan_artifact({ parser: "ffuf", artifactPath: "/workspace/.artifacts/broad/ffuf-api.json" })
```

---

## Example 4 - Wildcard Response (ffuf False Positives)

Scenario: target returns `200` for all paths with a generic error page.

```bash
BSIZE=$(curl -s -o /dev/null -w "%{size_download}" "https://app.example.com/doesnotexist-$(date +%s)")
echo "Wildcard response size: $BSIZE bytes"
```

Output:

```text
Wildcard response size: 1842 bytes
```

Decision: filter by size in `ffuf`.

```bash
ffuf -u "https://app.example.com/FUZZ" \
  -w /workspace/.skills/broad-surface-scan/wordlists/raft-medium-directories.txt \
  -mc 200,401,403 -fc 404,429 \
  -fs "$BSIZE" \
  -t 20 -rate 50 -timeout 10 -c -s \
  -o /workspace/.artifacts/broad/ffuf-dirs.json -of json
```

If the artifact still contains mostly repeated redirects or identical-size
catch-all rows, ingest it once and stop. The ingest path keeps the raw artifact
but suppresses low-signal canonical endpoint notes.

---

## Example 5 - Blocked Scan (Coverage Note Required)

Scenario: target is unreachable. DNS resolves but all ports time out.

```bash
naabu -host internal.example.com -top-ports 1000 -rate 500 -silent \
  -o /workspace/.artifacts/broad/ports.txt

curl -Ik --max-time 10 https://internal.example.com
```

Output:

```text
curl: (28) Connection timed out after 10001 milliseconds
```

Write a blocked coverage note immediately:

```json
{
  "assetRef": { "kind": "domain", "value": "internal.example.com" },
  "ntype": "scan.coverage",
  "title": "Broad surface scan blocked for internal.example.com",
  "data": {
    "family": "broad-surface",
    "status": "blocked",
    "profileVersion": "broad-surface-scan/v1",
    "reason": "All ports timed out. Target appears to be network-restricted or requires VPN/internal runner. DNS resolves correctly."
  }
}
```

---

## Example 6 - Return Scope Narrow Pass

Scenario: inventory already contains validated assets and the planner says five
specific hosts still have `needsBroadScan=true`.

Do not rerun root-domain `subfinder` or `naabu` unless the service picture is
missing or stale. Start from the known assets:

```bash
printf '%s\n' \
  cip.mit.gov.jo \
  alphaplus.mc.gov.jo \
  admhec.gov.jo \
  asytrade.customs.gov.jo \
  acc.gov.jo > /workspace/.artifacts/targets.txt

httpx -l /workspace/.artifacts/targets.txt \
  -title -status-code -tech-detect -web-server \
  -follow-redirects -timeout 10 -rate-limit 30 \
  -nc -silent -json \
  -o /workspace/.artifacts/httpx.jsonl
```

Immediately ingest:

```text
ingest_scan_artifact({ parser: "httpx", artifactPath: "/workspace/.artifacts/httpx.jsonl" })
```

If the required service and tech evidence is now present, write per-asset
`scan.coverage` and close the broad-scan task. Pick only one deeper follow-up
(`katana` or `ffuf`) if evidence is still missing.
