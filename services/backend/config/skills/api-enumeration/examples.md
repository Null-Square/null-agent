# API Surface Enumeration - Annotated Examples

## Swagger Discovery
```bash
curl -i https://target.com/swagger.json
```
Good signal:
```
HTTP/1.1 200 OK
Content-Type: application/json
{"openapi":"3.0.1","paths":{...}}
```

## Route Bruteforce with Kiterunner
```bash
kr scan https://target.com -w /usr/share/wordlists/nullai/routes-small.kite
```
Sample outputs:
```
200 GET /api/v1/users
401 POST /api/v1/auth/refresh
403 GET /api/internal/admin
```

## Method Matrix Check
```bash
curl -i -X OPTIONS https://target.com/api/v1/users
```
Signal to capture:
```
Allow: GET,POST,OPTIONS
```

## GraphQL Probe
```bash
curl -s https://target.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query{__typename}"}'
```
Typical outcomes:
```
{"data":{"__typename":"Query"}}
```
or
```
{"errors":[{"message":"Unauthorized"}]}
```
